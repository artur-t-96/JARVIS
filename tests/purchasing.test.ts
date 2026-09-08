import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { purchasingFixture } from "./helpers/purchasing-fixture.js";
import { custodyNow } from "./helpers/custody-fixture.js";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  JsonObject,
} from "../src/contracts.js";

test("two firms compare offers, choose explicitly, approve cost and record a single local order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchasing-")),
    f = purchasingFixture(dir);
  try {
    for (const tenant of ["synthetic-a", "synthetic-b"]) {
      const { request, quote, supplier } = await f.seedPurchase(tenant);
      const second = await f.create(
        "Other supplier",
        { kind: "supplier", description: "Synthetic" },
        tenant,
      );
      await f.create(
        "Other offer",
        f.quotation(request.id, second.id, tenant, { unitPriceMinor: 430000 }),
        tenant,
      );
      const initial = f.view(request.id, tenant);
      assert.equal(initial.quotes.length, 2);
      assert.equal(initial.costDecisionCurrent, false);
      await f.select(request.id, quote.id, tenant);
      assert.equal(f.view(request.id, tenant).costDecisionCurrent, false);
      await f.approveCost(request.id, quote.id, tenant);
      assert.equal(f.view(request.id, tenant).costDecisionCurrent, true);
      const input = f.orderInput(request.id, tenant),
        run = await f.complete(
          "ops.purchases.placeOrder",
          input,
          "manager",
          tenant,
        );
      const ordered = f.get("purchases", request.id, tenant),
        orderId = String(ordered.data.orderId),
        order = f.get("purchases", orderId, tenant);
      assert.equal(order.status, "ordered");
      assert.equal(order.data.totalMinor, 810000);
      assert.equal(order.data.dispatch, "not_sent_local_record");
      assert.equal(order.data.supplierId, supplier.id);
      assert.equal(order.data.receivedQuantity, 0);
      assert.equal(
        f.workspace.list(f.actor("manager", tenant), "assets").length,
        0,
      );
      assert.equal(f.view(orderId, tenant).costDecisionCurrent, true);
      await f.failRun(
        "ops.purchases.placeOrder",
        { ...input, expectedVersion: ordered.version },
        tenant,
      );
      assert.equal(
        f.workspace
          .list(f.actor("manager", tenant), "purchases")
          .filter((e) => e.data.kind === "order").length,
        1,
      );
      assert.equal(run.steps[0]!.attempts, 1);
      assert.throws(() =>
        f.workspace.purchasing(
          f.actor(
            "manager",
            tenant === "synthetic-a" ? "synthetic-b" : "synthetic-a",
          ),
          request.id,
        ),
      );
    }
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncomparable, over-budget, late and withdrawn quotes cannot be selected; duplicate source uses a revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-gates-")),
    f = purchasingFixture(dir);
  try {
    const { request, supplier, quote } = await f.seedPurchase();
    for (const override of [
      { currency: "EUR" },
      { priceBasis: "net" },
      { quantity: 1 },
      { unitPriceMinor: 600000 },
      { expectedDelivery: "2026-09-21" },
    ]) {
      const bad = await f.create(
        "Non-comparable offer",
        f.quotation(request.id, supplier.id, "synthetic-a", override),
      );
      const view = f.view(request.id);
      assert.equal(
        view.quotes.find((x) => x.quote.id === bad.id)!.eligible,
        false,
      );
      await f.failRun("ops.purchases.selectQuote", {
        id: request.id,
        expectedVersion: f.get("purchases", request.id).version,
        quoteId: bad.id,
        expectedQuoteVersion: bad.version,
        selectionReason: "Must fail",
      });
    }
    await f.failRun("ops.purchases.create", {
      title: "Duplicate",
      data: f.quotation(request.id, supplier.id, "synthetic-a", {
        quoteReference: quote.data.quoteReference!,
      }),
    });
    await f.action(quote.id, "withdrawQuote", {
      expectedRequestVersion: f.get("purchases", request.id).version,
      reason: "Withdrawn",
    });
    assert.equal(
      f.view(request.id).quotes.find((x) => x.quote.id === quote.id)!.eligible,
      false,
    );
    assert.throws(() =>
      f.engine.createRun(
        f.actor(),
        "No direct order",
        {
          title: "Invalid",
          summary: "Invalid",
          steps: [
            {
              id: "x",
              title: "x",
              toolId: "ops.purchases.create",
              input: {
                title: "Bypass",
                data: {
                  kind: "order",
                  supplierId: supplier.id,
                  description: "Invalid",
                  quantity: 2,
                },
              },
            },
          ],
        },
        "bypass-order",
      ),
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote changes invalidate a selected approval and a staged order; rejected cost needs a new decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-revision-")),
    f = purchasingFixture(dir);
  try {
    const { request, quote, supplier } = await f.seedPurchase();
    await f.select(request.id, quote.id);
    await f.action(request.id, "decideCost", {
      quoteId: quote.id,
      expectedQuoteVersion: quote.version,
      decision: "rejected",
      note: "Choose again",
      humanDecision: true,
    });
    assert.equal(f.get("purchases", request.id).status, "needs_changes");
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    const staged = await f.stage(
      "ops.purchases.placeOrder",
      f.orderInput(request.id),
    );
    const {
      kind: _kind,
      requestId: _id,
      ...fields
    } = f.quotation(request.id, supplier.id, "synthetic-a", {
      quoteReference: quote.data.quoteReference!,
      unitPriceMinor: 420000,
    });
    await f.action(quote.id, "reviseQuote", {
      ...fields,
      reason: "Price updated",
    });
    assert.equal(f.get("purchases", quote.id).version, 2);
    assert.equal(f.view(request.id).costDecisionCurrent, false);
    f.approve(staged);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), staged.id).status, "completed");
    assert.equal(
      f.workspace
        .list(f.actor(), "purchases")
        .filter((e) => e.data.kind === "order").length,
      0,
    );
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    await f.complete("ops.purchases.placeOrder", f.orderInput(request.id));
    assert.equal(
      f.get("purchases", String(f.get("purchases", request.id).data.orderId))
        .data.totalMinor,
      850000,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expiry, changed supplier, revoked cost authority and cancelled request block ordering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-authority-"));
  let now = custodyNow;
  const f = purchasingFixture(dir, { domainClock: () => now });
  try {
    const { request, quote, supplier } = await f.seedPurchase();
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    now = Date.parse("2026-10-01T10:00:00Z");
    assert.equal(f.view(request.id).costDecisionCurrent, false);
    await f.failRun("ops.purchases.placeOrder", f.orderInput(request.id));
    now = custodyNow;
    await f.action(supplier.id, "update", { title: "Changed supplier" });
    assert.equal(f.view(request.id).costDecisionCurrent, false);
    await f.failRun("ops.purchases.placeOrder", f.orderInput(request.id));
    const clean = await f.seedPurchase();
    await f.select(clean.request.id, clean.quote.id);
    await f.approveCost(clean.request.id, clean.quote.id);
    const staged = await f.stage(
      "ops.purchases.placeOrder",
      f.orderInput(clean.request.id),
    );
    f.approve(staged);
    f.actor("reviewer").roles = ["viewer"];
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), staged.id).status, "completed");
    assert.equal(f.view(clean.request.id).costDecisionCurrent, false);
    f.actor("reviewer").roles = ["approver"];
    await f.action(clean.request.id, "cancel", { reason: "No longer needed" });
    await f.failRun("ops.purchases.placeOrder", f.orderInput(clean.request.id));
    assert.equal(
      f.workspace
        .list(f.actor(), "purchases")
        .filter((e) => e.data.kind === "order").length,
      0,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart reconciles a lost order response from durable domain storage without a second order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-recovery-"));
  let writes = 0,
    lose = true;
  const wrap = (tool: ToolDefinition): ToolDefinition =>
    tool.id === "ops.purchases.placeOrder"
      ? {
          ...tool,
          execute: async (ctx, input) => {
            writes++;
            const result = await tool.execute(ctx, input);
            if (lose) {
              lose = false;
              throw Error("Synthetic lost response after commit");
            }
            return result;
          },
        }
      : tool;
  let f = purchasingFixture(dir, { wrap });
  try {
    const { request, quote } = await f.seedPurchase();
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    const staged = await f.stage(
      "ops.purchases.placeOrder",
      f.orderInput(request.id),
    );
    f.approve(staged);
    await f.engine.tick();
    assert.equal(
      f.engine.getRun(f.actor(), staged.id).status,
      "needs_reconciliation",
    );
    const saved = f.get("purchases", request.id),
      order = f.get("purchases", String(saved.data.orderId));
    f.close();
    f = purchasingFixture(dir, { wrap });
    f.engine.retry(f.actor(), staged.id);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), staged.id).status, "completed");
    assert.equal(writes, 1);
    assert.deepEqual(f.get("purchases", order.id), order);
    assert.deepEqual(f.get("purchases", request.id), saved);
    assert.equal(
      f.workspace
        .list(f.actor(), "purchases")
        .filter((e) => e.data.kind === "order").length,
      1,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tampered quote and order records fail independent reads and receipt reconciliation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-integrity-"));
  let receipt: {
    tool: ToolDefinition;
    ctx: ToolContext;
    input: JsonObject;
    result: ToolResult;
  };
  const f = purchasingFixture(dir, {
    wrap: (tool) =>
      tool.id === "ops.purchases.placeOrder"
        ? {
            ...tool,
            execute: async (ctx, input) => {
              const result = await tool.execute(ctx, input);
              receipt = { tool, ctx, input, result };
              return result;
            },
          }
        : tool,
  });
  const db = new DatabaseSync(join(dir, "operations.sqlite"));
  try {
    const { request, quote } = await f.seedPurchase();
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    await f.complete("ops.purchases.placeOrder", f.orderInput(request.id));
    const orderId = String(f.get("purchases", request.id).data.orderId);
    db.prepare(
      "UPDATE ops_entities SET data_json=json_set(data_json,'$.totalMinor',1) WHERE id=?",
    ).run(orderId);
    assert.throws(() => f.view(orderId), /histori/);
    await assert.rejects(
      receipt!.tool.reconcile(receipt!.ctx, receipt!.input),
      /histori/,
    );
    await assert.rejects(
      receipt!.tool.verify(receipt!.ctx, receipt!.input, receipt!.result),
      /histori/,
    );
    db.prepare(
      "UPDATE ops_entities SET data_json=json_set(data_json,'$.unitPriceMinor',1) WHERE id=?",
    ).run(quote.id);
    assert.throws(() => f.view(request.id), /histori/);
  } finally {
    db.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revised request invalidates all old offers, supports clearing equipment kind, and preserves quote source identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-scope-")),
    f = purchasingFixture(dir);
  try {
    const { request, supplier, quote } = await f.seedPurchase();
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    await f.action(request.id, "reviseRequest", {
      description: "General office purchase",
      quantity: 2,
      budgetMinor: 1100000,
      currency: "PLN",
      priceBasis: "gross",
      requiredBy: "2026-09-21",
      reason: "Scope changed",
    });
    assert.equal(f.get("purchases", request.id).data.assetType, undefined);
    assert.equal(f.view(request.id).quotes[0]!.eligible, false);
    assert.equal(f.view(request.id).costDecisionCurrent, false);
    const {
      kind: _kind,
      requestId: _id,
      ...input
    } = f.quotation(request.id, supplier.id, "synthetic-a", {
      quoteReference: quote.data.quoteReference!,
    });
    await f.action(quote.id, "reviseQuote", {
      ...input,
      reason: "Offer for new scope",
    });
    assert.equal(f.view(request.id).quotes[0]!.eligible, true);
    await f.failRun("ops.purchases.reviseQuote", {
      id: quote.id,
      expectedVersion: 2,
      ...input,
      expectedRequestVersion: f.get("purchases", request.id).version,
      quoteReference: "Different source",
      reason: "Cannot rewrite reference",
    });
    assert.equal(f.get("purchases", quote.id).version, 2);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refused operations have no attempt; cost owner and current case scope are enforced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-owner-")),
    f = purchasingFixture(dir);
  try {
    const seeded = await f.seed();
    const supplier = await f.create("Supplier", {
      kind: "supplier",
      description: "Synthetic",
    });
    const request = await f.create("Linked need", {
      kind: "request",
      description: "For onboarding",
      quantity: 2,
      budgetMinor: 1000000,
      currency: "PLN",
      priceBasis: "gross",
      requiredBy: "2026-09-20",
      assetType: "laptop",
      caseId: seeded.caseId,
      caseScopeRevision: 1,
    });
    const quote = await f.create("Offer", f.quotation(request.id, supplier.id));
    await f.select(request.id, quote.id);
    f.actor("it-two").scopes = ["*"];
    const wrongOwner = await f.stage(
      "ops.purchases.decideCost",
      {
        id: request.id,
        expectedVersion: f.get("purchases", request.id).version,
        quoteId: quote.id,
        expectedQuoteVersion: quote.version,
        decision: "approved",
        note: "Not the owner",
        humanDecision: true,
      },
      "it-two",
    );
    f.approve(wrongOwner);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(
      f.engine.getRun(f.actor(), wrongOwner.id).status,
      "completed",
    );
    await f.approveCost(request.id, quote.id);
    const refused = await f.stage(
      "ops.purchases.placeOrder",
      f.orderInput(request.id),
    );
    const approval = refused.steps[0]!.approval!;
    f.engine.approve(f.actor("reviewer"), refused.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "rejected",
    });
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), refused.id).steps[0]!.attempts, 0);
    const source = f.get("cases", seeded.caseId);
    await f.complete("ops.cases.revise", {
      id: source.id,
      expectedVersion: source.version,
      brief: "Changed onboarding scope",
      acceptanceCriteria: "Updated evidence",
      reason: "Synthetic changed need",
    });
    assert.match(f.view(request.id).problems.join(" "), /Zakres/);
    await f.failRun("ops.purchases.placeOrder", f.orderInput(request.id));
    assert.equal(
      f.workspace
        .list(f.actor(), "purchases")
        .filter((x) => x.data.kind === "order").length,
      0,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed order transaction rolls back both entities, snapshots, audit and outbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-rollback-")),
    f = purchasingFixture(dir),
    db = new DatabaseSync(join(dir, "operations.sqlite"));
  try {
    const { request, quote } = await f.seedPurchase();
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    const snapshot = () =>
      [
        "ops_entities",
        "ops_entity_versions",
        "ops_commands",
        "ops_audit",
        "ops_outbox",
      ].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER fail_order_parent BEFORE UPDATE ON ops_entities WHEN json_extract(NEW.data_json,'$.kind')='request' AND NEW.status='ordered' BEGIN SELECT RAISE(ABORT,'synthetic parent commit failure'); END",
    );
    await f.failRun("ops.purchases.placeOrder", f.orderInput(request.id));
    assert.deepEqual(snapshot(), before);
    db.exec("DROP TRIGGER fail_order_parent");
    await f.complete("ops.purchases.placeOrder", f.orderInput(request.id));
    assert.equal(
      f.workspace
        .list(f.actor(), "purchases")
        .filter((x) => x.data.kind === "order").length,
      1,
    );
  } finally {
    db.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
