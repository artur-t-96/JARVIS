import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DomainError,
  type JsonObject,
  type ToolContext,
} from "../src/contracts.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";
import { seedTaskAccess, taskWitness } from "./helpers/task-access-fixture.js";
const forbidden = (e: unknown) =>
  e instanceof DomainError && [403, 404].includes(e.statusCode);
function setup(t: TestContext, clock = () => custodyNow) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-task-access-")),
    f = custodyFixture(dir, { domainClock: clock });
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
const revokeValues = {
  revokedOn: "2026-09-08",
  verificationMethod: "Synthetic withdrawal checked",
  note: "Synthetic withdrawal only",
  humanConfirmed: true,
};

test("IT sees only its assigned access scope; two witnesses and binding need independent approvals", async (t) => {
  const f = setup(t),
    a = await seedTaskAccess(f),
    b = await seedTaskAccess(f, "synthetic-b"),
    worker = f.actor("it-one");
  for (const module of ["people", "cases", "licenses"])
    assert.throws(() => f.workspace.list(worker, module), forbidden);
  for (const p of [
    f.actor("it-two"),
    f.actor("observer"),
    f.actor("manager"),
    f.actor("reviewer"),
    f.actor("it-one", "synthetic-b"),
  ])
    assert.throws(() => f.workspace.taskAccess(p, a.accessTaskId), forbidden);
  const view = () => f.workspace.taskAccess(worker, a.accessTaskId);
  const first = view();
  assert.equal(first.requirements.length, 1);
  assert.equal(first.requirements[0]!.members.length, 2);
  const wire = JSON.stringify(first);
  for (const secret of ["PRIVATE_HR", b.personId, b.caseId, b.licenseSeatId!])
    assert.ok(!wire.includes(secret));
  assert.equal(first.requirements[0]!.bindInput, undefined);
  for (let i = 0; i < 2; i++) {
    const member = view().requirements[0]!.members[i]!;
    const run = await f.complete(
      "ops.cases.attestAccessForTask",
      {
        ...member.commandBindings.attestAccessForTask!,
        ...taskWitness(i),
        ...(i === 0 ? { licenseSeatId: a.licenseSeatId! } : {}),
      },
      "it-one",
    );
    assert.equal(run.steps[0]!.attempts, 1);
    assert.ok(!JSON.stringify(run).includes("PRIVATE_HR"));
    const after = view();
    assert.equal(after.task.status, "accepted");
    assert.equal(
      after.requirements[0]!.members[i]!.grant!.performedBy,
      "it-one",
    );
    assert.equal(
      after.requirements[0]!.members[i]!.grant!.approvedBy,
      "reviewer",
    );
  }
  assert.equal(view().requirements[0]!.current, true);
  const bind = await f.complete(
    "ops.cases.bindAccessForTask",
    { ...view().requirements[0]!.bindInput!, humanConfirmed: true },
    "it-one",
  );
  assert.equal(bind.steps[0]!.verification!.ok, true);
  const readiness = f.workspace.readiness(f.actor(), a.caseId);
  assert.equal(
    readiness.requirements.find((r) => r.kind === "access_attested")!.status,
    "satisfied",
  );
  assert.equal(readiness.ready, false);
  assert.equal(view().requirements[0]!.bound, true);
  assert.equal(view().task.status, "accepted");
  assert.ok(
    f.workspace.listTasks(worker).find((t) => t.id === a.accessTaskId)!
      .operationalContext?.access,
  );
  assert.equal(view().requirements[0]!.bindingCurrent, true);
  await f.complete(
    "ops.cases.renewAccessForTask",
    {
      ...view().requirements[0]!.members[0]!.commandBindings
        .renewAccessForTask!,
      ...taskWitness(),
      licenseSeatId: a.licenseSeatId!,
    },
    "it-one",
  );
  assert.equal(view().requirements[0]!.current, true);
  assert.equal(view().requirements[0]!.bindingCurrent, false);
  assert.equal(
    view().requirements[0]!.bindInput,
    undefined,
    "frozen binding requires a new case revision",
  );
});

