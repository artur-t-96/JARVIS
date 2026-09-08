import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { JsonObject } from "../src/contracts.js";
import type { TaskAssetProjection } from "../src/workspace-tasks.js";
import { custodyFixture } from "./helpers/custody-fixture.js";

const issueFacts = {
  issuedOn: "2026-09-08",
  location: "Synthetic recipient location",
  condition: "good",
  handoverNote: "SYNTHETIC witness report, not a real handover",
  humanConfirmed: true,
};

test("task equipment API exposes one recipient and allocation to its accepted IT worker, with separate verified binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-custody-api-"));
  const h = custodyFixture(directory);
  const app = createApp({
    ...h,
    planner: {
      kind: "test",
      async plan() {
        throw new Error("Unused model");
      },
    },
  });
  const get = (url: string, id = "it-one", tenant = "synthetic-a") =>
    app.inject({
      method: "GET",
      url,
      headers: {
        authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
      },
    });
  const post = (toolId: string, input: JsonObject, id = "it-one") =>
    app.inject({
      method: "POST",
      url: "/api/commands",
      headers: {
        authorization: `Bearer synthetic-custody-synthetic-a-${id}-aaaaaaaaaaaaaaaa`,
      },
      payload: { toolId, input, idempotencyKey: randomUUID() },
    });
  try {
    const seed = await h.seed();
    for (const endpoint of ["register", "custodians"]) {
      assert.equal(
        (await get(`/api/assets/${seed.assetId}/${endpoint}`)).statusCode,
        403,
      );
      assert.equal(
        (
          await get(
            `/api/assets/${seed.assetId}/${endpoint}`,
            "manager",
            "synthetic-b",
          )
        ).statusCode,
        404,
      );
    }
    const register = (
      await get(
        `/api/assets/${seed.assetId}/register?limit=1&offset=1`,
        "manager",
      )
    ).json().register;
    assert.equal(register.consistent, true);
    assert.equal(register.total, 2);
    assert.equal(register.events.length, 1);
    assert.equal(register.events[0].assetVersion, 1);
    assert.doesNotMatch(
      JSON.stringify(register),
      /PRIVATE_HR_|personId|allocations/,
    );
    for (const query of ["limit=0", "limit=101", "offset=-1", "unexpected=1"])
      assert.equal(
        (await get(`/api/assets/${seed.assetId}/register?${query}`, "manager"))
          .statusCode,
        400,
      );
    assert.deepEqual(
      (await get(`/api/assets/${seed.assetId}/custodians`, "manager")).json()
        .assignees,
      [{ id: "manager", label: "manager" }],
    );
    const response = await get(`/api/tasks/${seed.taskId}/equipment`);
    assert.equal(response.statusCode, 200, response.body);
    let equipment = response.json<{ equipment: TaskAssetProjection }>()
      .equipment;
    assert.equal(equipment.recipientLabel, "SYNTHETIC CUSTODY RECIPIENT");
    assert.equal(equipment.allocations.length, 1);
    assert.equal(equipment.allocations[0]!.asset.id, seed.assetId);
    assert.doesNotMatch(
      response.body,
      /PRIVATE_HR_|department|jobTitle|acceptanceCriteria|processTemplateSnapshot|roleBindings/,
    );
    assert.equal(
      (await get(`/api/tasks/${seed.taskId}/equipment`, "it-two")).statusCode,
      403,
    );
    assert.equal(
      (await get(`/api/tasks/${seed.taskId}/equipment`, "reviewer")).statusCode,
      403,
    );
    assert.equal(
      (await get(`/api/tasks/${seed.taskId}/equipment`, "observer")).statusCode,
      403,
    );
    assert.equal(
      (
        await get(
          `/api/tasks/${seed.taskId}/equipment`,
          "it-one",
          "synthetic-b",
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await get(`/api/workspace/cases/${seed.caseId}`)).statusCode,
      403,
    );
    assert.equal((await get("/api/workspace/people")).statusCode, 403);
    assert.equal(
      (await get(`/api/assets/${seed.assetId}/custody`)).statusCode,
      403,
    );
    assert.equal(
      (await get(`/api/assets/${seed.assetId}/custody?limit=0`, "manager"))
        .statusCode,
      400,
    );
    assert.equal(
      (await get(`/api/assets/${seed.assetId}/custody?limit=101`, "manager"))
        .statusCode,
      400,
    );
    assert.equal(
      (await get(`/api/assets/${seed.assetId}/custody?unexpected=1`, "manager"))
        .statusCode,
      400,
    );
    const input = {
      ...equipment.allocations[0]!.commandBindings.issueForTask!,
      ...issueFacts,
    };
    assert.equal(
      (
        await post("ops.assets.issueForTask", {
          ...input,
          performedBy: "reviewer",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await post("ops.assets.issueForTask", input, "it-two")).statusCode,
      403,
    );
    const staged = await h.stage("ops.assets.issueForTask", input, "it-one");
    assert.equal(
      h.get("assets", seed.assetId).status,
      "reserved",
      "plan has no physical side effect",
    );
    h.approve(staged);
    await h.engine.tick();
    const issuedRun = h.engine.getRun(h.actor("it-one"), staged.id);
    assert.equal(issuedRun.status, "completed", JSON.stringify(issuedRun));
    assert.equal(issuedRun.steps[0]!.verification?.ok, true);
    equipment = (await get(`/api/tasks/${seed.taskId}/equipment`)).json<{
      equipment: TaskAssetProjection;
    }>().equipment;
    const issued = equipment.allocations[0]!;
    assert.equal(issued.status, "issued");
    assert.equal(issued.binding.status, "unbound");
    assert.equal(issued.issueEvent?.performedBy, "it-one");
    assert.equal(issued.issueEvent?.approvedBy, "reviewer");
    assert.ok(issued.commandBindings.bindAssetForTask);
    assert.ok(!issued.allowedActions.includes("issueForTask"));
    const bound = await h.complete(
      "ops.assets.bindAssetForTask",
      issued.commandBindings.bindAssetForTask!,
      "it-one",
    );
    assert.equal(bound.steps[0]!.verification?.ok, true);
    equipment = (await get(`/api/tasks/${seed.taskId}/equipment`)).json<{
      equipment: TaskAssetProjection;
    }>().equipment;
    assert.equal(equipment.allocations[0]!.binding.status, "bound");
    const readiness = h.workspace.readiness(h.actor(), seed.caseId);
    assert.equal(
      readiness.requirements.find((r) => r.key === "equipment")?.status,
      "satisfied",
    );
    assert.equal(
      readiness.ready,
      false,
      "missing document and access still block onboarding",
    );
    const custody = await get(
      `/api/assets/${seed.assetId}/custody?limit=1&offset=0`,
      "manager",
    );
    assert.equal(custody.statusCode, 200, custody.body);
    const page = custody.json().custody;
    assert.equal(page.totalEvents, 2, "separate binding did not issue again");
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].kind, "issue");
    const older = (
      await get(
        `/api/assets/${seed.assetId}/custody?limit=1&offset=1`,
        "manager",
      )
    ).json().custody;
    assert.equal(older.events[0].kind, "reserve");
  } finally {
    await app.close();
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
