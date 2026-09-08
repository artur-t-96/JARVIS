import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Conversations, type BusinessModelOptions } from "../src/assistant.js";
import {
  DomainError,
  type JsonObject,
  type Principal,
} from "../src/contracts.js";
import { Engine } from "../src/engine.js";
import { WorkspaceStore } from "../src/workspace.js";
import { baselineProcessTemplates } from "../src/workspace-models.js";
const operator: Principal = {
  id: "operator-test",
  tenantId: "tenant-test",
  roles: ["operator", "approver"],
  scopes: ["*"],
};
const forbidden = (e: unknown) =>
  e instanceof DomainError && e.statusCode === 403;
const code = (expected: string) => (e: unknown) =>
  e instanceof DomainError && e.code === expected;
const modelAnswer = () =>
  new Response(
    JSON.stringify({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "answer",
            message: "Bezpieczna propozycja",
            planJson: "",
          }),
        },
      ],
      usage: { input_tokens: 4, output_tokens: 3 },
    }),
  );
function fixture(
  t: TestContext,
  fetchImpl?: typeof fetch,
  failVerification = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-continuity-test-")),
    chatPath = join(dir, "conversations.sqlite");
  let active = [operator],
    store: WorkspaceStore,
    engine: Engine,
    chat: Conversations;
  const profile = {
    version: 1,
    definitionVersion: "3",
    timezone: "Europe/Warsaw",
    updatedAt: "2026-09-08T10:00:00Z",
    updatedApprovedBy: operator.id,
    roleBindings: { hr: operator.id, it: operator.id, manager: operator.id },
    processTemplates: baselineProcessTemplates("internal"),
    employmentPolicy: {
      mode: "single_open" as const,
      maxConcurrent: 1,
      allowInternalOverlap: false,
    },
  };
  const model: BusinessModelOptions | undefined = fetchImpl
    ? { apiKey: "synthetic-only", model: "explicit-test-model", fetchImpl }
    : undefined;
  const attach = () => {
    chat.setPrincipalProvider((tenant) =>
      active.filter((p) => p.tenantId === tenant),
    );
    chat.setCompanyProvider(() => profile);
  };
  const open = () => {
    store = new WorkspaceStore(join(dir, "operations.sqlite"));
    store.setPrincipalProvider((tenant) =>
      active.filter((p) => p.tenantId === tenant),
    );
    store.setProfileProvider(() => profile);
    const tools = store.tools().map((tool) =>
      tool.id === "ops.assets.create" && failVerification
        ? {
            ...tool,
            verify: async (...args: Parameters<typeof tool.verify>) => ({
              ...(await tool.verify(...args)),
              ok: false,
              summary: "Synthetic negative independent verification",
            }),
          }
        : tool,
    );
    engine = new Engine({
      dbPath: join(dir, "core.sqlite"),
      tools,
      principals: active,
      policies: [
        {
          tenantId: operator.tenantId,
          version: "1",
          name: "Synthetic",
          allowedTools: tools.map((t) => t.id),
          approvalTools: [],
          allowSelfApproval: true,
        },
      ],
    });
    chat = new Conversations(chatPath, store, engine, tools, model);
    attach();
  };
  open();
  const conversation = chat!.create(operator);
  const close = () => {
    chat.close();
    engine.close();
    store.close();
  };
  t.after(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  const inspect = <T>(read: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(chatPath, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const send = (text: string) =>
    chat.message(operator, conversation.id, text, randomUUID(), {
      expectedDraftVersion:
        chat.get(operator, conversation.id).draft?.version ?? 0,
    });
  const beforeFinal = async (title = "Laptop testowy") => {
    for (const text of [
      "Dodaj sprzęt",
      title,
      "laptop",
      "TEST-SERIAL",
      "Laboratorium",
    ])
      await send(text);
    return chat.get(operator, conversation.id);
  };
  const seed = async (module: string, action: string, input: JsonObject) => {
    const tool = store
      .tools()
      .find((tool) => tool.id === `ops.${module}.${action}`)!;
    const prepared = tool.prepareInput?.(input, operator.tenantId) ?? input;
    const result = await tool.execute(
      {
        tenantId: operator.tenantId,
        actorId: operator.id,
        approvedBy: operator.id,
        operationKey: randomUUID(),
        runId: "synthetic-fixture-only",
        stepId: "fixture",
        signal: new AbortController().signal,
      },
      prepared,
    );
    return store.get(operator, module, String(result.data.entityId));
  };
  const approveAndExecute = async (runId: string) => {
    engine.start(operator, runId);
    await engine.tick();
    let run = engine.getRun(operator, runId);
    assert.equal(run.status, "waiting_approval");
    assert.equal(store.list(operator, "assets").length, 0);
    const approval = run.steps[0]!.approval!;
    engine.approve(operator, runId, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    for (let i = 0; i < 8; i++) {
      await engine.tick();
      run = engine.getRun(operator, runId);
      if (run.status === "completed") break;
    }
    assert.equal(run.status, "completed");
    assert.equal(run.steps[0]!.attempts, 1);
    return run;
  };
  return {
    conversation,
    chatPath,
    inspect,
    send,
    seed,
    beforeFinal,
    approveAndExecute,
    get chat() {
      return chat;
    },
    get engine() {
      return engine;
    },
    get store() {
      return store;
    },
    reopen() {
      close();
      open();
    },
    revoke() {
      active = [];
      engine.setPrincipals(active);
    },
    restore() {
      active = [operator];
      engine.setPrincipals(active);
    },
    secondChat() {
      const second = new Conversations(
        chatPath,
        store,
        engine,
        store.tools(),
        model,
      );
      second.setPrincipalProvider((tenant) =>
        active.filter((p) => p.tenantId === tenant),
      );
      return second;
    },
  };
}

test("deterministic create wizard preserves its scope, CAS and exact replay; every write still requires approval", async (t) => {
  const f = fixture(t);
  const before = await f.beforeFinal("Laptop dla Ani");
  assert.equal(
    before.draft!.intent,
    "create",
    "a title containing equipment words is data within the active wizard",
  );
  const key = randomUUID(),
    options = { expectedDraftVersion: before.draft!.version };
  const result = await f.chat.message(
    operator,
    f.conversation.id,
    "good",
    key,
    options,
  );
  assert.equal(result.messages.at(-1)!.kind, "ready");
  assert.equal(result.draft!.version, before.draft!.version + 1);
  const runId = result.messages.at(-1)!.runId!;
  assert.equal(f.engine.getRun(operator, runId).status, "planned");
  assert.equal(f.store.list(operator, "assets").length, 0);
  assert.deepEqual(
    await f.chat.message(operator, f.conversation.id, "good", key, options),
    result,
  );
  await assert.rejects(
    f.chat.message(operator, f.conversation.id, "repair", key, options),
    code("IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    f.chat.message(operator, f.conversation.id, "good", key, {
      expectedDraftVersion: result.draft!.version,
    }),
    code("IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    f.chat.message(
      operator,
      f.conversation.id,
      "co dalej",
      randomUUID(),
      options,
    ),
    code("DRAFT_VERSION_CONFLICT"),
  );
  assert.equal(f.engine.listRuns(operator).length, 1);
  await f.approveAndExecute(runId);
  assert.equal(f.store.list(operator, "assets")[0]!.title, "Laptop dla Ani");
  const followup = await f.send("co dalej");
  assert.equal(followup.draft!.phase, "completed");
  assert.equal(followup.draft!.linkedRuns[0]!.runId, runId);
  assert.equal(followup.draft!.linkedRuns[0]!.status, "completed");
});

test("restart after Core commit before draft finish reuses durable proposal and exactly one run", async (t) => {
  const f = fixture(t),
    before = await f.beforeFinal(),
    key = randomUUID();
  const create = f.engine.createRun.bind(f.engine);
  let committedId = "";
  f.engine.createRun = ((...args: Parameters<Engine["createRun"]>) => {
    const run = create(...args);
    committedId = run.id;
    throw new Error("Synthetic process lost after Core commit");
  }) as Engine["createRun"];
  await assert.rejects(
    f.chat.message(operator, f.conversation.id, "good", key, {
      expectedDraftVersion: before.draft!.version,
    }),
    /Synthetic process lost/,
  );
  const persisted = f.inspect((db) =>
    db
      .prepare(
        "SELECT proposal_hash,proposal_json,status FROM assistant_draft_turns WHERE conversation_id=? AND request_key=?",
      )
      .get(f.conversation.id, key)!,
  );
  assert.equal(persisted.status, "pending");
  assert.ok(persisted.proposal_hash);
  assert.equal(f.engine.listRuns(operator).length, 1);
  assert.equal(
    f.chat.get(operator, f.conversation.id).messages.length,
    before.messages.length,
  );
  f.reopen();
  f.engine.createRun = (() => {
    throw new Error("Recovery must replay the committed run");
  }) as Engine["createRun"];
  const result = await f.chat.resume(operator, f.conversation.id);
  assert.equal(result.messages.at(-1)!.runId, committedId);
  assert.equal(result.draft!.version, before.draft!.version + 1);
  assert.equal(result.pendingTurn, undefined);
  assert.equal(f.engine.listRuns(operator).length, 1);
  const after = f.inspect((db) =>
    db
      .prepare(
        "SELECT proposal_hash,proposal_json,status FROM assistant_draft_turns WHERE conversation_id=? AND request_key=?",
      )
      .get(f.conversation.id, key)!,
  );
  assert.equal(after.proposal_hash, persisted.proposal_hash);
  assert.equal(after.proposal_json, persisted.proposal_json);
  assert.equal(after.status, "completed");
  assert.equal(f.store.list(operator, "assets").length, 0);
  await f.approveAndExecute(committedId);
  assert.equal(f.store.list(operator, "assets").length, 1);
});

test("revocation between Core creation and draft finish cannot publish an answer or finalize the turn", async (t) => {
  const f = fixture(t),
    before = await f.beforeFinal(),
    create = f.engine.createRun.bind(f.engine),
    key = randomUUID();
  f.engine.createRun = ((...args: Parameters<Engine["createRun"]>) => {
    const run = create(...args);
    f.revoke();
    return run;
  }) as Engine["createRun"];
  await assert.rejects(
    f.chat.message(operator, f.conversation.id, "good", key, {
      expectedDraftVersion: before.draft!.version,
    }),
    forbidden,
  );
  await assert.rejects(f.chat.resume(operator, f.conversation.id), forbidden);
  assert.throws(() => f.chat.get(operator, f.conversation.id), forbidden);
  const row = f.inspect((db) => ({
    turn: db
      .prepare(
        "SELECT status,proposal_hash FROM assistant_draft_turns WHERE conversation_id=? AND request_key=?",
      )
      .get(f.conversation.id, key)!,
    messages: db
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id=?",
      )
      .get(f.conversation.id)!.n,
    draft: db
      .prepare(
        "SELECT version FROM assistant_need_drafts WHERE conversation_id=?",
      )
      .get(f.conversation.id)!.version,
  }));
  assert.equal(row.turn.status, "pending");
  assert.ok(row.turn.proposal_hash);
  assert.equal(row.messages, before.messages.length);
  assert.equal(row.draft, before.draft!.version);
  f.restore();
  assert.equal(f.engine.listRuns(operator).length, 1);
  assert.equal(f.store.list(operator, "assets").length, 0);
});

test("provider failure keeps the same pending request resumable across restart without duplicate messages", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    if (calls === 1) throw new Error("Synthetic provider failure");
    return modelAnswer();
  });
  const key = randomUUID();
  await assert.rejects(
    f.chat.message(operator, f.conversation.id, "Potrzebuję pomocy", key, {
      expectedDraftVersion: 0,
    }),
    code("PLANNER_FAILED"),
  );
  const before = f.chat.get(operator, f.conversation.id);
  assert.equal(before.messages.length, 0);
  assert.equal(before.pendingTurn!.idempotencyKey, key);
  assert.equal(before.draft!.version, 0);
  await assert.rejects(
    f.chat.message(
      operator,
      f.conversation.id,
      "Nowa wiadomość",
      randomUUID(),
      { expectedDraftVersion: 0 },
    ),
    code("TURN_RECOVERY_REQUIRED"),
  );
  f.reopen();
  const result = await f.chat.resume(operator, f.conversation.id);
  assert.equal(calls, 2);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]!.content, "Potrzebuję pomocy");
  assert.equal(result.pendingTurn, undefined);
  assert.equal(result.draft!.version, 1);
  assert.deepEqual(
    await f.chat.message(
      operator,
      f.conversation.id,
      "Potrzebuję pomocy",
      key,
      { expectedDraftVersion: 0 },
    ),
    result,
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    f.chat
      .usage(operator)
      .map((r) => r.status)
      .sort(),
    ["completed", "failed"],
  );
});

