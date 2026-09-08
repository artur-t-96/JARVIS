import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  askBusinessModel,
  type BusinessTask,
  type BusinessModelOptions,
} from "../src/business-model.js";
import { ContextBroker } from "../src/context-broker.js";
import {
  DomainError,
  type JsonObject,
  type Principal,
} from "../src/contracts.js";
import { Diagnostics } from "../src/diagnostics.js";
import { hash } from "../src/engine.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";
const principal: Principal = {
  id: "synthetic-operator",
  tenantId: "tenant-a",
  roles: ["operator", "approver"],
  scopes: ["*"],
};
const foreign: Principal = { ...principal, tenantId: "tenant-b" };
const code = (value: string) => (e: unknown) =>
  e instanceof DomainError && e.code === value;
const answer = (
  message = "Sprawdź propozycję.",
  usage: unknown = { input_tokens: 10, output_tokens: 5 },
) =>
  new Response(
    JSON.stringify({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({ kind: "answer", message, planJson: "" }),
        },
      ],
      usage,
    }),
  );
const toolCall = (name: string, input: JsonObject, id = "call_test") => ({
  type: "tool_use",
  name,
  input,
  id,
});
const calls = (blocks: ReturnType<typeof toolCall>[]) =>
  new Response(
    JSON.stringify({
      stop_reason: "tool_use",
      content: blocks,
      usage: { input_tokens: 20, output_tokens: 8 },
    }),
  );
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-model-test-")),
    db = new DatabaseSync(":memory:"),
    store = new WorkspaceStore(":memory:");
  db.exec(
    "CREATE TABLE conversations(id TEXT PRIMARY KEY,tenant_id TEXT,actor_id TEXT,authority_hash TEXT); CREATE TABLE model_usage(id TEXT PRIMARY KEY,tenant_id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,status TEXT,created_at TEXT,pricing_json TEXT,duration_ms INTEGER,estimated_cost REAL)",
  );
  let active = [principal, foreign];
  store.setPrincipalProvider((tenant) =>
    active.filter((p) => p.tenantId === tenant),
  );
  const broker = new ContextBroker(db, store, {
    principalProvider: (tenant) => active.filter((p) => p.tenantId === tenant),
    companyProvider: () => ({
      version: 3,
      definitionVersion: "3",
      timezone: "Europe/Warsaw",
      updatedAt: "2026-09-08T10:00:00Z",
      updatedApprovedBy: "PRIVATE_LOGIN",
      roleBindings: {
        hr: principal.id,
        it: principal.id,
        manager: principal.id,
      },
    }),
  });
  const turn = (p = principal) => {
    const id = randomUUID();
    db.prepare("INSERT INTO conversations VALUES(?,?,?,?)").run(
      id,
      p.tenantId,
      p.id,
      hash({
        roles: [...p.roles].sort(),
        scopes: [...(p.scopes ?? [])].sort(),
      }),
    );
    return broker.beginTurn(p, id, randomUUID());
  };
  const current = turn(),
    requests: { url: string; init: RequestInit; payload: JsonObject }[] = [];
  const lines: string[] = [];
  const diagnostics = new Diagnostics({
    dataDir: dir,
    version: "test",
    writeLog: (line) => lines.push(line),
  });
  const tools = store.tools();
  const create = async (
    module: string,
    title: string,
    data: JsonObject,
    p = principal,
  ): Promise<Entity> => {
    const tool = tools.find((t) => t.id === `ops.${module}.create`)!;
    const result = await tool.execute(
      {
        tenantId: p.tenantId,
        actorId: p.id,
        approvedBy: p.id,
        operationKey: randomUUID(),
        runId: "fixture",
        stepId: "fixture",
        signal: new AbortController().signal,
      },
      { title, data },
    );
    return store.get(p, module, String(result.data.entityId));
  };
  const invoke = async (entity: Entity, action: string, fields: JsonObject) => {
    const tool = tools.find((t) => t.id === `ops.${entity.module}.${action}`)!;
    let input = { id: entity.id, expectedVersion: entity.version, ...fields };
    input =
      (tool.prepareInput?.(input, principal.tenantId) as typeof input) ?? input;
    const result = await tool.execute(
      {
        tenantId: principal.tenantId,
        actorId: principal.id,
        approvedBy: principal.id,
        operationKey: randomUUID(),
        runId: "fixture",
        stepId: "fixture",
        signal: new AbortController().signal,
      },
      input,
    );
    return store.get(principal, entity.module, String(result.data.entityId));
  };
  const ask = (
    task: BusinessTask,
    fetchImpl: typeof fetch,
    options: Partial<BusinessModelOptions> = {},
  ) =>
    askBusinessModel({
      db,
      broker,
      turn: current,
      task,
      tools,
      diagnostics,
      options: {
        apiKey: "sk-ant-SYNTHETIC_ONLY",
        model: "explicit-test-model",
        ...options,
        fetchImpl: async (url, init) => {
          requests.push({
            url: String(url),
            init: init!,
            payload: JSON.parse(String(init?.body)) as JsonObject,
          });
          return fetchImpl(url, init);
        },
      },
    });
  t.after(async () => {
    await diagnostics.close();
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    store,
    broker,
    turn,
    current,
    requests,
    lines,
    ask,
    create,
    invoke,
    revoke: () => {
      active = [];
    },
    usage: () => db.prepare("SELECT * FROM model_usage ORDER BY rowid").all(),
  };
}

