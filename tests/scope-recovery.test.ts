import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  DomainError,
  OutcomeUnknownError,
  type Plan,
  type Principal,
  type ToolDefinition,
} from "../src/contracts.js";
import { Accounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { WorkspaceStore } from "../src/workspace.js";

test("persisted reference resolution never exposes HR input or results to a documents-only viewer", async () => {
  const owner: Principal = {
    id: "owner",
    tenantId: "a",
    roles: ["operator", "approver"],
    scopes: ["*"],
  };
  const viewer: Principal = {
    id: "viewer",
    tenantId: "a",
    roles: ["viewer"],
    scopes: ["documents", "it", "cases"],
  };
  const workspace = new WorkspaceStore(":memory:");
  workspace.setPrincipalProvider(() => [owner, viewer]);
  const source: ToolDefinition = {
    id: "test.area",
    version: "1",
    effect: "read",
    recovery: "idempotent",
    scope: "documents",
    description: "Synthetic area lookup",
    inputSchema: z.object({}).strict(),
    async execute() {
      return { data: { area: "people" } };
    },
    async verify() {
      return {
        ok: true,
        summary: "Synthetic",
        evidence: [
          {
            source: "synthetic-test",
            summary: "Area from synthetic fixture",
            observedAt: new Date().toISOString(),
            data: { area: "people" },
          },
        ],
      };
    },
  };
  const tools = [source, ...workspace.tools()];
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals: [owner, viewer],
    policies: [
      {
        tenantId: "a",
        name: "Test",
        version: "1",
        allowedTools: tools.map((t) => t.id),
        approvalTools: [],
        allowSelfApproval: true,
      },
    ],
  });
  try {
    const plan: Plan = {
      title: "HR test",
      summary: "Synthetic",
      steps: [
        { id: "area", title: "Area", toolId: "test.area", input: {} },
        {
          id: "doc",
          title: "Private HR record",
          toolId: "ops.documents.create",
          input: {
            title: "Private HR record",
            data: {
              accessScope: { $step: "area", path: "area" },
              documentType: "contract",
              content: "PRIVATE-SYNTHETIC-HR",
            },
          },
        },
      ],
    };
    let run = engine.createRun(
      owner,
      "HR synthetic test",
      plan,
      "scope-ref-test",
    );
    assert.throws(
      () => engine.getRun(viewer, run.id),
      (e) => e instanceof DomainError && e.statusCode === 403,
      "unresolved classification fails closed",
    );
    engine.start(owner, run.id);
    for (let i = 0; i < 4; i++) await engine.tick();
    run = engine.getRun(owner, run.id);
    assert.equal(run.status, "waiting_approval");
    assert.throws(
      () => engine.getRun(viewer, run.id),
      (e) => e instanceof DomainError && e.statusCode === 403,
      "resolved_input must be checked, not original reference placeholder",
    );
    const approval = run.steps[1]!.approval!;
    engine.approve(owner, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    for (let i = 0; i < 4; i++) await engine.tick();
    assert.equal(engine.getRun(owner, run.id).status, "completed");
    assert.deepEqual(engine.listRuns(viewer), []);
    assert.throws(
      () => engine.getRun(viewer, run.id),
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
  } finally {
    engine.close();
    workspace.close();
  }
});

test("revoked real account session cannot authorize recovery of an absent operation effect", async () => {
  const accounts = new Accounts(":memory:");
  for (const id of ["operator", "approver"])
    accounts.provision({
      id,
      tenantId: "a",
      username: id,
      password: "synthetic-test-password",
      roles: [id],
      scopes: ["*"],
    });
  const workspace = new WorkspaceStore(":memory:");
  let executeCalls = 0;
  const tools = workspace.tools().map((tool) =>
    tool.id === "ops.assets.create"
      ? {
          ...tool,
          async execute(...args: Parameters<typeof tool.execute>) {
            executeCalls++;
            if (executeCalls === 1)
              throw new OutcomeUnknownError(
                "synthetic transport ambiguity before effect",
              );
            return tool.execute(...args);
          },
        }
      : tool,
  );
  const config: AppConfig = {
    mode: "accounts",
    host: "127.0.0.1",
    port: 4310,
    dataDir: "/unused",
    plannerKind: "demo",
    tokens: new Map(),
    principals: accounts.principals(),
    policies: [
      {
        tenantId: "a",
        name: "Test",
        version: "1",
        allowedTools: tools.map((t) => t.id),
        approvalTools: [],
        allowSelfApproval: false,
      },
    ],
  };
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals: config.principals,
    policies: config.policies,
  });
  const app = createApp({
    engine,
    config,
    tools,
    workspace,
    accounts,
    planner: {
      kind: "unused",
      async plan() {
        throw new Error("Unused");
      },
    },
  });
  const post = (url: string, payload: object, cookie?: string) =>
    app.inject({
      method: "POST",
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });
  try {
    const login = async (username: string) => {
      const response = await post("/api/auth/login", {
        username,
        password: "synthetic-test-password",
      });
      assert.equal(response.statusCode, 200, response.body);
      return String(response.headers["set-cookie"]).split(";")[0]!;
    };
    const operatorCookie = await login("operator"),
      approverCookie = await login("approver");
    const response = await post(
      "/api/commands",
      {
        toolId: "ops.assets.create",
        input: {
          title: "Synthetic",
          data: {
            assetType: "laptop",
            serial: "SYNTHETIC",
            location: "Local",
            condition: "good",
          },
        },
        idempotencyKey: "revocation-test",
      },
      operatorCookie,
    );
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().run.id as string;
    await post(`/api/runs/${id}/start`, {}, operatorCookie);
    await engine.tick();
    const operator = config.principals.find((p) => p.id === "operator")!;
    const approval = engine.getRun(operator, id).steps[0]!.approval!;
    assert.equal(
      (
        await post(
          `/api/runs/${id}/approve`,
          {
            approvalId: approval.id,
            bindingHash: approval.bindingHash,
            decision: "approved",
          },
          approverCookie,
        )
      ).statusCode,
      200,
    );
    await engine.tick();
    assert.equal(engine.getRun(operator, id).status, "needs_reconciliation");
    accounts.revoke("a", "approver");
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/context",
          headers: { cookie: approverCookie },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await post(`/api/runs/${id}/retry`, {}, operatorCookie)).statusCode,
      200,
    );
    for (let i = 0; i < 4; i++) await engine.tick();
    assert.equal(executeCalls, 1);
    assert.equal(workspace.list(operator, "assets").length, 0);
    assert.notEqual(engine.getRun(operator, id).status, "completed");
  } finally {
    await app.close();
    engine.close();
    workspace.close();
    accounts.close();
  }
});