test("two application connections cannot overwrite one pending turn or advance a stale draft", async (t) => {
  let resolve!: (r: Response) => void;
  const f = fixture(
    t,
    async () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const second = f.secondChat();
  t.after(() => second.close());
  const key = randomUUID(),
    work = f.chat.message(operator, f.conversation.id, "Pomoc", key, {
      expectedDraftVersion: 0,
    });
  await assert.rejects(
    second.message(operator, f.conversation.id, "Pomoc", key, {
      expectedDraftVersion: 0,
    }),
    code("TURN_IN_PROGRESS"),
  );
  await assert.rejects(
    second.message(
      operator,
      f.conversation.id,
      "Inna wiadomość",
      randomUUID(),
      { expectedDraftVersion: 0 },
    ),
    code("TURN_RECOVERY_REQUIRED"),
  );
  resolve(modelAnswer());
  const result = await work;
  assert.equal(result.messages.length, 2);
  assert.equal(result.draft!.version, 1);
  await assert.rejects(
    second.message(
      operator,
      f.conversation.id,
      "Inna wiadomość",
      randomUUID(),
      { expectedDraftVersion: 0 },
    ),
    code("DRAFT_VERSION_CONFLICT"),
  );
  await assert.rejects(
    second.message(
      operator,
      f.conversation.id,
      "Nieuprawniony wybór",
      randomUUID(),
      { expectedDraftVersion: 1, choiceRef: "forged-choice" },
    ),
    code("INVALID_CHOICE"),
  );
  assert.equal(second.get(operator, f.conversation.id).draft!.version, 1);
});

test("scope changes cancel only a wholly unexecuted proposal and preserve committed effects/history", async (t) => {
  for (const executed of [false, true]) {
    const f = fixture(t);
    await f.beforeFinal();
    const ready = await f.send("good"),
      runId = ready.messages.at(-1)!.runId!;
    if (executed) await f.approveAndExecute(runId);
    const result = await f.send("Jednak dla innej osoby");
    if (executed) {
      assert.equal(f.engine.getRun(operator, runId).status, "completed");
      assert.equal(result.draft!.phase, "blocked");
      assert.equal(result.draft!.linkedRuns[0]!.runId, runId);
      assert.equal(f.store.list(operator, "assets").length, 1);
      assert.match(
        result.messages.at(-1)!.content,
        /rozpoczęte lub zapisane skutki/,
      );
    } else {
      assert.equal(f.engine.getRun(operator, runId).status, "cancelled");
      assert.equal(result.draft!.phase, "collecting");
      assert.equal(result.draft!.linkedRuns[0]!.status, "cancelled");
      assert.equal(f.store.list(operator, "assets").length, 0);
    }
    assert.equal(result.messages.length, ready.messages.length + 2);
    assert.equal(result.draft!.version, ready.draft!.version + 1);
  }
});

test("a cancelled run with a committed effect cannot be erased by a new conversational scope", async (t) => {
  const f = fixture(t, undefined, true);
  await f.beforeFinal();
  const ready = await f.send("good"),
    runId = ready.messages.at(-1)!.runId!;
  f.engine.start(operator, runId);
  await f.engine.tick();
  const approval = f.engine.getRun(operator, runId).steps[0]!.approval!;
  f.engine.approve(operator, runId, {
    approvalId: approval.id,
    bindingHash: approval.bindingHash,
    decision: "approved",
  });
  await f.engine.tick();
  assert.equal(f.engine.getRun(operator, runId).status, "blocked");
  assert.equal(f.store.list(operator, "assets").length, 1);
  const cancelled = f.engine.cancel(operator, runId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.steps[0]!.attempts, 1);
  const result = await f.send("Nowe zadanie");
  assert.equal(result.draft!.phase, "blocked");
  assert.equal(result.draft!.intent, ready.draft!.intent);
  assert.equal(result.draft!.linkedRuns[0]!.runId, runId);
  assert.match(
    result.messages.at(-1)!.content,
    /rozpoczęte lub zapisane skutki/,
  );
  assert.equal(f.engine.listRuns(operator).length, 1);
  assert.equal(f.store.list(operator, "assets").length, 1);
});

test("case selection sends only broker cloud metadata and subsequent questions refresh the source version", async (t) => {
  const requests: JsonObject[] = [];
  const f = fixture(t, async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)));
    return new Response(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "answer",
              message: "Wydałem laptop i zatwierdziłem odbiór.",
              planJson: "",
            }),
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
    );
  });
  const record = await f.seed("cases", "create", {
    title: "PRIVATE_HR_TITLE",
    data: {
      caseType: "general",
      brief: "PRIVATE_HR_BRIEF private@example.test",
      acceptanceCriteria: "PRIVATE_HR_CRITERIA",
      dueDate: "2030-09-20",
    },
  });
  const listing = await f.send("pokaż sprawy");
  assert.equal(requests.length, 0);
  assert.equal(listing.draft!.phase, "needs_choice");
  const option = listing.draft!.clarification!.options[0]!;
  assert.equal(option.label, "PRIVATE_HR_TITLE");
  const selected = await f.chat.message(
    operator,
    f.conversation.id,
    option.label,
    randomUUID(),
    { expectedDraftVersion: listing.draft!.version, choiceRef: option.ref },
  );
  assert.equal(selected.messages.at(-1)!.kind, "answer");
  assert.match(selected.messages.at(-1)!.content, /niepotwierdzona propozycja/);
  assert.match(selected.messages.at(-1)!.content, /Wydałem laptop/);
  assert.equal(selected.draft!.sources[0]!.version, record.version);
  assert.equal(f.engine.listRuns(operator).length, 0);
  const firstPayload = JSON.parse(
    String((requests[0]!.messages as JsonObject[])[0]!.content),
  );
  assert.equal(firstPayload.task.intent, "case_followup");
  assert.match(firstPayload.task.selectedRefs.case, /^ctx_/);
  assert.equal(firstPayload.context.length, 1);
  const wire = JSON.stringify(requests);
  for (const secret of [
    record.id,
    record.title,
    "PRIVATE_HR_BRIEF",
    "PRIVATE_HR_CRITERIA",
    "private@example.test",
    operator.id,
  ])
    assert.ok(
      !wire.includes(secret),
      `private local value reached provider: ${secret}`,
    );
  assert.match(wire, /2030-09-20/);
  const changed = await f.seed("cases", "addEvidence", {
    id: record.id,
    expectedVersion: record.version,
    title: "LOCAL_HUMAN_EVIDENCE",
    reference: "manual",
    note: "PRIVATE_ATTESTATION",
    humanConfirmed: true,
  });
  f.reopen();
  const current = await f.send("co dalej");
  assert.equal(requests.length, 2);
  assert.equal(current.draft!.sources[0]!.version, changed.version);
  assert.equal(current.draft!.sources[0]!.freshness, "current");
  assert.match(
    current.messages.at(-1)!.content,
    new RegExp(`wersja ${changed.version}`),
  );
  assert.equal(f.engine.listRuns(operator).length, 0);
  assert.ok(!JSON.stringify(requests).includes("PRIVATE_ATTESTATION"));
});

