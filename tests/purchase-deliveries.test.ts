import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deliveryFixture } from "./helpers/delivery-fixture.js";
import type {
  JsonObject,
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../src/contracts.js";

const asset = (serial: string) => ({
  title: "Synthetic laptop",
  serial,
  assetType: "laptop",
  location: "Synthetic stock",
});
test("two companies receive partial deliveries, reject duplicate documents and keep damage open until confirmed return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-deliveries-")),
    f = deliveryFixture(dir);
  try {
    for (const tenant of ["synthetic-a", "synthetic-b"]) {
      const { order } = await f.order(tenant);
      const input = f.deliveryInput(order.id, "  TEST WZ 001  ", 2, 1, tenant);
      await f.complete(
        "ops.purchases.recordDelivery",
        input,
        "manager",
        tenant,
      );
      let view = f.deliveries(order.id, tenant);
      assert.equal(view.order.status, "needs_resolution");
      assert.equal(view.totals.outstandingQuantity, 1);
      const first = view.receipts[0]!;
      await f.failRun(
        "ops.purchases.recordDelivery",
        {
          ...input,
          documentNumber: "test  wz 001",
          expectedVersion: view.order.version,
        },
        tenant,
      );
      assert.equal(f.deliveries(order.id, tenant).receipts.length, 1);
      await f.complete(
        "ops.purchases.recordDelivery",
        f.deliveryInput(order.id, "TEST WZ 002", 1, 1, tenant),
        "manager",
        tenant,
      );
      view = f.deliveries(order.id, tenant);
      assert.equal(view.order.status, "needs_resolution");
      assert.equal(view.proof.identity.current, false);
      assert.equal(view.totals.outstandingQuantity, 0);
      await f.action(
        order.id,
        "returnRejectedDelivery",
        {
          receiptId: first.id,
          expectedReceiptVersion: first.version,
          returnedOn: "2026-09-08",
          returnReference: "SYNTHETIC RETURN 1",
          evidenceNote: "Synthetic physical return confirmed",
          humanConfirmed: true,
        },
        tenant,
      );
      view = f.deliveries(order.id, tenant);
      assert.equal(view.order.status, "received");
      assert.equal(view.proof.identity.current, true);
      assert.deepEqual(view.totals, {
        physicalQuantity: 3,
        acceptedQuantity: 2,
        confirmedQuantity: 2,
        rejectedQuantity: 1,
        unresolvedQuantity: 0,
        unverifiedLegacyQuantity: 0,
        outstandingQuantity: 0,
      });
      assert.equal(
        f.workspace.list(f.actor("manager", tenant), "assets").length,
        0,
      );
      assert.throws(() =>
        f.workspace.purchaseDeliveries(
          f.actor(
            "manager",
            tenant === "synthetic-a" ? "synthetic-b" : "synthetic-a",
          ),
          order.id,
        ),
      );
    }
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepted units create identified equipment atomically, with bounded quantities and normalized serial uniqueness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-receipt-assets-")),
    f = deliveryFixture(dir),
    db = new DatabaseSync(join(dir, "operations.sqlite"));
  try {
    const { order } = await f.order();
    await f.complete(
      "ops.purchases.recordDelivery",
      f.deliveryInput(order.id, "WZ ASSETS", 2),
    );
    const receipt = f.deliveries(order.id).receipts[0]!;
    const input: JsonObject = {
      id: order.id,
      expectedVersion: f.get("purchases", order.id).version,
      receiptId: receipt.id,
      expectedReceiptVersion: receipt.version,
      assets: [asset("SYNTHETIC-ONE"), asset("synthetic-one")],
      evidenceNote: "Synthetic count and serials checked",
      humanConfirmed: true,
    };
    const counts = () =>
      [
        "ops_entities",
        "ops_entity_versions",
        "ops_asset_register_events",
        "ops_commands",
        "ops_audit",
        "ops_outbox",
      ].map((t) => db.prepare(`SELECT count(*) n FROM ${t}`).get()!.n);
    const before = counts();
    await f.failRun("ops.purchases.registerDeliveredAssets", input);
    assert.deepEqual(
      counts(),
      before,
      "second serial conflict rolls back first asset and every side record",
    );
    await f.complete("ops.purchases.registerDeliveredAssets", {
      ...input,
      assets: [asset("SYNTHETIC-ONE"), asset("SYNTHETIC-TWO")],
    });
    const view = f.deliveries(order.id),
      saved = view.receipts[0]!;
    assert.equal((saved.data.assetIds as string[]).length, 2);
    const equipment = f.workspace.list(f.actor(), "assets");
    assert.equal(equipment.length, 2);
    assert.deepEqual(
      equipment.map((e) => (e.data.purchaseOrigin as JsonObject).unit).sort(),
      [1, 2],
    );
    assert.ok(
      equipment.every(
        (e) =>
          e.status === "available" &&
          f.workspace.assetRegister(f.actor(), e.id).consistent,
      ),
    );
    assert.equal(view.proof.hash, f.deliveries(order.id).proof.hash);
    await f.failRun("ops.purchases.registerDeliveredAssets", {
      ...input,
      expectedReceiptVersion: saved.version,
      assets: [asset("SYNTHETIC-THREE")],
    });
    assert.equal(f.workspace.list(f.actor(), "assets").length, 2);
    await f.failRun("ops.assets.create", {
      title: "Duplicate normalized serial",
      data: {
        serial: "  synthetic-one  ",
        assetType: "laptop",
        location: "Stock",
        condition: "good",
      },
    });
    assert.equal(f.workspace.list(f.actor(), "assets").length, 2);
  } finally {
    db.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delivery evidence belongs to the precise case requirement; an unrelated purchase and an incomplete receipt cannot satisfy it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-delivery-evidence-")),
    f = deliveryFixture(dir);
  try {
    const run = await f.complete("ops.cases.create", {
      title: "Synthetic procurement case",
      data: {
        caseType: "procurement",
        brief: "Two laptops",
        acceptanceCriteria: "Confirmed receipt",
        requirements: [
          {
            key: "delivery",
            title: "Both laptops received",
            kind: "delivery_received",
            required: true,
            expected: {},
          },
        ],
      },
    });
    const id = String(run.steps[0]!.output!.data.entityId),
      requirement = f.workspace.readiness(f.actor(), id).requirements[0]!;
    const { order } = await f.order("synthetic-a", {
      caseId: id,
      caseScopeRevision: 1,
      caseRequirementId: requirement.id,
    });
    const binding = (): JsonObject => ({
      id,
      expectedVersion: f.get("cases", id).version,
      requirementId: requirement.id,
      sourceModule: "purchases",
      sourceId: order.id,
      sourceVersion: f.deliveries(order.id).proof.version,
    });
    await f.complete(
      "ops.purchases.recordDelivery",
      f.deliveryInput(order.id, "WZ CASE 1", 1),
    );
    await f.failRun("ops.cases.bindEvidence", binding());
    await f.complete(
      "ops.purchases.recordDelivery",
      f.deliveryInput(order.id, "WZ CASE 2", 1),
    );
    const other = await f.order();
    await f.complete(
      "ops.purchases.recordDelivery",
      f.deliveryInput(other.order.id, "WZ OTHER", 2),
    );
    await f.failRun("ops.cases.bindEvidence", {
      ...binding(),
      sourceId: other.order.id,
      sourceVersion: f.deliveries(other.order.id).proof.version,
    });
    await f.complete("ops.cases.bindEvidence", binding());
    assert.equal(
      f.workspace.readiness(f.actor(), id).requirements[0]!.status,
      "satisfied",
    );
    const before = f.deliveries(order.id).proof.hash,
      receipt = f.deliveries(order.id).receipts[0]!;
    await f.action(order.id, "registerDeliveredAssets", {
      receiptId: receipt.id,
      expectedReceiptVersion: receipt.version,
      assets: [asset("CASE-LAPTOP")],
      evidenceNote: "Synthetic registration",
      humanConfirmed: true,
    });
    assert.equal(
      f.deliveries(order.id).proof.hash,
      before,
      "stock registration does not rewrite physical receipt evidence",
    );
    assert.equal(
      f.workspace.readiness(f.actor(), id).requirements[0]!.status,
      "satisfied",
    );
    const c = f.get("cases", id);
    await f.complete("ops.cases.revise", {
      id,
      expectedVersion: c.version,
      brief: "Changed scope",
      acceptanceCriteria: "Fresh receipt proof",
      reason: "Synthetic change",
      requirements: [
        {
          key: "delivery",
          title: "New scope delivery",
          kind: "delivery_received",
          required: true,
          expected: { purchaseId: order.id },
        },
      ],
    });
    const fresh = f.workspace.readiness(f.actor(), id).requirements[0]!;
    await f.failRun("ops.cases.bindEvidence", {
      ...binding(),
      requirementId: fresh.id,
    });
    assert.equal(
      f.workspace.readiness(f.actor(), id).requirements[0]!.status,
      "missing",
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lost receipt response is reconciled after restart without another delivery; current authority and tampering remain enforced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-delivery-recovery-"));
  let writes = 0,
    receipt: {
      tool: ToolDefinition;
      ctx: ToolContext;
      input: JsonObject;
      result: ToolResult;
    };
  const wrap = (tool: ToolDefinition): ToolDefinition =>
    tool.id !== "ops.purchases.recordDelivery"
      ? tool
      : {
          ...tool,
          execute: async (ctx, input) => {
            writes++;
            const result = await tool.execute(ctx, input);
            receipt = { tool, ctx, input, result };
            throw Error("Synthetic lost response after durable commit");
          },
        };
  let f = deliveryFixture(dir, { wrap });
  const db = new DatabaseSync(join(dir, "operations.sqlite"));
  try {
    const { order } = await f.order();
    const run = await f.stage(
      "ops.purchases.recordDelivery",
      f.deliveryInput(order.id, "WZ RESTART", 2),
    );
    f.approve(run);
    await f.engine.tick();
    assert.equal(
      f.engine.getRun(f.actor(), run.id).status,
      "needs_reconciliation",
    );
    const saved = f.deliveries(order.id);
    f.close();
    f = deliveryFixture(dir, { wrap });
    f.actor("reviewer").scopes = [];
    f.engine.retry(f.actor(), run.id);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), run.id).status, "completed");
    assert.equal(writes, 1);
    assert.deepEqual(f.deliveries(order.id), saved);
    f.actor("reviewer").scopes = ["*"];
    f.engine.retry(f.actor(), run.id);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), run.id).status, "completed");
    assert.equal(writes, 1);
    assert.deepEqual(f.deliveries(order.id), saved);
    const native = f.tools.find(
      (t) => t.id === "ops.purchases.recordDelivery",
    )!;
    db.prepare(
      "UPDATE ops_entities SET data_json=json_set(data_json,'$.attestation.quantityAccepted',99) WHERE id=?",
    ).run(saved.receipts[0]!.id);
    assert.throws(() => f.deliveries(order.id));
    await assert.rejects(
      () => native.verify!(receipt!.ctx, receipt!.input, receipt!.result),
      { code: "PURCHASE_STATE_INCONSISTENT" },
    );
  } finally {
    db.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