test("bounded-role requester can review its reference plan and profile preparation pins configuration before approvals", async () => {
  const owner: Principal = {
    id: "owner",
    tenantId: "a",
    roles: ["operator", "approver"],
    scopes: ["people", "cases"],
  };
  const viewer: Principal = { ...owner, id: "viewer", roles: ["viewer"] };
  const workspace = new WorkspaceStore(":memory:");
  const template = [
    {
      key: "verify",
      title: "Test template",
      required: true,
      offsetDays: 0,
      dependsOn: [],
      assigneeRole: "manager" as const,
      kind: "work" as const,
      requirementKeys: [],
    },
  ];
  workspace.setProfileProvider(() => ({
    version: 9,
    definitionVersion: "2",
    roleBindings: { manager: owner.id },
    processTemplates: { onboarding: template, offboarding: template },
  }));
  const tools = workspace.tools();
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals: [owner, viewer],
    policies: [
      {
        tenantId: "a",
        name: "Test",
        version: "1",
        allowedTools: tools.map((t) => t.id),
        approvalTools: [],
        allowSelfApproval: true,
      },
    ],
  });
  try {
    const run = engine.createRun(
      owner,
      "Create and onboard",
      {
        title: "Bounded multistep",
        summary: "Test",
        steps: [
          {
            id: "person",
            title: "Person",
            toolId: "ops.people.create",
            input: {
              title: "Synthetic person",
              data: { personCategory: "internal" },
            },
          },
          {
            id: "onboard",
            title: "Onboard",
            toolId: "ops.people.startEmployment",
            input: {
              id: { $step: "person", path: "entityId" },
              expectedVersion: { $step: "person", path: "version" },
              employmentKind: "internal",
              startDate: "2020-01-01",
              role: "Test",
              humanDecision: true,
            },
          },
        ],
      },
      "bounded-ref-test",
    );
    assert.equal(run.plan.steps[1]!.input.profileVersion, 9);
    assert.equal(run.status, "planned");
    assert.throws(
      () => engine.getRun(viewer, run.id),
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
    engine.start(owner, run.id);
    for (let i = 0; i < 12; i++) {
      await engine.tick();
      const current = engine.getRun(owner, run.id);
      if (current.status === "waiting_approval") {
        const approval = current.steps.find(
          (step) => step.approval?.status === "pending",
        )!.approval!;
        engine.approve(owner, run.id, {
          approvalId: approval.id,
          bindingHash: approval.bindingHash,
          decision: "approved",
        });
      }
      if (current.status === "completed") break;
    }
    assert.equal(engine.getRun(owner, run.id).status, "completed");
    assert.equal(workspace.list(owner, "people")[0]!.status, "onboarding");
    assert.equal(workspace.list(owner, "cases")[0]!.data.profileVersion, 9);
  } finally {
    engine.close();
    workspace.close();
  }
});

