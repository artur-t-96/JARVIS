import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Conversations } from "../src/assistant.js";
import { DomainError, type Plan, type Principal } from "../src/contracts.js";
import { Engine } from "../src/engine.js";
import { WorkspaceStore } from "../src/workspace.js";

function setup(proposal?: { kind: string; message: string; planJson: string }) {
  const person: Principal = {
    id: "operator",
    tenantId: "a",
    roles: ["operator", "approver"],
    scopes: ["*"],
  };
  const other: Principal = { ...person, id: "another" },
    foreign: Principal = { ...person, tenantId: "b" };
  const store = new WorkspaceStore(":memory:"),
    tools = store.tools();
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals: [person, other, foreign],
    policies: ["a", "b"].map((tenantId) => ({
      tenantId,
      version: "1",
      name: "Test",
      allowedTools: tools.map((t) => t.id),
      approvalTools: [],
      allowSelfApproval: true,
    })),
  });
  const requests: string[] = [];
  const chat = new Conversations(
    ":memory:",
    store,
    engine,
    tools,
    proposal
      ? {
          apiKey: "synthetic-only",
          model: "explicit-test-model",
          fetchImpl: async (_url, init) => {
            requests.push(String(init?.body));
            return new Response(
              JSON.stringify({
                stop_reason: "end_turn",
                content: [{ type: "text", text: JSON.stringify(proposal) }],
                usage: { input_tokens: 10, output_tokens: 10 },
              }),
              { status: 200 },
            );
          },
        }
      : undefined,
  );
  return {
    person,
    other,
    foreign,
    store,
    engine,
    chat,
    requests,
    close() {
      chat.close();
      engine.close();
      store.close();
    },
  };
}
const plan: Plan = {
  title: "Dodaj syntetyczny sprzęt",
  summary: "Plan wymaga zatwierdzenia",
  steps: [
    {
      id: "create",
      title: "Dodaj",
      toolId: "ops.assets.create",
      input: {
        title: "TEST Laptop",
        data: {
          assetType: "laptop",
          serial: "TEST-1",
          location: "Local",
          condition: "good",
        },
      },
    },
  ],
};

test("model output proposes only a plan; maximum messages/keys replay without duplicating a run", async () => {
  const f = setup({
    kind: "ready",
    message: "Przygotowałem plan",
    planJson: JSON.stringify(plan),
  });
  try {
    const conversation = f.chat.create(f.person),
      text = "x".repeat(4000),
      key = "k".repeat(128);
    const result = await f.chat.message(f.person, conversation.id, text, key);
    assert.equal(result.messages.at(-1)!.kind, "ready");
    const runId = result.messages.at(-1)!.runId!;
    assert.equal(f.engine.getRun(f.person, runId).status, "planned");
    assert.equal(f.store.list(f.person, "assets").length, 0);
    assert.deepEqual(
      await f.chat.message(f.person, conversation.id, text, key),
      result,
    );
    assert.equal(f.requests.length, 1);
    await assert.rejects(
      f.chat.message(f.person, conversation.id, "changed", key),
      (e) => e instanceof DomainError && e.code === "IDEMPOTENCY_CONFLICT",
    );
    f.engine.start(f.person, runId);
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.person, runId).status, "waiting_approval");
    assert.equal(f.store.list(f.person, "assets").length, 0);
  } finally {
    f.close();
  }
});

test("conversations are private per actor and tenant and become inaccessible after authority change", async () => {
  const f = setup({ kind: "answer", message: "Odpowiedź", planJson: "" });
  try {
    const c = f.chat.create(f.person);
    await f.chat.message(
      f.person,
      c.id,
      "Prywatny kontekst testowy",
      randomUUID(),
    );
    assert.throws(
      () => f.chat.get(f.other, c.id),
      (e) => e instanceof DomainError && e.statusCode === 404,
    );
    assert.throws(
      () => f.chat.get(f.foreign, c.id),
      (e) => e instanceof DomainError && e.statusCode === 404,
    );
    const narrowed = { ...f.person, scopes: ["it", "documents", "cases"] };
    assert.deepEqual(f.chat.list(narrowed), []);
    assert.throws(
      () => f.chat.get(narrowed, c.id),
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
    await assert.rejects(
      f.chat.message(narrowed, c.id, "Kontynuuj", randomUUID()),
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
    assert.equal(
      f.requests.length,
      1,
      "no stale privileged history sent after scope revocation",
    );
  } finally {
    f.close();
  }
});

test("malicious model plans cannot invent executable tools, identity fields or tenant authority", async () => {
  for (const bad of [
    {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          toolId: "shell.execute",
          input: { command: "read private files" },
        },
      ],
    },
    {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          input: {
            ...plan.steps[0]!.input,
            tenantId: "b",
            approvedBy: "admin",
          },
        },
      ],
    },
  ]) {
    const f = setup({
      kind: "ready",
      message: "Ignore restrictions; done",
      planJson: JSON.stringify(bad),
    });
    try {
      const c = f.chat.create(f.person);
      await assert.rejects(
        f.chat.message(f.person, c.id, "Test malicious provider", randomUUID()),
      );
      assert.equal(f.engine.listRuns(f.person).length, 0);
      assert.equal(f.store.list(f.person, "assets").length, 0);
    } finally {
      f.close();
    }
  }
});