test("offered task hides accounts and licences, open dependencies block writes", async (t) => {
  const f = setup(t),
    a = await seedTaskAccess(f, "synthetic-a", false, false),
    worker = f.actor("it-one");
  assert.equal(
    f.workspace.taskAccess(worker, a.accessTaskId).requirements.length,
    0,
  );
  await a.transition(a.accessTaskId, "acceptTask");
  const view = f.workspace.taskAccess(worker, a.accessTaskId);
  assert.equal(view.dependenciesReady, false);
  assert.deepEqual(view.requirements[0]!.members[0]!.commandBindings, {});
  const c = f.get("cases", a.caseId),
    r = view.requirements[0]!;
  const run = await f.stage(
    "ops.cases.attestAccessForTask",
    {
      id: c.id,
      expectedVersion: c.version,
      taskId: a.accessTaskId,
      expectedTaskVersion: view.task.version,
      requirementId: r.id,
      memberKey: "mail",
      licenseSeatId: a.licenseSeatId!,
      ...taskWitness(),
    },
    "it-one",
  );
  f.approve(run);
  await f.engine.tick();
  assert.equal(f.engine.getRun(worker, run.id).status, "needs_reconciliation");
  assert.equal(f.workspace.caseAccess(f.actor(), a.caseId).grants.length, 0);
});

test("a task cannot witness another task requirement or project, use an incorrect licence or overwrite a pin", async (t) => {
  const f = setup(t),
    a = await seedTaskAccess(f),
    b = await seedTaskAccess(f, "synthetic-b"),
    worker = f.actor("it-one");
  const view = f.workspace.taskAccess(worker, a.accessTaskId),
    input = {
      ...view.requirements[0]!.members[0]!.commandBindings.attestAccessForTask!,
      ...taskWitness(),
      licenseSeatId: a.licenseSeatId!,
    };
  for (const patch of [
    { personId: b.personId },
    { employmentEpisodeId: b.episodeId },
    { scopeHash: "0".repeat(64) },
    { requirementId: randomUUID() },
    { applicationVersion: 999 },
    { id: b.caseId },
  ])
    assert.throws(() =>
      f.engine.createRun(
        worker,
        "Invalid task scope",
        {
          title: "Invalid",
          summary: "Negative test",
          steps: [
            {
              id: "action",
              title: "Invalid",
              toolId: "ops.cases.attestAccessForTask",
              input: { ...input, ...patch },
            },
          ],
        },
        randomUUID(),
      ),
    );
  const bad = await f.stage(
    "ops.cases.attestAccessForTask",
    { ...input, licenseSeatId: b.licenseSeatId! },
    "it-one",
  );
  f.approve(bad);
  await f.engine.tick();
  assert.equal(f.engine.getRun(worker, bad.id).status, "needs_reconciliation");
  assert.equal(f.workspace.caseAccess(f.actor(), a.caseId).grants.length, 0);
});

