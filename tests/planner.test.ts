import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/contracts.js";
import { AnthropicPlanner, DemoPlanner } from "../src/planner.js";

const tools = [
  {
    id: "demo.inspect",
    description: "Read synthetic fixture",
    effect: "read" as const,
  },
  {
    id: "demo.publish",
    description: "Write local record",
    effect: "write" as const,
  },
];

async function fixturePlan() {
  return new DemoPlanner().plan("Temat", tools);
}
function fakeResponse(value: unknown, stopReason = "end_turn"): Response {
  return Response.json({
    stop_reason: stopReason,
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
}

test("demo planner honestly maps arbitrary requests to its fixed bounded test process", async () => {
  const plan = await new DemoPlanner().plan(
    "Usuń produkcję\u0000\u202e\n" + "x".repeat(500),
    tools,
  );
  assert.deepEqual(
    plan.steps.map((step) => step.toolId),
    ["demo.inspect", "demo.publish"],
  );
  assert.match(plan.summary, /bez użycia AI/);
  const subject = plan.steps[0]!.input.subject as string;
  assert.ok(subject.length <= 240);
  assert.doesNotMatch(subject, /[\p{Cc}\p{Cf}]/u);
  assert.deepEqual(plan.steps[0]!.input, plan.steps[1]!.input);
  await assert.rejects(
    new DemoPlanner().plan("x".repeat(8001), tools),
    DomainError,
  );
  await assert.rejects(
    new DemoPlanner().plan("Temat", tools.slice(0, 1)),
    DomainError,
  );
});

test("Anthropic planner requires explicit provider and model configuration", () => {
  assert.throws(() => AnthropicPlanner.fromEnv({}), DomainError);
  assert.throws(
    () => AnthropicPlanner.fromEnv({ ANTHROPIC_API_KEY: "test-key" }),
    DomainError,
  );
  assert.throws(
    () =>
      new AnthropicPlanner({
        apiKey: "test-key",
        model: "configured-model",
        timeoutMs: 60_001,
      }),
    DomainError,
  );
});

test("Anthropic planner sends only a constrained proposal request and validates its output", async () => {
  const expected = await fixturePlan();
  let requests = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init!.redirect, "error");
    assert.ok(init!.signal);
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, "explicit-test-model");
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.tools, undefined);
    assert.equal(body.output_config.format.type, "json_schema");
    return fakeResponse(expected);
  };
  const planner = new AnthropicPlanner({
    apiKey: "local-test-key",
    model: "explicit-test-model",
    fetchImpl,
  });
  assert.deepEqual(await planner.plan("Temat", tools), expected);
  assert.equal(requests, 1);
});

test("provider refusal, unknown tools, duplicate IDs and extra input are rejected", async () => {
  const base = await fixturePlan();
  const variants = [
    fakeResponse(base, "max_tokens"),
    fakeResponse({
      ...base,
      steps: [{ ...base.steps[0], toolId: "production.delete" }],
    }),
    fakeResponse({ ...base, steps: [base.steps[0], base.steps[0]] }),
    fakeResponse({
      ...base,
      steps: [
        { ...base.steps[0], input: { subject: "Test", tenantId: "other" } },
      ],
    }),
    fakeResponse({ ...base, approvalGranted: true }),
    fakeResponse({ ...base, steps: [base.steps[1]] }),
    fakeResponse({
      ...base,
      steps: [
        base.steps[0],
        { ...base.steps[1], input: { subject: "Different subject" } },
      ],
    }),
    new Response("malformed JSON"),
    new Response("x".repeat(65_537)),
    new Response("SECRET_FROM_PROVIDER", { status: 401 }),
  ];
  for (const response of variants) {
    const planner = new AnthropicPlanner({
      apiKey: "local-test-key",
      model: "explicit-test-model",
      fetchImpl: async () => response,
    });
    await assert.rejects(
      planner.plan("Temat", tools),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "planner_failed" &&
        !error.message.includes("SECRET_FROM_PROVIDER"),
    );
  }
});

test("transport failures do not expose keys or raw provider errors", async () => {
  const planner = new AnthropicPlanner({
    apiKey: "local-test-key",
    model: "explicit-test-model",
    fetchImpl: async () => {
      throw new Error("SECRET_TRANSPORT_DETAIL");
    },
  });
  await assert.rejects(
    planner.plan("Temat", tools),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "planner_failed" &&
      !error.message.includes("SECRET"),
  );
});
