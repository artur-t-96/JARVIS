import { custodyPins } from "./helpers/custody-pins.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DomainError,
  hasToolAccess,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "../src/contracts.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";
import { Engine } from "../src/engine.js";

const principal = (tenantId = "tenant-a", scopes = ["*"]): Principal => ({
  id: "human-reviewer",
  tenantId,
  roles: ["operator", "approver"],
  scopes,
});
const ctx = (
  tenantId = "tenant-a",
  operationKey = randomUUID(),
): ToolContext => ({
  tenantId,
  actorId: "human-reviewer",
  approvedBy: "human-reviewer",
  operationKey,
  runId: "run-test",
  stepId: "step-test",
  signal: new AbortController().signal,
});
const today = new Date().toISOString().slice(0, 10);
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
function helper(store: WorkspaceStore, tenantId = "tenant-a") {
  store.setPrincipalProvider((tenant) => [principal(tenant)]);
  const tools = new Map(store.tools().map((tool) => [tool.id, tool]));
  const invoke = async (
    module: string,
    action: string,
    input: JsonObject,
    context = ctx(tenantId),
  ) => {
    const tool = tools.get(`ops.${module}.${action}`)!;
    if (
      (module === "people" &&
        ["activate", "beginOffboarding", "endEmployment"].includes(action)) ||
      (module === "assets" && ["reserve", "issue"].includes(action)) ||
      (module === "licenses" && ["assign", "revoke"].includes(action))
    ) {
      if (!input.employmentEpisodeId) {
        const episodes = store
          .listEmploymentEpisodes(
            principal(tenantId),
            String(module === "people" ? input.id : input.personId),
          )
          .filter((episode) => episode.status !== "ended");
        assert.equal(
          episodes.length,
          1,
          "This legacy test fixture explicitly has one episode",
        );
        input = {
          ...input,
          employmentEpisodeId: episodes[0]!.id,
          expectedEpisodeVersion: episodes[0]!.version,
        };
      }
    }
    if (
      module === "cases" &&
      action === "revise" &&
      input.startDate &&
      input.expectedEpisodeVersion === undefined
    ) {
      const record = store.get(principal(tenantId), "cases", String(input.id));
      const episode = store
        .listEmploymentEpisodes(
          principal(tenantId),
          String(record.data.personId),
        )
        .find((episode) => episode.id === record.data.employmentEpisodeId)!;
      input = { ...input, expectedEpisodeVersion: episode.version };
    }
    if (module === "assets")
      input = custodyPins(store, principal(tenantId), action, input);
    input =
      input.profileVersion === undefined
        ? (tool.prepareInput?.(input, tenantId) ?? input)
        : input;
    const result = await tool.execute(context, input);
    assert.equal(
      (await tool.verify(context, input, result)).ok,
      true,
      `${module}.${action} independently verified`,
    );
    return store.get(principal(tenantId), module, String(result.data.entityId));
  };
  const create = (module: string, title: string, data: JsonObject) =>
    invoke(module, "create", { title, data });
  const action = async (
    entity: Entity,
    action: string,
    fields: JsonObject = {},
  ) => {
    const input = { ...fields };
    if (action === "addTask") {
      input.kind ??= "work";
      input.assigneePrincipalId ??= "human-reviewer";
    }
    if (action === "completeTask") {
      let task = (entity.data.tasks as JsonObject[]).find(
        (task) => task.id === input.taskId,
      );
      if (task && task.status === "unassigned") {
        const updated = await invoke("cases", "transferTask", {
          id: entity.id,
          expectedVersion: entity.version,
          taskId: task.id!,
          expectedTaskVersion: task.version!,
          assigneePrincipalId: "human-reviewer",
          reason: "Jawny wykonawca scenariusza testowego",
          humanConfirmed: true,
        });
        Object.assign(entity, updated);
        task = (entity.data.tasks as JsonObject[]).find(
          (item) => item.id === input.taskId,
        );
      }
      if (task && task.status === "offered") {
        const updated = await invoke("cases", "acceptTask", {
          id: entity.id,
          expectedVersion: entity.version,
          taskId: task.id!,
          expectedTaskVersion: task.version!,
          humanConfirmed: true,
        });
        Object.assign(entity, updated);
        task = (entity.data.tasks as JsonObject[]).find(
          (item) => item.id === input.taskId,
        );
      }
      input.expectedTaskVersion ??= task?.version ?? 1;
    }
    const raw = { id: entity.id, expectedVersion: entity.version, ...input };
    const tool = tools.get(`ops.${entity.module}.${action}`)!;
    return invoke(
      entity.module,
      action,
      action === "addTask" ? tool.prepareInput!(raw, tenantId) : raw,
    );
  };
  const person = async (category = "internal") => {
    const p = await create("people", "Osoba testowa", {
      personCategory: category,
    });
    return action(p, "startEmployment", {
      employmentKind: category,
      startDate: "2020-01-01",
      role: "Test",
      humanDecision: true,
    });
  };
  const acceptCase = async (id: string) => {
    let e = store.get(principal(tenantId), "cases", id);
    for (const task of e.data.tasks as JsonObject[])
      e = await action(e, "completeTask", {
        taskId: task.id!,
        evidenceNote: "Jawne potwierdzenie testowe człowieka",
        humanConfirmed: true,
      });
    e = await action(e, "addEvidence", {
      title: "Protokół",
      reference: "test-only",
      note: "Ręczne potwierdzenie wykonania testu",
      humanConfirmed: true,
    });
    e = await action(e, "submit");
    return action(e, "accept", {
      decision: "accepted",
      note: "Odebrano zakres testowy",
      humanDecision: true,
    });
  };
  return { tools, invoke, create, action, person, acceptCase };
}

test("catalog exposes nine typed workflows with strict inputs and rejects spoofed identity", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store);
    assert.equal(store.catalog().length, 9);
    assert.ok(
      store.catalog().every((m) => m.fields.length && m.actions.length),
    );
    assert.ok(
      store
        .catalog()
        .find((m) => m.id === "cases")!
        .actions.find((a) => a.id === "addTask")!
        .fields!.some((f) => f.key === "dependsOn"),
    );
    assert.ok(
      [...h.tools.values()].every(
        (t) =>
          (t.scope || t.requiredScopesForInput) &&
          t.recovery === "reconcile" &&
          t.effect === "write",
      ),
    );
    const create = h.tools.get("ops.people.create")!;
    await assert.rejects(
      create.execute(ctx(), {
        title: "A",
        data: { personCategory: "internal", hired: true },
      }),
      code("INVALID_DOMAIN_INPUT"),
    );
    await assert.rejects(
      create.execute(ctx(), {
        title: "A",
        data: { personCategory: "internal" },
        tenantId: "spoof",
      }),
      code("INVALID_DOMAIN_INPUT"),
    );
    const p = await h.create("people", "A", { personCategory: "internal" });
    await assert.rejects(
      h.action(p, "startEmployment", {
        employmentKind: "internal",
        startDate: "2026-02-31",
        role: "T",
        humanDecision: true,
      }),
      code("INVALID_DOMAIN_INPUT"),
    );
    await assert.rejects(
      h.tools.get("ops.people.startEmployment")!.execute(
        { ...ctx(), actorId: undefined },
        {
          id: p.id,
          expectedVersion: p.version,
          employmentKind: "internal",
          startDate: "2020-01-01",
          role: "T",
          humanDecision: true,
        },
      ),
      code("HUMAN_CONFIRMATION_REQUIRED"),
    );
    assert.throws(
      () => store.list(principal("tenant-a", ["assets"]), "people"),
      code("SCOPE_REQUIRED"),
    );
  } finally {
    store.close();
  }
});

