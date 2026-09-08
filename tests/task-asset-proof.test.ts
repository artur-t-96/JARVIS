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
import { readIssuedAllocationProof } from "../src/asset-custody.js";
import { WorkspaceTasks } from "../src/workspace-tasks.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";

const forbidden = (e: unknown) =>
  e instanceof DomainError && [403, 404].includes(e.statusCode);
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-task-custody-proof-")),
    f = custodyFixture(dir);
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
const attestation = {
  issuedOn: "2026-09-08",
  location: "Synthetic recipient desk",
  condition: "good",
  handoverNote: "Synthetic IT attestation; no recipient signature",
  humanConfirmed: true,
};

test("accepted IT task exposes only its recipient and allocation; issue and binding are separately approved facts", async (t) => {
  const f = setup(t),
    a = await f.seed(),
    b = await f.seed("synthetic-b"),
    worker = f.actor("it-one");
  for (const module of ["people", "cases", "assets"])
    assert.throws(() => f.workspace.list(worker, module), forbidden);
  for (const unauthorized of [
    f.actor("it-two"),
    f.actor("observer"),
    f.actor("reviewer"),
    f.actor("it-one", "synthetic-b"),
  ])
    assert.throws(
      () => f.workspace.taskEquipment(unauthorized, a.taskId),
      forbidden,
    );
  const equipment = f.workspace.taskEquipment(worker, a.taskId);
  assert.equal(equipment.allocations.length, 1);
  assert.equal(equipment.allocations[0]!.asset.id, a.assetId);
  assert.deepEqual(equipment.allocations[0]!.allowedActions, ["issueForTask"]);
  const wire = JSON.stringify(equipment);
  assert.ok(!wire.includes("PRIVATE_HR"));
  assert.ok(!wire.includes(b.assetId));
  assert.ok(!wire.includes(b.personId));
  assert.equal(equipment.requirements.length, 1);
  const pins = equipment.allocations[0]!.commandBindings.issueForTask!;
  const issue = await f.complete(
    "ops.assets.issueForTask",
    { ...pins, ...attestation },
    "it-one",
  );
  assert.equal(f.get("assets", a.assetId).status, "issued");
  assert.equal(
    f.workspace
      .readiness(f.actor(), a.caseId)
      .requirements.find((r) => r.kind === "asset_issued")!.status,
    "missing",
  );
  const after = f.workspace.taskEquipment(worker, a.taskId),
    allocation = after.allocations[0]!;
  assert.equal(allocation.issueEvent!.performedBy, "it-one");
  assert.equal(allocation.issueEvent!.approvedBy, "reviewer");
  assert.equal(
    after.task.status,
    "accepted",
    "issuing does not complete the whole human task",
  );
  assert.deepEqual(allocation.allowedActions, ["bindAssetForTask"]);
  const bindPins = allocation.commandBindings.bindAssetForTask!;
  const bound = await f.complete(
    "ops.assets.bindAssetForTask",
    bindPins,
    "it-one",
  );
  assert.notEqual(bound.id, issue.id);
  const readiness = f.workspace.readiness(f.actor(), a.caseId);
  assert.equal(
    readiness.requirements.find((r) => r.kind === "asset_issued")!.status,
    "satisfied",
  );
  assert.equal(readiness.ready, false);
  assert.equal(readiness.acceptanceCurrent, false);
  assert.ok(
    readiness.requirements.some(
      (r) =>
        ["document_approved", "access_attested"].includes(r.kind) &&
        r.status !== "satisfied",
    ),
  );
  assert.deepEqual(
    f.workspace.taskEquipment(worker, a.taskId).allocations[0]!.allowedActions,
    [],
  );
});

