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
  type Principal,
  type ToolContext,
} from "../src/contracts.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";
import { baselineProcessTemplates } from "../src/workspace-models.js";

const NOW = "2026-09-08T10:00:00.000Z";
const manager: Principal = {
  id: "manager",
  tenantId: "test",
  roles: ["operator", "approver"],
  scopes: ["*"],
};
const it: Principal = {
  id: "it-worker",
  tenantId: "test",
  roles: ["operator"],
  scopes: ["it"],
};
const nextIt: Principal = { ...it, id: "next-it" };
const failure = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
const context = (
  actor = manager.id,
  operationKey = randomUUID(),
): ToolContext => ({
  tenantId: "test",
  actorId: actor,
  approvedBy: "reviewer",
  operationKey,
  runId: randomUUID(),
  stepId: randomUUID(),
  signal: new AbortController().signal,
});
const tasks = (e: Entity) => e.data.tasks as JsonObject[];

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-readiness-")),
    path = join(dir, "workspace.db");
  let accounts: Principal[] = [manager, it, nextIt];
  let store = new WorkspaceStore(path, { clock: () => Date.parse(NOW) });
  const configure = () => store.setPrincipalProvider(() => accounts);
  configure();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const get = (id: string, module = "cases") => store.get(manager, module, id);
  const tool = (module: string, action: string) =>
    store.tools().find((item) => item.id === `ops.${module}.${action}`)!;
  const invoke = async (
    module: string,
    action: string,
    raw: JsonObject,
    ctx = context(),
  ) => {
    // Fixtures deliberately have one open period; production must receive an explicit selection.
    if (
      (module === "people" &&
        ["activate", "beginOffboarding", "endEmployment"].includes(action)) ||
      (module === "assets" && ["reserve", "issue"].includes(action)) ||
      (module === "licenses" && ["assign", "revoke"].includes(action))
    ) {
      const episodes = store
        .listEmploymentEpisodes(
          manager,
          String(module === "people" ? raw.id : raw.personId),
        )
        .filter((e) => e.status !== "ended");
      assert.equal(
        episodes.length,
        1,
        "fixture must select exactly one open employment period",
      );
      raw = {
        employmentEpisodeId: episodes[0]!.id,
        expectedEpisodeVersion: episodes[0]!.version,
        ...raw,
      };
    }
    if (module === "cases" && action === "revise" && raw.startDate) {
      const current = get(String(raw.id));
      const episode = store
        .listEmploymentEpisodes(manager, String(current.data.personId))
        .find((e) => e.id === current.data.employmentEpisodeId);
      assert.ok(episode, "case must explicitly identify its period");
      raw = { expectedEpisodeVersion: episode.version, ...raw };
    }
    const adapter = tool(module, action),
      input = adapter.prepareInput?.(raw, ctx.tenantId) ?? raw;
    const result = await adapter.execute(ctx, input);
    assert.equal(
      (await adapter.verify(ctx, input, result)).ok,
      true,
      `${module}.${action}`,
    );
    return get(String(result.data.entityId), module);
  };
  const create = (module: string, title: string, data: JsonObject) =>
    invoke(module, "create", { title, data });
  const action = (
    e: Entity,
    action: string,
    data: JsonObject = {},
    ctx?: ToolContext,
  ) =>
    invoke(
      e.module,
      action,
      { id: e.id, expectedVersion: e.version, ...data },
      ctx,
    );
  const person = async () =>
    action(
      await create("people", "Synthetic person", {
        personCategory: "internal",
      }),
      "startEmployment",
      {
        employmentKind: "internal",
        startDate: "2026-09-01",
        role: "Test",
        humanDecision: true,
      },
    );
  const complete = async (entity: Entity) => {
    let e = get(entity.id);
    for (const initial of tasks(e)) {
      let task = tasks(e).find((item) => item.id === initial.id)!;
      if (task.status === "completed") continue;
      if (task.assigneePrincipalId !== manager.id) {
        e = await action(e, "transferTask", {
          taskId: task.id!,
          expectedTaskVersion: task.version!,
          assigneePrincipalId: manager.id,
          humanConfirmed: true,
          reason: "Explicit test assignment",
        });
        task = tasks(e).find((item) => item.id === initial.id)!;
      }
      if (task.status === "offered") {
        e = await action(e, "acceptTask", {
          taskId: task.id!,
          expectedTaskVersion: task.version!,
          humanConfirmed: true,
        });
        task = tasks(e).find((item) => item.id === initial.id)!;
      }
      e = await action(e, "completeTask", {
        taskId: task.id!,
        expectedTaskVersion: task.version!,
        humanConfirmed: true,
        evidenceNote: "Test work reported by the assigned person",
      });
    }
    return e;
  };
  const caseWith = async (requirements: JsonObject[]) => {
    let e = await create("cases", "Synthetic typed case", {
      caseType: "general",
      brief: "Complete bounded test scope",
      acceptanceCriteria: "Independent source proof",
      requirements,
    });
    e = await action(e, "addTask", {
      title: "Read and assess",
      kind: "work",
      required: true,
      assigneePrincipalId: manager.id,
    });
    return complete(e);
  };
  const document = async (data: JsonObject = {}) => {
    let d = await create("documents", "Synthetic contract", {
      documentType: "contract",
      accessScope: "documents",
      content: "Synthetic approved contract content",
      ...data,
    });
    d = await action(d, "submit");
    return action(d, "approve", {
      decision: "approved",
      note: "Explicit test approval",
      humanDecision: true,
    });
  };
  const bind = async (
    e: Entity,
    source: Entity,
    kind = "document_approved",
  ) => {
    const requirement = store
      .readiness(manager, e.id)
      .requirements.find((r) => r.kind === kind)!;
    return action(e, "bindEvidence", {
      requirementId: requirement.id,
      sourceModule: source.module,
      sourceId: source.id,
      sourceVersion: source.version,
    });
  };
  const revise = (e: Entity, more: JsonObject = {}) =>
    action(e, "revise", {
      brief: String(e.data.brief),
      acceptanceCriteria: String(e.data.acceptanceCriteria),
      reason: "Explicit scope correction",
      ...more,
    });
  return {
    get store() {
      return store;
    },
    path,
    get,
    tool,
    invoke,
    create,
    action,
    person,
    complete,
    caseWith,
    document,
    bind,
    revise,
    accounts: (value: Principal[]) => {
      accounts = value;
    },
    restart: () => {
      store.close();
      store = new WorkspaceStore(path, { clock: () => Date.parse(NOW) });
      configure();
    },
  };
}
const docRequirement: JsonObject = {
  key: "contract",
  title: "Approved contract",
  kind: "document_approved",
  required: true,
  expected: { documentType: "contract", currentVersionRequired: true },
};
const assetRequirement: JsonObject = {
  key: "equipment",
  title: "Issued laptop",
  kind: "asset_issued",
  required: true,
  expected: { assetType: "laptop" },
};

