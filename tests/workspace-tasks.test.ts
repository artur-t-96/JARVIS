import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainError, type Principal } from "../src/contracts.js";
import {
  baselineProcessTemplates,
  processTemplatesSchema,
  actionSchemas,
} from "../src/workspace-models.js";
import {
  WorkspaceTasks,
  taskTablesSql,
  type TaskContext,
  type TaskTransition,
  type TaskAction,
} from "../src/workspace-tasks.js";

const account = (id: string, scopes = ["it"], tenantId = "a"): Principal => ({
  id,
  tenantId,
  roles: ["operator"],
  scopes,
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-p03-tasks-"));
  const path = join(dir, "operations.sqlite");
  let db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE ops_entities(tenant_id TEXT,id TEXT,module TEXT,title TEXT,status TEXT,version INTEGER,data_json TEXT,PRIMARY KEY(tenant_id,id));
    ${taskTablesSql}`);
  const caseId = randomUUID();
  for (const tenant of ["a", "b"])
    db.prepare("INSERT INTO ops_entities VALUES(?,?,?,?,?,?,?)").run(
      tenant,
      caseId,
      "cases",
      "PRIVATE HR TITLE",
      "open",
      1,
      JSON.stringify({
        scopeRevision: 1,
        brief: "PRIVATE HR BRIEF",
        personId: randomUUID(),
      }),
    );
  let people = [
    account("it-a"),
    account("it-b"),
    account("hr", ["people"]),
    account("manager", ["cases", "people"]),
    account("foreign", ["*"], "b"),
  ];
  const provider = (tenant: string) =>
    people.filter((p) => p.tenantId === tenant);
  const manager = (p: Principal) =>
    p.scopes?.includes("people") === true &&
    p.scopes?.includes("cases") === true;
  let tasks = new WorkspaceTasks(db, provider, manager);
  const context = (actor = "it-a", tenantId = "a"): TaskContext => ({
    ctx: {
      tenantId,
      actorId: actor,
      approvedBy: "reviewer",
      runId: randomUUID(),
      stepId: "task",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    },
    now: "2099-01-02T12:00:00.000Z",
    caseId,
    scopeRevision: 1,
    canManage: actor === "manager",
  });
  const insert = (extra: Record<string, unknown> = {}) =>
    tasks.insert(context("manager"), {
      title: "Przygotuj komputer",
      required: true,
      kind: "work",
      assigneePrincipalId: "it-a",
      requiredScopes: ["it"],
      ...extra,
    });
  const change = (
    taskId: string,
    version: number,
    action: TaskAction,
    actor = "it-a",
    extra: Partial<TaskTransition> = {},
    ctx = context(actor),
  ) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = tasks.transition(ctx, action, {
        taskId,
        expectedTaskVersion: version,
        humanConfirmed: true,
        ...extra,
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    caseId,
    path,
    context,
    insert,
    change,
    get tasks() {
      return tasks;
    },
    get db() {
      return db;
    },
    accounts(next: Principal[]) {
      people = next;
    },
    restart() {
      db.close();
      db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
      tasks = new WorkspaceTasks(db, provider, manager);
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const errorCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code;

test("two baseline profiles encode different dates and responsibilities; schemas reject spoofed performers", () => {
  const a = processTemplatesSchema.parse(baselineProcessTemplates("internal"));
  const b = processTemplatesSchema.parse(
    baselineProcessTemplates("contractor"),
  );
  assert.notDeepEqual(a, b);
  assert.deepEqual(
    a.onboarding.map((t) => t.assigneeRole),
    ["hr", "it", "it", "manager"],
  );
  assert.equal(
    a.onboarding.find((t) => t.key === "access")?.kind,
    "attestation",
  );
  assert.equal(b.onboarding[0]?.offsetDays, -3);
  assert.equal(
    actionSchemas.cases.completeTask!.safeParse({
      id: randomUUID(),
      expectedVersion: 1,
      taskId: randomUUID(),
      expectedTaskVersion: 1,
      evidenceNote: "done",
      humanConfirmed: true,
      performedBy: "someone-else",
    }).success,
    false,
  );
  const legacy = {
    onboarding: [
      {
        key: "old",
        title: "Old",
        required: true,
        offsetDays: 0,
        dependsOn: [],
      },
    ],
    offboarding: a.offboarding,
  };
  assert.equal(processTemplatesSchema.safeParse(legacy).success, false);
});

test("actual requester accepts and performs work; independent approval never impersonates performer", () => {
  const f = fixture();
  try {
    let t = f.insert({ assigneeId: randomUUID(), kind: "attestation" });
    assert.equal(t.status, "offered");
    assert.throws(
      () =>
        f.change(t.id, t.version, "completeTask", "it-a", {
          evidenceNote: "done",
        }),
      errorCode("TASK_NOT_ACCEPTED"),
    );
    assert.throws(
      () => f.change(t.id, t.version, "acceptTask", "it-b"),
      errorCode("TASK_ASSIGNEE_ONLY"),
    );
    t = f.change(t.id, t.version, "acceptTask");
    t = f.change(t.id, t.version, "completeTask", "it-a", {
      evidenceNote: "Odebrałem lokalny protokół",
    });
    assert.equal(t.performedBy, "it-a");
    assert.equal(t.requestedBy, "it-a");
    assert.equal(t.approvedBy, "reviewer");
    const history = f.tasks.history("a", t.id);
    assert.equal(history.length, 3);
    assert.equal(history[1]?.performedBy, null);
    assert.equal(history[2]?.performedBy, "it-a");
    assert.throws(
      () =>
        f.change(t.id, t.version, "transferTask", "manager", {
          assigneePrincipalId: "it-b",
          reason: "change",
        }),
      errorCode("TASK_TERMINAL"),
    );
  } finally {
    f.close();
  }
});

test("decline and transfer persist; new worker accepts anew, stale versions and wrong tenant fail", () => {
  const f = fixture();
  try {
    let t = f.insert();
    t = f.change(t.id, t.version, "declineTask", "it-a", {
      reason: "Brak czasu",
    });
    const transferContext = f.context("it-a");
    t = f.change(
      t.id,
      t.version,
      "transferTask",
      "it-a",
      { reason: "Przekazuję koledze", assigneePrincipalId: "it-b" },
      transferContext,
    );
    assert.equal(t.status, "offered");
    assert.equal(t.assigneePrincipalId, "it-b");
    assert.equal(
      f.tasks.verifyCommitted(transferContext.ctx, t.id),
      true,
      "recovery proof survives changed assignee",
    );
    assert.equal(
      f.tasks.verifyCommitted(
        { ...transferContext.ctx, actorId: "it-b" },
        t.id,
      ),
      false,
    );
    f.restart();
    assert.equal(f.tasks.get("a", t.id).assigneePrincipalId, "it-b");
    assert.equal(f.tasks.verifyCommitted(transferContext.ctx, t.id), true);
    assert.throws(
      () => f.change(t.id, 1, "acceptTask", "it-b"),
      errorCode("TASK_VERSION_CONFLICT"),
    );
    assert.throws(
      () => f.change(t.id, t.version, "acceptTask", "it-a"),
      errorCode("TASK_ASSIGNEE_ONLY"),
    );
    assert.throws(() => f.tasks.get("b", t.id), errorCode("TASK_NOT_FOUND"));
    assert.throws(
      () =>
        f.change(t.id, t.version, "transferTask", "it-b", {
          reason: "foreign",
          assigneePrincipalId: "foreign",
        }),
      errorCode("TASK_ASSIGNEE_FORBIDDEN"),
    );
    t = f.change(t.id, t.version, "acceptTask", "it-b");
    t = f.change(t.id, t.version, "completeTask", "it-b", {
      evidenceNote: "Wykonane",
    });
    assert.equal(t.performedBy, "it-b");
    assert.equal(f.tasks.history("a", t.id).length, 5);
  } finally {
    f.close();
  }
});

test("live revocation denies projected tasks, completion and committed recovery; manager may reassign", () => {
  const f = fixture();
  try {
    let t = f.insert();
    const acceptCtx = f.context();
    t = f.change(t.id, t.version, "acceptTask", "it-a", {}, acceptCtx);
    f.accounts([
      account("it-a", []),
      account("it-b"),
      account("manager", ["people", "cases"]),
    ]);
    assert.deepEqual(f.tasks.project(account("it-a")), []);
    assert.throws(
      () =>
        f.change(t.id, t.version, "completeTask", "it-a", {
          evidenceNote: "done",
        }),
      errorCode("TASK_ACTOR_FORBIDDEN"),
    );
    assert.equal(f.tasks.verifyCommitted(acceptCtx.ctx, t.id), false);
    t = f.change(t.id, t.version, "transferTask", "manager", {
      assigneePrincipalId: "it-b",
      reason: "Uprawnienia poprzednika cofnięte",
    });
    assert.equal(t.assigneePrincipalId, "it-b");
    assert.equal(t.status, "offered");
    f.accounts([]);
    assert.throws(
      () => f.tasks.project(account("it-b")),
      errorCode("TASK_VIEW_FORBIDDEN"),
    );
  } finally {
    f.close();
  }
});

test("dependencies block completion and revisions; IT projection contains only authorized own minimal work", () => {
  const f = fixture();
  try {
    const hr = f.insert({
      title: "PRIVATE DOCUMENT SALARY",
      assigneePrincipalId: "hr",
      requiredScopes: ["people"],
      assigneeRole: "hr",
    });
    let it = f.insert({ dependsOn: [hr.id], dueDate: "2099-01-01" });
    const serialized = JSON.stringify(
      f.tasks.project(account("it-a"), { today: "2099-01-02" }),
    );
    assert.equal(serialized.includes("PRIVATE"), false);
    assert.equal(serialized.includes("personId"), false);
    const project = f.tasks.project(account("it-a"), { today: "2099-01-02" });
    assert.equal(project.length, 1);
    assert.equal(project[0]?.overdue, true);
    assert.deepEqual(project[0]?.dependsOn, [{ id: hr.id, completed: false }]);
    assert.deepEqual(f.tasks.eligibleAssignees(account("it-a"), it.id), [
      { id: "it-a" },
      { id: "it-b" },
    ]);
    assert.throws(
      () => f.tasks.eligibleAssignees(account("it-b"), it.id),
      errorCode("TASK_VIEW_FORBIDDEN"),
    );
    it = f.change(it.id, it.version, "acceptTask");
    assert.throws(
      () =>
        f.change(it.id, it.version, "completeTask", "it-a", {
          evidenceNote: "done",
        }),
      errorCode("TASK_DEPENDENCIES_OPEN"),
    );
    const ctx = f.context();
    ctx.scopeRevision = 2;
    assert.throws(
      () =>
        f.change(
          it.id,
          it.version,
          "completeTask",
          "it-a",
          { evidenceNote: "done" },
          ctx,
        ),
      errorCode("TASK_REVISION_CONFLICT"),
    );
    const hrAccepted = f.change(hr.id, hr.version, "acceptTask", "hr");
    f.change(hr.id, hrAccepted.version, "completeTask", "hr", {
      evidenceNote: "HR reported actual work",
    });
    it = f.change(it.id, it.version, "completeTask", "it-a", {
      evidenceNote: "Actual IT work",
    });
    assert.equal(it.status, "completed");
  } finally {
    f.close();
  }
});

test("missing, ambiguous and unauthorized bindings stay unassigned without guessing business-person identity", () => {
  const f = fixture();
  try {
    const businessId = randomUUID();
    const t = f.insert({
      assigneePrincipalId: undefined,
      assigneeId: businessId,
    });
    assert.equal(t.assigneeId, businessId);
    assert.equal(t.assigneePrincipalId, null);
    assert.equal(t.status, "unassigned");
    assert.equal(f.tasks.resolveRole("a", { it: "hr" }, "it"), undefined);
    assert.equal(f.tasks.resolveRole("a", { it: "foreign" }, "it"), undefined);
    assert.equal(f.tasks.resolveRole("a", { it: "it-a" }, "it"), "it-a");
    f.accounts([account("it-a"), account("it-a")]);
    assert.equal(f.tasks.resolveRole("a", { it: "it-a" }, "it"), undefined);
    const ambiguous = f.insert({ allowUnassigned: true });
    assert.equal(ambiguous.status, "unassigned");
  } finally {
    f.close();
  }
});

test("independent durable adapters cannot accept the same task version twice; abort does not write an event", () => {
  const f = fixture();
  const second = new DatabaseSync(f.path);
  try {
    const t = f.insert();
    const another = new WorkspaceTasks(second, () => [account("it-a")]);
    f.change(t.id, t.version, "acceptTask");
    assert.throws(
      () =>
        another.transition(f.context(), "acceptTask", {
          taskId: t.id,
          expectedTaskVersion: t.version,
          humanConfirmed: true,
        }),
      errorCode("TASK_VERSION_CONFLICT"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = f.context();
    ctx.ctx.signal = ac.signal;
    assert.throws(
      () =>
        f.change(
          t.id,
          2,
          "completeTask",
          "it-a",
          { evidenceNote: "notdone" },
          ctx,
        ),
      /abort/i,
    );
    assert.equal(f.tasks.history("a", t.id).length, 2);
  } finally {
    second.close();
    f.close();
  }
});

test("closed or historically cancelled case never advertises pending work or task actions", () => {
  const f = fixture();
  try {
    f.insert({ dueDate: "2099-01-01" });
    const before = f.tasks.project(account("it-a"), { today: "2099-01-02" });
    assert.equal(before[0]?.overdue, true);
    assert.ok(before[0]!.allowedActions.length > 0);
    for (const status of ["awaiting_acceptance", "accepted"]) {
      f.db
        .prepare(
          "UPDATE ops_entities SET status=? WHERE tenant_id='a' AND id=?",
        )
        .run(status, f.caseId);
      const closed = f.tasks.project(account("it-a"), { today: "2099-01-02" });
      assert.equal(closed[0]?.overdue, false);
      assert.deepEqual(closed[0]?.allowedActions, []);
    }
    f.db
      .prepare(
        "UPDATE ops_entities SET status='cancelled' WHERE tenant_id='a' AND id=?",
      )
      .run(f.caseId);
    assert.deepEqual(
      f.tasks.project(account("it-a"), { today: "2099-01-02" }),
      [],
    );
  } finally {
    f.close();
  }
});
