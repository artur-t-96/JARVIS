import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../src/workspace.js";
import { hash } from "../src/engine.js";
import { operationsV14 } from "./helpers/operations-v14.js";
test("v15 preserves historical seats and unknown costs, with atomic DDL rollback", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-v14-")),
    path = join(dir, "operations.sqlite"),
    db = operationsV14(path);
  try {
    const id = randomUUID(),
      entity = {
        id,
        module: "licenses",
        title: "Historical license",
        status: "active",
        version: 1,
        data: {
          product: "Legacy product",
          totalSeats: 2,
          expiresOn: "2027-01-01",
          assignments: [],
        },
        createdAt: "2026-09-01",
        updatedAt: "2026-09-01",
      };
    db.prepare(
      "INSERT INTO ops_entities VALUES(?,?,'licenses',?,'active',1,?,?,?)",
    ).run(
      "legacy",
      id,
      entity.title,
      JSON.stringify(entity.data),
      entity.createdAt,
      entity.updatedAt,
    );
    db.prepare("INSERT INTO ops_entity_versions VALUES(?,?,1,?,?)").run(
      "legacy",
      id,
      JSON.stringify(entity),
      hash(entity),
    );
    const before = [
      db.prepare("SELECT * FROM ops_entities").all(),
      db.prepare("SELECT * FROM ops_entity_versions").all(),
    ];
    db.exec(
      "CREATE INDEX ops_license_confirmation_source ON ops_entities(title)",
    );
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_license_confirmation_source already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      14,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_license_terms_pool'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_license_confirmation_source");
    const store = new WorkspaceStore(path);
    try {
      const view = store.licenseContracts(
        {
          id: "reader",
          tenantId: "legacy",
          roles: ["viewer"],
          scopes: ["licenses", "purchases"],
        },
        id,
      );
      assert.equal(view.costKnown, false);
      assert.equal(view.terms.length, 0);
      assert.equal(view.pool.data.ownerPrincipalId, undefined);
      assert.equal(view.pool.data.totalSeats, 2);
      assert.equal(view.pool.version, 1);
    } finally {
      store.close();
    }
    new WorkspaceStore(path).close();
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      16,
    );
    assert.deepEqual(
      [
        db.prepare("SELECT * FROM ops_entities").all(),
        db.prepare("SELECT * FROM ops_entity_versions").all(),
      ],
      before,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
