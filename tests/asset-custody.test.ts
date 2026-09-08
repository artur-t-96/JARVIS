import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { reservationExpiresAt } from "../src/asset-custody.js";
import type { JsonObject } from "../src/contracts.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";

function fixture(t: TestContext, clock = () => custodyNow) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-custody-domain-")),
    h = custodyFixture(directory, { domainClock: clock });
  t.after(() => {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return h;
}
const facts = {
  issuedOn: "2026-09-08",
  location: "Synthetic recipient desk",
  condition: "good",
  handoverNote: "Synthetic physical attestation only",
  humanConfirmed: true,
};

test("reservation end is exclusive local midnight across spring/fall DST and omitted calendar days", () => {
  assert.equal(
    reservationExpiresAt("2026-03-29", "Europe/Warsaw"),
    "2026-03-29T22:00:00.000Z",
  );
  assert.equal(
    reservationExpiresAt("2026-10-25", "Europe/Warsaw"),
    "2026-10-25T23:00:00.000Z",
  );
  assert.equal(
    Date.parse(reservationExpiresAt("2026-03-29", "Europe/Warsaw")) -
      Date.parse(reservationExpiresAt("2026-03-28", "Europe/Warsaw")),
    23 * 3_600_000,
  );
  assert.equal(
    Date.parse(reservationExpiresAt("2026-10-25", "Europe/Warsaw")) -
      Date.parse(reservationExpiresAt("2026-10-24", "Europe/Warsaw")),
    25 * 3_600_000,
  );
  assert.equal(
    reservationExpiresAt("2026-09-08", "UTC"),
    "2026-09-09T00:00:00.000Z",
  );
  assert.throws(() => reservationExpiresAt("2011-12-30", "Pacific/Apia"));
  assert.throws(() => reservationExpiresAt("2026-02-30", "UTC"));
});

test("a write failure after the custody event rolls back allocation, task, snapshots and outbox together", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    input = {
      ...h.workspace.taskEquipment(h.actor("it-one"), seed.taskId)
        .allocations[0]!.commandBindings.issueForTask!,
      ...facts,
    };
  const db = new DatabaseSync(join(h.directory, "operations.sqlite"));
  t.after(() => db.close());
  const before = h.get("assets", seed.assetId),
    taskBefore = h.workspace
      .listTasks(h.actor("it-one"))
      .find((t) => t.id === seed.taskId)!;
  const counts = () =>
    [
      "ops_asset_events",
      "ops_task_events",
      "ops_commands",
      "ops_outbox",
      "ops_entity_versions",
    ].map((table) =>
      Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n),
    );
  const prior = counts();
  db.exec(
    "CREATE TRIGGER synthetic_fail_issue AFTER INSERT ON ops_asset_events WHEN NEW.kind='issue' BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END",
  );
  const tool = h.tools.find((t) => t.id === "ops.assets.issueForTask")!,
    ctx = {
      tenantId: "synthetic-a",
      actorId: "it-one",
      approvedBy: "reviewer",
      runId: randomUUID(),
      stepId: "proof",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    };
  await assert.rejects(tool.execute(ctx, input), /synthetic event failure/);
  assert.deepEqual(counts(), prior);
  assert.deepEqual(h.get("assets", seed.assetId), before);
  assert.equal(
    h.workspace.listTasks(h.actor("it-one")).find((t) => t.id === seed.taskId)!
      .version,
    taskBefore.version,
  );
  assert.equal((await tool.reconcile!(ctx, input)).status, "not_applied");
  db.exec("DROP TRIGGER synthetic_fail_issue");
  await h.complete("ops.assets.issueForTask", input, "it-one");
  assert.equal(h.get("assets", seed.assetId).status, "issued");
});

test("approved company version changes block an already prepared IT handover without repinning", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    input = {
      ...h.workspace.taskEquipment(h.actor("it-one"), seed.taskId)
        .allocations[0]!.commandBindings.issueForTask!,
      ...facts,
    };
  assert.equal(input.profileVersion, 1);
  const staged = await h.stage("ops.assets.issueForTask", input, "it-one"),
    p = h.initiatives.profile(h.actor());
  await h.complete("initiatives.configure", {
    companyName: p.companyName,
    timezone: "UTC",
    licenseReminderDays: p.licenseReminderDays,
    quietHours: p.quietHours,
    rules: p.rules,
    roleBindings: p.roleBindings,
    processTemplates: p.processTemplates,
    employmentPolicy: p.employmentPolicy,
    expectedVersion: p.version,
  } as unknown as JsonObject);
  h.approve(staged);
  for (let i = 0; i < 5; i++) await h.engine.tick();
  const run = h.engine.getRun(h.actor("it-one"), staged.id);
  assert.equal(run.status, "needs_reconciliation");
  assert.equal(h.get("assets", seed.assetId).status, "reserved");
  assert.equal(run.plan.steps[0]!.input.profileVersion, 1);
});