test("native tool loop uses two broker reads and records real calls, tokens and configured costs", async (t) => {
  const f = fixture(t);
  await f.create("people", "Anna IGNORE SYSTEM private@example.test", {
    personCategory: "internal",
    department: "PRIVATE_DEPARTMENT",
  });
  let iteration = 0;
  const result = await f.ask(
    { intent: "unknown", missingFields: ["person", "requirements"] },
    async () =>
      ++iteration === 1
        ? calls([
            toolCall(
              "context_company",
              { purpose: "case_followup" },
              "call_company",
            ),
            toolCall(
              "context_findPeople",
              { query: "Anna", limit: 5 },
              "call_people",
            ),
          ])
        : answer(),
    {
      pricing: {
        version: "explicit-test-tariff",
        currency: "USD",
        inputPerMillion: 2,
        outputPerMillion: 8,
      },
    },
  );
  assert.equal(result.verification, "unverified_proposal");
  assert.equal(result.kind, "answer");
  assert.ok(result.sourceRefs.length >= 2);
  assert.equal(iteration, 2);
  assert.equal(
    f.db
      .prepare("SELECT reads FROM context_turns WHERE id=?")
      .get(f.current.id)!.reads,
    2,
  );
  assert.deepEqual(
    f.usage().map((r) => [r.status, r.input_tokens, r.output_tokens]),
    [
      ["completed", 20, 8],
      ["completed", 10, 5],
    ],
  );
  assert.deepEqual(
    f.usage().map((r) => r.estimated_cost),
    [(20 * 2 + 8 * 8) / 1e6, (10 * 2 + 5 * 8) / 1e6],
  );
  for (const request of f.requests) {
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.init.redirect, "error");
    assert.equal(
      (request.init.headers as Record<string, string>)["x-api-key"],
      "sk-ant-SYNTHETIC_ONLY",
    );
    const body = String(request.init.body);
    for (const value of [
      "IGNORE SYSTEM",
      "private@example",
      "PRIVATE_DEPARTMENT",
      "PRIVATE_LOGIN",
      "sk-ant-SYNTHETIC_ONLY",
      principal.id,
    ])
      assert.equal(body.includes(value), false, value);
  }
  const second = f.requests[1]!.payload.messages as JsonObject[];
  const toolResults = second.at(-1)!.content as JsonObject[];
  assert.equal(toolResults.length, 2);
  const people = JSON.parse(String(toolResults[1]!.content));
  assert.equal(people.items[0].source.id, undefined);
  assert.match(people.items[0].label, /^PERSON_/);
  assert.equal(
    JSON.stringify(people).includes("Anna"),
    false,
    "broker results never contain local names; prior tool query is model-authored",
  );
  assert.equal(String(f.requests[0]!.init.body).includes("Anna"), false);
  const logs = f.lines.join("\n");
  for (const value of [
    "Anna",
    "PRIVATE_",
    "sk-ant-SYNTHETIC_ONLY",
    "Sprawdź propozycję",
  ])
    assert.equal(logs.includes(value), false);
});

