import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/workspace.js";
import { operationsV15 } from "./helpers/operations-v15.js";
test("CSV v16 migration preserves v15 data and rolls back its entire schema on DDL failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-import-v15-")),
    path = join(directory, "operations.sqlite"),
    db = operationsV15(path);
  try {
    const data = JSON.stringify({
      assetType: "laptop",
      serial: "0000123",
      location: "Legacy",
      condition: "good",
      allocations: [],
    });
    db.prepare(
      "INSERT INTO ops_entities VALUES('legacy','asset','assets','Historical source','available',1,?,'2026-09-08','2026-09-08')",
    ).run(data);
    db.exec("CREATE INDEX ops_asset_import_history ON ops_entities(title)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_asset_import_history already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      15,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_asset_imports'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_asset_import_history");
    new WorkspaceStore(path).close();
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      17,
    );
    assert.equal(
      db.prepare("SELECT data_json FROM ops_entities WHERE id='asset'").get()!
        .data_json,
      data,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM ops_asset_imports").get()!.n,
      0,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