test("expired reservation stays occupied until approved expiry; stale release cannot mutate the freed asset", async (t) => {
  let now = custodyNow;
  const h = fixture(t, () => now),
    seed = await h.seed();
  const asset = h.get("assets", seed.assetId),
    allocation = (asset.data.allocations as JsonObject[])[0]!;
  const input = {
    id: asset.id,
    expectedVersion: asset.version,
    allocationId: allocation.id!,
    expectedAllocationVersion: allocation.version!,
    reason: "Synthetic expired reservation review",
  };
  const early = await h.stage("ops.assets.expireReservation", input);
  h.approve(early);
  for (let i = 0; i < 5; i++) await h.engine.tick();
  assert.equal(
    h.engine.getRun(h.actor(), early.id).status,
    "needs_reconciliation",
  );
  h.engine.cancel(h.actor(), early.id);
  h.engine.retry(h.actor(), early.id);
  await h.engine.tick();
  assert.equal(h.engine.getRun(h.actor(), early.id).status, "cancelled");
  now = Date.parse(String(allocation.expiresAt));
  assert.equal(h.get("assets", asset.id).status, "reserved");
  const view = h.workspace.taskEquipment(h.actor("it-one"), seed.taskId);
  assert.equal(view.allocations[0]!.expired, true);
  assert.ok(!view.allocations[0]!.allowedActions.includes("issueForTask"));
  await h.complete("ops.assets.expireReservation", input);
  assert.equal(h.get("assets", asset.id).status, "available");
  const stale = await h.stage("ops.assets.release", input);
  h.approve(stale);
  for (let i = 0; i < 5; i++) await h.engine.tick();
  assert.equal(
    h.engine.getRun(h.actor(), stale.id).status,
    "needs_reconciliation",
  );
  const custody = h.workspace.assetCustody(h.actor(), asset.id);
  assert.equal(custody.totalEvents, 2);
  assert.equal(custody.events[0]!.kind, "expire");
});

test("narrow offboarding return keeps the original issue case and records authenticated receipt without completing access work", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    worker = h.actor("it-one");
  const issue = h.workspace.taskEquipment(worker, seed.taskId).allocations[0]!
    .commandBindings.issueForTask!;
  await h.complete("ops.assets.issueForTask", { ...issue, ...facts }, "it-one");
  let view = h.workspace.taskEquipment(worker, seed.taskId);
  await h.complete(
    "ops.assets.bindAssetForTask",
    view.allocations[0]!.commandBindings.bindAssetForTask!,
    "it-one",
  );
  const person = h.get("people", seed.personId),
    episode = h.workspace.listEmploymentEpisodes(h.actor(), seed.personId)[0]!;
  await h.complete("ops.people.beginOffboarding", {
    id: person.id,
    expectedVersion: person.version,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: episode.version,
    endDate: "2026-09-08",
    reason: "Synthetic bounded offboarding",
    humanDecision: true,
  });
  const ending = h.workspace.listEmploymentEpisodes(
      h.actor(),
      seed.personId,
    )[0]!,
    c = h.get("cases", ending.offboardingCaseId!);
  const task = (c.data.tasks as JsonObject[]).find(
    (t) => t.templateKey === "resources",
  )!;
  assert.ok(task);
  await h.complete(
    "ops.cases.acceptTask",
    {
      id: c.id,
      expectedVersion: c.version,
      taskId: task.id!,
      expectedTaskVersion: task.version!,
      humanConfirmed: true,
    },
    "it-one",
  );
  view = h.workspace.taskEquipment(worker, String(task.id));
  const input = view.allocations[0]!.commandBindings.returnForTask!;
  assert.equal(input.caseId, c.id);
  assert.equal(input.allocationCaseId, seed.caseId);
  await h.complete(
    "ops.assets.returnForTask",
    {
      ...input,
      returnedOn: "2026-09-08",
      location: "Synthetic returns room",
      condition: "repair",
      receiptNote: "Synthetic damaged return attestation",
      humanConfirmed: true,
    },
    "it-one",
  );
  const after = h.workspace.assetCustody(h.actor(), seed.assetId);
  assert.equal(after.allocations[0]!.status, "returned");
  assert.equal(after.allocations[0]!.caseId, seed.caseId);
  assert.equal(after.events[0]!.performedBy, "it-one");
  assert.equal(after.events[0]!.approvedBy, "reviewer");
  assert.equal(h.get("assets", seed.assetId).status, "maintenance");
  assert.equal(
    h.workspace.listTasks(worker).find((t) => t.id === task.id)!.status,
    "accepted",
  );
  assert.equal(h.workspace.readiness(h.actor(), c.id).ready, false);
});