test("initial refs use the same broker cloud projection and debit the same read allowance", async (t) => {
  const f = fixture(t),
    person = await f.create("people", "PRIVATE_NAME", {
      personCategory: "internal",
    });
  const ref = f.broker.reference(
    f.current,
    { module: "people", id: person.id },
    "employment",
  ).items[0]!.ref;
  const result = await f.ask(
    { intent: "employment", selectedRefs: { person: ref } },
    async () => answer(),
  );
  assert.equal(result.verification, "unverified_proposal");
  assert.equal(
    f.db
      .prepare("SELECT reads FROM context_turns WHERE id=?")
      .get(f.current.id)!.reads,
    2,
  );
  const payload = JSON.parse(
    String((f.requests[0]!.payload.messages as JsonObject[])[0]!.content),
  );
  assert.equal(payload.task.selectedRefs.person, ref);
  assert.equal(payload.context.length, 1);
  assert.equal(payload.context[0].items[0].source.id, undefined);
  assert.equal(JSON.stringify(payload).includes(person.id), false);
  assert.equal(JSON.stringify(payload).includes("PRIVATE_NAME"), false);
  assert.equal(
    f.usage()[0]!.estimated_cost,
    null,
    "no tariff must remain unavailable, never zero cost",
  );
});

test("raw text/history and arbitrary UUID selections are rejected before any network call", async (t) => {
  const f = fixture(t);
  let network = 0;
  for (const task of [
    { intent: "unknown", text: "SECRET_RAW_USER_MESSAGE" },
    { intent: "unknown", history: [{ content: "PRIVATE_HISTORY" }] },
    { intent: "unknown", selectedRefs: { person: randomUUID() } },
    {
      intent: "unknown",
      selectedRefs: { person: `https://example.test/${randomUUID()}` },
    },
  ]) {
    await assert.rejects(
      f.ask(task as BusinessTask, async () => {
        network++;
        return answer();
      }),
      code("PLANNER_TASK_INVALID"),
    );
  }
  assert.equal(network, 0);
  assert.equal(f.usage().length, 0);
});

test("unknown tool, foreign token and fabricated token all fail closed without domain effects", async (t) => {
  for (const variant of ["write", "foreign", "fabricated"]) {
    const f = fixture(t),
      other = await f.create(
        "people",
        "PRIVATE_OTHER_TENANT",
        { personCategory: "internal" },
        foreign,
      );
    const foreignRef = f.broker.reference(
      f.turn(foreign),
      { module: "people", id: other.id },
      "equipment_request",
    ).items[0]!.ref;
    const block =
      variant === "write"
        ? toolCall("ops_assets_create", { title: "forged write" })
        : toolCall("context_readRecord", {
            ref: variant === "foreign" ? foreignRef : `ctx_${"a".repeat(32)}`,
            purpose: "equipment_request",
          });
    await assert.rejects(
      f.ask({ intent: "unknown" }, async () => calls([block])),
      code("PLANNER_FAILED"),
    );
    assert.equal(f.store.list(principal, "assets").length, 0);
    assert.equal(f.usage()[0]!.status, "failed");
    assert.equal(
      f.usage()[0]!.input_tokens,
      20,
      "reported usage remains factual even when an unsafe response is rejected",
    );
  }
});

test("each model read shares the four-read ceiling across successive provider calls", async (t) => {
  const f = fixture(t);
  let count = 0;
  await assert.rejects(
    f.ask({ intent: "unknown" }, async () => {
      count++;
      return calls([
        toolCall(
          "context_company",
          { purpose: "case_followup" },
          `call_${count}`,
        ),
      ]);
    }),
    code("CONTEXT_READ_LIMIT"),
  );
  assert.equal(count, 5);
  assert.equal(
    f.db
      .prepare("SELECT reads FROM context_turns WHERE id=?")
      .get(f.current.id)!.reads,
    4,
  );
  assert.deepEqual(
    f.usage().map((r) => r.status),
    ["completed", "completed", "completed", "completed", "failed"],
  );
});

test("revocation during provider latency prevents reads and all subsequent calls", async (t) => {
  const f = fixture(t);
  let count = 0;
  await assert.rejects(
    f.ask({ intent: "unknown" }, async () => {
      count++;
      f.revoke();
      return calls([toolCall("context_company", { purpose: "case_followup" })]);
    }),
    code("PLANNER_FAILED"),
  );
  assert.equal(count, 1);
  assert.equal(
    f.db
      .prepare("SELECT reads FROM context_turns WHERE id=?")
      .get(f.current.id)!.reads,
    0,
  );
  assert.equal(f.usage()[0]!.status, "failed");
});

