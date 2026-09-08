import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { itCaseFixture } from "./helpers/it-case-fixture.js";

const headers = (id = "manager", tenant = "synthetic-a") => ({
  authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  host: "127.0.0.1:4330",
  origin: "http://127.0.0.1:4330",
});
test("IT case API isolates firms, denies narrow IT repair and applies live revocation after approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-it-api-")),
    f = await itCaseFixture(dir),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw Error("No provider needed");
        },
      },
    });
  try {
    const caseId = await f.open(),
      url = `/api/cases/${caseId}/laboratory`;
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
              toolId: "lab.repairCase",
              input: f.view(caseId).repairInput,
              idempotencyKey: randomUUID(),
            },
          })
        ).statusCode,
        403,
      );
    }
    const read = (await app.inject({ url, headers: headers() })).json()
      .laboratoryCase;
    assert.equal(read.context.targetId, "jarvis-local-service");
    assert.equal(read.readiness.ready, false);
    assert.equal(
      (await app.inject({ url: "/api/laboratory", headers: headers("it-one") }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({ url: "/api/laboratory", headers: headers("it-one") })
      ).json().laboratory.activeCase,
      null,
    );
    const run = await f.stage("lab.repairCase", read.repairInput);
    f.approve(run);
    f.actor("reviewer").scopes = ["it"];
    for (let i = 0; i < 4; i++) await f.engine.tick();
    const result = f.engine.getRun(f.actor(), run.id);
    assert.notEqual(result.status, "completed");
    assert.equal((await f.inspect()).version, 0);
    assert.equal(f.view(caseId).proofs.length, 0);
  } finally {
    await app.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API requires exact proof hash and never accepts a generic IT record or an arbitrary target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-it-source-")),
    f = await itCaseFixture(dir),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw Error("No provider needed");
        },
      },
    });
  try {
    const caseId = await f.open(),
      input = f.view(caseId).repairInput;
    const invalid = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers(),
      payload: {
        toolId: "lab.repairCase",
        input: { ...input, targetId: "https://other-system.invalid" },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(invalid.statusCode, 400);
    await f.complete("lab.repairCase", input);
    const proof = f.view(caseId).proofs[0]!,
      requirementId = f.view(caseId).readiness.requirements[0]!.id;
    const failed = await f.failCommand("ops.cases.bindEvidence", {
      id: caseId,
      expectedVersion: 1,
      requirementId,
      sourceModule: "laboratory",
      sourceId: proof.id,
      sourceVersion: 1,
      sourceProofHash: "0".repeat(64),
    });
    assert.match(failed.steps[0]!.error!, /aktualny pozytywny test/);
    const manual = await f.complete("ops.it.create", {
      title: "Synthetic manual note",
      data: {
        kind: "lab_case",
        description: "Reported repaired",
        environment: "lab",
        severity: "low",
      },
    });
    await assert.rejects(
      f.stage("ops.cases.bindEvidence", {
        id: caseId,
        expectedVersion: 1,
        requirementId,
        sourceModule: "it",
        sourceId: String(manual.steps[0]!.output!.data.entityId),
        sourceVersion: 1,
      }),
      /Warunek nie dotyczy/,
    );
    assert.equal(f.view(caseId).readiness.ready, false);
  } finally {
    await app.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