test("commands survive restart, replay exactly once, conflict on changed input and verify actual records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-operations-"));
  const path = join(dir, "operations.sqlite");
  let store = new WorkspaceStore(path);
  try {
    const input = { title: "A", data: { personCategory: "internal" } };
    const context = ctx("tenant-a", "durable-command");
    let tool = store.tools().find((t) => t.id === "ops.people.create")!;
    const result = await tool.execute(context, input);
    store.close();
    store = new WorkspaceStore(path);
    tool = store.tools().find((t) => t.id === "ops.people.create")!;
    assert.deepEqual(await tool.reconcile!(context, input), {
      status: "applied",
      result,
    });
    assert.deepEqual(await tool.execute(context, input), result);
    assert.equal(store.list(principal(), "people").length, 1);
    await assert.rejects(
      tool.execute(context, { ...input, title: "Changed" }),
      code("IDEMPOTENCY_CONFLICT"),
    );
    assert.equal(
      (await tool.verify(ctx("tenant-b", context.operationKey), input, result))
        .ok,
      false,
    );
    const b = await tool.execute(ctx("tenant-b", context.operationKey), input);
    assert.notEqual(b.data.entityId, result.data.entityId);
    assert.throws(
      () =>
        store.get(
          principal("tenant-b"),
          "people",
          String(result.data.entityId),
        ),
      code("ENTITY_NOT_FOUND"),
    );
    await helper(store).action(
      store.get(principal(), "people", String(result.data.entityId)),
      "update",
      { title: "New title" },
    );
    assert.equal(
      (await tool.verify(context, input, result)).ok,
      true,
      "historical effect stays valid after legitimate later version",
    );
    const db = new DatabaseSync(path);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM ops_commands WHERE tenant_id='tenant-a'",
        )
        .get()!.n,
      2,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM ops_outbox WHERE tenant_id='tenant-a'",
        )
        .get()!.n,
      2,
    );
    db.prepare(
      "UPDATE ops_entities SET title='tampered' WHERE tenant_id=? AND id=?",
    ).run("tenant-a", String(result.data.entityId));
    db.close();
    assert.equal(
      (await tool.verify(context, input, result)).ok,
      false,
      "verification reads current actual payload, not receipt only",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IT role cannot read HR cases/documents or authorize their mutations; composite operations require all domains", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store),
      p = await h.person();
    const itUser = principal("tenant-a", ["it", "cases", "documents"]);
    const hrCase = store.get(
      principal(),
      "cases",
      String(p.data.onboardingCaseId),
    );
    const itCase = await h.create("cases", "Publiczny dla IT", {
      caseType: "it",
      brief: "Test",
      acceptanceCriteria: "Test",
    });
    const hrDoc = await h.create("documents", "Dokument HR", {
      accessScope: "people",
      documentType: "contract",
      content: "Dane testowe HR",
    });
    const itDoc = await h.create("documents", "Dokument IT", {
      accessScope: "it",
      documentType: "policy",
      content: "Dane testowe IT",
    });
    assert.deepEqual(
      store.list(itUser, "cases").map((e) => e.id),
      [itCase.id],
    );
    assert.deepEqual(
      store.list(itUser, "documents").map((e) => e.id),
      [itDoc.id],
    );
    assert.throws(
      () => store.get(itUser, "cases", hrCase.id),
      code("SCOPE_REQUIRED"),
    );
    assert.throws(
      () => store.get(itUser, "documents", hrDoc.id),
      code("SCOPE_REQUIRED"),
    );
    assert.equal(
      store.summary(itUser).modules.find((m) => m.id === "cases")!.total,
      1,
    );
    assert.equal(
      hasToolAccess(itUser, h.tools.get("ops.cases.revise")!, {
        id: hrCase.id,
        expectedVersion: hrCase.version,
        brief: "T",
        acceptanceCriteria: "T",
        reason: "T",
      }),
      false,
    );
    assert.equal(
      hasToolAccess(itUser, h.tools.get("ops.documents.revise")!, {
        id: hrDoc.id,
        expectedVersion: hrDoc.version,
        content: "T",
        changeNote: "T",
      }),
      false,
    );
    assert.equal(
      hasToolAccess(itUser, h.tools.get("ops.documents.create")!, {
        title: "HR",
        data: { accessScope: "people", documentType: "contract", content: "T" },
      }),
      false,
    );
    assert.equal(
      hasToolAccess(
        principal("tenant-a", ["recruitment"]),
        h.tools.get("ops.recruitment.hire")!,
      ),
      false,
    );
    assert.equal(
      hasToolAccess(
        principal("tenant-a", ["people"]),
        h.tools.get("ops.people.startEmployment")!,
      ),
      false,
    );
    assert.equal(
      hasToolAccess(
        principal("tenant-a", ["sales"]),
        h.tools.get("ops.sales.handoff")!,
      ),
      false,
    );
    await assert.rejects(
      h.action(hrDoc, "update", { data: { accessScope: "it" } }),
      code("INVALID_DOMAIN_INPUT"),
    );
    await assert.rejects(
      h.create("documents", "Brak klasyfikacji", {
        documentType: "policy",
        content: "T",
      }),
      code("INVALID_DOMAIN_INPUT"),
    );
    assert.equal(store.health(), true);
  } finally {
    store.close();
  }
});