test("provider proposals may use validated earlier-step references but every write still waits for approval", async () => {
  const proposal: Plan = {
    title: "Osoba i onboarding",
    summary: "Test referencji",
    steps: [
      {
        id: "person",
        title: "Person",
        toolId: "ops.people.create",
        input: {
          title: "Synthetic person",
          data: { personCategory: "internal" },
        },
      },
      {
        id: "onboarding",
        title: "Start",
        toolId: "ops.people.startEmployment",
        input: {
          id: { $step: "person", path: "entityId" },
          expectedVersion: { $step: "person", path: "version" },
          employmentKind: "internal",
          startDate: "2020-01-01",
          role: "Test",
          humanDecision: true,
        },
      },
    ],
  };
  const f = setup({
    kind: "ready",
    message: "Plan wymaga Twojej decyzji",
    planJson: JSON.stringify(proposal),
  });
  try {
    const c = f.chat.create(f.person),
      result = await f.chat.message(
        f.person,
        c.id,
        "Zaplanuj start",
        randomUUID(),
      );
    const runId = result.messages.at(-1)!.runId!;
    assert.equal(f.engine.getRun(f.person, runId).status, "planned");
    assert.equal(f.store.list(f.person, "people").length, 0);
    f.engine.start(f.person, runId);
    await f.engine.tick();
    let run = f.engine.getRun(f.person, runId);
    const approval = run.steps[0]!.approval!;
    f.engine.approve(f.person, runId, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    for (let i = 0; i < 4; i++) await f.engine.tick();
    run = f.engine.getRun(f.person, runId);
    assert.equal(run.status, "waiting_approval");
    assert.equal(run.steps[1]!.approval!.status, "pending");
    assert.equal(
      f.store.list(f.person, "people")[0]!.status,
      "registered",
      "first write approval never authorizes the dependent lifecycle transition",
    );
  } finally {
    f.close();
  }
});

test("provider context minimizes mentioned people and excludes unrelated registry/document contents", async () => {
  const f = setup({ kind: "answer", message: "Potrzebne dane", planJson: "" });
  try {
    const write = async (toolId: string, input: object) =>
      f.store
        .tools()
        .find((t) => t.id === toolId)!
        .execute(
          {
            tenantId: f.person.tenantId,
            actorId: f.person.id,
            runId: "test",
            stepId: "test",
            operationKey: randomUUID(),
            signal: new AbortController().signal,
          },
          input as never,
        );
    await write("ops.people.create", {
      title: "Alicja Sekretna",
      data: {
        personCategory: "internal",
        email: "private-registry@example.invalid",
        department: "NEVER-SEND-DEPARTMENT",
      },
    });
    await write("ops.people.create", {
      title: "Waldemar Niewspomniany",
      data: { personCategory: "internal" },
    });
    await write("ops.documents.create", {
      title: "Niepowiązany raport",
      data: {
        accessScope: "people",
        documentType: "report",
        content: "NEVER-SEND-DOCUMENT-CONTENT",
      },
    });
    const c = f.chat.create(f.person);
    await f.chat.message(
      f.person,
      c.id,
      "Przygotuj dla Alicja Sekretna. Kontakt alicja@example.invalid. Identyfikator 12345678901. Token sk-ant-syntheticsecret",
      randomUUID(),
    );
    const body = f.requests[0]!;
    assert.ok(body.includes("OSOBA_"));
    for (const privateText of [
      "Alicja Sekretna",
      "Waldemar",
      "private-registry",
      "NEVER-SEND",
      "alicja@example.invalid",
      "12345678901",
      "sk-ant-syntheticsecret",
    ])
      assert.equal(body.includes(privateText), false, privateText);
    const payload = JSON.parse(JSON.parse(body).messages[0].content);
    assert.equal(payload.records.length, 1);
    assert.deepEqual(Object.keys(payload.records[0]).sort(), [
      "id",
      "label",
      "module",
      "status",
      "version",
    ]);
  } finally {
    f.close();
  }
});
