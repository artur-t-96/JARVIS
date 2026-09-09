import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../src/workspace.js";
import { hash } from "../src/engine.js";
import { operationsV13 } from "./helpers/operations-v13.js";
test("v14 migrates historical receipt counts without invented attestations and rolls back partial DDL", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-delivery-v13-")),
    path = join(dir, "operations.sqlite"),
    db = operationsV13(path);
  try {
    const id = randomUUID(),
      entity = {
        id,
        module: "purchases",
        title: "Legacy received order",
        status: "received",
        version: 3,
        data: {
          kind: "order",
          supplierId: randomUUID(),
          quantity: 2,
          receivedQuantity: 2,
          deliveries: [
            {
              id: randomUUID(),
              quantity: 2,
              receivedOn: "2026-09-01",
              note: "Legacy human note",
              reportedBy: "legacy",
            },
          ],
          acknowledgment: { date: "2026-09-01" },
        },
        createdAt: "2026-09-01",
        updatedAt: "2026-09-01",
      };
    db.prepare(
      "INSERT INTO ops_entities VALUES(?,?,'purchases',?,'received',3,?,?,?)",
    ).run(
      "legacy",
      id,
      entity.title,
      JSON.stringify(entity.data),
      entity.createdAt,
      entity.updatedAt,
    );
    db.prepare("INSERT INTO ops_entity_versions VALUES(?,?,3,?,?)").run(
      "legacy",
      id,
      JSON.stringify(entity),
      hash(entity),
    );
    const before = [
      db.prepare("SELECT * FROM ops_entities").all(),
      db.prepare("SELECT * FROM ops_entity_versions").all(),
    ];
    db.exec("CREATE INDEX ops_delivery_order ON ops_entities(title)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_delivery_order already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      13,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_delivery_document_line'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_delivery_order");
    const store = new WorkspaceStore(path);
    try {
      const view = store.purchaseDeliveries(
        {
          tenantId: "legacy",
          id: "reader",
          roles: ["viewer"],
          scopes: ["purchases"],
        },
        id,
      );
      assert.equal(view.totals.unverifiedLegacyQuantity, 2);
      assert.equal(view.proof.identity.current, false);
      assert.equal(view.receipts.length, 0);
      assert.equal(view.order.version, 3);
    } finally {
      store.close();
    }
    new WorkspaceStore(path).close();
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      14,
    );
    assert.deepEqual(
      [
        db.prepare("SELECT * FROM ops_entities").all(),
        db.prepare("SELECT * FROM ops_entity_versions").all(),
      ],
      before,
    );
    const insert = (tenant: string, id: string, orderId: string) =>
      db
        .prepare(
          "INSERT INTO ops_entities VALUES(?,?,'purchases','Receipt','confirmed',1,?,'2026-09-08','2026-09-08')",
        )
        .run(
          tenant,
          id,
          JSON.stringify({
            kind: "receipt",
            orderId,
            supplierId: "same-supplier",
            documentKey: "wz 1",
            documentLine: 1,
          }),
        );
    insert("a", "first", "order-1");
    assert.throws(() => insert("a", "duplicate", "order-2"), /UNIQUE/);
    insert("b", "other-company", "order-1");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
