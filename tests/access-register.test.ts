import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";
import {
  seedAccess,
  accessInput,
  accessBindInput,
  reviseAccess,
} from "./helpers/access-fixture.js";
import { WorkspaceStore } from "../src/workspace.js";
import type { JsonObject, ToolContext } from "../src/contracts.js";
import { baselineProcessTemplates } from "../src/workspace-models.js";

function setup(
  t: TestContext,
  options: Parameters<typeof custodyFixture>[1] = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-access-"));
  const f = custodyFixture(directory, options);
  t.after(() => {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}
const rejected = async (
  f: ReturnType<typeof setup>,
  tool: string,
  input: JsonObject,
) => {
  const r = await f.stage(tool, input);
  f.approve(r);
  await f.engine.tick();
  assert.notEqual(f.engine.getRun(f.actor(), r.id).status, "completed");
};
test("a complete witnessed bundle binds independently; partial records and comments never satisfy access", async (t) => {
  const f = setup(t),
    s = await seedAccess(f);
  await rejected(f, "ops.cases.bindEvidence", accessBindInput(f, s));
  await f.complete("ops.cases.attestAccess", accessInput(f, s));
  assert.equal(
    f.workspace.caseAccess(f.actor(), s.caseId).requirements[0]!.assessment!
      .identity.current,
    false,
  );
  await rejected(f, "ops.cases.bindEvidence", accessBindInput(f, s));
  await f.complete("ops.cases.attestAccess", accessInput(f, s, 1));
  await f.complete("ops.cases.bindEvidence", accessBindInput(f, s));
  const result = f.workspace.readiness(f.actor(), s.caseId);
  assert.equal(
    result.requirements.find((r) => r.kind === "access_attested")!.status,
    "satisfied",
  );
  assert.equal(
    result.ready,
    false,
    "equipment and document remain separate obligations",
  );
  const grants = f.workspace.caseAccess(f.actor(), s.caseId).grants;
  assert.equal(grants.length, 2);
  assert.ok(
    grants.every(
      (g) =>
        g.performedBy === "manager" &&
        g.approvedBy === "reviewer" &&
        g.events.length === 1,
    ),
  );
  const restarted = new WorkspaceStore(join(f.directory, "operations.sqlite"), {
    clock: () => custodyNow,
  });
  try {
    assert.deepEqual(restarted.caseAccess(f.actor(), s.caseId).grants, grants);
  } finally {
    restarted.close();
  }
  assert.throws(() => f.workspace.caseAccess(f.actor("it-one"), s.caseId));
  assert.throws(() =>
    f.workspace.caseAccess(f.actor("manager", "synthetic-b"), s.caseId),
  );
});
test("license facts are checked for the same person and episode and revocation invalidates the binding", async (t) => {
  const f = setup(t),
    s = await seedAccess(f, "synthetic-a", true);
  const missing = { ...accessInput(f, s) };
  delete missing.licenseSeatId;
  await rejected(f, "ops.cases.attestAccess", missing);
  await f.complete("ops.cases.attestAccess", accessInput(f, s));
  await f.complete("ops.cases.attestAccess", accessInput(f, s, 1));
  await f.complete("ops.cases.bindEvidence", accessBindInput(f, s));
  await f.complete("ops.licenses.revoke", {
    id: s.licenseId!,
    expectedVersion: f.get("licenses", s.licenseId!).version,
    personId: s.personId,
    employmentEpisodeId: s.episodeId,
    expectedEpisodeVersion: 1,
    reason: "Synthetic seat revocation",
  });
  assert.notEqual(
    f.workspace
      .readiness(f.actor(), s.caseId)
      .requirements.find((r) => r.kind === "access_attested")!.status,
    "satisfied",
  );
});
test("explicit renewal recovers expiry and scope revision without rewriting old witnesses", async (t) => {
  let now = custodyNow;
  const f = setup(t, { domainClock: () => now }),
    s = await seedAccess(f);
  await f.complete("ops.cases.attestAccess", accessInput(f, s));
  await f.complete("ops.cases.attestAccess", accessInput(f, s, 1));
  await f.complete("ops.cases.bindEvidence", accessBindInput(f, s));
  const original = f.workspace.caseAccess(f.actor(), s.caseId).grants;
  now = Date.parse("2026-09-15T10:00:00Z");
  assert.notEqual(
    f.workspace
      .readiness(f.actor(), s.caseId)
      .requirements.find((r) => r.kind === "access_attested")!.status,
    "satisfied",
  );
  await reviseAccess(f, s.caseId, s.bundleId);
  for (let i = 0; i < 2; i++)
    await f.complete("ops.cases.renewAccess", {
      ...accessInput(f, s, i),
      grantId: original[i]!.id,
      expectedGrantVersion: 1,
      observedOn: "2026-09-15",
      validUntil: "2026-09-21",
    });
  await f.complete("ops.cases.bindEvidence", accessBindInput(f, s));
  const renewed = f.workspace.caseAccess(f.actor(), s.caseId).grants;
  assert.ok(
    renewed.every((g) => g.version === 2 && g.events[1]!.kind === "renew"),
  );
  assert.deepEqual(
    renewed.map((g) => g.events[0]),
    original.map((g) => g.events[0]),
  );
  assert.equal(
    f.workspace
      .readiness(f.actor(), s.caseId)
      .requirements.find((r) => r.kind === "access_attested")!.status,
    "satisfied",
  );
  await f.complete("ops.cases.revokeAccess", {
    id: s.caseId,
    expectedVersion: f.get("cases", s.caseId).version,
    grantId: renewed[0]!.id,
    expectedGrantVersion: 2,
    revokedOn: "2026-09-15",
    note: "Synthetic removal",
    verificationMethod: "Synthetic role absence checked",
    humanConfirmed: true,
  });
  assert.equal(
    f.workspace.caseAccess(f.actor(), s.caseId).grants[0]!.events[2]!.kind,
    "revoke",
  );
  assert.notEqual(
    f.workspace
      .readiness(f.actor(), s.caseId)
      .requirements.find((r) => r.kind === "access_attested")!.status,
    "satisfied",
  );
});
test("changed source versions, roles and foreign identity block writes; old cases gain no fabricated configuration", async (t) => {
  const f = setup(t),
    s = await seedAccess(f);
  await rejected(f, "ops.cases.attestAccess", {
    ...accessInput(f, s),
    personId: s.apps[0]!,
  });
  await rejected(f, "ops.cases.attestAccess", {
    ...accessInput(f, s),
    observedOn: "2026-09-09",
  });
  await rejected(f, "ops.cases.attestAccess", {
    ...accessInput(f, s),
    validUntil: "2026-10-01",
  });
  const staged = await f.stage("ops.cases.attestAccess", accessInput(f, s));
  f.approve(staged);
  // A different approved transaction changes the exact application definition.
  const tool = f.tools.find((t) => t.id === "ops.it.reviseApplication")!;
  await tool.execute(
    {
      tenantId: "synthetic-a",
      actorId: "manager",
      approvedBy: "reviewer",
      runId: "change-app",
      stepId: "action",
      operationKey: "change-app",
      signal: new AbortController().signal,
    },
    {
      id: s.apps[0]!,
      expectedVersion: 1,
      supportedRoles: ["reader"],
      description: "Synthetic changed role",
    },
  );
  await f.engine.tick();
  assert.equal(f.workspace.caseAccess(f.actor(), s.caseId).grants.length, 0);
  const legacy = await f.seed("synthetic-b");
  assert.match(
    f.workspace.caseAccess(f.actor("manager", "synthetic-b"), legacy.caseId)
      .requirements[0]!.problem!,
    /nie ma zatwierdzonej wersji/,
  );
});
test("a revoked operator cannot execute or reconcile an access effect and a changed grant cannot reuse binding approval", async (t) => {
  const f = setup(t),
    s = await seedAccess(f);
  const staged = await f.stage("ops.cases.attestAccess", accessInput(f, s));
  f.approve(staged);
  f.actor().roles = [];
  await f.engine.tick();
  assert.equal(
    f.workspace.caseAccess(f.actor("reviewer"), s.caseId).grants.length,
    0,
  );
  f.actor().roles = ["operator"];
  const done = await f.complete("ops.cases.attestAccess", accessInput(f, s));
  const tool = f.tools.find((t) => t.id === "ops.cases.attestAccess")!;
  const step = done.steps[0]!;
  const ctx: ToolContext = {
    tenantId: "synthetic-a",
    actorId: "manager",
    approvedBy: "reviewer",
    runId: done.id,
    stepId: step.id,
    operationKey: step.operationKey!,
    signal: new AbortController().signal,
  };
  f.actor().scopes = ["cases", "people"];
  await assert.rejects(() => tool.reconcile!(ctx, step.input));
  f.actor().scopes = ["*"];
  await f.complete("ops.cases.attestAccess", accessInput(f, s, 1));
  const binding = f.tools.find((t) => t.id === "ops.cases.bindEvidence")!;
  const pinned = binding.prepareInput!(accessBindInput(f, s), "synthetic-a");
  const g = f.workspace.caseAccess(f.actor(), s.caseId).grants[0]!;
  await f.complete("ops.cases.renewAccess", {
    ...accessInput(f, s),
    grantId: g.id,
    expectedGrantVersion: g.version,
  });
  // Pin the new case version to isolate the independent source-hash check.
  await rejected(f, "ops.cases.bindEvidence", {
    ...pinned,
    expectedVersion: f.get("cases", s.caseId).version,
  });
});
test("event corruption and tampered relational licence seats fail independent evidence reads", async (t) => {
  const f = setup(t),
    s = await seedAccess(f, "synthetic-a", true);
  await f.complete("ops.cases.attestAccess", accessInput(f, s));
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  t.after(() => db.close());
  const event = db.prepare("SELECT * FROM ops_access_events").get()!;
  db.prepare("UPDATE ops_access_events SET event_hash='invalid'").run();
  assert.throws(() => f.workspace.caseAccess(f.actor(), s.caseId), /Zdarzenie/);
  db.prepare("UPDATE ops_access_events SET event_hash=?").run(
    event.event_hash!,
  );
  db.prepare("UPDATE ops_license_seats SET status='revoked' WHERE id=?").run(
    s.licenseSeatId!,
  );
  assert.match(
    f.workspace.caseAccess(f.actor(), s.caseId).requirements[0]!.problem!,
    /licencji/,
  );
});
test("command transaction rollback removes grant, event and case version together", async (t) => {
  const f = setup(t),
    s = await seedAccess(f);
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER access_fail_ledger BEFORE INSERT ON ops_commands WHEN NEW.tool_id='ops.cases.attestAccess' BEGIN SELECT RAISE(ABORT,'synthetic interrupted ledger'); END",
  );
  const version = f.get("cases", s.caseId).version;
  await rejected(f, "ops.cases.attestAccess", accessInput(f, s));
  assert.equal(f.get("cases", s.caseId).version, version);
  assert.equal(
    db.prepare("SELECT count(*) n FROM ops_access_grants").get()!.n,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM ops_access_events").get()!.n,
    0,
  );
});
test("two firms and parallel projects keep grants separate; a shared account cannot silently serve a second period", async (t) => {
  const f = setup(t),
    a = await seedAccess(f),
    b = await seedAccess(f, "synthetic-b");
  for (const s of [a, b]) {
    for (let i = 0; i < 2; i++)
      await f.complete(
        "ops.cases.attestAccess",
        accessInput(f, s, i),
        "manager",
        s.tenant,
      );
    await f.complete(
      "ops.cases.bindEvidence",
      accessBindInput(f, s),
      "manager",
      s.tenant,
    );
  }
  const aBefore = f.workspace.caseAccess(f.actor(), a.caseId);
  const tenant = b.tenant,
    actor = f.actor("manager", tenant),
    p = f.initiatives.profile(actor);
  const complete = (tool: string, input: JsonObject) =>
    f.complete(tool, input, "manager", tenant);
  await complete("initiatives.configure", {
    companyName: "Synthetic project access",
    timezone: "America/New_York",
    licenseReminderDays: p.licenseReminderDays,
    quietHours: p.quietHours,
    rules: p.rules,
    roleBindings: { hr: "manager", it: "it-one", manager: "manager" },
    processTemplates: baselineProcessTemplates("contractor"),
    employmentPolicy: {
      mode: "parallel_projects",
      maxConcurrent: 2,
      allowInternalOverlap: false,
    },
    expectedVersion: p.version,
  } as unknown as JsonObject);
  const person = await complete("ops.people.create", {
      title: "Synthetic consultant",
      data: { personCategory: "contractor" },
    }),
    personId = String(person.steps[0]!.output!.data.entityId);
  const projects: (typeof b)[] = [];
  for (const title of ["Project Alpha", "Project Beta"]) {
    const project = await complete("ops.cases.create", {
        title,
        data: {
          caseType: "delivery",
          brief: "Synthetic project",
          acceptanceCriteria: "Synthetic acceptance",
        },
      }),
      engagementId = String(project.steps[0]!.output!.data.entityId);
    await complete("ops.people.startEmployment", {
      id: personId,
      expectedVersion: f.get("people", personId, tenant).version,
      employmentKind: "contractor",
      startDate: "2026-09-08",
      role: title,
      engagementRef: { module: "cases", id: engagementId },
      humanDecision: true,
    });
    const episode = f.workspace
      .listEmploymentEpisodes(actor, personId)
      .find((e) => e.engagementRef?.id === engagementId)!;
    await reviseAccess(f, episode.onboardingCaseId!, b.bundleId, tenant);
    projects.push({
      ...b,
      personId,
      episodeId: episode.id,
      caseId: episode.onboardingCaseId!,
    });
  }
  const alpha = projects[0]!,
    beta = projects[1]!;
  await complete("ops.cases.attestAccess", {
    ...accessInput(f, alpha),
    accountRef: "synthetic-shared-account",
  });
  const staged = await f.stage(
    "ops.cases.attestAccess",
    { ...accessInput(f, beta), accountRef: "synthetic-shared-account" },
    "manager",
    tenant,
  );
  f.approve(staged, tenant);
  await f.engine.tick();
  assert.equal(f.workspace.caseAccess(actor, beta.caseId).grants.length, 0);
  await complete("ops.cases.attestAccess", accessInput(f, beta));
  const betaBefore = f.workspace.caseAccess(actor, beta.caseId),
    grant = f.workspace.caseAccess(actor, alpha.caseId).grants[0]!;
  assert.equal(grant.expiresAt, "2026-09-15T04:00:00.000Z");
  await complete("ops.cases.revokeAccess", {
    id: alpha.caseId,
    expectedVersion: f.get("cases", alpha.caseId, tenant).version,
    grantId: grant.id,
    expectedGrantVersion: grant.version,
    revokedOn: "2026-09-08",
    verificationMethod: "Synthetic project Alpha absence check",
    note: "Alpha only",
    humanConfirmed: true,
  });
  assert.deepEqual(f.workspace.caseAccess(actor, beta.caseId), betaBefore);
  assert.deepEqual(f.workspace.caseAccess(f.actor(), a.caseId), aBefore);
});
test("two approved requests for one role cannot both create active records", async (t) => {
  const f = setup(t),
    s = await seedAccess(f),
    input = accessInput(f, s);
  const a = await f.stage("ops.cases.attestAccess", input),
    b = await f.stage("ops.cases.attestAccess", input);
  f.approve(a);
  f.approve(b);
  for (let i = 0; i < 6; i++) await f.engine.tick();
  assert.equal(
    [a, b].filter(
      (r) => f.engine.getRun(f.actor(), r.id).status === "completed",
    ).length,
    1,
  );
  assert.equal(f.workspace.caseAccess(f.actor(), s.caseId).grants.length, 1);
});
