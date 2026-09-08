import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createApp } from "../src/app.js";
import { Conversations, type Conversation } from "../src/assistant.js";
import type { AppConfig } from "../src/config.js";
import type { JsonObject, Principal } from "../src/contracts.js";
import { Engine } from "../src/engine.js";
import { WorkspaceStore } from "../src/workspace.js";

function fixture(t: TestContext) {
  const operator: Principal = {
    id: "operator",
    tenantId: "synthetic-a",
    roles: ["operator", "approver"],
    scopes: ["*"],
  };
  const other = { ...operator, id: "other" };
  const foreign = { ...operator, tenantId: "synthetic-b" };
  const peopleOnly = { ...operator, id: "people-reader", scopes: ["people"] };
  const itOnly = { ...operator, id: "it-reader", scopes: ["it"] };
  const principals = [operator, other, foreign, peopleOnly, itOnly];
  const workspace = new WorkspaceStore(":memory:");
  const tools = workspace.tools();
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 4310,
    mode: "authenticated",
    dataDir: "/unused",
    plannerKind: "demo",
    principals,
    policies: ["synthetic-a", "synthetic-b"].map((tenantId) => ({
      tenantId,
      name: "Synthetic API test",
      version: "1",
      allowedTools: tools.map((tool) => tool.id),
      approvalTools: [],
      allowSelfApproval: true,
    })),
    tokens: new Map(
      principals.map((p) => [
        `synthetic-only-${p.tenantId}-${p.id}-aaaaaaaaaaaaaaaaaaaa`,
        p,
      ]),
    ),
  };
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals,
    policies: config.policies,
  });
  const conversations = new Conversations(":memory:", workspace, engine, tools);
  const app = createApp({
    engine,
    workspace,
    conversations,
    config,
    tools,
    planner: {
      kind: "test",
      async plan() {
        throw new Error("Unused planner");
      },
    },
  });
  t.after(async () => {
    await app.close();
    conversations.close();
    engine.close();
    workspace.close();
  });
  const headers = (p: Principal) => ({
    authorization: `Bearer synthetic-only-${p.tenantId}-${p.id}-aaaaaaaaaaaaaaaaaaaa`,
  });
  const get = (url: string, p = operator) =>
    app.inject({ method: "GET", url, headers: headers(p) });
  const post = (url: string, payload: object, p = operator) =>
    app.inject({ method: "POST", url, payload, headers: headers(p) });
  const create = async () => {
    const response = await post("/api/conversations", {});
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ conversation: Conversation }>().conversation;
  };
  const apply = async (module: string, action: string, raw: JsonObject) => {
    const tool = tools.find((tool) => tool.id === `ops.${module}.${action}`)!;
    const input = tool.prepareInput?.(raw, operator.tenantId) ?? raw;
    const result = await tool.execute(
      {
        tenantId: operator.tenantId,
        actorId: operator.id,
        approvedBy: operator.id,
        operationKey: randomUUID(),
        runId: randomUUID(),
        stepId: "seed",
        signal: new AbortController().signal,
      },
      input,
    );
    return workspace.get(operator, module, String(result.data.entityId));
  };
  return {
    app,
    config,
    engine,
    workspace,
    get,
    post,
    create,
    apply,
    operator,
    other,
    foreign,
    peopleOnly,
    itOnly,
  };
}