test("acceptance binds scope revision, human evidence and all required dependency tasks", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store);
    let e = await h.create("cases", "Sprawa", {
      caseType: "general",
      brief: "Zakres",
      acceptanceCriteria: "Gotowe",
      dueDate: today,
    });
    await assert.rejects(h.action(e, "submit"), code("ACCEPTANCE_NOT_READY"));
    e = await h.action(e, "addTask", {
      title: "Pierwsze",
      required: true,
      dueDate: today,
    });
    const first = (e.data.tasks as JsonObject[])[0]!.id!;
    e = await h.action(e, "addTask", {
      title: "Drugie",
      required: true,
      dependsOn: [first],
    });
    const second = (e.data.tasks as JsonObject[])[1]!.id!;
    await assert.rejects(
      h.action(e, "completeTask", {
        taskId: second,
        evidenceNote: "Test",
        humanConfirmed: true,
      }),
      code("TASK_DEPENDENCIES_OPEN"),
    );
    await assert.rejects(
      h.action(e, "addTask", {
        title: "Błędne",
        required: true,
        dependsOn: [randomUUID()],
      }),
      code("TASK_NOT_FOUND"),
    );
    e = await h.action(e, "completeTask", {
      taskId: first,
      evidenceNote: "Test 1",
      humanConfirmed: true,
    });
    e = await h.action(e, "completeTask", {
      taskId: second,
      evidenceNote: "Test 2",
      humanConfirmed: true,
    });
    assert.equal(
      (e.data.tasks as JsonObject[])[0]!.completedBy,
      "human-reviewer",
    );
    await assert.rejects(h.action(e, "submit"), code("ACCEPTANCE_NOT_READY"));
    e = await h.action(e, "addEvidence", {
      title: "Dowód",
      reference: "manual:test",
      note: "Człowiek potwierdza",
      humanConfirmed: true,
    });
    e = await h.action(e, "submit");
    await assert.rejects(
      h.action(e, "accept", {
        decision: "accepted",
        note: "Tak",
        humanDecision: false,
      }),
      code("INVALID_DOMAIN_INPUT"),
    );
    e = await h.action(e, "accept", {
      decision: "accepted",
      note: "Tak",
      humanDecision: true,
    });
    assert.equal(e.status, "accepted");
    e = await h.action(e, "revise", {
      brief: "Nowy zakres",
      acceptanceCriteria: "Nowe kryteria",
      reason: "Zmiana celu",
    });
    assert.equal(e.data.scopeRevision, 2);
    assert.equal((e.data.tasks as JsonObject[]).length, 2);
    assert.ok(
      (e.data.tasks as JsonObject[]).every(
        (task) =>
          task.status === "offered" && task.id !== first && task.id !== second,
      ),
    );
    assert.deepEqual(e.data.evidence, []);
    assert.equal((e.data.acceptances as JsonObject[]).length, 1);
    await assert.rejects(h.action(e, "submit"), code("ACCEPTANCE_NOT_READY"));
    await assert.rejects(
      h.action(e, "completeTask", {
        taskId: first,
        evidenceNote: "Stary",
        humanConfirmed: true,
      }),
      code("TASK_REVISION_CONFLICT"),
    );
  } finally {
    store.close();
  }
});

test("employment episodes create real lifecycle cases, keep contractors separate and gate readiness/exit", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store);
    let p = await h.create("people", "Kontraktor", {
      personCategory: "contractor",
    });
    p = await h.action(p, "startEmployment", {
      employmentKind: "contractor",
      startDate: "2020-01-01",
      role: "T",
      humanDecision: true,
    });
    const onboarding = store.get(
      principal(),
      "cases",
      String(p.data.onboardingCaseId),
    );
    assert.equal(onboarding.data.employmentKind, "contractor");
    assert.equal((onboarding.data.tasks as JsonObject[]).length, 4);
    assert.ok(
      (onboarding.data.tasks as JsonObject[]).every(
        (task) => task.status === "unassigned" && task.assigneeId === null,
      ),
    );
    assert.equal(
      (onboarding.data.tasks as JsonObject[])[0]!.dueDate,
      "2019-12-29",
    );
    await assert.rejects(
      h.action(p, "activate", { humanDecision: true }),
      code("INVALID_TRANSITION"),
    );
    await assert.rejects(
      h.acceptCase(onboarding.id),
      code("ACCEPTANCE_NOT_READY"),
    );
    const readiness = store.readiness(principal(), onboarding.id);
    assert.equal(readiness.ready, false);
    assert.equal(
      readiness.requirements.filter(
        (r) => r.required && r.status !== "satisfied",
      ).length,
      3,
    );
    // Cancelling an unfinished onboarding through offboarding is a supported
    // independent workflow; this does not pretend onboarding was accepted.

    let license = await h.create("licenses", "Produkt", {
      product: "T",
      totalSeats: 1,
    });
    license = await h.action(license, "assign", {
      personId: p.id,
      note: "Rejestr lokalny",
    });
    p = await h.action(p, "beginOffboarding", {
      endDate: today,
      reason: "Koniec",
      humanDecision: true,
    });
    await assert.rejects(
      h.action(p, "endEmployment", {
        endDate: today,
        reason: "Koniec",
        humanDecision: true,
      }),
      code("INVALID_TRANSITION"),
    );
    await h.acceptCase(String(p.data.offboardingCaseId));
    await assert.rejects(
      h.action(p, "endEmployment", {
        endDate: today,
        reason: "Koniec",
        humanDecision: true,
      }),
      code("LICENSES_NOT_REVOKED"),
    );
    await h.action(license, "revoke", { personId: p.id, reason: "Koniec" });
    p = await h.action(p, "endEmployment", {
      endDate: today,
      reason: "Koniec",
      humanDecision: true,
    });
    assert.equal(p.status, "exited");
    await assert.rejects(
      h.action(p, "startEmployment", {
        employmentKind: "contractor",
        startDate: "2020-01-02",
        role: "T",
        humanDecision: true,
      }),
      code("OVERLAPPING_EMPLOYMENT"),
    );
    p = await h.action(p, "startEmployment", {
      employmentKind: "contractor",
      startDate: "2099-01-01",
      role: "T2",
      humanDecision: true,
    });
    assert.equal((p.data.employmentEpisodes as JsonObject[]).length, 2);
    assert.notEqual(p.data.onboardingCaseId, onboarding.id);
  } finally {
    store.close();
  }
});

