import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { purchasingFixture } from "./helpers/purchasing-fixture.js";
const headers = (id = "manager", tenant = "synthetic-a") => ({
  authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  host: "127.0.0.1:4330",
  origin: "http://127.0.0.1:4330",
});
test("purchasing API applies tenant, source-data and live authority boundaries to offers, orders and commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-api-")),
    f = purchasingFixture(dir);
  const app = createApp({
    ...f,
    planner: {
      kind: "test",
      async plan() {
        throw Error("No provider");
      },
    },
  });
  try {
    const seeded = await f.seed(),
      supplier = await f.create("Supplier", {
        kind: "supplier",
        description: "Synthetic",
      });
    const request = await f.create("HR linked need", {
      kind: "request",
      description: "SYNTHETIC_PRIVATE_NEED",
      quantity: 2,
      budgetMinor: 1000000,
      currency: "PLN",
      priceBasis: "gross",
      requiredBy: "2026-09-20",
      caseId: seeded.caseId,
      caseScopeRevision: 1,
    });
    const quote = await f.create(
      "Private offer",
      f.quotation(request.id, supplier.id),
    );
    await f.select(request.id, quote.id);
    await f.approveCost(request.id, quote.id);
    await f.complete("ops.purchases.placeOrder", f.orderInput(request.id));
    f.actor("it-one").scopes = ["purchases"];
    for (const id of [
      request.id,
      quote.id,
      String(f.get("purchases", request.id).data.orderId),
    ]) {
      const url = `/api/purchases/${id}/workflow`;
      assert.equal((await app.inject({ url })).statusCode, 401);
      assert.equal(
        (await app.inject({ url, headers: headers("manager", "synthetic-b") }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url, headers: headers("it-one") })).statusCode,
        403,
      );
      const read = await app.inject({ url, headers: headers() });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json().purchasing.quotes.length, 1);
    }
    const listed = await app.inject({
      url: "/api/workspace/purchases",
      headers: headers("it-one"),
    });
    assert.equal(listed.statusCode, 200);
    assert.doesNotMatch(listed.body, /SYNTHETIC_PRIVATE_NEED|Private offer/);
    const denied = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-one"),
      payload: {
        toolId: "ops.purchases.create",
        input: { title: "Denied", data: f.quotation(request.id, supplier.id) },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const clean = await f.seedPurchase();
    await f.select(clean.request.id, clean.quote.id);
    await f.approveCost(clean.request.id, clean.quote.id);
    const pending = await f.stage(
      "ops.purchases.placeOrder",
      f.orderInput(clean.request.id),
    );
    f.approve(pending);
    f.actor("manager").scopes = ["it"];
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(
      f.engine.getRun(f.actor("reviewer"), pending.id).status,
      "completed",
    );
    f.actor("manager").scopes = ["*"];
    assert.equal(f.get("purchases", clean.request.id).data.orderId, null);
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
