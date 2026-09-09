import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApp } from "../src/app.js";
import { prepareDocument } from "../src/artifacts.js";
import { salesFixture } from "./helpers/sales-fixture.js";
const headers = (id = "manager", tenant = "synthetic-a") => ({
  authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  host: "127.0.0.1:4330",
  origin: "http://127.0.0.1:4330",
});
test("sales API isolates contacts, pricing, history, owner choices and offers by company and scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sales-api-")),
    f = salesFixture(dir);
  const app = createApp({
    ...f,
    planner: {
      kind: "test",
      async plan() {
        throw Error("No model");
      },
    },
  });
  try {
    const a = await f.salesSeed(),
      b = await f.salesSeed("synthetic-b");
    for (const path of [
      `/api/sales/${a.offer.id}/workflow`,
      `/api/workspace/sales/${a.offer.id}`,
    ]) {
      assert.equal((await app.inject({ url: path })).statusCode, 401);
      assert.equal(
        (await app.inject({ url: path, headers: headers("it-one") }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: path,
            headers: headers("manager", "synthetic-b"),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: path, headers: headers() })).statusCode,
        200,
      );
    }
    assert.equal(
      (
        await app.inject({
          url: "/api/sales/owners",
          headers: headers("it-one"),
        })
      ).statusCode,
      403,
    );
    const owners = await app.inject({
      url: "/api/sales/owners",
      headers: headers(),
    });
    assert.deepEqual(owners.json().owners, [
      { id: "manager", label: "manager" },
    ]);
    const first = await app.inject({
      url: "/api/sales/records?limit=2",
      headers: headers(),
    });
    const second = await app.inject({
      url: "/api/sales/records?limit=2&offset=2",
      headers: headers(),
    });
    assert.equal(first.json().hasMore, true);
    assert.equal(second.json().hasMore, false);
    assert.equal(
      new Set(
        [...first.json().items, ...second.json().items].map(
          (e: { id: string }) => e.id,
        ),
      ).size,
      4,
    );
    const onlyB = await app.inject({
      url: "/api/sales/records?kind=offer",
      headers: headers("manager", "synthetic-b"),
    });
    assert.deepEqual(
      onlyB.json().items.map((e: { id: string }) => e.id),
      [b.offer.id],
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/sales/records?limit=1000",
          headers: headers(),
        })
      ).statusCode,
      400,
    );
    const command = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-one"),
      payload: {
        toolId: "ops.sales.submitOffer",
        input: { id: a.offer.id, expectedVersion: a.offer.version },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(command.statusCode, 403);
    const draft = prepareDocument(
      f.workspace,
      f.actor(),
      "sales_offer",
      a.offer.id,
    );
    assert.match(
      String((draft.data as Record<string, unknown>).content),
      /620,35 PLN/,
    );
    assert.match(
      String((draft.data as Record<string, unknown>).content),
      /Brak obowiązującej akceptacji/,
    );
    await f.salesSend(a.offer.id);
    await f.salesAccept(a.offer.id);
    const accepted = prepareDocument(
      f.workspace,
      f.actor(),
      "sales_offer",
      a.offer.id,
    );
    assert.match(
      String((accepted.data as Record<string, unknown>).content),
      /Potwierdzona akceptacja klienta/,
    );
    assert.doesNotMatch(
      String((accepted.data as Record<string, unknown>).content),
      /undefined|NaN/,
    );
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
