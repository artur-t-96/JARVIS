import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationsV15 } from "./helpers/operations-v15.js";
import { migrateAssetImports } from "../src/asset-imports.js";
import { WorkspaceStore } from "../src/workspace.js";
import { migrateDatabase } from "../src/migrations.js";
test("v17 report preview migration rolls back on DDL conflict and preserves earlier data; a report-unaware runtime cannot open it", () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-report-v16-")),
    path = join(directory, "operations.sqlite"),
    db = operationsV15(path);
  try {
    migrateAssetImports(db);
    db.exec(
      "INSERT INTO schema_versions_operations VALUES(16,'v16'); CREATE INDEX ops_report_preview_expiry ON ops_entities(title)",
    );
    const before = db.prepare("SELECT * FROM ops_entities").all();
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_report_preview_expiry already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      16,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_report_previews'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_report_preview_expiry");
    new WorkspaceStore(path).close();
    new WorkspaceStore(path).close();
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      17,
    );
    assert.deepEqual(db.prepare("SELECT * FROM ops_entities").all(), before);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(
      () =>
        migrateDatabase(db, {
          namespace: "operations",
          migrations: Array.from({ length: 16 }, (_, i) => ({
            version: i + 1,
            name: "historical",
            up() {
              throw Error("Must not run");
            },
          })),
        }),
      /v17 is newer than supported v16/,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
