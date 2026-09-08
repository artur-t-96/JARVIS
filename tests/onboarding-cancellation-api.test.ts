import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApp } from "../src/app.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import {
  configureVariants,
  startVariant,
} from "./helpers/onboarding-variants-fixture.js";
import { seedOnboarding } from "./helpers/onboarding-fixture.js";
import { cancellationInput } from "./helpers/cancellation-fixture.js";

test("cancellation details respect tenant and resource scopes; only the owner can decide and revoked access blocks a waiting write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-api-")),
    f = custodyFixture(dir),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw Error("No model called");
        },
      },
    });
  const headers = (id = "manager", tenant = "synthetic-a") => ({
    authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
    host: "127.0.0.1:4330",
    origin: "http://127.0.0.1:4330",
  });
  try {
    await configureVariants(f);
    const s = await startVariant(f, "internal"),
      url = "/api/cases/" + s.caseId + "/onboarding",
      input = cancellationInput(f, s.caseId),
      before = f.get("cases", s.caseId);
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal(
      (await app.inject({ url, headers: headers("manager", "synthetic-b") }))
        .statusCode,
      404,
    );
    for (const id of ["it-one", "observer"]) {
      assert.equal(
        (await app.inject({ url, headers: headers(id) })).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/commands",
            headers: headers(id),
            payload: {
              toolId: "ops.people.cancelStart",
              input,
              idempotencyKey: randomUUID(),
            },
          })
        ).statusCode,
        403,
      );
    }
    const preview = (await app.inject({ url, headers: headers() })).json()
      .onboarding;
    assert.equal(preview.cancellation.ready, true);
    assert.equal(preview.cancellation.command.toolId, "ops.people.cancelStart");
    assert.equal(
      preview.cancellation.command.input.expectedCaseVersion,
      before.version,
    );
    assert.equal(
      (await app.inject({ url, headers: headers("reviewer") })).json()
        .onboarding.cancellation.command,
      undefined,
    );
    f.actor("it-two").scopes = ["people", "cases"];
    const limited = await app.inject({ url, headers: headers("it-two") });
    assert.equal(limited.statusCode, 200);
    assert.equal(limited.json().onboarding.cancellation, undefined);
    f.actor("it-two").scopes = ["*"];
    assert.equal(
      (await app.inject({ url, headers: headers("it-two") })).json().onboarding
        .cancellation.command,
      undefined,
    );
    const wrongOwner = await f.stage("ops.people.cancelStart", input, "it-two");
    f.approve(wrongOwner);
    await f.engine.tick();
    assert.match(
      f.engine.getRun(f.actor("it-two"), wrongOwner.id).steps[0]!.error!,
      /właściciel/,
    );
    const pending = await f.stage("ops.people.cancelStart", input);
    f.approve(pending);
    f.actor().scopes = ["people", "cases"];
    await f.engine.tick();
    f.actor().scopes = ["*"];
    const stopped = f.engine.getRun(f.actor(), pending.id);
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.steps[0]!.attempts, 0);
    assert.deepEqual(f.get("cases", s.caseId), before);
    const falseClaim = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers(),
      payload: {
        toolId: "ops.people.cancelStart",
        input: { ...input, workNeverStarted: false },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(falseClaim.statusCode, 400);
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a started or offboarding episode cannot be cancelled as an unstarted cooperation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-active-")),
    f = custodyFixture(dir);
  try {
    const s = await seedOnboarding(f);
    await s.documents();
    await s.equipment();
    await s.access();
    await s.managerReview();
    await s.accept();
    await s.complete("ops.people.activate", s.activationInput());
    for (const state of ["active", "offboarding"]) {
      if (state === "offboarding")
        await s.complete("ops.people.beginOffboarding", {
          ...s.activationInput(),
          endDate: "2026-09-09",
          reason: "Synthetic planned departure",
        });
      const before = f.get("people", s.personId),
        o = f.workspace.onboarding(f.actor(), s.caseId);
      assert.equal(o.cancellation, undefined);
      const attempt = await f.stage(
        "ops.people.cancelStart",
        cancellationInput(f, s.caseId),
      );
      f.approve(attempt);
      await f.engine.tick();
      assert.match(
        f.engine.getRun(f.actor(), attempt.id).steps[0]!.error!,
        /nie pozwala/,
      );
      assert.deepEqual(f.get("people", s.personId), before);
    }
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
