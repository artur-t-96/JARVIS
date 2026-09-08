import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { WorkspaceStore } from "../src/workspace.js";
import type { JsonObject } from "../src/contracts.js";
function setup(
  t: TestContext,
  options: Parameters<typeof custodyFixture>[1] = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-asset-register-"));
  const f = custodyFixture(directory, options);
  t.after(() => {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}
const facts = {
  occurredOn: "2026-09-08",
  note: "Syntetyczne poświadczenie czynności magazynowej",
  humanConfirmed: true,
};
test("stock actions preserve witnessed history, distinct approver, restart and a terminal retirement", async (t) => {
  const f = setup(t);
  const created = await f.complete("ops.assets.create", {
    title: "Synthetic service laptop",
    data: {
      assetType: "laptop",
      serial: "STOCK-A",
      condition: "good",
      location: "Synthetic stock A",
    },
  });
  const id = String(created.steps[0]!.output!.data.entityId);
  for (const [action, fields] of [
    ["move", { location: "Synthetic stock B" }],
    ["sendToService", { location: "Synthetic service" }],
    ["markRepaired", {}],
    ["retire", {}],
  ] as const) {
    const asset = f.get("assets", id);
    await f.complete(`ops.assets.${action}`, {
      id,
      expectedVersion: asset.version,
      ...facts,
      ...fields,
    });
  }
  const history = f.workspace.assetRegister(f.actor(), id);
  assert.equal(history.consistent, true);
  assert.equal(history.historyFromVersion, 1);
  assert.equal(history.total, 5);
  assert.equal(f.get("assets", id).status, "retired");
  assert.deepEqual(
    history.events.map((e) => e.assetVersion),
    [5, 4, 3, 2, 1],
  );
  assert.ok(
    history.events.every(
      (e) => e.requestedBy === "manager" && e.approvedBy === "reviewer",
    ),
  );
  const restored = new WorkspaceStore(join(f.directory, "operations.sqlite"));
  try {
    assert.equal(restored.assetRegister(f.actor(), id).consistent, true);
  } finally {
    restored.close();
  }
  assert.throws(() => f.workspace.assetRegister(f.actor("it-one"), id));
  assert.throws(() =>
    f.workspace.assetRegister(f.actor("manager", "synthetic-b"), id),
  );
  const staged = await f.stage("ops.assets.move", {
    id,
    expectedVersion: 5,
    location: "Synthetic extra",
    ...facts,
  });
  f.approve(staged);
  await f.engine.tick();
  assert.equal(f.get("assets", id).version, 5);
  assert.equal(f.workspace.assetRegister(f.actor(), id).total, 5);
});
test("an active reservation cannot be moved, serviced or retired; rejected physical dates cannot write history", async (t) => {
  const f = setup(t),
    seed = await f.seed();
  for (const action of ["move", "sendToService", "retire"]) {
    const input: JsonObject = {
      id: seed.assetId,
      expectedVersion: f.get("assets", seed.assetId).version,
      ...facts,
      ...(action !== "retire"
        ? { location: "Synthetic invalid destination" }
        : {}),
    };
    const r = await f.stage(`ops.assets.${action}`, input);
    f.approve(r);
    await f.engine.tick();
    assert.equal(f.get("assets", seed.assetId).status, "reserved");
    assert.equal(f.workspace.assetRegister(f.actor(), seed.assetId).total, 2);
  }
  const asset = await f.complete("ops.assets.create", {
    title: "Synthetic date check",
    data: {
      assetType: "laptop",
      serial: "STOCK-DATE",
      condition: "good",
      location: "Synthetic stock",
    },
  });
  const id = String(asset.steps[0]!.output!.data.entityId);
  const r = await f.stage("ops.assets.move", {
    id,
    expectedVersion: 1,
    ...facts,
    occurredOn: "2026-09-09",
    location: "Synthetic future",
  });
  f.approve(r);
  await f.engine.tick();
  assert.equal(f.get("assets", id).version, 1);
});
test("missing or modified register history fails independent verification and blocks subsequent mutation", async (t) => {
  const f = setup(t),
    seed = await f.seed();
  const asset = f.get("assets", seed.assetId);
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  t.after(() => db.close());
  const events = f.workspace.assetRegister(f.actor(), asset.id).events;
  assert.equal(events.length, 2);
  db.prepare(
    "DELETE FROM ops_asset_register_events WHERE tenant_id=? AND id=?",
  ).run(f.actor().tenantId, events[1]!.id);
  assert.equal(
    f.workspace.assetRegister(f.actor(), asset.id).consistent,
    false,
  );
  const r = await f.stage("ops.assets.release", {
    id: asset.id,
    expectedVersion: asset.version,
    allocationId: (asset.data.allocations as JsonObject[])[0]!.id,
    expectedAllocationVersion: 1,
    reason: "Synthetic release after corrupt history",
  });
  f.approve(r);
  await f.engine.tick();
  assert.equal(f.get("assets", asset.id).status, "reserved");
});

test("custodian assignment uses live asset-account authority and metadata cannot bypass physical movement", async (t) => {
  const f = setup(t),
    created = await f.complete("ops.assets.create", {
      title: "Synthetic owner test",
      data: {
        assetType: "laptop",
        serial: "STOCK-OWNER",
        condition: "good",
        location: "Synthetic stock",
      },
    }),
    id = String(created.steps[0]!.output!.data.entityId);
  await f.complete("ops.assets.assignCustodian", {
    id,
    expectedVersion: 1,
    custodianPrincipalId: "manager",
    note: "Synthetic responsibility",
    humanConfirmed: true,
  });
  assert.equal(f.get("assets", id).data.custodianPrincipalId, "manager");
  await assert.rejects(
    f.stage("ops.assets.update", {
      id,
      expectedVersion: 2,
      data: { location: "Silent move" },
    }),
  );
  const staged = await f.stage("ops.assets.assignCustodian", {
    id,
    expectedVersion: 2,
    custodianPrincipalId: "it-two",
    note: "Synthetic invalid scope",
    humanConfirmed: true,
  });
  f.approve(staged);
  await f.engine.tick();
  assert.equal(f.get("assets", id).version, 2);
  await f.complete("ops.assets.update", {
    id,
    expectedVersion: 2,
    data: { manufacturer: "Synthetic manufacturer", model: "Synthetic model" },
  });
  assert.equal(f.get("assets", id).data.location, "Synthetic stock");
  assert.equal(f.workspace.assetRegister(f.actor(), id).consistent, true);
});

test("physical stock actions cannot move backwards before the preceding witnessed action", async (t) => {
  let now = Date.parse("2026-09-08T10:00:00.000Z");
  const f = setup(t, { clock: () => now, domainClock: () => now });
  const created = await f.complete("ops.assets.create", {
    title: "Synthetic chronology",
    data: {
      assetType: "laptop",
      serial: "STOCK-CHRONO",
      location: "Synthetic A",
      condition: "good",
    },
  });
  const id = String(created.steps[0]!.output!.data.entityId);
  now += 86400000;
  await f.complete("ops.assets.sendToService", {
    id,
    expectedVersion: 1,
    ...facts,
    occurredOn: "2026-09-09",
    location: "Synthetic service",
  });
  const rejected = await f.stage("ops.assets.markRepaired", {
    id,
    expectedVersion: 2,
    ...facts,
  });
  f.approve(rejected);
  await f.engine.tick();
  assert.equal(f.get("assets", id).status, "maintenance");
  assert.equal(f.get("assets", id).version, 2);
  await f.complete("ops.assets.markRepaired", {
    id,
    expectedVersion: 2,
    ...facts,
    occurredOn: "2026-09-09",
  });
  assert.equal(f.get("assets", id).status, "available");
});