for (const cancellation of ["cancel", "beginOffboarding"] as const) {
  test(`${cancellation} cancels all unfinished onboarding tasks atomically, preserves completed work and records one event per task`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-task-cancellation-"));
    const path = join(dir, "workspace.db");
    const store = new WorkspaceStore(path);
    const db = new DatabaseSync(path);
    try {
      const h = helper(store),
        person = await h.person();
      let onboarding = store.get(
        principal(),
        "cases",
        String(person.data.onboardingCaseId),
      );
      const tasks = () => onboarding.data.tasks as JsonObject[];
      onboarding = await h.action(onboarding, "completeTask", {
        taskId: tasks()[0]!.id!,
        evidenceNote: "Work completed before cancellation",
        humanConfirmed: true,
      });
      for (const [index, action] of [
        [1, "acceptTask"],
        [2, "declineTask"],
      ] as const) {
        const id = tasks()[index]!.id!;
        onboarding = await h.action(onboarding, "transferTask", {
          taskId: id,
          expectedTaskVersion: tasks()[index]!.version!,
          assigneePrincipalId: principal().id,
          reason: "Explicit worker assignment",
          humanConfirmed: true,
        });
        onboarding = await h.action(onboarding, action, {
          taskId: id,
          expectedTaskVersion: tasks()[index]!.version!,
          humanConfirmed: true,
          ...(action === "declineTask"
            ? { reason: "Cannot perform this task" }
            : {}),
        });
      }
      onboarding = await h.action(onboarding, "addTask", {
        title: "Offered work",
        required: false,
      });
      const before = structuredClone(tasks());
      assert.deepEqual(before.map((task) => task.status).sort(), [
        "accepted",
        "completed",
        "declined",
        "offered",
        "unassigned",
      ]);
      const eventsBefore = Number(
        db
          .prepare("SELECT count(*) AS n FROM ops_task_events WHERE case_id=?")
          .get(onboarding.id)!.n,
      );
      const target = cancellation === "cancel" ? onboarding : person;
      const tool = h.tools.get(`ops.${target.module}.${cancellation}`)!;
      const command = {
        id: target.id,
        expectedVersion: target.version,
        reason: "Explicit cancellation",
        ...(cancellation === "beginOffboarding"
          ? {
              endDate: today,
              humanDecision: true,
              employmentEpisodeId: store.listEmploymentEpisodes(
                principal(),
                person.id,
              )[0]!.id,
              expectedEpisodeVersion: store.listEmploymentEpisodes(
                principal(),
                person.id,
              )[0]!.version,
            }
          : {}),
      };
      const operation = { ...ctx(), approvedBy: "independent-reviewer" };
      // Fail the last task after earlier task transitions have executed. Their
      // writes and events must roll back together with the case and person.
      db.exec(
        `CREATE TRIGGER reject_last_cancellation BEFORE UPDATE ON ops_tasks WHEN NEW.id='${String(before.at(-1)!.id)}' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT, 'synthetic cancellation rollback'); END;`,
      );
      await assert.rejects(
        tool.execute(operation, command),
        /synthetic cancellation rollback/,
      );
      assert.deepEqual(
        store.get(principal(), "cases", onboarding.id).data.tasks,
        before,
      );
      assert.equal(
        store.get(principal(), "cases", onboarding.id).status,
        "open",
      );
      assert.equal(
        store.get(principal(), "people", person.id).status,
        "onboarding",
      );
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM ops_task_events WHERE case_id=?",
            )
            .get(onboarding.id)!.n,
        ),
        eventsBefore,
      );
      db.exec("DROP TRIGGER reject_last_cancellation");
      const result = await tool.execute(operation, command);
      assert.equal((await tool.verify(operation, command, result)).ok, true);
      const cancelled = store.get(principal(), "cases", onboarding.id);
      assert.equal(cancelled.status, "cancelled");
      for (const old of before) {
        const task = (cancelled.data.tasks as JsonObject[]).find(
          (task) => task.id === old.id,
        )!;
        if (old.status === "completed") assert.deepEqual(task, old);
        else {
          assert.equal(task.status, "cancelled");
          assert.equal(task.version, Number(old.version) + 1);
          const event = db
            .prepare(
              "SELECT * FROM ops_task_events WHERE task_id=? ORDER BY task_version DESC LIMIT 1",
            )
            .get(String(old.id))!;
          assert.equal(event.action, "cancelTask");
          assert.equal(event.from_status, old.status);
          assert.equal(event.to_status, "cancelled");
          assert.equal(event.requested_by, principal().id);
          assert.equal(event.approved_by, "independent-reviewer");
          assert.equal(event.operation_key, operation.operationKey);
          assert.equal(event.reason, cancelled.data.cancellationReason);
        }
      }
      assert.ok(
        store
          .listTasks(principal())
          .filter((task) => task.caseId === onboarding.id)
          .every((task) => task.allowedActions.length === 0),
      );
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM ops_task_events WHERE case_id=?",
            )
            .get(onboarding.id)!.n,
        ),
        eventsBefore + 4,
      );
      assert.deepEqual(await tool.execute(operation, command), result);
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM ops_task_events WHERE case_id=?",
            )
            .get(onboarding.id)!.n,
        ),
        eventsBefore + 4,
      );
      assert.equal(
        store.get(principal(), "people", person.id).status,
        cancellation === "beginOffboarding" ? "offboarding" : "onboarding",
      );
    } finally {
      db.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("employment exit rechecks the accepted offboarding document and keeps the episode open after source changes", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store);
    let person = await h.person();
    person = await h.action(person, "beginOffboarding", {
      endDate: today,
      reason: "Test offboarding",
      humanDecision: true,
    });
    let offboarding = store.get(
      principal(),
      "cases",
      String(person.data.offboardingCaseId),
    );
    offboarding = await h.action(offboarding, "revise", {
      brief: String(offboarding.data.brief),
      acceptanceCriteria: "Current approved settlement document",
      reason: "Explicit typed settlement proof",
      requirements: [
        {
          key: "settlement",
          title: "Approved settlement",
          kind: "document_approved",
          required: true,
          expected: { documentType: "report", currentVersionRequired: true },
        },
      ],
    });
    let document = await h.create("documents", "Synthetic settlement report", {
      documentType: "report",
      content: "Synthetic settlement content",
      accessScope: "people",
      linkedCaseId: offboarding.id,
    });
    document = await h.action(document, "submit");
    document = await h.action(document, "approve", {
      decision: "approved",
      note: "Explicit report acceptance",
      humanDecision: true,
    });
    offboarding = await h.action(offboarding, "bindEvidence", {
      requirementId: store.readiness(principal(), offboarding.id)
        .requirements[0]!.id,
      sourceModule: "documents",
      sourceId: document.id,
      sourceVersion: document.version,
    });
    offboarding = await h.acceptCase(offboarding.id);
    assert.equal(
      store.readiness(principal(), offboarding.id).acceptanceCurrent,
      true,
    );
    await h.action(document, "revise", {
      content: "Changed settlement terms",
      changeNote: "New revision after acceptance",
    });
    assert.equal(
      store.readiness(principal(), offboarding.id).acceptanceCurrent,
      false,
    );
    await assert.rejects(
      h.action(person, "endEmployment", {
        endDate: today,
        reason: "Must recheck acceptance",
        humanDecision: true,
      }),
      code("EXIT_READINESS_STALE"),
    );
    const unchanged = store.get(principal(), "people", person.id);
    assert.equal(unchanged.status, "offboarding");
    assert.equal(
      (unchanged.data.employmentEpisodes as JsonObject[]).at(-1)!.status,
      "offboarding",
    );
  } finally {
    store.close();
  }
});

