import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash } from "../src/engine.js";
import { laboratoryFreshnessMs } from "../src/laboratory-contract.js";
import { custodyNow } from "./helpers/custody-fixture.js";
import { itCaseFixture } from "./helpers/it-case-fixture.js";

const temporary = () => mkdtempSync(join(tmpdir(), "jarvis-it-case-"));
test("two firms require actual approved HTTP repair, typed evidence and separate owner acceptance", async () => {
  const dir = temporary(),
    f = await itCaseFixture(dir);
  try {
    for (const tenant of ["synthetic-a", "synthetic-b"]) {
      const caseId = await f.open(tenant),
        actor = f.actor("manager", tenant);
      assert.equal(f.view(caseId, tenant).readiness.ready, false);
      const duplicate = await f.failCommand(
        "ops.cases.create",
        f.openingInput(tenant),
        tenant,
      );
      assert.match(duplicate.steps[0]!.error!, /otwartą sprawę/);
      await f.failCommand(
        "ops.cases.submit",
        { id: caseId, expectedVersion: 1 },
        tenant,
      );
      const repair = await f.complete(
        "lab.repairCase",
        f.view(caseId, tenant).repairInput,
        "manager",
        tenant,
      );
      assert.equal(repair.steps[0]!.attempts, 1);
      assert.equal(
        repair.steps[0]!.verification!.evidence[0]!.data.httpStatus,
        200,
      );
      assert.equal(f.view(caseId, tenant).readiness.ready, false);
      await f.bind(caseId, tenant);
      assert.equal(
        f.view(caseId, tenant).readiness.ready,
        true,
        JSON.stringify(f.view(caseId, tenant).readiness),
      );
      await f.complete(
        "ops.cases.submit",
        { id: caseId, expectedVersion: 2 },
        "manager",
        tenant,
      );
      await f.complete(
        "ops.cases.accept",
        {
          id: caseId,
          expectedVersion: 3,
          decision: "accepted",
          note: "Synthetic owner accepted actual HTTP result",
          humanDecision: true,
        },
        "manager",
        tenant,
      );
      const result = f.workspace.readiness(actor, caseId);
      assert.equal(result.acceptanceCurrent, true);
      assert.equal(result.requirements[0]!.source!.runId, repair.id);
      assert.equal(
        f.get("cases", caseId, tenant).data.ownerPrincipalId,
        "manager",
      );
    }
    assert.equal(f.laboratory.view("unconfigured").observed, null);
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope revision, cancellation, refusal and expired observation block an already proposed repair", async () => {
  const dir = temporary();
  let now = custodyNow;
  const f = await itCaseFixture(dir, { clock: () => now });
  try {
    const caseId = await f.open(),
      pins = f.view(caseId).repairInput;
    const refused = await f.stage("lab.repairCase", pins),
      approval = refused.steps[0]!.approval!;
    f.engine.approve(f.actor("reviewer"), refused.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "rejected",
    });
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), refused.id).steps[0]!.attempts, 0);
    assert.equal((await f.inspect()).httpStatus, 503);
    await f.failCommand("ops.cases.revise", {
      id: caseId,
      expectedVersion: 1,
      brief: "Changed",
      acceptanceCriteria: "No test",
      reason: "Invalid removal",
      requirements: [],
    });
    await f.complete("ops.cases.revise", {
      id: caseId,
      expectedVersion: 1,
      brief: "Revised hypothesis",
      acceptanceCriteria: "Same own HTTP test",
      reason: "Explicit change",
    });
    assert.match(
      (await f.failCommand("lab.repairCase", pins)).steps[0]!.error!,
      /zmieniły się/,
    );
    now += laboratoryFreshnessMs + 1;
    assert.equal(f.view(caseId).laboratory.observed!.current, false);
    assert.match(
      (await f.failCommand("lab.repairCase", f.view(caseId).repairInput))
        .steps[0]!.error!,
      /aktualny stan/,
    );
    await f.complete("ops.cases.cancel", {
      id: caseId,
      expectedVersion: 2,
      reason: "Synthetic no action needed",
    });
    await f.failCommand("lab.repairCase", f.view(caseId).repairInput);
    assert.equal((await f.inspect()).version, 0);
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("later failure and age invalidate accepted evidence; historical verification cannot hide a new service state", async () => {
  const dir = temporary();
  let now = custodyNow;
  const f = await itCaseFixture(dir, { clock: () => now });
  try {
    const caseId = await f.open();
    await f.complete("lab.repairCase", f.view(caseId).repairInput);
    await f.bind(caseId);
    const acceptedProof = f.view(caseId).proofs[0]!;
    assert.equal(
      f.view(caseId).readiness.ready,
      true,
      JSON.stringify(f.view(caseId).readiness),
    );
    await f.complete("ops.cases.submit", { id: caseId, expectedVersion: 2 });
    await f.complete("ops.cases.accept", {
      id: caseId,
      expectedVersion: 3,
      decision: "accepted",
      note: "Synthetic owner received current test",
      humanDecision: true,
    });
    assert.equal(f.view(caseId).readiness.acceptanceCurrent, true);
    now += laboratoryFreshnessMs + 1;
    assert.equal(f.view(caseId).readiness.requirements[0]!.status, "stale");
    assert.equal(f.view(caseId).readiness.acceptanceCurrent, false);
    now = custodyNow;
    await f.complete("lab.simulateFailure", { expectedVersion: 1 });
    assert.equal(f.view(caseId).readiness.ready, false);
    assert.equal(f.view(caseId).proofs[0]!.identity.current, false);
    assert.equal(f.view(caseId).proofs[0]!.hash, acceptedProof.hash);
    await f.complete("lab.repair", { expectedVersion: 2 });
    assert.equal(
      f.view(caseId).readiness.ready,
      false,
      "legacy repair cannot replace this case proof",
    );
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent negative verification and a fabricated observer cannot become case evidence", async () => {
  const dir = temporary();
  let breakCheck = true;
  const f = await itCaseFixture(dir, {
    wrap: (tool) =>
      tool.id === "lab.repairCase"
        ? {
            ...tool,
            async verify(ctx, input, result) {
              if (breakCheck) {
                const db = new DatabaseSync(join(dir, "laboratory.sqlite"));
                db.prepare(
                  "UPDATE laboratory_state SET healthy=0,version=version+1 WHERE tenant_id=?",
                ).run(ctx.tenantId);
                db.close();
              }
              return tool.verify(ctx, input, result);
            },
          }
        : tool,
  });
  try {
    const caseId = await f.open();
    const failed = await f.failCommand(
      "lab.repairCase",
      f.view(caseId).repairInput,
    );
    assert.equal(failed.steps[0]!.verification!.ok, false);
    assert.equal(f.view(caseId).testHistory[0]!.result, "negative");
    assert.equal(f.view(caseId).proofs.length, 0);
    assert.equal(f.view(caseId).readiness.ready, false);
    breakCheck = false;
    await f.inspect();
    await f.complete("lab.repairCase", f.view(caseId).repairInput);
    const proof = f.view(caseId).proofs[0]!,
      db = new DatabaseSync(join(dir, "laboratory.sqlite"));
    const r = JSON.parse(
      String(
        db
          .prepare("SELECT record_json FROM laboratory_observations WHERE id=?")
          .get(proof.id)!.record_json,
      ),
    );
    r.actorId = "fabricated-author";
    db.prepare(
      "UPDATE laboratory_observations SET record_json=?,record_hash=? WHERE id=?",
    ).run(JSON.stringify(r), hash(r), proof.id);
    db.close();
    assert.equal(
      f.view(caseId).proofs.length,
      0,
      "rehashed metadata still needs matching Core authority",
    );
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart after a committed laboratory effect reconciles once from separate durable stores", async () => {
  const dir = temporary();
  let f = await itCaseFixture(dir);
  try {
    const caseId = await f.open(),
      pending = await f.stage("lab.repairCase", f.view(caseId).repairInput);
    await f.close();
    f = await itCaseFixture(dir);
    f.approve(f.engine.getRun(f.actor(), pending.id));
    for (let i = 0; i < 4; i++) await f.engine.tick();
    const finished = f.engine.getRun(f.actor(), pending.id),
      proof = f.view(caseId).proofs[0]!;
    assert.equal(finished.status, "completed");
    assert.equal(finished.steps[0]!.attempts, 1);
    const db = new DatabaseSync(join(dir, "core.sqlite")),
      op = String(
        db
          .prepare("SELECT operation_key FROM steps WHERE run_id=?")
          .get(pending.id)!.operation_key,
      );
    db.close();
    const tool = f.tools.find((t) => t.id === "lab.repairCase")!,
      ctx = {
        tenantId: "synthetic-a",
        actorId: "manager",
        approvedBy: "reviewer",
        runId: pending.id,
        stepId: "action",
        operationKey: op,
        signal: new AbortController().signal,
      };
    assert.equal(
      (await tool.reconcile!(ctx, finished.steps[0]!.input)).status,
      "applied",
    );
    assert.equal((await f.inspect()).version, 1);
    assert.equal(
      f.laboratory.proof(
        "synthetic-a",
        proof.id,
        caseId,
        1,
        new Date(custodyNow).toISOString(),
      ).identity.current,
      true,
    );
    assert.throws(
      () =>
        f.laboratory.proof(
          "synthetic-b",
          proof.id,
          caseId,
          1,
          new Date(custodyNow).toISOString(),
        ),
      /Brak obserwacji/,
    );
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