test("onboarding stays blocked after task reports; missing owner, license seats and legacy allocation are not readiness", async (t) => {
  const h = setup(t),
    person = await h.person();
  let e = await h.complete(h.get(String(person.data.onboardingCaseId)));
  e = await h.action(e, "addEvidence", {
    title: "Checklist",
    reference: "synthetic",
    note: "All tasks were reported complete",
    humanConfirmed: true,
  });
  let readiness = h.store.readiness(manager, e.id);
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.requirements.map((r) => r.status),
    ["missing", "missing", "missing"],
  );
  assert.ok(
    readiness.taskBlockers.some((reason) => reason.includes("właściciela")),
  );
  const license = await h.create("licenses", "Synthetic seat", {
    product: "Workspace",
    totalSeats: 1,
  });
  const assigned = await h.action(license, "assign", {
    personId: person.id,
    note: "Local license seat only",
  });
  await assert.rejects(
    h.bind(e, assigned, "access_attested"),
    failure("EVIDENCE_SOURCE_UNSUPPORTED"),
  );
  await assert.rejects(h.action(e, "submit"), failure("ACCEPTANCE_NOT_READY"));
  await assert.rejects(
    h.revise(e, { requirements: [docRequirement] }),
    failure("BASELINE_REQUIREMENT_REQUIRED"),
  );
  await assert.rejects(
    h.revise(e, { ownerPrincipalId: it.id }),
    failure("CASE_OWNER_UNAVAILABLE"),
  );
  const priorTasks = tasks(e);
  const priorHash = h.store.readiness(manager, e.id).scopeHash;
  e = await h.revise(e, {
    ownerPrincipalId: manager.id,
    startDate: "2026-09-02",
  });
  assert.notEqual(h.store.readiness(manager, e.id).scopeHash, priorHash);
  for (const [index, task] of tasks(e).entries()) {
    assert.notEqual(task.id, priorTasks[index]!.id);
    assert.equal(
      Date.parse(String(task.dueDate)) -
        Date.parse(String(priorTasks[index]!.dueDate)),
      86_400_000,
    );
  }
  const db = new DatabaseSync(h.path);
  try {
    for (const task of priorTasks)
      assert.equal(
        db
          .prepare("SELECT due_date FROM ops_tasks WHERE id=?")
          .get(String(task.id))!.due_date,
        task.dueDate,
      );
  } finally {
    db.close();
  }
  readiness = h.store.readiness(manager, e.id);
  assert.equal(
    readiness.taskBlockers.some((reason) => reason.includes("właściciela")),
    false,
  );
  assert.equal(e.data.employmentStartDate, "2026-09-02");
  assert.equal(
    (h.get(person.id, "people").data.employmentEpisodes as JsonObject[])[0]!
      .startDate,
    "2026-09-02",
  );
  h.accounts([it, nextIt]);
  assert.ok(
    h.store
      .readiness(manager, e.id)
      .taskBlockers.some((reason) => reason.includes("właściciela")),
  );
});