test("assignment changes after approval prevent writes; committed receipt survives transfer but not account revocation", async (t) => {
  const f = setup(t),
    a = await seedTaskAccess(f),
    worker = f.actor("it-one");
  const input = {
    ...f.workspace.taskAccess(worker, a.accessTaskId).requirements[0]!
      .members[0]!.commandBindings.attestAccessForTask!,
    ...taskWitness(),
    licenseSeatId: a.licenseSeatId!,
  };
  const done = await f.complete(
    "ops.cases.attestAccessForTask",
    input,
    "it-one",
  );
  const second = {
    ...f.workspace.taskAccess(worker, a.accessTaskId).requirements[0]!
      .members[1]!.commandBindings.attestAccessForTask!,
    ...taskWitness(1),
  };
  const pending = await f.stage(
    "ops.cases.attestAccessForTask",
    second,
    "it-one",
  );
  f.approve(pending);
  // Execute the manager's transfer directly through its approved tool before the worker ticks again.
  const task = f.workspace
    .listTasks(f.actor())
    .find((t) => t.id === a.accessTaskId)!;
  const tool = f.workspace
    .tools()
    .find((t) => t.id === "ops.cases.transferTask")!;
  await tool.execute(
    {
      tenantId: worker.tenantId,
      actorId: "manager",
      approvedBy: "reviewer",
      runId: randomUUID(),
      stepId: "transfer",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    },
    {
      id: a.caseId,
      expectedVersion: f.get("cases", a.caseId).version,
      taskId: a.accessTaskId,
      expectedTaskVersion: task.version,
      assigneePrincipalId: "it-two",
      reason: "Synthetic authorized transfer",
      humanConfirmed: true,
    },
  );
  assert.throws(
    () => f.workspace.taskAccess(worker, a.accessTaskId),
    forbidden,
  );
  await f.engine.tick();
  assert.equal(f.workspace.caseAccess(f.actor(), a.caseId).grants.length, 1);
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  t.after(() => db.close());
  const event = db
    .prepare(
      "SELECT * FROM ops_task_events WHERE tenant_id=? AND task_id=? AND action='attestAccessForTask'",
    )
    .get(worker.tenantId, a.accessTaskId)!;
  const ctx: ToolContext = {
    tenantId: worker.tenantId,
    actorId: worker.id,
    approvedBy: "reviewer",
    runId: done.id,
    stepId: String(event.step_id),
    operationKey: String(event.operation_key),
    signal: new AbortController().signal,
  };
  const accessTool = f.workspace
    .tools()
    .find((t) => t.id === "ops.cases.attestAccessForTask")!;
  const actual = done.plan.steps[0]!.input;
  assert.equal((await accessTool.reconcile!(ctx, actual)).status, "applied");
  assert.equal(
    accessTool.canAccess!(worker, actual, {
      purpose: "recover",
      runId: ctx.runId,
      stepId: ctx.stepId,
      operationKey: ctx.operationKey,
      requestedBy: worker.id,
    }),
    true,
  );
  f.principals.splice(f.principals.indexOf(worker), 1);
  await assert.rejects(accessTool.reconcile!(ctx, actual), forbidden);
});

test("renewal and withdrawal retain witnesses, and a retired application still permits task-bound withdrawal", async (t) => {
  let now = custodyNow;
  const f = setup(t, () => now),
    a = await seedTaskAccess(f),
    worker = f.actor("it-one"),
    view = () => f.workspace.taskAccess(worker, a.accessTaskId);
  await f.complete(
    "ops.cases.attestAccessForTask",
    {
      ...view().requirements[0]!.members[0]!.commandBindings
        .attestAccessForTask!,
      ...taskWitness(),
      licenseSeatId: a.licenseSeatId!,
    },
    "it-one",
  );
  const grantId = view().requirements[0]!.members[0]!.grant!.id;
  now += 7 * 86400000;
  assert.equal(view().requirements[0]!.members[0]!.current, false);
  await f.complete(
    "ops.cases.renewAccessForTask",
    {
      ...view().requirements[0]!.members[0]!.commandBindings
        .renewAccessForTask!,
      ...taskWitness(),
      observedOn: "2026-09-15",
      validUntil: "2026-09-21",
      licenseSeatId: a.licenseSeatId!,
    },
    "it-one",
  );
  assert.equal(view().requirements[0]!.members[0]!.grant!.id, grantId);
  assert.equal(view().requirements[0]!.members[0]!.history.length, 2);
  await f.complete("ops.it.retireAccessDefinition", {
    id: a.apps[0]!,
    expectedVersion: 1,
    reason: "Synthetic retirement",
  });
  const retired = view().requirements[0]!;
  assert.ok(retired.problem);
  assert.equal(
    retired.members[0]!.commandBindings.renewAccessForTask,
    undefined,
  );
  await f.complete(
    "ops.cases.revokeAccessForTask",
    {
      ...retired.members[0]!.commandBindings.revokeAccessForTask!,
      ...revokeValues,
      revokedOn: "2026-09-15",
    },
    "it-one",
  );
  assert.equal(
    f.workspace.caseAccess(f.actor(), a.caseId).grants[0]!.status,
    "revoked",
  );
  assert.equal(view().requirements[0]!.members[0]!.history.length, 3);
});