test(
  "one deadline bounds the whole loop even if fetch and body ignore the abort signal",
  { timeout: 5000 },
  async (t) => {
    for (const variant of ["fetch", "body", "second-call"]) {
      const f = fixture(t);
      let count = 0,
        settled = false;
      let reachedBlockedIO!: () => void;
      const blockedIO = new Promise<void>((resolve) => {
        reachedBlockedIO = resolve;
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const result = f
          .ask(
            { intent: "unknown" },
            async () => {
              count++;
              if (variant === "body")
                return new Response(
                  new ReadableStream({
                    pull: () => {
                      reachedBlockedIO();
                      return new Promise(() => {});
                    },
                  }),
                );
              if (variant === "second-call" && count === 1) {
                // Consume part of the one shared budget without depending on runner load.
                t.mock.timers.tick(30);
                return calls([
                  toolCall("context_company", { purpose: "case_followup" }),
                ]);
              }
              reachedBlockedIO();
              return new Promise(() => {});
            },
            { timeoutMs: 50 },
          )
          .finally(() => {
            settled = true;
          });
        const rejection = assert.rejects(result, code("PLANNER_FAILED"));
        await blockedIO;
        assert.equal(count, variant === "second-call" ? 2 : 1);
        t.mock.timers.tick(variant === "second-call" ? 19 : 49);
        await Promise.resolve();
        assert.equal(
          settled,
          false,
          "the whole-turn deadline has not expired yet",
        );
        t.mock.timers.tick(1);
        await rejection;
        assert.equal(
          settled,
          true,
          "deadline does not depend on cooperative fake I/O",
        );
        assert.equal(f.usage().at(-1)!.input_tokens, null);
        assert.equal(f.usage().at(-1)!.status, "failed");
      } finally {
        t.mock.timers.reset();
      }
    }
  },
);

test("oversized/error provider responses expose no body or key and invent no usage", async (t) => {
  for (const response of [
    new Response("PROVIDER_SECRET_sk-ant-SYNTHETIC_ONLY", { status: 401 }),
    new Response("x".repeat(96 * 1024 + 1)),
    new Response("small", {
      headers: { "content-length": String(96 * 1024 + 1) },
    }),
  ]) {
    const f = fixture(t);
    const error = await f
      .ask({ intent: "unknown" }, async () => response)
      .catch((e) => e);
    assert.ok(code("PLANNER_FAILED")(error));
    assert.equal(String(error).includes("SYNTHETIC_ONLY"), false);
    assert.equal(f.usage()[0]!.input_tokens, null);
    assert.equal(f.usage()[0]!.output_tokens, null);
    assert.equal(f.usage()[0]!.estimated_cost, null);
    assert.equal(f.usage()[0]!.status, "failed");
    assert.equal(f.lines.join("\n").includes("PROVIDER_SECRET"), false);
  }
});

test("reported cache tokens are counted but unpriced cache usage cannot receive an invented cost", async (t) => {
  const f = fixture(t);
  await f.ask(
    { intent: "unknown" },
    async () =>
      answer("Test", {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 20,
      }),
    {
      pricing: {
        version: "base-only",
        currency: "USD",
        inputPerMillion: 1,
        outputPerMillion: 2,
      },
    },
  );
  assert.equal(f.usage()[0]!.input_tokens, 60);
  assert.equal(f.usage()[0]!.output_tokens, 5);
  assert.equal(f.usage()[0]!.estimated_cost, null);
});

test("a registered plan with live opaque refs remains only a proposal; UUID and authority/URL spoofing are rejected", async (t) => {
  const f = fixture(t),
    person = await f.create("people", "PRIVATE_PERSON", {
      personCategory: "internal",
    });
  const employed = await f.invoke(person, "startEmployment", {
    employmentKind: "internal",
    startDate: "2020-01-01",
    role: "Synthetic role",
    humanDecision: true,
  });
  const asset = await f.create("assets", "PRIVATE_LAPTOP", {
    assetType: "laptop",
    serial: "PRIVATE_SERIAL",
    location: "PRIVATE_LOCATION",
    condition: "good",
  });
  const prior = f.broker.beginTurn(
    principal,
    f.current.conversationId,
    "previous-server-turn",
  );
  const personRef = f.broker.reference(
    prior,
    { module: "people", id: person.id },
    "equipment_request",
  ).items[0]!.ref;
  const episodeRef = f.broker.read(prior, "context.personWork", {
    personRef,
    purpose: "equipment_request",
  }).items[0]!.ref;
  const assetRef = f.broker.reference(
    prior,
    { module: "assets", id: asset.id },
    "equipment_request",
  ).items[0]!.ref;
  const episode = f.store.listEmploymentEpisodes(principal, employed.id)[0]!;
  const caseRef = f.broker.reference(
    prior,
    { module: "cases", id: episode.onboardingCaseId! },
    "equipment_request",
  ).items[0]!.ref;
  const input = {
    caseId: caseRef,
    id: assetRef,
    expectedVersion: asset.version,
    personId: personRef,
    employmentEpisodeId: episodeRef,
    expectedEpisodeVersion: episode.version,
    purpose: "Synthetic need",
    until: "2099-01-01",
  };
  const plan = {
    title: "Rezerwacja",
    summary: "Wyłącznie propozycja",
    steps: [
      {
        id: "reserve",
        title: "Zarezerwuj po zgodzie",
        toolId: "ops.assets.reserve",
        input,
      },
    ],
  };
  const result = await f.ask(
    {
      intent: "equipment_request",
      assetType: "laptop",
      readyOn: "2099-01-01",
      reservationUntil: "2099-01-01",
      selectedRefs: {
        person: personRef,
        episode: episodeRef,
        asset: assetRef,
        case: caseRef,
      },
    },
    async () =>
      new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                kind: "ready",
                message: "Zarezerwowałem laptop.",
                planJson: JSON.stringify(plan),
              }),
            },
          ],
          usage: { input_tokens: 30, output_tokens: 20 },
        }),
      ),
  );
  assert.equal(result.kind, "ready");
  assert.equal(result.verification, "unverified_proposal");
  assert.match(result.message, /Niezweryfikowana propozycja/);
  assert.deepEqual(result.plan, plan);
  assert.equal(
    f.store.get(principal, "assets", asset.id).status,
    "available",
    "adapter never executes even an apparently valid plan",
  );
  for (const corrupt of [
    { ...input, id: asset.id },
    { ...input, actorId: principal.id },
    { ...input, purpose: "https://attacker.test/private" },
    { ...input, id: { $ref: "x.result.id" } },
  ]) {
    const next = f.broker.beginTurn(
      principal,
      f.current.conversationId,
      randomUUID(),
    );
    await assert.rejects(
      askBusinessModel({
        db: f.db,
        broker: f.broker,
        turn: next,
        task: {
          intent: "equipment_request",
          selectedRefs: {
            case: caseRef,
            person: personRef,
            episode: episodeRef,
            asset: assetRef,
          },
        },
        tools: f.store.tools(),
        options: {
          apiKey: "synthetic",
          model: "explicit-test-model",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                stop_reason: "end_turn",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      kind: "ready",
                      message: "Plan",
                      planJson: JSON.stringify({
                        ...plan,
                        steps: [{ ...plan.steps[0], input: corrupt }],
                      }),
                    }),
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
            ),
        },
      }),
      code("PLANNER_FAILED"),
    );
  }
});

