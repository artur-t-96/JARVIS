import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { JsonObject } from "../src/contracts.js";
import { WorkspaceStore } from "../src/workspace.js";
import { baselineProcessTemplates } from "../src/workspace-models.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";
import {
  replacementAsset,
  replacementInput,
} from "./helpers/replacement-fixture.js";

function fixture(t: TestContext, clock = () => custodyNow) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-replacement-"));
  const h = custodyFixture(directory, { domainClock: clock });
  t.after(() => {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return h;
}
const ctx = (tenantId = "synthetic-a") => ({
  tenantId,
  actorId: "manager",
  approvedBy: "reviewer",
  runId: randomUUID(),
  stepId: "replace",
  operationKey: randomUUID(),
  signal: new AbortController().signal,
});

test("replacement keeps original expiry and identities in two tenants; restart replays both histories without a second effect", async (t) => {
  const h = fixture(t);
  for (const tenant of ["synthetic-a", "synthetic-b"]) {
    const seed = await h.seed(tenant),
      target = await replacementAsset(h, tenant);
    const old = h.workspace.assetCustody(
      h.actor("manager", tenant),
      seed.assetId,
    ).allocations[0]!;
    const p = h.initiatives.profile(h.actor("manager", tenant));
    await h.complete(
      "initiatives.configure",
      {
        companyName: p.companyName,
        timezone: "America/New_York",
        licenseReminderDays: p.licenseReminderDays,
        quietHours: p.quietHours,
        rules: p.rules,
        roleBindings: p.roleBindings,
        processTemplates: p.processTemplates,
        employmentPolicy: p.employmentPolicy,
        expectedVersion: p.version,
      } as unknown as JsonObject,
      "manager",
      tenant,
    );
    const run = await h.complete(
      "ops.assets.replaceReservation",
      replacementInput(h, seed.assetId, target.id, tenant),
      "manager",
      tenant,
    );
    assert.equal(run.plan.steps[0]!.input.profileVersion, 2);
    assert.equal(run.plan.steps[0]!.input.reservationProfileVersion, 1);
    const after = h.workspace.assetCustody(
        h.actor("manager", tenant),
        target.id,
      ),
      reserved = after.allocations[0]!;
    for (const key of [
      "personId",
      "employmentEpisodeId",
      "caseId",
      "reservedUntil",
      "expiresAt",
      "timezone",
      "profileVersion",
    ] as const)
      assert.equal(reserved[key], old[key], key);
    assert.equal(h.get("assets", seed.assetId, tenant).status, "available");
    assert.equal(h.get("assets", target.id, tenant).status, "reserved");
    assert.equal(reserved.issueEventId, null);
    const proof = run.steps[0]!.output!.data.replacement as JsonObject;
    assert.equal(proof.releasedAllocationId, old.id);
    assert.equal(proof.reservedAllocationId, reserved.id);
    assert.equal(run.steps[0]!.output!.data.entityId, target.id);
    assert.equal(
      h.workspace.assetRegister(h.actor("manager", tenant), seed.assetId)
        .consistent,
      true,
    );
    assert.equal(
      h.workspace.assetRegister(h.actor("manager", tenant), target.id)
        .consistent,
      true,
    );
    assert.throws(() =>
      h.get(
        "assets",
        target.id,
        tenant === "synthetic-a" ? "synthetic-b" : "synthetic-a",
      ),
    );
    assert.throws(() =>
      h.workspace.assetCustody(h.actor("it-one", tenant), target.id),
    );
    const restarted = new WorkspaceStore(
      join(h.directory, "operations.sqlite"),
    );
    try {
      restarted.setPrincipalProvider((t) =>
        h.principals.filter((p) => p.tenantId === t),
      );
      const tool = restarted
        .tools()
        .find((t) => t.id === "ops.assets.replaceReservation")!;
      const db = new DatabaseSync(join(h.directory, "operations.sqlite"));
      const event = db
        .prepare("SELECT * FROM ops_asset_events WHERE id=?")
        .get(String(proof.reserveEventId))!;
      db.close();
      const context = {
        ...ctx(tenant),
        operationKey: String(event.operation_key),
        runId: run.id,
        stepId: String(event.step_id),
      };
      assert.deepEqual(
        await tool.execute(context, run.plan.steps[0]!.input),
        run.steps[0]!.output,
      );
      assert.equal(
        (
          await tool.verify(
            context,
            run.plan.steps[0]!.input,
            run.steps[0]!.output!,
          )
        ).ok,
        true,
      );
      assert.equal(
        restarted.assetCustody(h.actor("manager", tenant), target.id)
          .totalEvents,
        1,
      );
    } finally {
      restarted.close();
    }
  }
});

test("failure on the second event rolls back both assets, allocations, register histories and outbox", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    target = await replacementAsset(h);
  const tool = h.tools.find((t) => t.id === "ops.assets.replaceReservation")!;
  const input = tool.prepareInput!(
    replacementInput(h, seed.assetId, target.id),
    "synthetic-a",
  );
  const db = new DatabaseSync(join(h.directory, "operations.sqlite"));
  t.after(() => db.close());
  const counts = () =>
    [
      "ops_allocations",
      "ops_asset_events",
      "ops_asset_register_events",
      "ops_entity_versions",
      "ops_commands",
      "ops_outbox",
      "ops_audit",
    ].map((table) => db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  const before = counts(),
    sourceBefore = h.get("assets", seed.assetId);
  db.exec(
    "CREATE TRIGGER synthetic_fail_replacement AFTER INSERT ON ops_asset_events WHEN NEW.kind='reserve' BEGIN SELECT RAISE(ABORT,'synthetic second event failure'); END",
  );
  const context = ctx();
  await assert.rejects(
    tool.execute(context, input),
    /synthetic second event failure/,
  );
  assert.deepEqual(counts(), before);
  assert.deepEqual(h.get("assets", seed.assetId), sourceBefore);
  assert.deepEqual(h.get("assets", target.id), target);
  assert.equal((await tool.reconcile!(context, input)).status, "not_applied");
  db.exec("DROP TRIGGER synthetic_fail_replacement");
  await h.complete(tool.id, input);
});

test("two approved reservations competing for one replacement preserve the losing reservation", async (t) => {
  const h = fixture(t),
    a = await h.seed(),
    b = await h.seed("synthetic-a", randomUUID()),
    target = await replacementAsset(h);
  const first = await h.stage(
    "ops.assets.replaceReservation",
    replacementInput(h, a.assetId, target.id),
  );
  const second = await h.stage(
    "ops.assets.replaceReservation",
    replacementInput(h, b.assetId, target.id),
  );
  h.approve(first);
  h.approve(second);
  for (let i = 0; i < 8; i++) await h.engine.tick();
  const runs = [first, second].map((r) => h.engine.getRun(h.actor(), r.id));
  assert.equal(runs.filter((r) => r.status === "completed").length, 1);
  assert.equal(
    runs.filter((r) => r.status === "needs_reconciliation").length,
    1,
  );
  const loser = runs.find((r) => r.status !== "completed")!;
  assert.equal(
    h.get("assets", String(loser.plan.steps[0]!.input.id)).status,
    "reserved",
  );
  assert.equal(h.workspace.assetCustody(h.actor(), target.id).totalEvents, 1);
});

test("replacement rejects expired reservations, fabricated pins, wrong device type and stale target without releasing the source", async (t) => {
  let now = custodyNow;
  const h = fixture(t, () => now),
    seed = await h.seed(),
    target = await replacementAsset(h),
    phone = await replacementAsset(h, "synthetic-a", "phone");
  const tool = h.tools.find((t) => t.id === "ops.assets.replaceReservation")!;
  const input = tool.prepareInput!(
    replacementInput(h, seed.assetId, target.id),
    "synthetic-a",
  );
  const before = h.get("assets", seed.assetId);
  for (const wrong of [
    { expiresAt: "2026-09-20T22:00:00.000Z" },
    { personId: randomUUID() },
    { expectedEpisodeVersion: 999 },
    { expectedAllocationVersion: 999 },
    { replacementAssetId: seed.assetId },
    { expectedReplacementVersion: 999 },
    { replacementAssetId: phone.id },
  ]) {
    await assert.rejects(tool.execute(ctx(), { ...input, ...wrong }));
    assert.deepEqual(h.get("assets", seed.assetId), before);
  }
  const changed = tool.prepareInput!(
    { ...input, expiresAt: "2026-09-20T22:00:00.000Z" },
    "synthetic-a",
  );
  assert.equal(
    changed.expiresAt,
    "2026-09-20T22:00:00.000Z",
    "prepare never replaces approved pins",
  );
  now = Date.parse(String(input.expiresAt));
  await assert.rejects(tool.execute(ctx(), input), /wygasłej/);
  assert.deepEqual(h.get("assets", seed.assetId), before);
});

test("revoked operator scope after approval prevents both writes", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    target = await replacementAsset(h);
  const run = await h.stage(
    "ops.assets.replaceReservation",
    replacementInput(h, seed.assetId, target.id),
  );
  h.approve(run);
  h.actor().scopes = [];
  for (let i = 0; i < 4; i++) await h.engine.tick();
  h.actor().scopes = ["*"];
  assert.notEqual(h.engine.getRun(h.actor(), run.id).status, "completed");
  assert.equal(h.get("assets", seed.assetId).status, "reserved");
  assert.equal(h.get("assets", target.id).status, "available");
});

