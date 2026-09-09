import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceStore } from "../src/workspace.js";
import { migrateDatabase } from "../src/migrations.js";
test("File migration chain preserves frozen v9 records and unrelated schemas and rejects a file-unaware runtime", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-document-files-v9-")),
    path = join(dir, "operations.sqlite"),
    db = new DatabaseSync(path);
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/operations-v9.sql", import.meta.url),
        "utf8",
      ),
    );
    db.prepare(
      "INSERT INTO ops_entities VALUES('synthetic','historical-file-free','documents','Original content','draft',1,?,'2026-09-01','2026-09-01')",
    ).run(
      JSON.stringify({
        content: "Historical file-free revision",
        sourceContract: "p09a1",
        revision: 1,
      }),
    );
    const schema = db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN('ops_employment','ops_one_open_internal','ops_one_open_engagement','ops_open_laboratory_case','ops_purchase_quote_source','ops_purchase_order_request','ops_delivery_document_line','ops_delivery_order','ops_license_terms_pool','ops_license_confirmation_source') ORDER BY name",
        )
        .all(),
      records = db.prepare("SELECT * FROM ops_entities").all();
    new WorkspaceStore(path).close();
    new WorkspaceStore(path).close();
    assert.deepEqual(
      db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN('ops_employment','ops_one_open_internal','ops_one_open_engagement','ops_open_laboratory_case','ops_purchase_quote_source','ops_purchase_order_request','ops_delivery_document_line','ops_delivery_order','ops_license_terms_pool','ops_license_confirmation_source') ORDER BY name",
        )
        .all(),
      schema,
    );
    assert.deepEqual(db.prepare("SELECT * FROM ops_entities").all(), records);
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      15,
    );
    assert.throws(
      () =>
        migrateDatabase(db, {
          namespace: "operations",
          migrations: Array.from({ length: 9 }, (_, i) => ({
            version: i + 1,
            name: "Historical runtime",
            up() {
              throw Error("Must not mutate");
            },
          })),
        }),
      /v15 is newer than supported v9/,
    );
    assert.deepEqual(db.prepare("SELECT * FROM ops_entities").all(), records);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
