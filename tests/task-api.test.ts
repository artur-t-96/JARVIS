import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Accounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { OutcomeUnknownError, type JsonObject } from "../src/contracts.js";
import { Engine, type RunDetail } from "../src/engine.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";
import type { TaskProjection } from "../src/workspace-tasks.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-task-api-"));
  const accounts = new Accounts(join(directory, "accounts.sqlite"));
  for (const tenant of ["a", "b"])
    for (const [id, roles, scopes] of [
      ["manager", ["operator"], ["*"]],
      ["case-manager", ["operator"], ["cases", "people"]],
      ["reviewer", ["approver"], ["*"]],
      ["it-one", ["operator"], ["it"]],
      ["it-two", ["operator"], ["it"]],
      ["observer", ["viewer"], []],
    ] as const)
      accounts.provision({
        id,
        tenantId: tenant,
        username: `${tenant}-${id}`,
        password: "synthetic-task-test-password",
        roles: [...roles],
        scopes: [...scopes],
      });
  const cookies = new Map(
    accounts
      .principals()
      .map((p) => [
        `${p.tenantId}:${p.id}`,
        `jarvis_session=${accounts.login(`${p.tenantId}-${p.id}`, "synthetic-task-test-password").token}`,
      ]),
  );
  let workspace: WorkspaceStore;
  let engine: Engine;
  let app: ReturnType<typeof createApp>;
  let loseTransferResponse = false;
  let transferExecutions = 0;
  function boot() {
    workspace = new WorkspaceStore(join(directory, "operations.sqlite"));
    const tools = workspace.tools().map((tool) =>
      tool.id !== "ops.cases.transferTask"
        ? tool
        : {
            ...tool,
            execute: async (...args: Parameters<typeof tool.execute>) => {
              transferExecutions++;
              const receipt = await tool.execute(...args);
              if (loseTransferResponse) {
                loseTransferResponse = false;
                throw new OutcomeUnknownError("test response loss");
              }
              return receipt;
            },
          },
    );
    const config: AppConfig = {
      mode: "accounts",
      host: "127.0.0.1",
      port: 4310,
      dataDir: "/unused",
      plannerKind: "demo",
      tokens: new Map(),
      principals: accounts.principals(),
      policies: ["a", "b"].map((tenantId) => ({
        tenantId,
        name: "Synthetic task test",
        version: "1",
        allowedTools: tools.map((t) => t.id),
        approvalTools: [],
        allowSelfApproval: false,
      })),
    };
    engine = new Engine({
      dbPath: join(directory, "core.sqlite"),
      tools,
      principals: config.principals,
      policies: config.policies,
    });
    app = createApp({
      engine,
      workspace,
      accounts,
      tools,
      config,
      planner: {
        kind: "test",
        async plan() {
          throw new Error("unused");
        },
      },
    });
  }
  boot();
  const get = (url: string, actor = "manager", tenant = "a") =>
    app.inject({
      method: "GET",
      url,
      headers: { cookie: cookies.get(`${tenant}:${actor}`)! },
    });
  const post = (
    url: string,
    payload: object,
    actor = "manager",
    tenant = "a",
  ) =>
    app.inject({
      method: "POST",
      url,
      payload,
      headers: { cookie: cookies.get(`${tenant}:${actor}`)! },
    });
  const current = (runId: string, actor = "manager", tenant = "a") =>
    engine.getRun(
      accounts
        .principals()
        .find((p) => p.id === actor && p.tenantId === tenant)!,
      runId,
    );
  const stage = async (
    toolId: string,
    input: JsonObject,
    actor = "manager",
    tenant = "a",
  ) => {
    const response = await post(
      "/api/commands",
      { toolId, input, idempotencyKey: randomUUID() },
      actor,
      tenant,
    );
    assert.equal(response.statusCode, 201, response.body);
    const { run } = response.json<{ run: RunDetail }>();
    assert.equal(
      (await post(`/api/runs/${run.id}/start`, {}, actor, tenant)).statusCode,
      200,
    );
    await engine.tick();
    const waiting = current(run.id, actor, tenant);
    assert.equal(waiting.status, "waiting_approval", JSON.stringify(waiting));
    const approval = waiting.steps[0]!.approval!;
    assert.equal(
      (
        await post(
          `/api/runs/${run.id}/approve`,
          {
            approvalId: approval.id,
            bindingHash: approval.bindingHash,
            decision: "approved",
          },
          "reviewer",
          tenant,
        )
      ).statusCode,
      200,
    );
    return run.id;
  };
  const execute = async (
    toolId: string,
    input: JsonObject,
    actor = "manager",
    tenant = "a",
  ) => {
    const runId = await stage(toolId, input, actor, tenant);
    await engine.tick();
    const run = current(runId, actor, tenant);
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(run.steps[0]!.verification?.ok, true);
    return run;
  };
  const setup = async () => {
    let run = await execute("ops.cases.create", {
      title: "HR_CASE_PRIVATE_TITLE",
      data: {
        caseType: "general",
        brief: "PRIVATE_HR_BRIEF_2026",
        acceptanceCriteria: "PRIVATE_HR_CRITERIA",
      },
    });
    const caseId = String(run.steps[0]!.output!.data.entityId);
    const e = workspace.get(
      accounts
        .principals()
        .find((p) => p.id === "manager" && p.tenantId === "a")!,
      "cases",
      caseId,
    );
    await execute("ops.cases.addTask", {
      id: caseId,
      expectedVersion: e.version,
      title: "Przygotuj stanowisko",
      kind: "work",
      required: true,
      assigneeRole: "it",
      assigneePrincipalId: "it-one",
      dueDate: "2020-01-01",
    });
    const tasks = (await get("/api/tasks", "it-one")).json<{
      tasks: TaskProjection[];
    }>().tasks;
    assert.equal(tasks.length, 1);
    return tasks[0]!;
  };
  return {
    accounts,
    get,
    post,
    stage,
    execute,
    setup,
    current,
    get engine() {
      return engine;
    },
    get workspace() {
      return workspace;
    },
    get transferExecutions() {
      return transferExecutions;
    },
    loseTransfer() {
      loseTransferResponse = true;
    },
    async restart() {
      await app.close();
      engine.close();
      workspace.close();
      boot();
    },
    async close() {
      await app.close();
      engine.close();
      workspace.close();
      accounts.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const input = (task: TaskProjection, fields: JsonObject = {}) => ({
  id: task.caseId,
  expectedVersion: task.caseVersion,
  taskId: task.id,
  expectedTaskVersion: task.version,
  humanConfirmed: true,
  ...fields,
});

// Real account sessions, Core approval and separate durable domain storage are exercised together.
test("IT receives only its task, performs the work under its own identity, and cannot forge another author", async () => {
  const f = fixture();
  try {
    let task = await f.setup();
    assert.equal(task.status, "offered");
    assert.equal(task.overdue, true);
    const projection = await f.get("/api/tasks", "it-one");
    assert.doesNotMatch(
      projection.body,
      /PRIVATE_HR|HR_CASE_PRIVATE_TITLE|acceptanceCriteria|personId/,
    );
    assert.deepEqual((await f.get("/api/tasks", "it-two")).json().tasks, []);
    assert.deepEqual(
      (await f.get("/api/tasks", "it-one", "b")).json().tasks,
      [],
    );
    assert.equal(
      (await f.get(`/api/workspace/cases/${task.caseId}`, "it-one")).statusCode,
      403,
    );
    assert.equal(
      (await f.get(`/api/cases/${task.caseId}/readiness`, "it-one")).statusCode,
      403,
    );
    assert.equal(
      (await f.get("/api/company/assignees", "it-one")).statusCode,
      403,
    );
    assert.equal(
      (await f.get("/api/company/assignees", "case-manager")).statusCode,
      403,
    );
    const owners = await f.get(
      `/api/cases/${task.caseId}/owners`,
      "case-manager",
    );
    assert.equal(owners.statusCode, 200, owners.body);
    assert.deepEqual(
      owners
        .json()
        .assignees.map((owner: { id: string }) => owner.id)
        .sort(),
      ["case-manager", "manager"],
    );
    assert.equal(
      (await f.get(`/api/cases/${task.caseId}/owners`, "it-one")).statusCode,
      403,
    );
    assert.equal(
      (await f.get(`/api/cases/${task.caseId}/owners`, "reviewer")).statusCode,
      403,
    );
    assert.equal(
      (await f.get(`/api/cases/${task.caseId}/owners`, "case-manager", "b"))
        .statusCode,
      404,
    );
    const assignment = await f.get(
      `/api/task-assignees?taskId=${task.id}`,
      "it-one",
    );
    assert.equal(assignment.statusCode, 200, assignment.body);
    assert.ok(
      assignment
        .json()
        .assignees.some((p: { id: string }) => p.id === "it-two"),
    );
    assert.equal(
      (await f.get(`/api/task-assignees?taskId=${task.id}`, "it-one", "b"))
        .statusCode,
      404,
    );
    const forged = await f.post(
      "/api/commands",
      {
        toolId: "ops.cases.completeTask",
        input: input(task, { evidenceNote: "test", performedBy: "manager" }),
        idempotencyKey: randomUUID(),
      },
      "it-one",
    );
    assert.equal(forged.statusCode, 400);
    const accepted = await f.execute(
      "ops.cases.acceptTask",
      input(task),
      "it-one",
    );
    assert.equal(
      (await f.get(`/api/runs/${accepted.id}`, "it-two")).statusCode,
      403,
      "another operator with the same IT scope cannot read this task run",
    );
    assert.equal(
      (await f.get(`/api/runs/${accepted.id}`, "observer")).statusCode,
      403,
    );
    assert.doesNotMatch(
      JSON.stringify(accepted),
      /PRIVATE_HR|HR_CASE_PRIVATE_TITLE/,
    );
    task = (await f.get("/api/tasks", "it-one")).json().tasks[0];
    assert.equal(task.status, "accepted");
    const completed = await f.execute(
      "ops.cases.completeTask",
      input(task, { evidenceNote: "Stanowisko sprawdzone" }),
      "it-one",
    );
    assert.doesNotMatch(
      JSON.stringify(completed),
      /PRIVATE_HR|HR_CASE_PRIVATE_TITLE/,
    );
    task = (await f.get("/api/tasks", "it-one")).json().tasks[0];
    assert.equal(task.status, "completed");
    assert.equal(task.performedBy, "it-one");
    assert.equal(task.approvedBy, "reviewer");
    assert.equal(
      task.events.filter((e) => e.action === "completeTask").length,
      1,
    );
    await f.restart();
    const restored = (await f.get("/api/tasks", "it-one")).json().tasks[0];
    assert.deepEqual(restored.events, task.events);
    assert.equal(restored.performedBy, "it-one");
  } finally {
    await f.close();
  }
});

test("committed task transfer is reconciled after lost response and restart without transferring twice", async () => {
  const f = fixture();
  try {
    let task = await f.setup();
    await f.execute("ops.cases.acceptTask", input(task), "it-one");
    task = (await f.get("/api/tasks", "it-one")).json().tasks[0];
    const runId = await f.stage(
      "ops.cases.transferTask",
      input(task, {
        assigneePrincipalId: "it-two",
        reason: "Przekazanie dyżuru",
      }),
      "it-one",
    );
    f.loseTransfer();
    assert.equal(
      (await f.get(`/api/runs/${runId}`, "it-two")).statusCode,
      403,
      "the proposed recipient is not assigned before the transfer executes",
    );
    await f.engine.tick();
    assert.equal(f.current(runId, "it-one").status, "needs_reconciliation");
    const after = (await f.get("/api/tasks", "it-two")).json().tasks[0];
    assert.equal(after.status, "offered");
    assert.equal(after.assigneePrincipalId, "it-two");
    await f.restart();
    assert.equal(
      (await f.post(`/api/runs/${runId}/retry`, {}, "it-one")).statusCode,
      200,
    );
    for (let i = 0; i < 3; i++) await f.engine.tick();
    assert.equal(f.current(runId, "it-one").status, "completed");
    assert.equal(f.transferExecutions, 1);
    const restored = (await f.get("/api/tasks", "it-two")).json().tasks[0];
    assert.deepEqual(restored.events, after.events);
    const nextRun = await f.stage(
      "ops.cases.acceptTask",
      input(restored),
      "it-two",
    );
    assert.equal(
      (await f.get(`/api/runs/${nextRun}`, "it-one")).statusCode,
      403,
      "a former assignee cannot read later runs after the transfer",
    );
    assert.equal(
      restored.events.filter(
        (e: { action: string }) => e.action === "transferTask",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("revoking an account after Core approval blocks the pending task action and its old session", async () => {
  const f = fixture();
  try {
    const task = await f.setup();
    const runId = await f.stage("ops.cases.acceptTask", input(task), "it-one");
    f.accounts.revoke("a", "it-one");
    // Mirrors the server worker's live principal refresh, independently of an HTTP request.
    f.engine.setPrincipals(f.accounts.principals());
    await f.engine.tick();
    assert.equal((await f.get("/api/tasks", "it-one")).statusCode, 401);
    const managed = (await f.get("/api/tasks"))
      .json()
      .tasks.find((t: TaskProjection) => t.id === task.id);
    assert.equal(managed.status, "offered");
    assert.equal(managed.events.length, 1);
    assert.notEqual(f.current(runId).status, "completed");
  } finally {
    await f.close();
  }
});

test("a task manager's cancellation plan is not readable by a same-tenant viewer without task access", async () => {
  const f = fixture();
  try {
    const task = await f.setup();
    const runId = await f.stage(
      "ops.cases.cancelTask",
      input(task, { reason: "MANAGER_PRIVATE_CANCELLATION" }),
    );
    const response = await f.get(`/api/runs/${runId}`, "observer");
    assert.equal(response.statusCode, 403);
    assert.doesNotMatch(response.body, /MANAGER_PRIVATE_CANCELLATION/);
    const listed = await f.get("/api/runs", "observer");
    assert.equal(listed.statusCode, 200);
    assert.doesNotMatch(listed.body, /MANAGER_PRIVATE_CANCELLATION/);
    assert.ok(
      !listed.json().runs.some((run: { id: string }) => run.id === runId),
    );
  } finally {
    await f.close();
  }
});