test("generic typed acceptance binds actual document revision; later source change blocks accept and historical readiness", async (t) => {
  const h = setup(t),
    source = await h.create("people", "Synthetic source", {
      personCategory: "internal",
    });
  let e = await h.caseWith([docRequirement]);
  const d = await h.document({
    sources: [
      {
        module: "people",
        id: source.id,
        version: source.version,
        observedAt: NOW,
      },
    ],
  });
  e = await h.bind(e, d);
  assert.equal(h.store.readiness(manager, e.id).ready, true);
  e = await h.action(e, "submit");
  await h.action(source, "update", { title: "Changed synthetic source" });
  assert.equal(
    h.store.readiness(manager, e.id).requirements[0]!.status,
    "stale",
  );
  await assert.rejects(
    h.action(e, "accept", {
      decision: "accepted",
      note: "Must recheck",
      humanDecision: true,
    }),
    failure("ACCEPTANCE_NOT_READY"),
  );
  assert.equal(h.get(e.id).status, "awaiting_acceptance");
  e = await h.revise(e);
  assert.equal(
    h.store.readiness(manager, e.id).requirements[0]!.status,
    "missing",
  );
  e = await h.complete(e);
  const fresh = await h.document();
  e = await h.bind(e, fresh);
  e = await h.action(e, "submit");
  e = await h.action(e, "accept", {
    decision: "accepted",
    note: "Current independent proof",
    humanDecision: true,
  });
  const accepted = h.store.readiness(manager, e.id);
  assert.equal(accepted.acceptanceCurrent, true);
  assert.equal((e.data.currentAcceptance as JsonObject).decidedBy, manager.id);
  assert.equal((e.data.currentAcceptance as JsonObject).approvedBy, "reviewer");
  await h.action(fresh, "revise", {
    content: "Different content",
    changeNote: "New version",
  });
  assert.equal(h.store.readiness(manager, e.id).acceptanceCurrent, false);
  assert.equal(
    h.store.readiness(manager, e.id).requirements[0]!.status,
    "stale",
  );
});