test("asset reservation serializes concurrent writers and requires actual human handover and return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-reserve-"));
  const path = join(dir, "operations.sqlite");
  const a = new WorkspaceStore(path),
    b = new WorkspaceStore(path);
  try {
    const h = helper(a),
      second = helper(b);
    const p = await h.person(),
      q = await h.person();
    let asset = await h.create("assets", "Laptop", {
      assetType: "laptop",
      serial: "TEST-1",
      location: "Local",
      condition: "good",
    });
    const input = {
      id: asset.id,
      expectedVersion: asset.version,
      purpose: "Test",
      until: "2099-01-01",
    };
    const results = await Promise.allSettled([
      h.tools.get("ops.assets.reserve")!.execute(ctx(), {
        ...input,
        personId: p.id,
        caseId: String(p.data.onboardingCaseId),
        employmentEpisodeId: a.listEmploymentEpisodes(principal(), p.id)[0]!.id,
        expectedEpisodeVersion: a.listEmploymentEpisodes(principal(), p.id)[0]!
          .version,
      }),
      second.tools.get("ops.assets.reserve")!.execute(ctx(), {
        ...input,
        personId: q.id,
        caseId: String(q.data.onboardingCaseId),
        employmentEpisodeId: b.listEmploymentEpisodes(principal(), q.id)[0]!.id,
        expectedEpisodeVersion: b.listEmploymentEpisodes(principal(), q.id)[0]!
          .version,
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    asset = a.get(principal(), "assets", asset.id);
    assert.equal(
      (asset.data.allocations as JsonObject[]).filter(
        (v) => v.status === "reserved",
      ).length,
      1,
    );
    const recipient = (asset.data.allocations as JsonObject[])[0]!.personId!;
    await assert.rejects(
      h.action(asset, "issue", {
        personId: q.id,
        issuedOn: today,
        handoverNote: "Test",
        humanConfirmed: true,
      }),
      code("WRONG_RECIPIENT"),
    );
    asset = await h.action(asset, "issue", {
      personId: recipient,
      issuedOn: today,
      handoverNote: "Protokół lokalny",
      humanConfirmed: true,
    });
    assert.equal(asset.status, "issued");
    asset = await h.action(asset, "return", {
      returnedOn: today,
      condition: "repair",
      receiptNote: "Uszkodzenie testowe",
      humanConfirmed: true,
    });
    assert.equal(asset.status, "maintenance");
    await assert.rejects(
      h.action(asset, "reserve", {
        personId: p.id,
        purpose: "Test",
        until: "2099-01-01",
      }),
      code("INVALID_TRANSITION"),
    );
    asset = await h.action(asset, "markRepaired", {
      note: "Potwierdzenie testowe",
      humanConfirmed: true,
    });
    assert.equal(asset.status, "available");
    await assert.rejects(
      helper(a, "tenant-b").invoke("assets", "reserve", {
        id: asset.id,
        expectedVersion: asset.version,
        personId: p.id,
        purpose: "Test",
        until: "2099-01-01",
      }),
      code("ENTITY_NOT_FOUND"),
    );
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("purchase acknowledgment is distinct from delivery; partial receipt and supplier obligations enforced", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store);
    const supplier = await h.create("purchases", "Dostawca", {
      kind: "supplier",
      description: "Test",
    });
    let request = await h.create("purchases", "Zapotrzebowanie", {
      kind: "request",
      description: "Syntetyczny zakup",
      quantity: 2,
      budgetMinor: 1000000,
      currency: "PLN",
      priceBasis: "gross",
      requiredBy: today,
    });
    const quote = await h.create("purchases", "Oferta dostawcy", {
      kind: "quote",
      requestId: request.id,
      expectedRequestVersion: request.version,
      supplierId: supplier.id,
      expectedSupplierVersion: supplier.version,
      quoteReference: "SYNTHETIC-QUOTE",
      description: "Syntetyczny zakup",
      quantity: 2,
      unitPriceMinor: 100000,
      shippingMinor: 0,
      currency: "PLN",
      priceBasis: "gross",
      validUntil: today,
      expectedDelivery: today,
      terms: "Syntetyczna oferta bez wysyłki",
    });
    request = store.get(principal(), "purchases", request.id);
    request = await h.action(request, "selectQuote", {
      quoteId: quote.id,
      expectedQuoteVersion: quote.version,
      selectionReason: "Uzgodniony koszt i termin",
    });
    request = await h.action(request, "decideCost", {
      quoteId: quote.id,
      expectedQuoteVersion: quote.version,
      decision: "approved",
      note: "Jawna decyzja testowa",
      humanDecision: true,
    });
    const cost = request.data.costDecision as JsonObject;
    request = await h.action(request, "placeOrder", {
      costDecisionHash: cost.hash!,
      expectedSupplierVersion: supplier.version,
    });
    let order = store.get(
      principal(),
      "purchases",
      String(request.data.orderId),
    );
    await assert.rejects(
      h.action(order, "recordDelivery", {
        quantityReceived: 1,
        receivedOn: today,
        deliveryNote: "Test",
        humanConfirmed: true,
      }),
      code("INVALID_TRANSITION"),
    );
    assert.equal(order.data.dispatch, "not_sent_local_record");
    order = await h.action(order, "acknowledge", {
      supplierReference: "PO-TEST",
      acknowledgedOn: today,
      evidenceNote: "Ręcznie zgłoszone",
      humanConfirmed: true,
    });
    assert.equal(order.data.receivedQuantity, 0);
    assert.equal(order.status, "acknowledged");
    await assert.rejects(
      h.action(supplier, "deactivate", { reason: "T" }),
      code("SUPPLIER_IN_USE"),
    );
    order = await h.action(order, "recordDelivery", {
      quantityReceived: 1,
      receivedOn: today,
      deliveryNote: "Test",
      humanConfirmed: true,
    });
    assert.equal(order.status, "part_received");
    await assert.rejects(
      h.action(order, "recordDelivery", {
        quantityReceived: 2,
        receivedOn: today,
        deliveryNote: "Test",
        humanConfirmed: true,
      }),
      code("DELIVERY_EXCEEDS_ORDER"),
    );
    order = await h.action(order, "recordDelivery", {
      quantityReceived: 1,
      receivedOn: today,
      deliveryNote: "Test",
      humanConfirmed: true,
    });
    assert.equal(order.status, "received");
    assert.equal(
      store.list(principal(), "assets").length,
      0,
      "delivery does not invent physical asset records",
    );
    assert.equal(
      (await h.action(supplier, "deactivate", { reason: "Zakończone" })).status,
      "inactive",
    );
  } finally {
    store.close();
  }
});

test("local licenses enforce seat capacity and expiry without provisioning external accounts", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store),
      p = await h.person(),
      q = await h.person();
    let license = await h.create("licenses", "Licencja", {
      product: "Test",
      totalSeats: 1,
      expiresOn: "2099-01-01",
    });
    license = await h.action(license, "assign", {
      personId: p.id,
      note: "Test",
    });
    assert.equal(license.data.provisioning, "local_register_only");
    await assert.rejects(
      h.action(license, "assign", { personId: q.id, note: "T" }),
      code("NO_FREE_SEATS"),
    );
    license = await h.action(license, "resize", { totalSeats: 2 });
    license = await h.action(license, "assign", { personId: q.id, note: "T" });
    await assert.rejects(
      h.action(license, "resize", { totalSeats: 1 }),
      code("SEAT_CAP_BELOW_USAGE"),
    );
    const expired = await h.create("licenses", "Wygasła", {
      product: "Test",
      totalSeats: 1,
      expiresOn: "2000-01-01",
    });
    await assert.rejects(
      h.action(expired, "assign", { personId: p.id, note: "T" }),
      code("LICENSE_EXPIRED"),
    );
  } finally {
    store.close();
  }
});