test("native strict schemas omit unsupported provider constraints while server validation retains them", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.ask({ intent: "unknown" }, async () =>
      calls([toolCall("context_findPeople", { query: "Anna", limit: 6 })]),
    ),
    code("PLANNER_FAILED"),
  );
  const providerTools = f.requests[0]!.payload.tools as JsonObject[];
  assert.equal(providerTools.length, 6);
  for (const tool of providerTools) {
    assert.match(String(tool.name), /^[A-Za-z0-9_-]+$/);
    assert.equal(tool.strict, true);
    const schema = JSON.stringify(tool.input_schema);
    for (const unsupported of [
      '"minimum":',
      '"maximum":',
      '"minLength":',
      '"maxLength":',
      '"maxItems":',
    ])
      assert.equal(schema.includes(unsupported), false, unsupported);
  }
  assert.equal(f.requests.length, 1);
  assert.equal(f.usage()[0]!.status, "failed");
});

test("source changes while the provider thinks invalidate its answer before it is returned", async (t) => {
  const f = fixture(t),
    person = await f.create("people", "PRIVATE_PERSON", {
      personCategory: "internal",
    });
  const ref = f.broker.reference(
    f.current,
    { module: "people", id: person.id },
    "employment",
  ).items[0]!.ref;
  await assert.rejects(
    f.ask({ intent: "employment", selectedRefs: { person: ref } }, async () => {
      await f.invoke(person, "update", {
        title: "Changed private title",
        data: {},
      });
      return answer();
    }),
    code("PLANNER_FAILED"),
  );
  assert.equal(f.usage()[0]!.status, "failed");
  assert.equal(f.usage()[0]!.input_tokens, 10);
  assert.equal(f.usage()[0]!.output_tokens, 5);
});