test("a changed case after planning requires new approval instead of silently accepting a new scope", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    target = await replacementAsset(h);
  const run = await h.stage(
    "ops.assets.replaceReservation",
    replacementInput(h, seed.assetId, target.id),
  );
  const c = h.get("cases", seed.caseId);
  await h.complete("ops.cases.update", {
    id: c.id,
    expectedVersion: c.version,
    title: "Synthetic changed case",
  });
  h.approve(run);
  for (let i = 0; i < 4; i++) await h.engine.tick();
  assert.equal(
    h.engine.getRun(h.actor(), run.id).status,
    "needs_reconciliation",
  );
  assert.equal(h.get("assets", seed.assetId).status, "reserved");
  assert.equal(h.get("assets", target.id).status, "available");
  assert.equal(run.plan.steps[0]!.input.expectedCaseVersion, c.version);
});

test("replacement in one parallel project keeps the other project, its reservation and case unchanged", async (t) => {
  const h = fixture(t),
    tenant = "synthetic-b",
    manager = h.actor("manager", tenant),
    p = h.initiatives.profile(manager);
  const complete = (tool: string, input: JsonObject) =>
    h.complete(tool, input, "manager", tenant);
  await complete("initiatives.configure", {
    companyName: "Synthetic parallel replacements",
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
  const created = await complete("ops.people.create", {
    title: "SYNTHETIC PROJECT CONSULTANT",
    data: { personCategory: "contractor" },
  });
  const personId = String(created.steps[0]!.output!.data.entityId),
    projects = [];
  for (const label of ["Project Alpha", "Project Beta"]) {
    const project = await complete("ops.cases.create", {
      title: label,
      data: {
        caseType: "delivery",
        brief: "Synthetic agreed project",
        acceptanceCriteria: "Independent project acceptance",
      },
    });
    const engagementId = String(project.steps[0]!.output!.data.entityId);
    await complete("ops.people.startEmployment", {
      id: personId,
      expectedVersion: h.get("people", personId, tenant).version,
      employmentKind: "contractor",
      startDate: "2026-09-08",
      role: label,
      engagementRef: { module: "cases", id: engagementId },
      humanDecision: true,
    });
    const episode = h.workspace
      .listEmploymentEpisodes(manager, personId)
      .find((e) => e.engagementRef?.id === engagementId)!;
    const asset = await replacementAsset(h, tenant);
    await complete("ops.assets.reserve", {
      id: asset.id,
      expectedVersion: asset.version,
      personId,
      employmentEpisodeId: episode.id,
      expectedEpisodeVersion: episode.version,
      caseId: episode.onboardingCaseId!,
      purpose: label,
      until: "2026-09-12",
    });
    projects.push({
      assetId: asset.id,
      episode,
      caseId: episode.onboardingCaseId!,
    });
  }
  const a = projects[0]!,
    b = projects[1]!,
    target = await replacementAsset(h, tenant);
  const before = {
    person: h.get("people", personId, tenant),
    other: h.get("assets", b.assetId, tenant),
    cases: projects.map((p) => h.get("cases", p.caseId, tenant)),
  };
  await complete(
    "ops.assets.replaceReservation",
    replacementInput(h, a.assetId, target.id, tenant),
  );
  assert.deepEqual(h.get("people", personId, tenant), before.person);
  assert.deepEqual(h.get("assets", b.assetId, tenant), before.other);
  assert.deepEqual(
    projects.map((p) => h.get("cases", p.caseId, tenant)),
    before.cases,
  );
  const allocation = h.workspace.assetCustody(manager, target.id)
    .allocations[0]!;
  assert.equal(allocation.employmentEpisodeId, a.episode.id);
  assert.equal(allocation.caseId, a.caseId);
  assert.equal(allocation.expiresAt, "2026-09-13T04:00:00.000Z");
});

test("an issued asset cannot bypass witnessed return through replacement", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    target = await replacementAsset(h);
  const input = replacementInput(h, seed.assetId, target.id);
  await h.complete(
    "ops.assets.issueForTask",
    {
      ...h.workspace.taskEquipment(h.actor("it-one"), seed.taskId)
        .allocations[0]!.commandBindings.issueForTask!,
      issuedOn: "2026-09-08",
      location: "Synthetic desk",
      condition: "good",
      handoverNote: "Synthetic physical handover",
      humanConfirmed: true,
    },
    "it-one",
  );
  const tool = h.tools.find((t) => t.id === "ops.assets.replaceReservation")!;
  const prepared = tool.prepareInput!(
    { ...input, expectedVersion: 3, expectedAllocationVersion: 2 },
    "synthetic-a",
  );
  await assert.rejects(tool.execute(ctx(), prepared));
  assert.equal(h.get("assets", seed.assetId).status, "issued");
  assert.equal(h.workspace.assetCustody(h.actor(), target.id).totalEvents, 0);
});

test("independent verification rejects a missing or altered member of a committed replacement pair", async (t) => {
  const h = fixture(t),
    seed = await h.seed(),
    target = await replacementAsset(h);
  const tool = h.tools.find((t) => t.id === "ops.assets.replaceReservation")!;
  const input = tool.prepareInput!(
      replacementInput(h, seed.assetId, target.id),
      "synthetic-a",
    ),
    context = ctx();
  const result = await tool.execute(context, input);
  assert.equal((await tool.verify(context, input, result)).ok, true);
  const db = new DatabaseSync(join(h.directory, "operations.sqlite"));
  t.after(() => db.close());
  db.prepare(
    "UPDATE ops_asset_events SET snapshot_hash='synthetic-corruption' WHERE id=?",
  ).run(String((result.data.replacement as JsonObject).releaseEventId));
  assert.equal((await tool.verify(context, input, result)).ok, false);
  await assert.rejects(tool.reconcile!(context, input), /spójnego zdarzenia/);
});