test("recruitment requires explicit human decisions and hire creates a single linked employment", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store),
      p = await h.create("people", "Kandydat", { personCategory: "internal" });
    const vacancy = await h.create("recruitment", "Rekrutacja", {
      kind: "vacancy",
      employmentKind: "internal",
      description: "Test",
    });
    let app = await h.create("recruitment", "Aplikacja", {
      kind: "application",
      employmentKind: "internal",
      personId: p.id,
      vacancyId: vacancy.id,
      description: "Test",
    });
    await assert.rejects(
      h.action(app, "hire", {
        startDate: "2020-01-01",
        role: "T",
        humanDecision: true,
      }),
      code("INVALID_TRANSITION"),
    );
    app = await h.action(app, "screen", {
      decision: "advance",
      assessment: "Ocena człowieka",
      humanDecision: true,
    });
    app = await h.action(app, "interview", {
      assessment: "Rozmowa człowieka",
      humanDecision: true,
    });
    app = await h.action(app, "makeOffer", {
      terms: "Warunki",
      startDate: "2020-01-01",
    });
    assert.equal(store.get(principal(), "people", p.id).status, "registered");
    app = await h.action(app, "decide", {
      decision: "accepted",
      reason: "Ręczne potwierdzenie",
      humanDecision: true,
    });
    app = await h.action(app, "hire", {
      startDate: "2020-01-01",
      role: "Test",
      humanDecision: true,
    });
    const person = store.get(principal(), "people", p.id);
    assert.equal(person.status, "onboarding");
    assert.equal((person.data.employmentEpisodes as JsonObject[]).length, 1);
    assert.equal(
      person.data.currentEmploymentEpisodeId,
      app.data.employmentEpisodeId,
    );
    assert.ok(person.data.onboardingCaseId);
    assert.equal(
      (await h.action(vacancy, "close", { reason: "Zatrudniono" })).status,
      "closed",
    );
  } finally {
    store.close();
  }
});

test("CRM offer handoff atomically creates delivery case and wins linked deal", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store),
      client = await h.create("sales", "Klient", {
        kind: "client",
        organizationName: "Firma",
      });
    let deal = await h.create("sales", "Szansa", {
      kind: "deal",
      organizationName: "Firma",
      parentId: client.id,
    });
    let offer = await h.create("sales", "Oferta", {
      kind: "offer",
      organizationName: "Firma",
      parentId: deal.id,
      scope: "Realizacja testowa",
      value: 100,
      currency: "PLN",
    });
    await assert.rejects(
      h.action(offer, "submitOffer"),
      code("INVALID_TRANSITION"),
    );
    deal = await h.action(deal, "qualify", {
      qualification: "Zakres i budżet potwierdzone",
    });
    offer = await h.action(offer, "submitOffer");
    offer = await h.action(offer, "acceptOffer", {
      acceptedOn: today,
      acceptanceNote: "Człowiek potwierdza",
      humanDecision: true,
    });
    await assert.rejects(
      h.action(deal, "lose", { reason: "T", humanDecision: true }),
      code("ACCEPTED_OFFER_EXISTS"),
    );
    offer = await h.action(offer, "handoff", {
      acceptanceCriteria: "Potwierdzenie odbioru przez człowieka",
    });
    const delivery = store.get(
      principal(),
      "cases",
      String(offer.data.deliveryCaseId),
    );
    assert.equal(delivery.data.sourceOfferId, offer.id);
    assert.equal(delivery.data.caseType, "delivery");
    assert.equal(store.get(principal(), "sales", deal.id).status, "won");
    await assert.rejects(
      h.action(offer, "handoff", { acceptanceCriteria: "Duplikat" }),
      code("INVALID_TRANSITION"),
    );
  } finally {
    store.close();
  }
});

test("document approvals bind content revision; IT observations remain local evidence workflows", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store);
    let doc = await h.create("documents", "Dokument", {
      accessScope: "documents",
      documentType: "policy",
      content: "Wersja 1",
    });
    doc = await h.action(doc, "submit");
    doc = await h.action(doc, "approve", {
      decision: "approved",
      note: "Przeczytano",
      humanDecision: true,
    });
    doc = await h.action(doc, "revise", {
      content: "Wersja 2",
      changeNote: "Zmiana",
    });
    assert.equal(doc.status, "draft");
    assert.equal((doc.data.versions as JsonObject[])[0]!.status, "approved");
    assert.equal((doc.data.versions as JsonObject[])[1]!.status, "draft");
    let observation = await h.create("it", "Obserwacja", {
      kind: "observation",
      description: "Test lokalny",
      severity: "low",
      environment: "lab",
    });
    observation = await h.action(observation, "promoteIncident", {
      description: "Incydent laboratoryjny",
      severity: "medium",
    });
    let incident = store.get(
      principal(),
      "it",
      String(observation.data.incidentId),
    );
    incident = await h.action(incident, "triage", {
      assessment: "Diagnoza człowieka",
    });
    incident = await h.action(incident, "recordAction", {
      actionNote: "Wykonane przez człowieka",
      evidenceNote: "Protokół",
      humanConfirmed: true,
    });
    incident = await h.action(incident, "resolve", {
      resolution: "Odebrano",
      evidenceNote: "Potwierdzenie człowieka",
      humanConfirmed: true,
    });
    assert.equal(incident.status, "resolved");
    assert.equal(incident.data.externalActionsPerformed, false);
  } finally {
    store.close();
  }
});

