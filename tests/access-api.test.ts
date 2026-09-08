import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { seedAccess, accessInput } from "./helpers/access-fixture.js";
test("access API protects full case evidence and IT configuration behind current scopes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-access-api-")),
    f = custodyFixture(directory);
  const app = createApp({
    ...f,
    planner: {
      kind: "test",
      async plan() {
        throw new Error("Unused model");
      },
    },
  });
  const headers = (id = "manager", tenant = "synthetic-a") => ({
    authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  });
  try {
    const s = await seedAccess(f),
      url = `/api/cases/${s.caseId}/access`;
    assert.equal(
      (await app.inject({ url, headers: headers("it-one") })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url, headers: headers("manager", "synthetic-b") }))
        .statusCode,
      404,
    );
    assert.equal((await app.inject({ url })).statusCode, 401);
    const denied = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-one"),
      payload: {
        toolId: "ops.cases.attestAccess",
        input: accessInput(f, s),
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.doesNotMatch(denied.body, /PRIVATE_HR_|SYNTHETIC CUSTODY RECIPIENT/);
    const config = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-one"),
      payload: {
        toolId: "ops.it.create",
        input: {
          title: "Synthetic unauthorized application",
          data: {
            kind: "application",
            description: "test",
            applicationKey: "unauthorized",
            supportedRoles: ["member"],
          },
        },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(config.statusCode, 403, config.body);
    await f.complete("ops.cases.attestAccess", accessInput(f, s));
    const read = await app.inject({ url, headers: headers() });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().access.grants[0].events[0].approvedBy, "reviewer");
    f.actor().scopes = ["cases", "people"];
    assert.equal(
      (await app.inject({ url, headers: headers() })).statusCode,
      403,
    );
  } finally {
    await app.close();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