test("wildcard scopes never bypass an identity-only tool predicate for unresolved references", async () => {
  const owner: Principal = {
    id: "owner",
    tenantId: "identity-test",
    roles: ["operator"],
    scopes: ["*"],
  };
  const viewer: Principal = { ...owner, id: "viewer", roles: ["viewer"] };
  const unrelated: Principal = { ...owner, id: "unrelated" };
  const base: ToolDefinition = {
    id: "context.read",
    version: "1",
    effect: "read",
    recovery: "idempotent",
    description: "Synthetic local read",
    inputSchema: z.object({ target: z.string() }).strict(),
    execute: async () => ({ data: { target: "known-target" } }),
    verify: async () => ({
      ok: true,
      summary: "Synthetic read checked",
      evidence: [
        {
          source: "synthetic",
          summary: "Fixture only",
          observedAt: new Date().toISOString(),
          data: {},
        },
      ],
    }),
  };
  const privateTool: ToolDefinition = {
    ...base,
    id: "context.private",
    canAccess: (p, input) =>
      p.id === owner.id && input.target === "known-target",
  };
  const engine = new Engine({
    dbPath: ":memory:",
    principals: [owner, viewer, unrelated],
    tools: [base, privateTool],
    policies: [
      {
        tenantId: owner.tenantId,
        version: "1",
        name: "Synthetic identity rule",
        allowedTools: [base.id, privateTool.id],
        approvalTools: [],
        allowSelfApproval: false,
      },
    ],
  });
  try {
    const run = engine.createRun(
      owner,
      "Private synthetic request",
      {
        title: "Private read",
        summary: "Identity cannot be replaced by wildcard",
        steps: [
          {
            id: "source",
            title: "Read",
            toolId: base.id,
            input: { target: "public" },
          },
          {
            id: "private",
            title: "Read private",
            toolId: privateTool.id,
            input: { target: { $step: "source", path: "target" } },
          },
        ],
      },
      "unresolved-identity-test",
    );
    assert.equal(engine.getRun(owner, run.id).status, "planned");
    for (const actor of [viewer, unrelated]) {
      assert.throws(
        () => engine.getRun(actor, run.id),
        (e) => e instanceof DomainError && e.statusCode === 403,
      );
      assert.deepEqual(engine.listRuns(actor), []);
    }
    engine.setPrincipals([{ ...owner, scopes: ["people"] }, viewer, unrelated]);
    assert.throws(
      () => engine.getRun(owner, run.id),
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
    engine.setPrincipals([owner, viewer, unrelated]);
    engine.start(owner, run.id);
    for (let i = 0; i < 4; i++) await engine.tick();
    assert.equal(engine.getRun(owner, run.id).status, "completed");
    for (const actor of [viewer, unrelated])
      assert.throws(
        () => engine.getRun(actor, run.id),
        (e) => e instanceof DomainError && e.statusCode === 403,
      );
  } finally {
    engine.close();
  }
});