test("failed model turn keeps its four-read budget across restart and resume closes with needs input", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    if (calls === 1)
      return new Response(
        JSON.stringify({
          stop_reason: "tool_use",
          content: [1, 2].map((n) => ({
            type: "tool_use",
            id: `company_${n}`,
            name: "context_company",
            input: { purpose: "case_followup" },
          })),
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
      );
    throw new Error("Synthetic provider failure after bounded reads");
  });
  await f.seed("cases", "create", {
    title: "Synthetic source",
    data: {
      caseType: "general",
      brief: "Synthetic brief",
      acceptanceCriteria: "Declared criteria",
    },
  });
  const listing = await f.send("pokaż sprawy"),
    option = listing.draft!.clarification!.options[0]!,
    key = randomUUID();
  await assert.rejects(
    f.chat.message(operator, f.conversation.id, option.label, key, {
      expectedDraftVersion: listing.draft!.version,
      choiceRef: option.ref,
    }),
    code("PLANNER_FAILED"),
  );
  assert.equal(calls, 2);
  const before = f.inspect((db) =>
    db.prepare("SELECT id,reads,bytes FROM context_turns WHERE reads=4").get()!,
  );
  assert.ok(before);
  assert.equal(
    f.chat.get(operator, f.conversation.id).pendingTurn!.idempotencyKey,
    key,
  );
  f.reopen();
  const result = await f.chat.resume(operator, f.conversation.id);
  assert.equal(calls, 2, "resume must not create another model budget or call");
  assert.equal(result.pendingTurn, undefined);
  assert.equal(result.messages.at(-1)!.kind, "needs_input");
  assert.equal(result.draft!.phase, "blocked");
  assert.equal(f.engine.listRuns(operator).length, 0);
  const after = f.inspect((db) =>
    db
      .prepare("SELECT id,reads,bytes FROM context_turns WHERE id=?")
      .get(before.id as string),
  );
  assert.deepEqual(after, before);
  assert.equal(
    f.inspect(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM context_turns").get()!.n,
    ),
    2,
  );
});