test("contractor IT tasks isolate two simultaneous projects; returning A leaves B issued and its period unchanged", async (t) => {
  const h = fixture(t),
    tenant = "synthetic-b",
    manager = h.actor("manager", tenant),
    worker = h.actor("it-one", tenant);
  const p = h.initiatives.profile(manager),
    { baselineProcessTemplates } = await import("../src/workspace-models.js");
  const run = (toolId: string, input: JsonObject, id = "manager") =>
    h.complete(toolId, input, id, tenant);
  await run("initiatives.configure", {
    companyName: "Synthetic parallel projects",
    timezone: "Europe/Warsaw",
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
  const created = await run("ops.people.create", {
      title: "Synthetic consultant",
      data: { personCategory: "contractor" },
    }),
    personId = String(created.steps[0]!.output!.data.entityId);
  const projects = [];
  for (const label of ["Project Alpha", "Project Beta"]) {
    const project = await run("ops.cases.create", {
      title: label,
      data: {
        caseType: "delivery",
        brief: "Synthetic agreed scope",
        acceptanceCriteria: "Independent project acceptance",
      },
    });
    const current = h.get("people", personId, tenant);
    await run("ops.people.startEmployment", {
      id: personId,
      expectedVersion: current.version,
      employmentKind: "contractor",
      startDate: "2026-09-08",
      role: "Synthetic project role",
      engagementRef: {
        module: "cases",
        id: project.steps[0]!.output!.data.entityId!,
      },
      humanDecision: true,
    });
    const episode = h.workspace
      .listEmploymentEpisodes(manager, personId)
      .find(
        (e) => e.engagementRef?.id === project.steps[0]!.output!.data.entityId,
      )!;
    const c = h.get("cases", episode.onboardingCaseId!, tenant),
      task = (c.data.tasks as JsonObject[]).find(
        (t) => t.templateKey === "equipment",
      )!;
    await run(
      "ops.cases.acceptTask",
      {
        id: c.id,
        expectedVersion: c.version,
        taskId: task.id!,
        expectedTaskVersion: task.version!,
        humanConfirmed: true,
      },
      "it-one",
    );
    const a = await run("ops.assets.create", {
        title: `Synthetic ${label} laptop`,
        data: {
          assetType: "laptop",
          serial: randomUUID(),
          location: "Synthetic stock",
          condition: "good",
        },
      }),
      assetId = String(a.steps[0]!.output!.data.entityId);
    await run("ops.assets.reserve", {
      id: assetId,
      expectedVersion: 1,
      personId,
      employmentEpisodeId: episode.id,
      expectedEpisodeVersion: episode.version,
      caseId: c.id,
      purpose: label,
      until: "2026-09-12",
    });
    const view = h.workspace.taskEquipment(worker, String(task.id));
    assert.match(view.engagementLabel, new RegExp(label));
    assert.equal(view.allocations.length, 1);
    assert.equal(view.allocations[0]!.asset.id, assetId);
    await run(
      "ops.assets.issueForTask",
      { ...view.allocations[0]!.commandBindings.issueForTask!, ...facts },
      "it-one",
    );
    projects.push({
      episodeId: episode.id,
      caseId: c.id,
      taskId: String(task.id),
      assetId,
    });
  }
  const [a, b] = projects;
  assert.ok(a && b);
  const beforeB = h.get("assets", b.assetId, tenant),
    periodB = h.workspace
      .listEmploymentEpisodes(manager, personId)
      .find((e) => e.id === b.episodeId)!;
  const current = h.get("people", personId, tenant),
    periodA = h.workspace
      .listEmploymentEpisodes(manager, personId)
      .find((e) => e.id === a.episodeId)!;
  await run("ops.people.beginOffboarding", {
    id: personId,
    expectedVersion: current.version,
    employmentEpisodeId: periodA.id,
    expectedEpisodeVersion: periodA.version,
    endDate: "2026-09-08",
    reason: "Synthetic end of Alpha only",
    humanDecision: true,
  });
  const ending = h.workspace
      .listEmploymentEpisodes(manager, personId)
      .find((e) => e.id === a.episodeId)!,
    c = h.get("cases", ending.offboardingCaseId!, tenant),
    task = (c.data.tasks as JsonObject[]).find(
      (t) => t.templateKey === "resources",
    )!;
  await run(
    "ops.cases.acceptTask",
    {
      id: c.id,
      expectedVersion: c.version,
      taskId: task.id!,
      expectedTaskVersion: task.version!,
      humanConfirmed: true,
    },
    "it-one",
  );
  const view = h.workspace.taskEquipment(worker, String(task.id));
  assert.equal(view.allocations.length, 1);
  assert.equal(view.allocations[0]!.asset.id, a.assetId);
  await run(
    "ops.assets.returnForTask",
    {
      ...view.allocations[0]!.commandBindings.returnForTask!,
      returnedOn: "2026-09-08",
      location: "Synthetic Alpha returns",
      condition: "good",
      receiptNote: "Synthetic Alpha receipt only",
      humanConfirmed: true,
    },
    "it-one",
  );
  assert.deepEqual(h.get("assets", b.assetId, tenant), beforeB);
  assert.deepEqual(
    h.workspace
      .listEmploymentEpisodes(manager, personId)
      .find((e) => e.id === b.episodeId),
    periodB,
  );
  assert.equal(
    h.workspace.taskEquipment(worker, b.taskId).allocations[0]!.status,
    "issued",
  );
  assert.throws(() => h.workspace.taskEquipment(h.actor("it-one"), b.taskId));
});
