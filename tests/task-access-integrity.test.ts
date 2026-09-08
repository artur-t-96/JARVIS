import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DomainError, type ToolContext } from "../src/contracts.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { seedTaskAccess, taskWitness } from "./helpers/task-access-fixture.js";

test("task proof, grant, case snapshot, receipt and outbox roll back together; changed task proof is not reconciled", async () => {
  const directory = mkdtempSync(
      join(tmpdir(), "jarvis-task-access-integrity-"),
    ),
    f = custodyFixture(directory),
    db = new DatabaseSync(join(directory, "operations.sqlite"));
  try {
    const seed = await seedTaskAccess(f),
      worker = f.actor("it-one"),
      view = () => f.workspace.taskAccess(worker, seed.accessTaskId);
    const before = view(),
      caseVersion = f.get("cases", seed.caseId).version;
    const input = {
      ...before.requirements[0]!.members[0]!.commandBindings
        .attestAccessForTask!,
      ...taskWitness(),
      licenseSeatId: seed.licenseSeatId!,
    };
    const tool = f.workspace
      .tools()
      .find((t) => t.id === "ops.cases.attestAccessForTask")!;
    const ctx: ToolContext = {
      tenantId: worker.tenantId,
      actorId: worker.id,
      approvedBy: "reviewer",
      runId: randomUUID(),
      stepId: "action",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    };
    db.exec(
      "CREATE TRIGGER reject_access_task_event BEFORE INSERT ON ops_task_events WHEN NEW.action='attestAccessForTask' BEGIN SELECT RAISE(ABORT,'synthetic task-event failure'); END",
    );
    await assert.rejects(
      tool.execute(ctx, input),
      /synthetic task-event failure/,
    );
    assert.equal(
      f.workspace.caseAccess(f.actor(), seed.caseId).grants.length,
      0,
    );
    assert.equal(f.get("cases", seed.caseId).version, caseVersion);
    assert.equal(view().task.version, before.task.version);
    for (const table of ["ops_commands", "ops_outbox"])
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM " + table + " WHERE operation_key=?")
          .get(ctx.operationKey)!.n,
        0,
      );
    db.exec("DROP TRIGGER reject_access_task_event");
    const run = await f.complete(
      "ops.cases.attestAccessForTask",
      input,
      "it-one",
    );
    const event = db
      .prepare(
        "SELECT * FROM ops_task_events WHERE tenant_id=? AND task_id=? AND action='attestAccessForTask'",
      )
      .get(worker.tenantId, seed.accessTaskId)!;
    const committed: ToolContext = {
      ...ctx,
      runId: run.id,
      stepId: String(event.step_id),
      operationKey: String(event.operation_key),
    };
    const actual = run.plan.steps[0]!.input;
    assert.equal((await tool.reconcile!(committed, actual)).status, "applied");
    const proof = JSON.parse(String(event.reason));
    proof.grantId = randomUUID();
    db.prepare(
      "UPDATE ops_task_events SET reason=? WHERE tenant_id=? AND id=?",
    ).run(JSON.stringify(proof), worker.tenantId, String(event.id));
    await assert.rejects(
      tool.reconcile!(committed, actual),
      (e) => e instanceof DomainError && e.code === "TASK_RECEIPT_FORBIDDEN",
    );
    assert.equal(
      f.workspace.caseAccess(f.actor(), seed.caseId).grants.length,
      1,
    );
  } finally {
    db.close();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
