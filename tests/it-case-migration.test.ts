import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalLaboratory } from "../src/laboratory.js";

test("laboratory v2 preserves existing tenant states and immutable effect receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-lab-migration-")),
    path = join(dir, "laboratory.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE schema_versions_laboratory(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_versions_laboratory VALUES(1,'2026-09-08T10:00:00Z');
    CREATE TABLE laboratory_state(tenant_id TEXT PRIMARY KEY,healthy INTEGER NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE laboratory_effects(tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(tenant_id,operation_key));
    INSERT INTO laboratory_state VALUES('a',1,7),('b',0,3);
    INSERT INTO laboratory_effects VALUES('a','old-operation','old-hash','{"data":{"version":7,"healthy":true}}');`);
  const before = [
    old.prepare("SELECT * FROM laboratory_state").all(),
    old.prepare("SELECT * FROM laboratory_effects").all(),
  ];
  old.close();
  const lab = new LocalLaboratory(path);
  await lab.start();
  const current = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(
      [
        current.prepare("SELECT * FROM laboratory_state").all(),
        current.prepare("SELECT * FROM laboratory_effects").all(),
      ],
      before,
    );
    assert.equal(
      current
        .prepare("SELECT max(version) n FROM schema_versions_laboratory")
        .get()!.n,
      2,
    );
    assert.equal(
      lab.view("a").observed,
      null,
      "old receipt is not a newly verified case observation",
    );
  } finally {
    current.close();
    await lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
