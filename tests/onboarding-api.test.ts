import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { seedOnboarding } from "./helpers/onboarding-fixture.js";

test("onboarding overview requires live full-case and person access, hides unrelated data and limits owner decisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-onboarding-api-")),
    f = custodyFixture(directory),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw new Error("No model called");
        },
      },
    });
  const headers = (id = "manager", tenant = "synthetic-a") => ({
    authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  });
  try {
    const a = await seedOnboarding(f),
      url = `/api/cases/${a.caseId}/onboarding`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    for (const id of ["it-one", "it-two", "observer"])
      assert.equal(
        (await app.inject({ url, headers: headers(id) })).statusCode,
        403,
      );
    assert.equal(
      (await app.inject({ url, headers: headers("manager", "synthetic-b") }))
        .statusCode,
      404,
    );
    const before = a.getCase(),
      response = await app.inject({ url, headers: headers() });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes("PRIVATE_HR_ONBOARDING_SENTINEL"));
    assert.deepEqual(a.getCase(), before, "overview is read-only");
    await a.documents();
    await a.equipment();
    await a.access();
    await a.managerReview();
    await a.complete("ops.cases.submit", {
      id: a.caseId,
      expectedVersion: a.getCase().version,
    });
    const waiting = (await app.inject({ url, headers: headers() })).json()
      .onboarding;
    assert.equal(waiting.stage.id, "awaiting_acceptance");
    assert.equal(waiting.command.action, "review");
    assert.equal(waiting.command.input.expectedVersion, a.getCase().version);
    assert.equal(
      (await app.inject({ url, headers: headers("reviewer") })).json()
        .onboarding.command,
      undefined,
    );
    f.actor("it-two").scopes = ["*"];
    assert.equal(
      (await app.inject({ url, headers: headers("it-two") })).json().onboarding
        .command,
      undefined,
      "another operator cannot decide on behalf of the owner",
    );
    const stalePrincipal = { ...f.actor(), scopes: ["*"] };
    f.actor().scopes = ["cases"];
    assert.equal(
      (await app.inject({ url, headers: headers() })).statusCode,
      403,
    );
    assert.throws(
      () => f.workspace.onboarding(stalePrincipal, a.caseId),
      /dostępu/,
    );
  } finally {
    await app.close();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