test("same-case mutable document source cannot form circular proof; unauthorized source details stay hidden", async (t) => {
  const h = setup(t);
  let e = await h.caseWith([docRequirement]);
  const circular = await h.document({
    sources: [
      { module: "cases", id: e.id, version: e.version, observedAt: NOW },
    ],
    linkedCaseId: e.id,
  });
  e = await h.bind(e, circular);
  const readiness = h.store.readiness(manager, e.id);
  assert.equal(readiness.ready, false);
  assert.match(readiness.requirements[0]!.reason, /Źródło|tej samej sprawy/);
  const casesOnly: Principal = { ...manager, scopes: ["cases"] };
  const safe = h.store.readiness(casesOnly, e.id);
  assert.equal(safe.requirements[0]!.source, undefined);
  assert.equal(JSON.stringify(safe).includes(circular.title), false);
  await assert.rejects(h.bind(e, circular), failure("REVISION_REQUIRED"));
  const foreign = { ...manager, tenantId: "other" };
  assert.throws(
    () => h.store.readiness(foreign, e.id),
    failure("ENTITY_NOT_FOUND"),
  );
});

test("reserved asset fails; generic actual issuance can pass, but return invalidates accepted binding", async (t) => {
  const h = setup(t),
    person = await h.person();
  let asset = await h.create("assets", "Synthetic laptop", {
    assetType: "laptop",
    serial: randomUUID(),
    condition: "good",
    location: "Test shelf",
  });
  asset = await h.action(asset, "reserve", {
    personId: person.id,
    purpose: "Test",
    until: "2026-09-10",
  });
  let e = await h.caseWith([assetRequirement]);
  e = await h.bind(e, asset, "asset_issued");
  assert.equal(
    h.store.readiness(manager, e.id).requirements[0]!.status,
    "failed",
  );
  asset = await h.action(asset, "issue", {
    personId: person.id,
    issuedOn: "2026-09-08",
    handoverNote: "Test physical handover",
    humanConfirmed: true,
  });
  assert.equal(
    h.store.readiness(manager, e.id).requirements[0]!.status,
    "stale",
  );
  e = await h.complete(await h.revise(e));
  e = await h.bind(e, asset, "asset_issued");
  assert.equal(h.store.readiness(manager, e.id).ready, true);
  e = await h.action(e, "submit");
  e = await h.action(e, "accept", {
    decision: "accepted",
    note: "Current issuance checked",
    humanDecision: true,
  });
  await h.action(asset, "return", {
    returnedOn: "2026-09-08",
    condition: "good",
    receiptNote: "Returned after acceptance",
    humanConfirmed: true,
  });
  assert.equal(h.store.readiness(manager, e.id).acceptanceCurrent, false);
});

test("onboarding asset proof rejects another person and a missing case link", async (t) => {
  const h = setup(t),
    person = await h.person(),
    other = await h.person();
  let e = h.get(String(person.data.onboardingCaseId));
  let asset = await h.create("assets", "Other person's laptop", {
    assetType: "laptop",
    serial: randomUUID(),
    condition: "good",
    location: "Test",
  });
  asset = await h.action(asset, "reserve", {
    personId: other.id,
    purpose: "Test allocation",
    until: "2026-09-10",
  });
  asset = await h.action(asset, "issue", {
    personId: other.id,
    issuedOn: "2026-09-08",
    handoverNote: "Issued to another test person",
    humanConfirmed: true,
  });
  e = await h.bind(e, asset, "asset_issued");
  assert.equal(
    h.store
      .readiness(manager, e.id)
      .requirements.find((r) => r.kind === "asset_issued")!.status,
    "failed",
  );
  e = await h.revise(e);
  let correctPerson = await h.create("assets", "Laptop without a case link", {
    assetType: "laptop",
    serial: randomUUID(),
    condition: "good",
    location: "Test",
  });
  correctPerson = await h.action(correctPerson, "reserve", {
    personId: person.id,
    purpose: "Test allocation",
    until: "2026-09-10",
  });
  correctPerson = await h.action(correctPerson, "issue", {
    personId: person.id,
    issuedOn: "2026-09-08",
    handoverNote: "Test issuance without a case link",
    humanConfirmed: true,
  });
  e = await h.bind(e, correctPerson, "asset_issued");
  assert.equal(
    h.store
      .readiness(manager, e.id)
      .requirements.find((r) => r.kind === "asset_issued")!.status,
    "failed",
  );
});

