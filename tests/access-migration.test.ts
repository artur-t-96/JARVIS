import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operationsV7 } from "./helpers/operations-v7.js";
import { WorkspaceStore } from "../src/workspace.js";
test("v8 migrates the frozen delivered schema without fabricating access; DDL failure rolls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-access-v7-")),
    path = join(dir, "operations.sqlite"),
    db = operationsV7(path);
  try {
    const data = JSON.stringify({
      kind: "observation",
      description: "Historical IT fact",
      severity: "low",
      environment: "local",
    });
    db.prepare(
      "INSERT INTO ops_entities VALUES('synthetic','old-observation','it','Historical source','observed',1,?,'2026-09-01','2026-09-01')",
    ).run(data);
    const before = db.prepare("SELECT * FROM ops_entities").all();
    db.exec("CREATE INDEX ops_access_bundle_key ON ops_entities(title)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_access_bundle_key already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      7,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_access_grants'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_access_bundle_key");
    for (let i = 0; i < 2; i++) new WorkspaceStore(path).close();
    assert.deepEqual(db.prepare("SELECT * FROM ops_entities").all(), before);
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      15,
    );
    for (const table of ["ops_access_grants", "ops_access_events"])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
