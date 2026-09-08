import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceStore } from "../src/workspace.js";
import { custodyFixture } from "./helpers/custody-fixture.js";

test("v7 migration preserves all existing custody rows and rolls back failed DDL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-replacement-v6-"));
  const h = custodyFixture(directory);
  let db: DatabaseSync | undefined;
  let fixtureOpen = true;
  try {
    await h.seed();
    h.close();
    fixtureOpen = false;
    const path = join(directory, "operations.sqlite");
    db = new DatabaseSync(path);
    const before = db
      .prepare("SELECT * FROM ops_asset_events ORDER BY rowid")
      .all();
    const sql = String(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name='ops_asset_events'")
        .get()!.sql,
    );
    db.exec(
      "ALTER TABLE ops_asset_events RENAME TO synthetic_old_events; DROP INDEX ops_asset_event_history",
    );
    db.exec(
      sql.replace(
        "UNIQUE(tenant_id,operation_key,asset_id)",
        "UNIQUE(tenant_id,operation_key)",
      ),
    );
    db.exec(
      "INSERT INTO ops_asset_events SELECT * FROM synthetic_old_events; DROP TABLE synthetic_old_events; CREATE INDEX ops_asset_event_history ON ops_asset_events(tenant_id,asset_id,recorded_at,id); DROP TABLE ops_access_events; DROP TABLE ops_access_grants; DROP INDEX ops_application_key; DROP INDEX ops_access_bundle_key; DROP INDEX ops_open_laboratory_case; DELETE FROM schema_versions_operations WHERE version>=7;",
    );
    for (const column of [
      "context_json",
      "context_hash",
      "created_by",
      "created_at",
      "approved_by",
    ])
      db.exec(`ALTER TABLE ops_document_versions DROP COLUMN ${column}`);
    db.exec("CREATE TABLE ops_asset_events_v7(synthetic_collision TEXT)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_asset_events_v7 already exists/,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM ops_asset_events ORDER BY rowid").all(),
      before,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      6,
    );
    db.exec("DROP TABLE ops_asset_events_v7");
    new WorkspaceStore(path).close();
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      12,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM ops_asset_events ORDER BY rowid").all(),
      before,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.match(
      String(
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name='ops_asset_events'",
          )
          .get()!.sql,
      ),
      /UNIQUE\(tenant_id,operation_key,asset_id\)/,
    );
  } finally {
    db?.close();
    if (fixtureOpen) h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
