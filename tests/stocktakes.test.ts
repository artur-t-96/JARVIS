import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash } from "../src/engine.js";
import type { JsonObject, ToolContext, ToolResult } from "../src/contracts.js";
import { custodyNow } from "./helpers/custody-fixture.js";
import { stocktakeFixture } from "./helpers/stocktake-fixture.js";
function setup(
  t: TestContext,
  options: Parameters<typeof stocktakeFixture>[1] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-stocktake-")),
    f = stocktakeFixture(dir, options);
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
test("stocktakes record observations and owner acceptance for two companies without altering equipment", async (t) => {
  const f = setup(t);
  for (const tenant of ["synthetic-a", "synthetic-b"]) {
    if (tenant === "synthetic-b") {
      const profile = f.initiatives.profileForTenant(tenant);
      await f.complete(
        "initiatives.configure",
        {
          companyName: "Synthetic B",
          timezone: "America/New_York",
          licenseReminderDays: profile.licenseReminderDays,
          quietHours: profile.quietHours,
          rules: profile.rules,
          roleBindings: {},
          processTemplates: profile.processTemplates,
          employmentPolicy: profile.employmentPolicy,
          expectedVersion: profile.version,
        },
        "manager",
        tenant,
      );
    }
    const a = await f.newAsset(tenant, "SAME-ISOLATED-SERIAL"),
      spis = await f.open([a.id], tenant, "it-two");
    assert.equal(f.view(spis.id, tenant).ready, false);
    await f.complete(
      "ops.inventory.recordObservation",
      f.observeInput(spis.id, a.id, {}, tenant),
      "it-two",
      tenant,
    );
    const report = f.view(spis.id, tenant);
    assert.equal(report.ready, true);
    assert.equal(report.lines[0]!.observation!.actorId, "it-two");
    assert.equal(report.lines[0]!.observation!.approvedBy, "reviewer");
    await f.act(
      spis.id,
      "acceptStocktake",
      {
        reportHash: report.hash,
        note: "Synthetic owner accepts exact report",
        humanDecision: true,
      },
      tenant,
      "it-two",
    );
    assert.equal(f.get("inventory", spis.id, tenant).status, "accepted");
    assert.deepEqual(f.get("assets", a.id, tenant), a);
    assert.deepEqual(
      f.workspace
        .stocktakeHistory(f.actor("manager", tenant), spis.id, 2, 1)
        .items.map((i) => i.record.version),
      [2, 1],
    );
    assert.throws(
      () =>
        f.workspace.stocktakeReport(
          f.actor(
            "manager",
            tenant === "synthetic-a" ? "synthetic-b" : "synthetic-a",
          ),
          spis.id,
        ),
      { code: "ENTITY_NOT_FOUND" },
    );
  }
});
test("missing equipment survives cancellation and needs a fresh observation plus owner resolution", async (t) => {
  const f = setup(t),
    a = await f.newAsset(),
    spis = await f.open([a.id]);
  const missing = f.observeInput(spis.id, a.id, { present: false });
  delete missing.location;
  delete missing.condition;
  await f.complete("ops.inventory.recordObservation", missing);
  assert.equal(f.workspace.assetInventoryHolds(f.actor(), a.id).length, 1);
  const report = f.view(spis.id);
  assert.equal(report.unresolved, 1);
  assert.equal(report.ready, false);
  await f.failRun(
    "ops.inventory.resolveDiscrepancy",
    f.resolveInput(spis.id, a.id),
  );
  await f.failRun(
    "ops.inventory.acceptStocktake",
    f.input(spis.id, {
      reportHash: report.hash,
      note: "cannot accept missing",
      humanDecision: true,
    }),
  );
  await f.act(spis.id, "cancelStocktake", {
    reason: "Synthetic cancellation preserves findings",
  });
  assert.equal(f.workspace.assetInventoryHolds(f.actor(), a.id).length, 1);
  await f.failRun("ops.inventory.create", f.createInput([a.id]));
  await f.complete(
    "ops.inventory.recordObservation",
    f.observeInput(spis.id, a.id),
  );
  assert.equal(f.workspace.assetInventoryHolds(f.actor(), a.id).length, 1);
  await f.complete(
    "ops.inventory.resolveDiscrepancy",
    f.resolveInput(spis.id, a.id),
  );
  assert.equal(f.workspace.assetInventoryHolds(f.actor(), a.id).length, 0);
  assert.equal(f.get("inventory", spis.id).status, "cancelled");
  assert.deepEqual(f.get("assets", a.id), a);
  const history = f.workspace.stocktakeHistory(f.actor(), spis.id, 50, 0);
  assert.ok(
    history.items.some(
      (i) =>
        (i.record.data.lines as JsonObject[])[0]!.observation &&
        ((i.record.data.lines as JsonObject[])[0]!.observation as JsonObject)
          .present === false,
    ),
  );
});
test("location and condition corrections are separate operations and do not silently resolve a stocktake", async (t) => {
  const f = setup(t),
    a = await f.newAsset(),
    spis = await f.open([a.id]);
  await f.complete(
    "ops.inventory.recordObservation",
    f.observeInput(spis.id, a.id, {
      location: "Synthetic service",
      condition: "repair",
    }),
  );
  assert.equal(f.view(spis.id).lines[0]!.discrepancy!.reasons.length, 2);
  assert.deepEqual(f.get("assets", a.id), a);
  await f.failRun(
    "ops.inventory.resolveDiscrepancy",
    f.resolveInput(spis.id, a.id),
  );
  await f.complete("ops.assets.sendToService", {
    id: a.id,
    expectedVersion: a.version,
    location: "Synthetic service",
    occurredOn: "2026-09-08",
    note: "Separate synthetic service transfer",
    humanConfirmed: true,
  });
  assert.equal(f.workspace.assetInventoryHolds(f.actor(), a.id).length, 1);
  await f.complete(
    "ops.inventory.resolveDiscrepancy",
    f.resolveInput(spis.id, a.id),
  );
  const report = f.view(spis.id);
  assert.equal(report.ready, true);
  await f.act(spis.id, "acceptStocktake", {
    reportHash: report.hash,
    note: "Service state matches observation",
    humanDecision: true,
  });
  assert.equal(f.get("assets", a.id).status, "maintenance");
});
test("an observation rolls back atomically if writing its immutable version fails", async (t) => {
  const f = setup(t),
    a = await f.newAsset(),
    spis = await f.open([a.id]);
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  db.exec(
    "CREATE TRIGGER fail_inventory_snapshot BEFORE INSERT ON ops_entity_versions WHEN json_extract(NEW.snapshot_json,'$.module')='inventory' BEGIN SELECT RAISE(ABORT,'synthetic snapshot failure'); END;",
  );
  try {
    await f.failRun(
      "ops.inventory.recordObservation",
      f.observeInput(spis.id, a.id),
    );
    assert.deepEqual(f.get("inventory", spis.id), spis);
    assert.equal(f.view(spis.id).observed, 0);
    assert.deepEqual(f.get("assets", a.id), a);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM ops_commands WHERE tool_id='ops.inventory.recordObservation'",
        )
        .get()!.n,
      0,
    );
  } finally {
    db.exec("DROP TRIGGER fail_inventory_snapshot");
    db.close();
  }
});
test("scope revisions, stale asset plans, refusal and revoked owner authority cannot invent observations", async (t) => {
  const f = setup(t),
    a = await f.newAsset(),
    b = await f.newAsset(),
    spis = await f.open([a.id]);
  const old = await f.stage(
    "ops.inventory.recordObservation",
    f.observeInput(spis.id, a.id),
  );
  await f.act(spis.id, "reviseStocktake", {
    assetPins: [{ id: b.id, expectedVersion: b.version }],
    reason: "Scope now selects second device",
  });
  f.approve(old);
  for (let i = 0; i < 4; i++) await f.engine.tick();
  assert.equal(f.view(spis.id).observed, 0);
  assert.equal(f.view(spis.id).lines[0]!.baseline.id, b.id);
  const stale = f.observeInput(spis.id, b.id);
  await f.complete("ops.assets.update", {
    id: b.id,
    expectedVersion: b.version,
    title: "Changed inventory title",
  });
  await f.failRun("ops.inventory.recordObservation", stale);
  assert.equal(f.view(spis.id).observed, 0);
  const refused = await f.stage(
      "ops.inventory.recordObservation",
      f.observeInput(spis.id, b.id),
    ),
    approval = refused.steps[0]!.approval!;
  f.engine.approve(f.actor("reviewer"), refused.id, {
    approvalId: approval.id,
    bindingHash: approval.bindingHash,
    decision: "rejected",
  });
  await f.engine.tick();
  assert.equal(f.engine.getRun(f.actor(), refused.id).steps[0]!.attempts, 0);
  const pending = await f.stage(
    "ops.inventory.recordObservation",
    f.observeInput(spis.id, b.id),
    "it-two",
  );
  f.actor("it-two").scopes = ["inventory"];
  assert.throws(() => f.approve(pending), { code: "TOOL_CHANGED" });
  await f.engine.tick();
  assert.equal(f.engine.getRun(f.actor(), pending.id).steps[0]!.attempts, 0);
  assert.equal(f.view(spis.id).observed, 0);
});
test("inventory findings invalidate issued evidence while preserving custody and other-company facts", async (t) => {
  const f = setup(t),
    a = await f.seed(),
    b = await f.newAsset("synthetic-b"),
    worker = f.actor("it-one");
  const before = f.workspace.taskEquipment(worker, a.taskId).allocations[0]!
    .commandBindings.issueForTask!;
  await f.complete(
    "ops.assets.issueForTask",
    {
      ...before,
      issuedOn: "2026-09-08",
      location: "Synthetic desk",
      condition: "good",
      handoverNote: "Synthetic attestation",
      humanConfirmed: true,
    },
    "it-one",
  );
  await f.complete(
    "ops.assets.bindAssetForTask",
    f.workspace.taskEquipment(worker, a.taskId).allocations[0]!.commandBindings
      .bindAssetForTask!,
    "it-one",
  );
  const readiness = () =>
    f.workspace
      .readiness(f.actor(), a.caseId)
      .requirements.find((r) => r.kind === "asset_issued")!.status;
  assert.equal(readiness(), "satisfied");
  const issued = f.get("assets", a.assetId),
    spis = await f.open([a.assetId]);
  assert.equal(
    readiness(),
    "satisfied",
    "opening alone does not change proof hashes",
  );
  const missing = f.observeInput(spis.id, a.assetId, { present: false });
  delete missing.location;
  delete missing.condition;
  await f.complete("ops.inventory.recordObservation", missing);
  assert.notEqual(readiness(), "satisfied");
  assert.deepEqual(f.get("assets", a.assetId), issued);
  assert.deepEqual(f.get("assets", b.id, "synthetic-b"), b);
  await f.complete(
    "ops.inventory.recordObservation",
    f.observeInput(spis.id, a.assetId),
  );
  await f.complete(
    "ops.inventory.resolveDiscrepancy",
    f.resolveInput(spis.id, a.assetId),
  );
  assert.equal(readiness(), "satisfied");
});
test("an unresolved finding blocks issuing and reserving, while an explicit reservation release remains possible", async (t) => {
  const f = setup(t),
    a = await f.seed(),
    spis = await f.open([a.assetId]);
  const input = f.observeInput(spis.id, a.assetId, { present: false });
  delete input.location;
  delete input.condition;
  await f.complete("ops.inventory.recordObservation", input);
  const pins = f.workspace.taskEquipment(f.actor("it-one"), a.taskId)
    .allocations[0]!.commandBindings.issueForTask!;
  await f.failRun(
    "ops.assets.issueForTask",
    {
      ...pins,
      issuedOn: "2026-09-08",
      location: "Synthetic desk",
      condition: "good",
      handoverNote: "Must not attest a missing item",
      humanConfirmed: true,
    },
    "synthetic-a",
    "it-one",
  );
  const asset = f.get("assets", a.assetId),
    allocation = (asset.data.allocations as JsonObject[])[0]!;
  assert.equal(asset.status, "reserved");
  await f.complete("ops.assets.release", {
    id: asset.id,
    expectedVersion: asset.version,
    allocationId: allocation.id,
    expectedAllocationVersion: allocation.version,
    reason: "Release the reservation without pretending a return",
  });
  const current = f.get("assets", asset.id),
    episode = f.workspace.listEmploymentEpisodes(f.actor(), a.personId)[0]!;
  assert.equal(current.status, "available");
  assert.equal(f.workspace.assetInventoryHolds(f.actor(), asset.id).length, 1);
  await f.failRun("ops.assets.reserve", {
    id: asset.id,
    expectedVersion: current.version,
    personId: a.personId,
    employmentEpisodeId: a.episodeId,
    expectedEpisodeVersion: episode.version,
    caseId: a.caseId,
    purpose: "Cannot reserve before finding is resolved",
    until: "2026-09-12",
  });
  assert.deepEqual(f.get("assets", asset.id), current);
});
test("late ownership and a changed register require current evidence, and lost response replays only its receipt", async (t) => {
  let now = custodyNow,
    domainNow = custodyNow,
    saved:
      { ctx: ToolContext; input: JsonObject; result: ToolResult } | undefined,
    calls = 0;
  const f = setup(t, {
    clock: () => now,
    domainClock: () => domainNow,
    wrap: (tool) =>
      tool.id === "ops.inventory.recordObservation"
        ? {
            ...tool,
            async execute(ctx, input) {
              calls++;
              const result = await tool.execute(ctx, input);
              saved = { ctx, input, result };
              throw Error("Synthetic response lost after domain commit");
            },
          }
        : tool,
  });
  const a = await f.newAsset(),
    spis = await f.open([a.id]);
  const run = await f.stage(
    "ops.inventory.recordObservation",
    f.observeInput(spis.id, a.id),
  );
  f.approve(run);
  await f.engine.tick();
  assert.ok(saved);
  now += 5000;
  domainNow += 3 * 86400000;
  f.engine.retry(f.actor(), run.id);
  for (let i = 0; i < 4; i++) await f.engine.tick();
  assert.equal(f.engine.getRun(f.actor(), run.id).status, "completed");
  assert.equal(calls, 1);
  assert.equal(f.view(spis.id).overdue, true);
  await f.act(spis.id, "assignStocktakeOwner", {
    ownerPrincipalId: "it-two",
    dueDate: "2026-09-15",
    reason: "Synthetic manager reassigned delayed work",
  });
  assert.equal(f.view(spis.id).overdue, false);
  await f.failRun(
    "ops.inventory.acceptStocktake",
    f.input(spis.id, {
      reportHash: f.view(spis.id).hash,
      note: "Old owner cannot accept",
      humanDecision: true,
    }),
  );
  await f.act(
    spis.id,
    "acceptStocktake",
    {
      reportHash: f.view(spis.id).hash,
      note: "New owner reviews report",
      humanDecision: true,
    },
    "synthetic-a",
    "it-two",
  );
  const tool = f.workspace
    .tools()
    .find((t) => t.id === "ops.inventory.recordObservation")!;
  assert.equal(
    (await tool.reconcile!(saved.ctx, saved.input)).status,
    "applied",
  );
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  const current = f.get("inventory", spis.id);
  ((current.data.lines as JsonObject[])[0]!.observation as JsonObject).present =
    false;
  db.prepare("UPDATE ops_entities SET data_json=? WHERE id=?").run(
    JSON.stringify(current.data),
    current.id,
  );
  db.prepare(
    "UPDATE ops_entity_versions SET snapshot_json=?,snapshot_hash=? WHERE entity_id=? AND version=?",
  ).run(JSON.stringify(current), hash(current), current.id, current.version);
  db.close();
  await assert.rejects(() => tool.reconcile!(saved!.ctx, saved!.input), {
    code: "STOCKTAKE_STATE_INCONSISTENT",
  });
  await assert.rejects(
    () => tool.verify!(saved!.ctx, saved!.input, saved!.result),
    { code: "STOCKTAKE_STATE_INCONSISTENT" },
  );
});