test("conversation HTTP endpoints enforce live actor authority, strict bodies, CAS and exact replay", async (t) => {
  const f = fixture(t),
    c = await f.create();
  const path = `/api/conversations/${c.id}`;
  assert.equal(
    (await f.app.inject({ method: "GET", url: path })).statusCode,
    401,
  );
  for (const actor of [f.other, f.foreign]) {
    assert.equal((await f.get(path, actor)).statusCode, 404);
    assert.equal((await f.post(`${path}/resume`, {}, actor)).statusCode, 404);
    assert.deepEqual(
      (await f.get("/api/conversations", actor)).json().conversations,
      [],
    );
  }
  const body = {
    message: "Potrzeba testowa bez wykonania",
    idempotencyKey: randomUUID(),
    expectedDraftVersion: 0,
  };
  const first = await f.post(`${path}/messages`, body);
  assert.equal(first.statusCode, 200, first.body);
  const version = first.json().conversation.draft.version;
  assert.equal(version, 1);
  assert.equal(first.json().conversation.messages.length, 2);
  const stale = await f.post(`${path}/messages`, {
    ...body,
    idempotencyKey: randomUUID(),
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "DRAFT_VERSION_CONFLICT");
  assert.equal(
    (await f.post(`${path}/messages`, { ...body, actorId: f.other.id }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.post(`${path}/messages`, { ...body, message: "Inna treść" })
    ).json().error.code,
    "IDEMPOTENCY_CONFLICT",
  );
  const second = await f.post(`${path}/messages`, {
    message: "Dodatkowe wyjaśnienie",
    idempotencyKey: randomUUID(),
    expectedDraftVersion: version,
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(
    (await f.post(`${path}/messages`, body)).json(),
    second.json(),
    "old replay returns current conversation without adding another message",
  );
  assert.deepEqual((await f.post(`${path}/resume`, {})).json(), second.json());
  assert.equal(
    (await f.post(`${path}/resume`, { expectedDraftVersion: 999 })).statusCode,
    400,
  );
  f.config.principals = f.config.principals.map((p) =>
    p.id === f.operator.id && p.tenantId === f.operator.tenantId
      ? { ...p, scopes: ["people"] }
      : p,
  );
  assert.equal((await f.get(path)).statusCode, 403);
  assert.equal((await f.get("/api/conversations")).statusCode, 403);
  assert.equal((await f.post(`${path}/resume`, {})).statusCode, 403);
});

test("HTTP resume after Core commit but lost response links the existing run exactly once and leaves effects awaiting approval", async (t) => {
  const f = fixture(t),
    c = await f.create(),
    path = `/api/conversations/${c.id}`;
  let current = c;
  for (const message of ["dodaj osobę", "SYNTETYCZNY TEST API"]) {
    const response = await f.post(`${path}/messages`, {
      message,
      idempotencyKey: randomUUID(),
      expectedDraftVersion: current.draft?.version ?? 0,
    });
    assert.equal(response.statusCode, 200, response.body);
    current = response.json().conversation;
  }
  const createRun = f.engine.createRun.bind(f.engine);
  let runCreates = 0;
  f.engine.createRun = (...args) => {
    runCreates++;
    createRun(...args);
    throw new Error("Synthetic lost response after Core commit");
  };
  const body = {
    message: "internal",
    idempotencyKey: randomUUID(),
    expectedDraftVersion: current.draft!.version,
  };
  const failed = await f.post(`${path}/messages`, body);
  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal(f.engine.listRuns(f.operator).length, 1);
  const pending = (await f.get(path)).json().conversation;
  assert.deepEqual(pending.pendingTurn.message, body.message);
  assert.equal(pending.pendingTurn.idempotencyKey, body.idempotencyKey);
  assert.equal(pending.messages.length, 4);
  f.engine.createRun = createRun;
  const resumed = await f.post(`${path}/resume`, {});
  assert.equal(resumed.statusCode, 200, resumed.body);
  const result = resumed.json().conversation;
  assert.equal(result.messages.length, 6);
  assert.equal(result.pendingTurn, undefined);
  assert.equal(result.draft.linkedRuns.length, 1);
  assert.equal(
    result.draft.linkedRuns[0].runId,
    f.engine.listRuns(f.operator)[0]!.id,
  );
  assert.equal(result.draft.linkedRuns[0].status, "planned");
  assert.equal(runCreates, 1);
  assert.deepEqual(
    (await f.post(`${path}/messages`, body)).json(),
    resumed.json(),
  );
  assert.equal(f.engine.listRuns(f.operator).length, 1);
  assert.equal(f.workspace.list(f.operator, "people").length, 0);
});

test("employment episode endpoint enforces auth, tenant and people access and omits inaccessible project labels", async (t) => {
  const f = fixture(t);
  const project = await f.apply("cases", "create", {
    title: "PRIVATE PROJECT LABEL",
    data: {
      caseType: "delivery",
      brief: "Synthetic scope",
      acceptanceCriteria: "Synthetic acceptance",
    },
  });
  let person = await f.apply("people", "create", {
    title: "Synthetic person",
    data: { personCategory: "contractor" },
  });
  person = await f.apply("people", "startEmployment", {
    id: person.id,
    expectedVersion: person.version,
    employmentKind: "contractor",
    startDate: "2026-09-01",
    role: "Test role",
    humanDecision: true,
    engagementRef: { module: "cases", id: project.id },
  });
  const path = `/api/people/${person.id}/episodes`;
  assert.equal(
    (await f.app.inject({ method: "GET", url: path })).statusCode,
    401,
  );
  assert.equal((await f.get(path, f.foreign)).statusCode, 404);
  assert.equal((await f.get(path, f.itOnly)).statusCode, 403);
  const allowed = await f.get(path);
  assert.equal(allowed.statusCode, 200, allowed.body);
  const [episode] = allowed.json().episodes;
  assert.equal(episode.personId, person.id);
  assert.equal(episode.version, 1);
  assert.equal(episode.engagementLabel, project.title);
  assert.equal("person_id" in episode, false);
  const narrowed = await f.get(path, f.peopleOnly);
  assert.equal(narrowed.statusCode, 200, narrowed.body);
  assert.equal(narrowed.json().episodes[0].engagementLabel, undefined);
  assert.equal(narrowed.body.includes(project.title), false);
});
