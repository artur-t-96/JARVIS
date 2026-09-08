import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../src/workspace.js";
import { hash } from "../src/engine.js";
import { operationsV12 } from "./helpers/operations-v12.js";
test("v13 rolls back a partial migration and preserves historical orders without inventing cost decisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-v12-")),
    path = join(dir, "operations.sqlite"),
    db = operationsV12(path);
  try {
    const id = randomUUID(),
      entity = {
        id,
        module: "purchases",
        title: "Historical order",
        status: "draft",
        version: 1,
        data: {
          kind: "order",
          description: "Old record",
          quantity: 2,
          budgetAmount: 1200,
          currency: "PLN",
        },
        createdAt: "2026-09-01",
        updatedAt: "2026-09-01",
      };
    db.prepare(
      "INSERT INTO ops_entities VALUES(?,?,'purchases',?,'draft',1,?,?,?)",
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
    db.exec("CREATE INDEX ops_purchase_order_request ON ops_entities(title)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_purchase_order_request already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      12,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='ops_purchase_quote_source'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ops_purchase_order_request");
    const store = new WorkspaceStore(path);
    try {
      const view = store.purchasing(
        {
          id: "reader",
          roles: ["viewer"],
          scopes: ["purchases"],
        },
        id,
      );
      assert.equal(view.legacy, true);
      assert.equal(view.costDecisionCurrent, false);
      assert.equal(view.request, null);
      assert.equal(
        store.tools().find((t) => t.id === "ops.purchases.placeOrder")!.version,
        "5",
      );
    } finally {
      store.close();
    }
    new WorkspaceStore(path).close();
    assert.deepEqual(
      [
        db.prepare("SELECT * FROM ops_entities").all(),
        db.prepare("SELECT * FROM ops_entity_versions").all(),
      ],
      before,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      13,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const insert = (tenant: string, id: string, data: object) =>
      db
        .prepare(
          "INSERT INTO ops_entities VALUES(?,?,'purchases','Synthetic','ordered',1,?,'2026-09-08','2026-09-08')",
        )
        .run(tenant, id, JSON.stringify(data));
    const order = { kind: "order", requestId: "need", procurementVersion: 1 };
    insert("a", "one", order);
    assert.throws(() => insert("a", "two", order), /UNIQUE/);
    insert("b", "two", order);
    const quote = {
      kind: "quote",
      requestId: "need",
      supplierId: "supplier",
      referenceKey: "ref",
    };
    insert("a", "quote-one", quote);
    assert.throws(() => insert("a", "quote-two", quote), /UNIQUE/);
    insert("b", "quote-two", quote);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