test("case worklogs are declared immutable entries and acceptance produces only a settlement draft for its revision", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store);
    let c = await h.create("cases", "Czas i koszty", {
      caseType: "general",
      brief: "Test",
      acceptanceCriteria: "Test",
    });
    c = await h.action(c, "addTask", { title: "Odbiór", required: true });
    c = await h.action(c, "addWorklog", {
      description: "Praca",
      minutes: 90,
      performedOn: today,
      amount: 12.34,
      currency: "PLN",
    });
    c = await h.action(c, "addWorklog", {
      description: "Materiał",
      minutes: 0,
      performedOn: today,
      amount: 0.01,
      currency: "PLN",
    });
    c = await h.action(c, "addWorklog", {
      description: "Usługa",
      minutes: 30,
      performedOn: today,
      amount: 10,
      currency: "EUR",
    });
    await assert.rejects(
      h.action(c, "addWorklog", {
        description: "Brak waluty",
        minutes: 30,
        performedOn: today,
        amount: 10,
      }),
      code("INVALID_DOMAIN_INPUT"),
    );
    await assert.rejects(
      h.action(c, "addWorklog", {
        description: "Przyszłość",
        minutes: 30,
        performedOn: "2099-01-01",
      }),
      code("FUTURE_WORKLOG"),
    );
    c = await h.acceptCase(c.id);
    const draft = c.data.settlementDraft as JsonObject;
    assert.equal(draft.kind, "draft");
    assert.equal(draft.declaredMinutes, 120);
    assert.deepEqual(draft.declaredCosts, [
      { currency: "PLN", amount: 12.35 },
      { currency: "EUR", amount: 10 },
    ]);
    assert.equal(draft.financialPosting, false);
    assert.equal(draft.paymentExecuted, false);
    await assert.rejects(
      h.action(c, "addWorklog", {
        description: "Dopisek",
        minutes: 1,
        performedOn: today,
      }),
      code("INVALID_TRANSITION"),
    );
    c = await h.action(c, "revise", {
      brief: "Korekta",
      acceptanceCriteria: "Nowy odbiór",
      reason: "Zmiana",
    });
    assert.deepEqual(c.data.worklogs, []);
    assert.equal(c.data.settlementDraft, null);
  } finally {
    store.close();
  }
});

test("document source references bind actual tenant/version and propagate source privacy", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const h = helper(store),
      p = await h.create("people", "Osoba HR", { personCategory: "internal" });
    const source = {
      module: "people",
      id: p.id,
      version: p.version,
      observedAt: new Date().toISOString(),
    };
    let doc = await h.create("documents", "Źródła", {
      accessScope: "documents",
      documentType: "report",
      content: "Test",
      sources: [source],
    });
    assert.match(
      String((doc.data.sources as JsonObject[])[0]!.snapshotHash),
      /^[a-f0-9]{64}$/,
    );
    assert.throws(
      () =>
        store.get(principal("tenant-a", ["documents"]), "documents", doc.id),
      code("SCOPE_REQUIRED"),
    );
    assert.deepEqual(
      store.list(principal("tenant-a", ["documents"]), "documents"),
      [],
    );
    await assert.rejects(
      h.create("documents", "Błędna wersja", {
        accessScope: "people",
        documentType: "report",
        content: "T",
        sources: [{ ...source, version: 999 }],
      }),
      code("SOURCE_VERSION_CHANGED"),
    );
    await assert.rejects(
      helper(store, "tenant-b").create("documents", "Inny tenant", {
        accessScope: "people",
        documentType: "report",
        content: "T",
        sources: [source],
      }),
      code("ENTITY_NOT_FOUND"),
    );
    await assert.rejects(
      h.create("documents", "Sfałszowany hash", {
        accessScope: "people",
        documentType: "report",
        content: "T",
        sources: [{ ...source, snapshotHash: "fake" }],
      }),
      code("INVALID_DOMAIN_INPUT"),
    );
    await h.action(p, "update", { title: "Aktualna nazwa" });
    await assert.rejects(
      h.create("documents", "Nieaktualne źródło", {
        accessScope: "people",
        documentType: "report",
        content: "T",
        sources: [source],
      }),
      code("SOURCE_VERSION_CHANGED"),
    );
    await assert.rejects(h.action(doc, "submit"), code("DOCUMENT_NOT_READY"));
    assert.equal(
      (doc.data.sources as JsonObject[])[0]!.version,
      1,
      "existing document keeps its frozen source version",
    );
    doc = await h.action(doc, "revise", {
      content: "Jawnie sprawdzono aktualne źródło",
      changeNote: "Odświeżenie po zmianie źródła",
      sources: store.documentRefresh(principal("tenant-a", ["*"]), doc.id)
        .sources,
    });
    doc = await h.action(doc, "submit");
    doc = await h.action(doc, "approve", {
      decision: "approved",
      note: "Sprawdzono nową rewizję",
      humanDecision: true,
    });
    assert.equal((doc.data.sources as JsonObject[])[0]!.version, 2);
  } finally {
    store.close();
  }
});