test("lost transfer response reconciles after database restart, but independent task-row tampering fails verification", async (t) => {
  const h = setup(t);
  let e = await h.create("cases", "Private generic case", {
    caseType: "general",
    brief: "Test task recovery",
    acceptanceCriteria: "Consistent event and task",
  });
  e = await h.action(e, "addTask", {
    title: "Minimal IT task",
    kind: "work",
    required: true,
    assigneeRole: "it",
    assigneePrincipalId: it.id,
  });
  const task = tasks(e)[0]!,
    ctx = context(it.id),
    input = {
      id: e.id,
      expectedVersion: e.version,
      taskId: task.id!,
      expectedTaskVersion: task.version!,
      assigneePrincipalId: nextIt.id,
      reason: "Private transfer reason",
      humanConfirmed: true,
    };
  const receipt = await h.tool("cases", "transferTask").execute(ctx, input);
  h.restart();
  const adapter = h.tool("cases", "transferTask");
  const recovered = await adapter.reconcile!(ctx, input);
  assert.equal(recovered.status, "applied");
  assert.equal((await adapter.verify(ctx, input, receipt)).ok, true);
  assert.deepEqual(await adapter.execute(ctx, input), receipt);
  // A later legitimate scope revision must not strand an earlier committed
  // operation whose response was lost. Verify its immutable revision snapshot.
  await h.revise(h.get(e.id));
  assert.equal((await adapter.reconcile!(ctx, input)).status, "applied");
  assert.equal((await adapter.verify(ctx, input, receipt)).ok, true);
  const db = new DatabaseSync(h.path);
  try {
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM ops_task_events WHERE task_id=? AND action='transferTask'",
          )
          .get(String(task.id)) as { n: number }
      ).n,
      1,
    );
    db.prepare(
      "UPDATE ops_tasks SET performed_by='forged-actor' WHERE id=?",
    ).run(String(task.id));
    assert.equal((await adapter.verify(ctx, input, receipt)).ok, false);
    await assert.rejects(
      adapter.reconcile!(ctx, input),
      failure("TASK_STATE_INCONSISTENT"),
    );
    db.prepare("UPDATE ops_tasks SET performed_by=NULL WHERE id=?").run(
      String(task.id),
    );
    h.accounts([manager, nextIt]);
    await assert.rejects(
      adapter.reconcile!(ctx, input),
      failure("TASK_RECEIPT_FORBIDDEN"),
    );
  } finally {
    db.close();
  }
});

test("task overdue projection uses company day rather than UTC", async (t) => {
  const h = setup(t);
  h.store.setProfileProvider(() => ({
    version: 1,
    definitionVersion: "2",
    timezone: "Pacific/Kiritimati",
    roleBindings: {},
    processTemplates: baselineProcessTemplates("internal"),
  }));
  let e = await h.create("cases", "Deadline test", {
    caseType: "general",
    brief: "Date consistency",
    acceptanceCriteria: "Company date",
  });
  e = await h.action(e, "addTask", {
    title: "Due today in UTC, yesterday locally",
    kind: "work",
    required: true,
    assigneePrincipalId: manager.id,
    dueDate: "2026-09-08",
  });
  assert.equal(
    h.store.listTasks(manager).find((task) => task.id === tasks(e)[0]!.id)!
      .overdue,
    true,
  );
});
