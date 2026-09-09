import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceStore } from "../src/workspace.js";
test("v9 preserves frozen v8 document content and unknown authors; a DDL conflict rolls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-doc-v8-")),
    path = join(dir, "operations.sqlite"),
    db = new DatabaseSync(path);
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/operations-v8.sql", import.meta.url),
        "utf8",
      ),
    );
    db.prepare(
      "INSERT INTO ops_entities VALUES('synthetic','old-document','documents','Historical','approved',3,?,'2026-09-01','2026-09-01')",
    ).run(
      JSON.stringify({
        documentType: "report",
        accessScope: "documents",
        revision: 1,
        content: "Historical approved content",
        sources: [],
      }),
    );
    db.prepare(
      "INSERT INTO ops_document_versions VALUES('synthetic','old-document',1,'Historical approved content','legacy-hash','approved','historical-decider','Historical note','2026-09-01')",
    ).run();
    const before = db.prepare("SELECT * FROM ops_entities").all();
    db.exec("ALTER TABLE ops_document_versions ADD COLUMN context_hash TEXT");
    assert.throws(
      () => new WorkspaceStore(path),
      /duplicate column name: context_hash/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      8,
    );
    assert.equal(
      db
        .prepare("PRAGMA table_info(ops_document_versions)")
        .all()
        .some((r) => r.name === "context_json"),
      false,
    );
    db.exec("ALTER TABLE ops_document_versions DROP COLUMN context_hash");
    for (let i = 0; i < 2; i++) new WorkspaceStore(path).close();
    assert.deepEqual(db.prepare("SELECT * FROM ops_entities").all(), before);
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      18,
    );
    const doc = db.prepare("SELECT * FROM ops_document_versions").get()!;
    assert.equal(doc.content, "Historical approved content");
    assert.equal(doc.decided_by, "historical-decider");
    for (const key of [
      "context_json",
      "context_hash",
      "created_by",
      "created_at",
      "approved_by",
    ])
      assert.equal(doc[key], null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
