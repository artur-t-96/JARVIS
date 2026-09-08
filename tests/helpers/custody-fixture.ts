import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import type {
  JsonObject,
  Principal,
  ToolDefinition,
} from "../../src/contracts.js";
import { Engine, type RunDetail } from "../../src/engine.js";
import { InitiativeStore } from "../../src/initiative.js";
import { WorkspaceStore } from "../../src/workspace.js";

export const custodyNow = Date.parse("2026-09-08T10:00:00.000Z");
export function custodyFixture(
  directory: string,
  options: {
    wrap?: (tool: ToolDefinition) => ToolDefinition;
    clock?: () => number;
    domainClock?: () => number;
  } = {},
) {
  const principals: Principal[] = ["synthetic-a", "synthetic-b"].flatMap(
    (tenantId) => [
      { id: "manager", tenantId, roles: ["operator"], scopes: ["*"] },
      { id: "reviewer", tenantId, roles: ["approver"], scopes: ["*"] },
      { id: "it-one", tenantId, roles: ["operator"], scopes: ["it"] },
      { id: "it-two", tenantId, roles: ["operator"], scopes: ["it"] },
      { id: "observer", tenantId, roles: ["viewer"], scopes: [] },
    ],
  );
  const workspace = new WorkspaceStore(join(directory, "operations.sqlite"), {
    clock: options.domainClock ?? (() => custodyNow),
  });
  workspace.setPrincipalProvider((tenant) =>
    principals.filter((p) => p.tenantId === tenant),
  );
  const initiatives = new InitiativeStore(
    join(directory, "initiatives.sqlite"),
    workspace,
    { clock: options.domainClock ?? (() => custodyNow) },
  );
  workspace.setProfileProvider((tenant) =>
    initiatives.profileForTenant(tenant),
  );
  const tools = [...workspace.tools(), ...initiatives.tools()].map(
    (tool) => options.wrap?.(tool) ?? tool,
  );
  const config: AppConfig = {
    mode: "authenticated",
    host: "127.0.0.1",
    port: 4330,
    dataDir: directory,
    plannerKind: "demo",
    principals,
    tokens: new Map(
      principals.map((p) => [
        `synthetic-custody-${p.tenantId}-${p.id}-aaaaaaaaaaaaaaaa`,
        p,
      ]),
    ),
    policies: ["synthetic-a", "synthetic-b"].map((tenantId) => ({
      tenantId,
      name: "Synthetic custody proof",
      version: "1",
      allowedTools: tools.map((t) => t.id),
      approvalTools: [],
      allowSelfApproval: false,
    })),
  };
  const engine = new Engine({
    dbPath: join(directory, "core.sqlite"),
    tools,
    principals,
    policies: config.policies,
    leaseMs: 500,
    clock: options.clock ?? (() => custodyNow),
  });
  const actor = (id = "manager", tenantId = "synthetic-a") => {
    const result = principals.find(
      (p) => p.id === id && p.tenantId === tenantId,
    );
    assert.ok(result);
    return result;
  };
  const stage = async (
    toolId: string,
    input: JsonObject,
    id = "manager",
    tenantId = "synthetic-a",
  ) => {
    const p = actor(id, tenantId);
    const run = engine.createRun(
      p,
      "Synthetic custody test only",
      {
        title: "Synthetic custody operation",
        summary: "Test fixture; no real handover",
        steps: [{ id: "action", title: "Synthetic operation", toolId, input }],
      },
      randomUUID(),
    );
    engine.start(p, run.id);
    await engine.tick();
    const current = engine.getRun(p, run.id);
    assert.equal(current.status, "waiting_approval", JSON.stringify(current));
    return current;
  };
  const approve = (run: RunDetail, tenantId = "synthetic-a") => {
    const approval = run.steps[0]!.approval!;
    engine.approve(actor("reviewer", tenantId), run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
  };
  const complete = async (
    toolId: string,
    input: JsonObject,
    id = "manager",
    tenantId = "synthetic-a",
  ) => {
    const staged = await stage(toolId, input, id, tenantId);
    approve(staged, tenantId);
    for (let i = 0; i < 5; i++) await engine.tick();
    const run = engine.getRun(actor(id, tenantId), staged.id);
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(run.steps[0]!.verification?.ok, true);
    return run;
  };
  const get = (module: string, id: string, tenant = "synthetic-a") =>
    workspace.get(actor("manager", tenant), module, id);
  const seed = async (tenant = "synthetic-a") => {
    const manager = actor("manager", tenant),
      profile = initiatives.profile(manager);
    await complete(
      "initiatives.configure",
      {
        companyName: `Synthetic custody ${tenant}`,
        timezone: "Europe/Warsaw",
        licenseReminderDays: profile.licenseReminderDays,
        quietHours: profile.quietHours,
        rules: profile.rules,
        roleBindings: { hr: "manager", it: "it-one", manager: "manager" },
        processTemplates: profile.processTemplates,
        employmentPolicy: profile.employmentPolicy,
        expectedVersion: profile.version,
      } as unknown as JsonObject,
      "manager",
      tenant,
    );
    const created = await complete(
      "ops.people.create",
      {
        title: "SYNTHETIC CUSTODY RECIPIENT",
        data: {
          personCategory: "internal",
          department: "PRIVATE_HR_CUSTODY_SENTINEL",
        },
      },
      "manager",
      tenant,
    );
    const personId = String(created.steps[0]!.output!.data.entityId);
    const person = get("people", personId, tenant);
    await complete(
      "ops.people.startEmployment",
      {
        id: personId,
        expectedVersion: person.version,
        employmentKind: "internal",
        startDate: "2026-09-08",
        role: "PRIVATE_HR_ROLE_SENTINEL",
        humanDecision: true,
      },
      "manager",
      tenant,
    );
    const episode = workspace.listEmploymentEpisodes(manager, personId)[0]!;
    const caseId = episode.onboardingCaseId!;
    const task = (get("cases", caseId, tenant).data.tasks as JsonObject[]).find(
      (t) =>
        Array.isArray(t.requirementKeys) &&
        t.requirementKeys.includes("equipment"),
    );
    assert.ok(task, "fixture selects the explicit equipment task");
    await complete(
      "ops.cases.acceptTask",
      {
        id: caseId,
        expectedVersion: get("cases", caseId, tenant).version,
        taskId: task.id,
        expectedTaskVersion: task.version,
        humanConfirmed: true,
      },
      "it-one",
      tenant,
    );
    const newAsset = await complete(
      "ops.assets.create",
      {
        title: "SYNTHETIC CUSTODY LAPTOP",
        data: {
          assetType: "laptop",
          serial: `CUSTODY-${tenant}`,
          location: "Synthetic stock",
          condition: "good",
        },
      },
      "manager",
      tenant,
    );
    const assetId = String(newAsset.steps[0]!.output!.data.entityId);
    await complete(
      "ops.assets.reserve",
      {
        id: assetId,
        expectedVersion: get("assets", assetId, tenant).version,
        personId,
        employmentEpisodeId: episode.id,
        expectedEpisodeVersion: episode.version,
        caseId,
        purpose: "Synthetic custody fixture only",
        until: "2026-09-12",
      },
      "manager",
      tenant,
    );
    return {
      personId,
      episodeId: episode.id,
      caseId,
      taskId: String(task.id),
      assetId,
    };
  };
  return {
    directory,
    principals,
    workspace,
    initiatives,
    engine,
    tools,
    config,
    actor,
    stage,
    approve,
    complete,
    get,
    seed,
    close() {
      engine.close();
      initiatives.close();
      workspace.close();
    },
  };
}
export type CustodyFixture = ReturnType<typeof custodyFixture>;
