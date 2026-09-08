import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { seedTaskAccess, taskWitness } from "./helpers/task-access-fixture.js";
test("HTTP task access remains isolated while IT creates a witnessed command and an independent reviewer approves", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-task-access-api-")),
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
  const headers = (id = "it-one", tenant = "synthetic-a") => ({
    authorization:
      "Bearer synthetic-custody-" + tenant + "-" + id + "-aaaaaaaaaaaaaaaa",
  });
  try {
    const seed = await seedTaskAccess(f),
      url = "/api/tasks/" + seed.accessTaskId + "/access";
    const read = await app.inject({ url, headers: headers() });
    assert.equal(read.statusCode, 200);
    assert.doesNotMatch(
      read.body,
      /PRIVATE_HR|department|sourceNotes|totalSeats/,
    );
    for (const [id, tenant, expected] of [
      ["it-two", "synthetic-a", 403],
      ["reviewer", "synthetic-a", 403],
      ["it-one", "synthetic-b", 404],
    ] as const)
      assert.equal(
        (await app.inject({ url, headers: headers(id, tenant) })).statusCode,
        expected,
      );
    assert.equal((await app.inject({ url })).statusCode, 401);
    for (const path of [
      "/api/cases/" + seed.caseId + "/access",
      "/api/workspace/people/" + seed.personId,
      "/api/workspace/licenses/" + seed.licenseId,
    ])
      assert.equal(
        (await app.inject({ url: path, headers: headers() })).statusCode,
        403,
      );
    const access = read.json().access,
      pins =
        access.requirements[0].members[0].commandBindings.attestAccessForTask;
    const proposal = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers(),
      payload: {
        toolId: "ops.cases.attestAccessForTask",
        input: { ...pins, ...taskWitness(), licenseSeatId: seed.licenseSeatId },
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(proposal.statusCode, 201, proposal.body);
    assert.doesNotMatch(proposal.body, /PRIVATE_HR/);
    const runId = proposal.json().run.id;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/runs/" + runId + "/start",
          headers: headers(),
          payload: {},
        })
      ).statusCode,
      200,
    );
    await f.engine.tick();
    const run = f.engine.getRun(f.actor("it-one"), runId),
      approval = run.steps[0]!.approval!;
    const denied = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/approve",
      headers: headers(),
      payload: {
        approvalId: approval.id,
        bindingHash: approval.bindingHash,
        decision: "approved",
      },
    });
    assert.equal(denied.statusCode, 403);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/approve",
      headers: headers("reviewer"),
      payload: {
        approvalId: approval.id,
        bindingHash: approval.bindingHash,
        decision: "approved",
      },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    for (let i = 0; i < 5; i++) await f.engine.tick();
    const completed = await app.inject({
      url: "/api/runs/" + runId,
      headers: headers(),
    });
    assert.equal(completed.json().run.status, "completed");
    assert.doesNotMatch(completed.body, /PRIVATE_HR/);
    assert.equal(
      (
        await app.inject({
          url: "/api/runs/" + runId,
          headers: headers("it-two"),
        })
      ).statusCode,
      403,
    );
    f.actor("it-one").scopes = [];
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
