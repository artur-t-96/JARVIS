import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DomainError,
  OutcomeUnknownError,
  type ToolContext,
} from "../src/contracts.js";
import { createDemoTools } from "../src/tools.js";

function context(
  tenantId = "tenant-a",
  operationKey = "publish-one",
): ToolContext {
  return {
    tenantId,
    operationKey,
    runId: "run-one",
    stepId: "publish",
    signal: new AbortController().signal,
  };
}

test("durable effect survives a lost response and restart; replay creates no second record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-tools-"));
  const path = join(dir, "effects.sqlite");
  let bundle = createDemoTools(path, { testFaultAfterPublishOnce: true });
  try {
    await assert.rejects(
      bundle.tools[1]!.execute(context(), { subject: "Próba" }),
      OutcomeUnknownError,
    );
    bundle.close();
    bundle = createDemoTools(path);
    const publish = bundle.tools[1]!;
    const recovered = await publish.reconcile!(context(), { subject: "Próba" });
    assert.equal(recovered.status, "applied");
    if (recovered.status !== "applied") assert.fail("Expected durable effect");
    const replay = await publish.execute(context(), { subject: "Próba" });
    assert.deepEqual(replay, recovered.result);
    const verified = await publish.verify(
      context(),
      { subject: "Próba" },
      replay,
    );
    assert.equal(verified.ok, true);
    assert.ok(Date.parse(verified.evidence[0]!.observedAt));
    const readDb = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        readDb.prepare("SELECT count(*) AS count FROM demo_publications").get()!
          .count,
        1,
      );
    } finally {
      readDb.close();
    }
  } finally {
    bundle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency checks payload conflicts while preserving tenant isolation", async () => {
  const bundle = createDemoTools(":memory:");
  try {
    const publish = bundle.tools[1]!;
    const a = await publish.execute(context(), { subject: "Temat A" });
    assert.equal(
      (
        await publish.verify(
          context("tenant-a", "another-operation"),
          { subject: "Temat A" },
          a,
        )
      ).ok,
      false,
    );
    assert.equal(
      (await publish.verify(context(), { subject: "Another subject" }, a)).ok,
      false,
    );
    await assert.rejects(
      publish.execute(context(), { subject: "Temat B" }),
      (error: unknown) =>
        error instanceof DomainError && error.code === "idempotency_conflict",
    );
    await assert.rejects(
      publish.reconcile!(context(), { subject: "Temat B" }),
      (error: unknown) =>
        error instanceof DomainError && error.code === "idempotency_conflict",
    );
    assert.deepEqual(
      await publish.reconcile!(context("tenant-b"), { subject: "Temat A" }),
      { status: "not_applied" },
    );
    assert.equal(
      (await publish.verify(context("tenant-b"), { subject: "Temat A" }, a)).ok,
      false,
    );
    const b = await publish.execute(context("tenant-b"), {
      subject: "Temat A",
    });
    assert.notEqual(a.data.recordId, b.data.recordId);
    assert.equal(
      (await publish.verify(context(), { subject: "Temat A" }, b)).ok,
      false,
    );
  } finally {
    bundle.close();
  }
});

test("verification rejects fabricated receipts and detects a removed persisted effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-proof-"));
  const path = join(dir, "effects.sqlite");
  const bundle = createDemoTools(path);
  try {
    const publish = bundle.tools[1]!;
    const input = { subject: "Dowód" };
    const fabricated = {
      data: {
        recordId: "invented",
        subject: input.subject,
        status: "published",
      },
    };
    assert.equal(
      (await publish.verify(context(), input, fabricated)).ok,
      false,
    );
    const result = await publish.execute(context(), input);
    assert.equal((await publish.verify(context(), input, result)).ok, true);
    const externalDb = new DatabaseSync(path);
    try {
      externalDb
        .prepare(
          "DELETE FROM demo_publications WHERE tenant_id = ? AND operation_key = ?",
        )
        .run("tenant-a", "publish-one");
    } finally {
      externalDb.close();
    }
    assert.equal((await publish.verify(context(), input, result)).ok, false);
  } finally {
    bundle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborted execution and invalid inputs have no side effects", async () => {
  const bundle = createDemoTools(":memory:");
  try {
    const publish = bundle.tools[1]!;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      publish.execute(
        { ...context(), signal: controller.signal },
        { subject: "Test" },
      ),
    );
    await assert.rejects(
      publish.execute(context(), { subject: "Test", tenantId: "tenant-b" }),
    );
    await assert.rejects(publish.execute(context(), { subject: "\n" }));
    assert.deepEqual(await publish.reconcile!(context(), { subject: "Test" }), {
      status: "not_applied",
    });
    const inspect = bundle.tools[0]!;
    const result = await inspect.execute(context(), { subject: "Test" });
    assert.equal(result.data.isTestData, true);
    assert.equal(
      (await inspect.verify(context(), { subject: "Test" }, result)).ok,
      true,
    );
    assert.equal(
      (await inspect.verify(context("tenant-b"), { subject: "Test" }, result))
        .ok,
      false,
    );
  } finally {
    bundle.close();
  }
});