test("equipment model receives four opaque selected sources and only the canonical reservation reaches approved Core", async (t) => {
  const requests: JsonObject[] = [];
  const f = fixture(t, async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    requests.push(body);
    const payload = JSON.parse(body.messages[0].content),
      refs = payload.task.selectedRefs;
    return new Response(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "ready",
              message:
                "Wydałem już sprzęt — niezweryfikowane twierdzenie testowe.",
              planJson: JSON.stringify({
                title: "MODEL_TITLE_MUST_NOT_OWN_SCOPE",
                summary: "Model proposal only",
                steps: [
                  {
                    id: "reserve",
                    title: "MODEL_STEP_LABEL",
                    toolId: "ops.assets.reserve",
                    input: {
                      id: refs.asset,
                      expectedVersion: 1,
                      personId: refs.person,
                      employmentEpisodeId: refs.episode,
                      expectedEpisodeVersion: 1,
                      caseId: refs.case,
                      profileVersion: 1,
                      purpose: "MODEL_PURPOSE_MUST_NOT_OWN_SCOPE",
                      until: payload.task.reservationUntil,
                    },
                  },
                ],
              }),
            }),
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      }),
    );
  });
  const person = await f.seed("people", "create", {
    title: "Anna PRIVATE_PERSON_SURNAME",
    data: { personCategory: "internal", email: "PRIVATE_EMAIL@example.test" },
  });
  await f.seed("people", "startEmployment", {
    id: person.id,
    expectedVersion: person.version,
    employmentKind: "internal",
    startDate: "2026-09-01",
    role: "PRIVATE_EMPLOYMENT_ROLE",
    humanDecision: true,
  });
  const asset = await f.seed("assets", "create", {
    title: "PRIVATE_ASSET_NAME",
    data: {
      assetType: "laptop",
      serial: "PRIVATE_SERIAL",
      location: "PRIVATE_LOCATION",
      condition: "good",
    },
  });
  const choose = async () => {
    const current = f.chat.get(operator, f.conversation.id),
      option = current.draft!.clarification!.options[0]!;
    return f.chat.message(
      operator,
      f.conversation.id,
      option.label,
      randomUUID(),
      { expectedDraftVersion: current.draft!.version, choiceRef: option.ref },
    );
  };
  await f.send("Przygotuj Ani laptop na 2030-09-20");
  await choose();
  await choose();
  await f.send("2030-09-22");
  await choose();
  const current = f.chat.get(operator, f.conversation.id),
    option = current.draft!.clarification!.options[0]!,
    key = randomUUID(),
    options = {
      expectedDraftVersion: current.draft!.version,
      choiceRef: option.ref,
    };
  assert.equal(current.draft!.clarification!.kind, "asset");
  assert.equal(requests.length, 0);
  const ready = await f.chat.message(
    operator,
    f.conversation.id,
    option.label,
    key,
    options,
  );
  assert.equal(requests.length, 1);
  assert.equal(ready.messages.at(-1)!.kind, "ready");
  assert.match(ready.messages.at(-1)!.content, /niepotwierdzona propozycja/);
  const payload = JSON.parse(
    String((requests[0]!.messages as JsonObject[])[0]!.content),
  );
  assert.equal(payload.task.intent, "equipment_request");
  assert.deepEqual(Object.keys(payload.task.selectedRefs).sort(), [
    "asset",
    "case",
    "episode",
    "person",
  ]);
  assert.equal(payload.context.length, 4);
  assert.ok(
    Object.values(payload.task.selectedRefs).every((ref) =>
      /^ctx_/.test(String(ref)),
    ),
  );
  const wire = JSON.stringify(requests);
  for (const privateValue of [
    person.id,
    asset.id,
    "PRIVATE_PERSON_SURNAME",
    "PRIVATE_EMAIL",
    "PRIVATE_EMPLOYMENT_ROLE",
    "PRIVATE_ASSET_NAME",
    "PRIVATE_SERIAL",
    "PRIVATE_LOCATION",
    operator.id,
  ])
    assert.ok(
      !wire.includes(privateValue),
      `private local field reached model: ${privateValue}`,
    );
  const runId = ready.messages.at(-1)!.runId!,
    run = f.engine.getRun(operator, runId);
  assert.equal(run.status, "planned");
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0]!.input.id, asset.id);
  assert.ok(!JSON.stringify(run).includes("MODEL_PURPOSE_MUST_NOT_OWN_SCOPE"));
  assert.ok(!JSON.stringify(run).includes("MODEL_TITLE_MUST_NOT_OWN_SCOPE"));
  assert.equal(f.store.get(operator, "assets", asset.id).status, "available");
  f.reopen();
  assert.deepEqual(
    await f.chat.message(
      operator,
      f.conversation.id,
      option.label,
      key,
      options,
    ),
    ready,
  );
  assert.equal(requests.length, 1);
  assert.equal(f.engine.listRuns(operator).length, 1);
  f.engine.start(operator, runId);
  await f.engine.tick();
  const approval = f.engine.getRun(operator, runId).steps[0]!.approval!;
  assert.equal(f.store.get(operator, "assets", asset.id).status, "available");
  f.engine.approve(operator, runId, {
    approvalId: approval.id,
    bindingHash: approval.bindingHash,
    decision: "approved",
  });
  await f.engine.tick();
  assert.equal(f.engine.getRun(operator, runId).status, "completed");
  assert.equal(f.store.get(operator, "assets", asset.id).status, "reserved");
  assert.equal(f.engine.getRun(operator, runId).steps[0]!.attempts, 1);
});

