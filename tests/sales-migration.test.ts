import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { operationsV15 } from "./helpers/operations-v15.js";
import { WorkspaceStore } from "../src/workspace.js";
import { migrateDatabase } from "../src/migrations.js";
import { hash } from "../src/engine.js";
test("sales v18 migration preserves conflicting historical offers without inventing approvals and rolls back DDL failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sales-v17-")),
    path = join(dir, "operations.sqlite"),
    db = operationsV15(path);
  try {
    // Literal v16/v17 DDL from main 529a1e4202a480fe1d06fc6b0046cfc09783d596.
    db.exec(`CREATE TABLE ops_asset_imports(tenant_id TEXT NOT NULL,id TEXT NOT NULL,operation_key TEXT NOT NULL,
      imported_at TEXT NOT NULL,receipt_json TEXT NOT NULL,receipt_hash TEXT NOT NULL,
      PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,operation_key));
      CREATE INDEX ops_asset_import_history ON ops_asset_imports(tenant_id,imported_at,id);
      CREATE TABLE ops_report_previews(tenant_id TEXT NOT NULL,id TEXT NOT NULL,requested_by TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,expires_at TEXT NOT NULL,operation_key TEXT,document_id TEXT,
      PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES ops_entities(tenant_id,id),
      CHECK((operation_key IS NULL) = (document_id IS NULL)));
      CREATE INDEX ops_report_preview_expiry ON ops_report_previews(tenant_id,expires_at) WHERE operation_key IS NULL;
      INSERT INTO schema_versions_operations VALUES(16,'frozen-v16'),(17,'frozen-v17');`);
    const dealId = randomUUID();
    for (let i = 0; i < 2; i++) {
      const e = {
        id: randomUUID(),
        module: "sales",
        title: `SYNTHETIC historical offer ${i}`,
        status: "accepted",
        version: 1,
        data: {
          kind: "offer",
          parentId: dealId,
          scope: "Historical scope",
          value: 100,
          acceptance: { note: "Historical record only" },
        },
        createdAt: "2026-09-08T10:00:00Z",
        updatedAt: "2026-09-08T10:00:00Z",
      };
      db.prepare("INSERT INTO ops_entities VALUES(?,?,?,?,?,?,?,?,?)").run(
        "synthetic-sales",
        e.id,
        e.module,
        e.title,
        e.status,
        1,
        JSON.stringify(e.data),
        e.createdAt,
        e.updatedAt,
      );
      db.prepare("INSERT INTO ops_entity_versions VALUES(?,?,?,?,?)").run(
        "synthetic-sales",
        e.id,
        1,
        JSON.stringify(e),
        hash(e),
      );
    }
    const before = db.prepare("SELECT * FROM ops_entities").all();
    db.exec("CREATE INDEX ops_one_current_sales_offer ON ops_entities(title)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_one_current_sales_offer already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      17,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_one_open_sales_step'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_one_current_sales_offer");
    new WorkspaceStore(path).close();
    new WorkspaceStore(path).close();
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      18,
    );
    assert.deepEqual(db.prepare("SELECT * FROM ops_entities").all(), before);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(
      () =>
        migrateDatabase(db, {
          namespace: "operations",
          migrations: Array.from({ length: 17 }, (_, i) => ({
            version: i + 1,
            name: "historical",
            up() {
              throw Error("Must not run");
            },
          })),
        }),
      /v18 is newer than supported v17/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
