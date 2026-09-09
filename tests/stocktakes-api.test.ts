import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { stocktakeFixture } from "./helpers/stocktake-fixture.js";
const headers = (id = "manager", tenant = "synthetic-a") => ({
  authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  host: "127.0.0.1:4330",
  origin: "http://127.0.0.1:4330",
});
test("stocktake API isolates reports and commands, paginates the selected register and rejects identity spoofing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-stocktake-api-")),
    f = stocktakeFixture(dir),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw Error("No provider");
        },
      },
    });
  try {
    const a = await f.newAsset(),
      b = await f.newAsset(),
      spis = await f.open([a.id]);
    f.actor("it-one").scopes = ["inventory"];
    const paths = [
      `/api/inventory/${spis.id}/report`,
      `/api/inventory/${spis.id}/history`,
      `/api/workspace/inventory/${spis.id}`,
    ];
    for (const url of paths) {
      assert.equal((await app.inject({ url })).statusCode, 401);
      assert.equal(
        (await app.inject({ url, headers: headers("it-one") })).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ url, headers: headers("manager", "synthetic-b") }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url, headers: headers("it-two") })).statusCode,
        200,
      );
    }
    assert.equal(
      (await app.inject({ url: "/api/inventory", headers: headers("it-one") }))
        .statusCode,
      403,
    );
    const catalog = await app.inject({
      url: "/api/workspace",
      headers: headers("it-one"),
    });
    assert.equal(catalog.statusCode, 200);
    assert.equal(
      catalog.json().catalog.some((m: { id: string }) => m.id === "inventory"),
      false,
    );
    const page = await app.inject({
      url: "/api/inventory/context?limit=1&offset=1",
      headers: headers("it-two"),
    });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().assets.length, 1);
    assert.equal(page.json().total, 2);
    assert.ok(
      page
        .json()
        .occupancy.some((o: { assetId: string }) => o.assetId === a.id),
    );
    const search = await app.inject({
      url: `/api/inventory/context?search=${encodeURIComponent(String(b.data.serial))}`,
      headers: headers("it-two"),
    });
    assert.equal(search.json().assets[0].id, b.id);
    assert.equal(
      (
        await app.inject({
          url: "/api/inventory/context?limit=0",
          headers: headers(),
        })
      ).statusCode,
      400,
    );
    const owners = page.json().owners.map((p: { id: string }) => p.id);
    assert.deepEqual(owners, ["manager", "it-two"]);
    const command = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-one"),
      payload: {
        toolId: "ops.inventory.create",
        input: f.createInput([b.id]),
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(command.statusCode, 403, command.body);
    const forged = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-two"),
      payload: {
        toolId: "ops.inventory.recordObservation",
        input: { ...f.observeInput(spis.id, a.id), actorId: "forged" },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(forged.statusCode, 400, forged.body);
    assert.equal(f.view(spis.id).observed, 0);
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
