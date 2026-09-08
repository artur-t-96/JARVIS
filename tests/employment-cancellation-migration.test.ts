import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceStore } from "../src/workspace.js";
import { migrateDatabase } from "../src/migrations.js";

test("v11 preserves historical employment and access foreign keys and permits a fresh start after cancellation", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-employment-v11-")),
    path = join(dir, "operations.sqlite"),
    db = new DatabaseSync(path);
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/operations-v9.sql", import.meta.url),
        "utf8",
      ),
    );
    // v10 changed only the ledger; file provenance is stored outside this schema.
    db.exec(
      "INSERT INTO schema_versions_operations VALUES(10,'frozen-v10'); PRAGMA foreign_keys=ON;",
    );
    for (const [id, module] of [
      ["person", "people"],
      ["case", "cases"],
      ["app", "it"],
    ])
      db.prepare(
        "INSERT INTO ops_entities VALUES('synthetic',?,?,?,'open',1,'{}','2026-09-01','2026-09-01')",
      ).run(id!, module!, id!);
    db.exec(`INSERT INTO ops_employment(tenant_id,id,person_id,kind,start_date,status,role,version,onboarding_case_id,updated_at)
      VALUES('synthetic','episode','person','internal','2026-09-10','onboarding','Historical role',3,'case','2026-09-02');
      INSERT INTO ops_access_grants VALUES('synthetic','grant','app','person','episode','case','member','synthetic-account','active',1,'{}','historical-hash','event');
      INSERT INTO ops_access_events VALUES('synthetic','event','grant',1,'{}','historical-event-hash','historical-operation');`);
    const employment = db.prepare("SELECT * FROM ops_employment").all(),
      entities = db.prepare("SELECT * FROM ops_entities ORDER BY id").all(),
      grants = db.prepare("SELECT * FROM ops_access_grants").all(),
      events = db.prepare("SELECT * FROM ops_access_events").all();
    new WorkspaceStore(path).close();
    new WorkspaceStore(path).close();
    assert.deepEqual(
      db
        .prepare("SELECT * FROM ops_employment")
        .all()
        .map(({ cancellation_json, ...row }) => {
          assert.equal(cancellation_json, null);
          return row;
        }),
      employment,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM ops_entities ORDER BY id").all(),
      entities,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM ops_access_grants").all(),
      grants,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM ops_access_events").all(),
      events,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(
      db
        .prepare("PRAGMA foreign_key_list(ops_access_grants)")
        .all()
        .some((r) => r.table === "ops_employment"),
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      11,
    );
    assert.throws(
      () => db.exec("UPDATE ops_employment SET status='cancelled'"),
      /CHECK/,
    );
    db.exec(`UPDATE ops_employment SET status='cancelled',cancellation_json='{"reason":"Synthetic no start"}';
      INSERT INTO ops_employment(tenant_id,id,person_id,kind,start_date,status,role) VALUES('synthetic','fresh','person','internal','2026-09-10','onboarding','New role');`);
    assert.throws(
      () =>
        db.exec(
          "UPDATE ops_employment SET status='onboarding',cancellation_json=NULL WHERE id='episode'",
        ),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        db.exec("UPDATE ops_access_grants SET employment_episode_id='missing'"),
      /FOREIGN KEY/,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM ops_access_grants").all(),
      grants,
    );
    assert.throws(
      () =>
        migrateDatabase(db, {
          namespace: "operations",
          migrations: Array.from({ length: 10 }, (_, i) => ({
            version: i + 1,
            name: "old",
            up() {
              throw Error("No mutation");
            },
          })),
        }),
      /v11 is newer than supported v10/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a referenced-table rebuild rolls back broken foreign keys and restores enforcement on failure and success", () => {
  const db = new DatabaseSync(":memory:");
  const initial = {
    version: 1,
    name: "parent and child",
    up(d: DatabaseSync) {
      d.exec(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1);",
      );
    },
  };
  try {
    db.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(db, { namespace: "rebuild", migrations: [initial] });
    assert.throws(
      () =>
        migrateDatabase(db, {
          namespace: "rebuild",
          migrations: [
            initial,
            {
              version: 2,
              name: "broken",
              rebuildTables: true,
              up(d) {
                d.exec(
                  "CREATE TABLE replacement(id INTEGER PRIMARY KEY); DROP TABLE parent; ALTER TABLE replacement RENAME TO parent;",
                );
              },
            },
          ],
        }),
      /foreign key references/,
    );
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_rebuild").get()!.n,
      1,
    );
    assert.equal(db.prepare("SELECT id FROM parent").get()!.id, 1);
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name='replacement'")
        .get(),
      undefined,
    );
    assert.throws(() => db.exec("INSERT INTO child VALUES(2)"), /FOREIGN KEY/);
    migrateDatabase(db, {
      namespace: "rebuild",
      migrations: [
        initial,
        {
          version: 2,
          name: "valid",
          rebuildTables: true,
          up(d) {
            d.exec(
              "CREATE TABLE replacement(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO replacement(id) SELECT id FROM parent; DROP TABLE parent; ALTER TABLE replacement RENAME TO parent;",
            );
          },
        },
      ],
    });
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_rebuild").get()!.n,
      2,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => db.exec("DELETE FROM parent"), /FOREIGN KEY/);
  } finally {
    db.close();
  }
});