test("receipt recovery after transfer is limited to the actual original operation and revoked accounts cannot reconcile", async (t) => {
  const f = setup(t),
    a = await f.seed(),
    worker = f.actor("it-one"),
    pins = f.workspace.taskEquipment(worker, a.taskId).allocations[0]!
      .commandBindings.issueForTask!;
  const issued = await f.complete(
    "ops.assets.issueForTask",
    { ...pins, ...attestation },
    "it-one",
  );
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  t.after(() => db.close());
  const event = db
    .prepare(
      "SELECT * FROM ops_task_events WHERE tenant_id=? AND task_id=? AND action='issueForTask'",
    )
    .get(worker.tenantId, a.taskId)!;
  const ctx: ToolContext = {
    tenantId: worker.tenantId,
    actorId: worker.id,
    approvedBy: "reviewer",
    runId: issued.id,
    stepId: String(event.step_id),
    operationKey: String(event.operation_key),
    signal: new AbortController().signal,
  };
  const input = { ...pins, ...attestation },
    helper = new WorkspaceTasks(db, (tenant) =>
      f.principals.filter((p) => p.tenantId === tenant),
    );
  const state = f.get("cases", a.caseId),
    task = (state.data.tasks as JsonObject[]).find(
      (row) => row.id === a.taskId,
    )!;
  await f.complete("ops.cases.transferTask", {
    id: a.caseId,
    expectedVersion: state.version,
    taskId: a.taskId,
    expectedTaskVersion: task.version!,
    assigneePrincipalId: "it-two",
    reason: "Synthetic transfer after recorded issuance",
    humanConfirmed: true,
  });
  assert.throws(() => f.workspace.taskEquipment(worker, a.taskId), forbidden);
  assert.equal(helper.verifyCommittedAsset(ctx, input, "issueForTask"), true);
  assert.equal(
    helper.canAccessAsset(
      worker,
      input,
      {
        purpose: "recover",
        runId: ctx.runId,
        stepId: ctx.stepId,
        operationKey: ctx.operationKey,
        requestedBy: worker.id,
      },
      "issueForTask",
    ),
    true,
  );
  assert.equal(
    helper.canAccessAsset(
      worker,
      input,
      {
        purpose: "read",
        runId: randomUUID(),
        stepId: ctx.stepId,
        operationKey: randomUUID(),
        requestedBy: worker.id,
      },
      "issueForTask",
    ),
    false,
  );
  assert.equal(
    helper.verifyCommittedAsset(
      { ...ctx, approvedBy: worker.id },
      input,
      "issueForTask",
    ),
    false,
  );
  f.principals.splice(f.principals.indexOf(worker), 1);
  assert.equal(helper.verifyCommittedAsset(ctx, input, "issueForTask"), false);
  assert.equal(
    helper.canAccessAsset(
      worker,
      input,
      {
        purpose: "recover",
        runId: ctx.runId,
        stepId: ctx.stepId,
        operationKey: ctx.operationKey,
        requestedBy: worker.id,
      },
      "issueForTask",
    ),
    false,
  );
});

test("readiness independently rejects allocation/event tampering while the asset JSON and receipt remain unchanged", async (t) => {
  const f = setup(t),
    a = await f.seed(),
    b = await f.seed("synthetic-b"),
    worker = f.actor("it-one"),
    pins = f.workspace.taskEquipment(worker, a.taskId).allocations[0]!
      .commandBindings.issueForTask!;
  await f.complete(
    "ops.assets.issueForTask",
    { ...pins, ...attestation },
    "it-one",
  );
  const selection = f.workspace.taskEquipment(worker, a.taskId).allocations[0]!,
    bind = selection.commandBindings.bindAssetForTask!;
  await f.complete("ops.assets.bindAssetForTask", bind, "it-one");
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  t.after(() => db.close());
  const selected = {
    assetId: a.assetId,
    allocationId: selection.id,
    issueEventId: selection.issueEvent!.id,
  };
  const originalJson = db
    .prepare("SELECT data_json FROM ops_entities WHERE tenant_id=? AND id=?")
    .get(worker.tenantId, a.assetId)!.data_json;
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE ops_allocations SET person_id=? WHERE tenant_id=? AND id=?",
        )
        .run(b.personId, worker.tenantId, selection.id),
    /FOREIGN KEY/,
  );
  const otherPerson = await f.complete("ops.people.create", {
    title: "Synthetic other recipient",
    data: { personCategory: "internal" },
  });
  const otherPersonId = String(otherPerson.steps[0]!.output!.data.entityId);
  assert.equal(
    readIssuedAllocationProof(db, worker.tenantId, selected).identity
      .performedBy,
    "it-one",
  );
  assert.throws(() => readIssuedAllocationProof(db, "synthetic-b", selected));
  assert.throws(() =>
    readIssuedAllocationProof(db, worker.tenantId, {
      ...selected,
      issueEventId: randomUUID(),
    }),
  );
  for (const [table, column, id, value] of [
    ["ops_allocations", "person_id", selection.id, otherPersonId],
    ["ops_allocations", "employment_episode_id", selection.id, randomUUID()],
    ["ops_allocations", "case_id", selection.id, randomUUID()],
    [
      "ops_asset_events",
      "performed_by",
      selected.issueEventId,
      "forged-person",
    ],
    ["ops_asset_events", "kind", selected.issueEventId, "return"],
  ]) {
    const before = db
      .prepare(
        `SELECT ${column} AS value FROM ${table} WHERE tenant_id=? AND id=?`,
      )
      .get(worker.tenantId, id!)!.value;
    db.prepare(
      `UPDATE ${table} SET ${column}=? WHERE tenant_id=? AND id=?`,
    ).run(value!, worker.tenantId, id!);
    assert.throws(
      () => readIssuedAllocationProof(db, worker.tenantId, selected),
      `${table}.${column} tamper must not satisfy independent proof`,
    );
    assert.equal(
      f.workspace
        .readiness(f.actor(), a.caseId)
        .requirements.find((r) => r.kind === "asset_issued")!.status,
      "failed",
    );
    db.prepare(
      `UPDATE ${table} SET ${column}=? WHERE tenant_id=? AND id=?`,
    ).run(before ?? null, worker.tenantId, id!);
  }
  assert.equal(
    db
      .prepare("SELECT data_json FROM ops_entities WHERE tenant_id=? AND id=?")
      .get(worker.tenantId, a.assetId)!.data_json,
    originalJson,
  );
  assert.equal(
    f.workspace
      .readiness(f.actor(), a.caseId)
      .requirements.find((r) => r.kind === "asset_issued")!.status,
    "satisfied",
  );
});
