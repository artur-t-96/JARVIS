import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { deliveryFixture } from "./helpers/delivery-fixture.js";
const headers = (id = "manager", tenant = "synthetic-a") => ({
  authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  host: "127.0.0.1:4330",
  origin: "http://127.0.0.1:4330",
});
test("receipt endpoints isolate companies and case data; equipment registration rechecks both purchase and asset authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-delivery-api-")),
    f = deliveryFixture(dir);
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
      { order } = await f.order("synthetic-a", {
        caseId: seeded.caseId,
        caseScopeRevision: 1,
      });
    await f.complete(
      "ops.purchases.recordDelivery",
      f.deliveryInput(order.id, "API WZ 1", 2),
    );
    const url = `/api/purchases/${order.id}/deliveries`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal(
      (await app.inject({ url, headers: headers("manager", "synthetic-b") }))
        .statusCode,
      404,
    );
    f.actor("it-one").scopes = ["purchases"];
    assert.equal(
      (await app.inject({ url, headers: headers("it-one") })).statusCode,
      403,
    );
    const response = await app.inject({ url, headers: headers() });
    assert.equal(response.statusCode, 200, response.body);
    const { deliveries } = response.json();
    assert.equal(deliveries.totals.confirmedQuantity, 2);
    assert.doesNotMatch(
      response.body,
      /PRIVATE_HR_ROLE_SENTINEL|PRIVATE_HR_CUSTODY_SENTINEL/,
    );
    f.actor("it-one").scopes = ["purchases", "people", "cases"];
    const input = {
      id: order.id,
      expectedVersion: deliveries.order.version,
      receiptId: deliveries.receipts[0].id,
      expectedReceiptVersion: deliveries.receipts[0].version,
      assets: [
        {
          title: "Synthetic delivered laptop",
          serial: "API-LAPTOP",
          assetType: "laptop",
          location: "Stock",
        },
      ],
      evidenceNote: "Synthetic serial witnessed",
      humanConfirmed: true,
    };
    const denied = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-one"),
      payload: {
        toolId: "ops.purchases.registerDeliveredAssets",
        input,
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const pending = await f.stage(
      "ops.purchases.registerDeliveredAssets",
      input,
    );
    f.approve(pending);
    f.actor("reviewer").scopes = ["purchases", "people", "cases"];
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), pending.id).status, "completed");
    assert.equal(
      (f.get("purchases", deliveries.receipts[0].id).data.assetIds as string[])
        .length,
      0,
    );
    const before = f.get("purchases", order.id);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers(),
      payload: {
        toolId: "ops.purchases.recordDelivery",
        input: f.deliveryInput(order.id, "api wz 1", 2),
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(duplicate.statusCode, 201, duplicate.body);
    f.actor("reviewer").scopes = ["*"];
    const duplicateRun = duplicate.json().run;
    f.engine.start(f.actor(), duplicateRun.id);
    await f.engine.tick();
    f.approve(f.engine.getRun(f.actor(), duplicateRun.id));
    for (let i = 0; i < 3; i++) await f.engine.tick();
    assert.notEqual(
      f.engine.getRun(f.actor(), duplicateRun.id).status,
      "completed",
    );
    assert.deepEqual(f.get("purchases", order.id), before);
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