test("Core pins company profile version; lifecycle uses frozen template offsets and rejects stale execution/recovery", async () => {
  const store = new WorkspaceStore(":memory:");
  let profileVersion = 3;
  const seenTenants: string[] = [];
  const tasks = [
    {
      key: "docs",
      kind: "work" as const,
      assigneeRole: "hr" as const,
      requirementKeys: ["documents"],
      title: "Firmowa kontrola dokumentów",
      required: true,
      offsetDays: -2,
      dependsOn: [],
    },
    {
      key: "ready",
      kind: "decision" as const,
      assigneeRole: "manager" as const,
      requirementKeys: ["equipment", "access"],
      title: "Firmowa gotowość",
      required: true,
      offsetDays: 3,
      dependsOn: ["docs"],
    },
  ];
  store.setProfileProvider((tenantId) => {
    seenTenants.push(tenantId);
    return {
      version: profileVersion,
      definitionVersion: "2",
      roleBindings: {
        hr: "human-reviewer",
        it: "human-reviewer",
        manager: "human-reviewer",
      },
      processTemplates: { onboarding: tasks, offboarding: tasks },
    };
  });
  const tools = store.tools();
  const actor = principal();
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals: [actor],
    policies: [
      {
        tenantId: actor.tenantId,
        name: "Test",
        version: "1",
        allowedTools: tools.map((t) => t.id),
        approvalTools: [],
        allowSelfApproval: true,
      },
    ],
  });
  try {
    const h = helper(store);
    const p = await h.create("people", "Szablon firmy", {
      personCategory: "internal",
    });
    const start = tools.find((t) => t.id === "ops.people.startEmployment")!;
    const input = {
      id: p.id,
      expectedVersion: p.version,
      employmentKind: "internal",
      startDate: "2020-01-10",
      role: "T",
      humanDecision: true,
    };
    const run = engine.createRun(
      actor,
      "Start z profilem",
      {
        title: "Start",
        summary: "Test",
        steps: [{ id: "start", title: "Start", toolId: start.id, input }],
      },
      "pinned-profile",
    );
    assert.equal(
      run.plan.steps[0]!.input.profileVersion,
      3,
      "profile is pinned before plan/approval hash",
    );
    engine.start(actor, run.id);
    await engine.tick();
    const approval = engine.getRun(actor, run.id).steps[0]!.approval!;
    engine.approve(actor, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    for (let i = 0; i < 4; i++) await engine.tick();
    assert.equal(engine.getRun(actor, run.id).status, "completed");
    const updated = store.get(actor, "people", p.id),
      c = store.get(actor, "cases", String(updated.data.onboardingCaseId));
    assert.equal(c.data.profileVersion, 3);
    assert.equal(
      (c.data.processTemplateSnapshot as JsonObject).profileVersion,
      3,
    );
    const actual = c.data.tasks as JsonObject[];
    assert.equal(actual.length, 2);
    assert.equal(actual[0]!.title, tasks[0]!.title);
    assert.equal(actual[0]!.dueDate, "2020-01-08");
    assert.equal(actual[1]!.dueDate, "2020-01-13");
    assert.deepEqual(actual[1]!.dependsOn, [actual[0]!.id]);
    assert.ok(seenTenants.every((tenant) => tenant === "tenant-a"));
    assert.ok(
      store
        .audit(actor, "people", p.id)
        .every((row) => row.initiatedBy === "human-reviewer"),
    );
    assert.throws(
      () => store.audit(principal("tenant-b"), "people", p.id),
      code("ENTITY_NOT_FOUND"),
    );
    const q = await h.create("people", "Stary plan", {
      personCategory: "internal",
    });
    const stale = start.prepareInput!(
      { ...input, id: q.id, expectedVersion: q.version },
      actor.tenantId,
    );
    profileVersion = 4;
    await assert.rejects(start.execute(ctx(), stale), code("PROFILE_CHANGED"));
    await assert.rejects(
      start.reconcile!(ctx(), stale),
      code("PROFILE_CHANGED"),
    );
    assert.equal(store.get(actor, "people", q.id).status, "registered");
    assert.equal(
      store.get(actor, "cases", c.id).data.profileVersion,
      3,
      "existing cases retain template snapshot",
    );
  } finally {
    engine.close();
    store.close();
  }
});

test("company calendar handles Polish midnight separately from a UTC tenant; legacy without profile stays UTC", async () => {
  // 01:30 on 8 September in Poland, still 7 September in UTC.
  const instant = Date.parse("2026-09-07T23:30:00.000Z");
  const store = new WorkspaceStore(":memory:", { clock: () => instant });
  const legacy = new WorkspaceStore(":memory:", { clock: () => instant });
  const template = [
    {
      key: "readiness",
      kind: "work" as const,
      assigneeRole: "hr" as const,
      requirementKeys: [],
      title: "Gotowość",
      required: true,
      offsetDays: 0,
      dependsOn: [],
    },
  ];
  store.setProfileProvider((tenantId) => ({
    version: 1,
    definitionVersion: "2",
    roleBindings: {},
    ...(tenantId === "tenant-b" ? { timezone: "UTC" } : {}),
    processTemplates: { onboarding: template, offboarding: template },
  }));
  try {
    const pl = helper(store),
      utc = helper(store, "tenant-b");
    const polishCase = await pl.create("cases", "Praca Polska", {
      caseType: "general",
      brief: "Test",
      acceptanceCriteria: "Test",
    });
    const utcCase = await utc.create("cases", "Praca UTC", {
      caseType: "general",
      brief: "Test",
      acceptanceCriteria: "Test",
    });
    await pl.action(polishCase, "addWorklog", {
      description: "Dzisiejsza praca",
      minutes: 15,
      performedOn: "2026-09-08",
    });
    await assert.rejects(
      utc.action(utcCase, "addWorklog", {
        description: "Jutro UTC",
        minutes: 15,
        performedOn: "2026-09-08",
      }),
      code("FUTURE_WORKLOG"),
    );
    // Onboarding remains open; license/calendar checks do not require or prove readiness.
    const onboard = async (h: ReturnType<typeof helper>) => {
      const person = await h.create("people", "Osoba kalendarza", {
        personCategory: "internal",
      });
      return h.action(person, "startEmployment", {
        employmentKind: "internal",
        profileVersion: 1,
        startDate: "2026-09-08",
        role: "Test",
        humanDecision: true,
      });
    };
    const polishPerson = await onboard(pl),
      utcPerson = await onboard(utc);
    const polishLicense = await pl.create("licenses", "Ważność Polska", {
      product: "Test",
      totalSeats: 1,
      expiresOn: "2026-09-07",
    });
    const utcLicense = await utc.create("licenses", "Ważność UTC", {
      product: "Test",
      totalSeats: 1,
      expiresOn: "2026-09-07",
    });
    await assert.rejects(
      pl.action(polishLicense, "assign", {
        personId: polishPerson.id,
        note: "Wygasła",
      }),
      code("LICENSE_EXPIRED"),
    );
    assert.equal(
      (
        await utc.action(utcLicense, "assign", {
          personId: utcPerson.id,
          note: "Jeszcze ważna",
        })
      ).data.assignedSeats,
      1,
    );
    const asset = await pl.create("assets", "Rezerwacja", {
      assetType: "laptop",
      serial: "TZ-1",
      location: "Local",
      condition: "good",
    });
    await assert.rejects(
      pl.action(asset, "reserve", {
        personId: polishPerson.id,
        purpose: "Test",
        until: "2026-09-07",
      }),
      code("RESERVATION_EXPIRED"),
    );
    const reserved = await pl.action(asset, "reserve", {
      personId: polishPerson.id,
      purpose: "Test",
      until: "2026-09-08",
    });
    assert.equal(
      (
        await pl.action(reserved, "issue", {
          personId: polishPerson.id,
          issuedOn: "2026-09-08",
          handoverNote: "Wydano dziś lokalnie",
          humanConfirmed: true,
        })
      ).status,
      "issued",
    );
    const old = helper(legacy),
      oldCase = await old.create("cases", "Legacy UTC", {
        caseType: "general",
        brief: "Test",
        acceptanceCriteria: "Test",
      });
    await assert.rejects(
      old.action(oldCase, "addWorklog", {
        description: "Przyszłość UTC",
        minutes: 15,
        performedOn: "2026-09-08",
      }),
      code("FUTURE_WORKLOG"),
    );
  } finally {
    store.close();
    legacy.close();
  }
});
