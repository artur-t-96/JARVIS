import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceStore } from "../src/workspace.js";
import type { Principal } from "../src/contracts.js";

test("v5 register migration rolls back and starts legacy history at the next approved version without inventing earlier facts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-register-v5-")),
    path = join(directory, "operations.sqlite");
  let db: DatabaseSync | undefined, store: WorkspaceStore | undefined;
  try {
    new WorkspaceStore(path).close();
    db = new DatabaseSync(path);
    db.exec(
      "DROP TABLE ops_asset_register_events; DELETE FROM schema_versions_operations WHERE version=6",
    );
    const id = randomUUID(),
      now = "2026-09-08T10:00:00.000Z";
    const data = JSON.stringify({
      assetType: "laptop",
      serial: "SYNTHETIC-LEGACY-REGISTER",
      location: "Historical declaration",
      condition: "good",
      allocations: [],
    });
    db.prepare(
      "INSERT INTO ops_entities VALUES('legacy',?,'assets','Synthetic old asset','available',4,?,?,?)",
    ).run(id, data, now, now);
    // Fail after table creation to prove the whole migration, including DDL, rolls back.
    db.exec("CREATE INDEX ops_asset_register_history ON ops_entities(title)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_asset_register_history already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      5,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_asset_register_events'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_asset_register_history");
    db.close();
    db = undefined;
    store = new WorkspaceStore(path, { clock: () => Date.parse(now) });
    const actor: Principal = {
      id: "stock-manager",
      tenantId: "legacy",
      roles: ["operator"],
      scopes: ["assets"],
    };
    store.setPrincipalProvider(() => [actor]);
    const before = store.assetRegister(actor, id);
    assert.equal(before.historyFromVersion, null);
    assert.equal(before.total, 0);
    assert.equal(before.consistent, true);
    db = new DatabaseSync(path);
    assert.equal(
      db.prepare("SELECT data_json FROM ops_entities WHERE id=?").get(id)!
        .data_json,
      data,
    );
    const tool = store.tools().find((t) => t.id === "ops.assets.move")!;
    const input = {
      id,
      expectedVersion: 4,
      location: "Synthetic verified stock",
      occurredOn: "2026-09-08",
      note: "Synthetic current witness only",
      humanConfirmed: true,
    };
    const ctx = {
      tenantId: actor.tenantId,
      actorId: actor.id,
      approvedBy: "independent-reviewer",
      runId: randomUUID(),
      stepId: "move",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    };
    const result = await tool.execute(ctx, input);
    assert.equal((await tool.verify(ctx, input, result)).ok, true);
    const after = store.assetRegister(actor, id);
    assert.equal(after.historyFromVersion, 5);
    assert.equal(after.total, 1);
    assert.equal(after.consistent, true);
    assert.equal(after.events[0]!.previousEventId, null);
    assert.equal(after.events[0]!.assetVersion, 5);
    assert.equal(after.events[0]!.state?.location, input.location);
    assert.equal(after.events[0]!.attestation?.occurredOn, input.occurredOn);
    const again = await tool.execute(ctx, input);
    assert.deepEqual(again, result);
    assert.equal(store.assetRegister(actor, id).total, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
