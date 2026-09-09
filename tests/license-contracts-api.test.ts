import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { licenseFixture } from "./helpers/license-fixture.js";
const headers = (id = "manager", tenant = "synthetic-a") => ({
  authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  host: "127.0.0.1:4330",
  origin: "http://127.0.0.1:4330",
});
test("license API isolates financial terms, owner choices and prepared commands from seat-only readers and other tenants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-api-")),
    f = licenseFixture(dir);
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
    const { pool, terms } = await f.seedLicense();
    const proposal = await f.licenseAction(pool.id, "proposeTerms", {
      terms: { ...terms, description: "SYNTHETIC_PRIVATE_LICENSE_COST" },
    });
    f.actor("it-one").scopes = ["licenses"];
    const paths = [
      `/api/licenses/${pool.id}/contracts`,
      `/api/licenses/${proposal.id}/contracts`,
      `/api/workspace/licenses/${proposal.id}`,
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
      const response = await app.inject({ url, headers: headers() });
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.body, /SYNTHETIC_PRIVATE_LICENSE_COST/);
    }
    const list = await app.inject({
      url: "/api/workspace/licenses",
      headers: headers("it-one"),
    });
    assert.equal(list.statusCode, 200);
    assert.doesNotMatch(
      list.body,
      /SYNTHETIC_PRIVATE_LICENSE_COST|totalCostMinor/,
    );
    assert.equal(list.json().items.length, 1);
    assert.equal(
      (
        await app.inject({
          url: "/api/licenses/owners",
          headers: headers("it-one"),
        })
      ).statusCode,
      403,
    );
    const owners = await app.inject({
      url: "/api/licenses/owners",
      headers: headers(),
    });
    assert.deepEqual(owners.json().owners, [
      { id: "manager", label: "manager" },
    ]);
    const command = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-one"),
      payload: {
        toolId: "ops.licenses.proposeTerms",
        input: {
          id: pool.id,
          expectedVersion: f.get("licenses", pool.id).version,
          terms,
        },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(command.statusCode, 403, command.body);
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