test("failed unknown need cannot renew its eight-call quota through recovery or process restart", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
      calls++;
      throw new Error("Synthetic unavailable model");
    }),
    key = randomUUID();
  await assert.rejects(
    f.chat.message(operator, f.conversation.id, "Pomoc", key, {
      expectedDraftVersion: 0,
    }),
    code("PLANNER_FAILED"),
  );
  for (let attempt = 1; attempt < 8; attempt++) {
    if (attempt === 4) f.reopen();
    await assert.rejects(
      f.chat.resume(operator, f.conversation.id),
      code("PLANNER_FAILED"),
    );
  }
  assert.equal(calls, 8);
  assert.equal(f.chat.get(operator, f.conversation.id).messages.length, 0);
  assert.equal(f.chat.get(operator, f.conversation.id).draft!.version, 0);
  const before = f.inspect((db) =>
    db.prepare("SELECT id,reads,bytes,model_calls FROM context_turns").get()!,
  );
  assert.equal(before.reads, 0);
  assert.equal(before.model_calls, 8);
  f.reopen();
  const result = await f.chat.resume(operator, f.conversation.id);
  assert.equal(calls, 8);
  assert.equal(result.pendingTurn, undefined);
  assert.equal(result.messages.at(-1)!.kind, "needs_input");
  assert.equal(result.draft!.phase, "blocked");
  assert.equal(f.engine.listRuns(operator).length, 0);
  assert.deepEqual(
    f.inspect((db) =>
      db.prepare("SELECT id,reads,bytes,model_calls FROM context_turns").get(),
    ),
    before,
  );
  const usage = f.chat.usage(operator);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.calls, 8);
  assert.ok(
    usage.every(
      (row) =>
        row.status === "failed" &&
        row.inputTokens === null &&
        row.outputTokens === null,
    ),
  );
  assert.deepEqual(
    await f.chat.message(operator, f.conversation.id, "Pomoc", key, {
      expectedDraftVersion: 0,
    }),
    result,
  );
  assert.equal(calls, 8);
});
