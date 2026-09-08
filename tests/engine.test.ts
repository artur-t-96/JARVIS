import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ZodError } from "zod";
import { Engine } from "../src/engine.js";
import { DomainError } from "../src/contracts.js";
import {
  approver,
  createFixtureTools,
  operator,
  otherOperator,
  plan,
  policies,
  principals,
  viewer,
  writePlan,
  type FixtureOptions,
} from "./helpers/engine-fixture.js";

function setup(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-engine-test-"));
  const dbPath = join(directory, "engine.sqlite");
  const effectsPath = join(directory, "effects.sqlite");
  const fixture = createFixtureTools(effectsPath, options);
  let engine = new Engine({
    dbPath,
    tools: fixture.tools,
    policies: policies(),
    principals,
  });
  return {
    directory,
    dbPath,
    effectsPath,
    fixture,
    get engine() {
      return engine;
    },
    reopen(next: Partial<ConstructorParameters<typeof Engine>[0]> = {}) {
      engine.close();
      engine = new Engine({
        dbPath,
        tools: fixture.tools,
        policies: policies(),
        principals,
        ...next,
      });
      return engine;
    },
    close() {
      engine.close();
      fixture.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function expectRefusal(action: () => unknown, status?: number) {
  assert.throws(
    action,
    (error: unknown) =>
      (error instanceof DomainError &&
        (status == null || error.statusCode === status)) ||
      (status == null && error instanceof ZodError),
  );
}

async function waitForApproval(engine: Engine, runId: string) {
  engine.start(operator, runId);
  for (let index = 0; index < 8; index++) {
    const run = engine.getRun(operator, runId);
    if (run.status === "waiting_approval") {
      const step = run.steps.find(
        (item) => item.approval?.status === "pending",
      );
      assert.ok(step?.approval, "a durable pending approval must be visible");
      return step.approval;
    }
    // A tick may create an approval without claiming a tool, and then return false.
    await engine.tick();
  }
  assert.fail("approval wait was not reached");
}

async function drain(engine: Engine, limit = 12) {
  for (let index = 0; index < limit; index++) {
    if (!(await engine.tick())) return;
  }
  assert.fail("engine did not become idle");
}

test("allowed read runs, write waits for exact approval, independent verification completes the run", async () => {
  const ctx = setup();
  try {
    const run = ctx.engine.createRun(
      operator,
      "Przygotuj pakiet.",
      plan(),
      "request-1",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    const waiting = ctx.engine.getRun(operator, run.id);
    assert.equal(waiting.steps[0]?.status, "succeeded");
    assert.equal(ctx.fixture.executeCount(), 0);
    assert.equal(ctx.fixture.effectCount(), 0);
    assert.equal(
      await ctx.engine.tick(),
      false,
      "waiting for a human is idle, not a repeated attempt",
    );
    expectRefusal(() =>
      ctx.engine.approve(approver, run.id, {
        approvalId: approval.id,
        bindingHash: "0".repeat(64),
        decision: "approved",
      }),
    );
    assert.equal(ctx.fixture.effectCount(), 0);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await drain(ctx.engine);
    const completed = ctx.engine.getRun(operator, run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[1]?.verification?.ok, true);
    assert.equal(
      completed.steps[1]?.verification?.evidence[0]?.source,
      "fixture-effects-db",
    );
    assert.equal(ctx.fixture.executeCount(), 1);
    assert.equal(ctx.fixture.effectCount(), 1);
    await drain(ctx.engine);
    assert.equal(ctx.fixture.executeCount(), 1);
  } finally {
    ctx.close();
  }
});

test("tenant, role and trusted principal boundaries apply to runs and approvals", async () => {
  const ctx = setup();
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "tenant-boundary",
    );
    expectRefusal(() => ctx.engine.getRun(otherOperator, run.id), 404);
    expectRefusal(() => ctx.engine.cancel(otherOperator, run.id), 404);
    assert.equal(ctx.engine.listRuns(otherOperator).length, 0);
    expectRefusal(() =>
      ctx.engine.createRun(viewer, "Zapisz.", writePlan(), "viewer-write"),
    );
    expectRefusal(() =>
      ctx.engine.createRun(
        { ...viewer, roles: ["operator"] },
        "Zapisz.",
        writePlan(),
        "forged-role",
      ),
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    const decision = {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved" as const,
    };
    expectRefusal(
      () => ctx.engine.approve(otherOperator, run.id, decision),
      404,
    );
    expectRefusal(() => ctx.engine.approve(operator, run.id, decision));
    assert.equal(ctx.fixture.effectCount(), 0);
  } finally {
    ctx.close();
  }
});

test("every write needs approval even if approvalTools is empty", async () => {
  const ctx = setup();
  try {
    ctx.reopen({
      policies: policies().map((policy) => ({ ...policy, approvalTools: [] })),
    });
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "unlisted-approval",
    );
    await waitForApproval(ctx.engine, run.id);
    assert.equal(ctx.fixture.executeCount(), 0);
  } finally {
    ctx.close();
  }
});

test("duplicate create key returns the original run and rejects changed intent", () => {
  const ctx = setup();
  try {
    const first = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "same-request",
    );
    const second = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "same-request",
    );
    assert.equal(second.id, first.id);
    expectRefusal(
      () =>
        ctx.engine.createRun(
          operator,
          "Zapisz.",
          writePlan("Inny zakres"),
          "same-request",
        ),
      409,
    );
    expectRefusal(
      () =>
        ctx.engine.createRun(
          operator,
          "Inna intencja.",
          writePlan(),
          "same-request",
        ),
      409,
    );
    const other = ctx.engine.createRun(
      otherOperator,
      "Zapisz.",
      writePlan(),
      "same-request",
    );
    assert.notEqual(other.id, first.id);
    assert.equal(ctx.engine.listRuns(operator).length, 1);
  } finally {
    ctx.close();
  }
});

test("a plan cannot introduce an unknown tool or invalid arguments", () => {
  const ctx = setup();
  try {
    const unknown = writePlan();
    unknown.steps[0]!.toolId = "arbitrary.shell";
    expectRefusal(() =>
      ctx.engine.createRun(operator, "Uruchom.", unknown, "unknown-tool"),
    );
    const malformed = writePlan();
    malformed.steps[0]!.input = { name: 42 };
    expectRefusal(() =>
      ctx.engine.createRun(operator, "Uruchom.", malformed, "invalid-args"),
    );
    assert.equal(ctx.fixture.effectCount(), 0);
  } finally {
    ctx.close();
  }
});

test("changed policy after approval blocks execution after restart", async () => {
  const ctx = setup();
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "policy-version",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    ctx.reopen({ policies: policies("2") });
    await drain(ctx.engine);
    assert.equal(ctx.engine.getRun(operator, run.id).status, "blocked");
    assert.equal(ctx.fixture.executeCount(), 0);
  } finally {
    ctx.close();
  }
});

test("revoked tool permission is rechecked after approval even if policy version is unchanged", async () => {
  const ctx = setup();
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "revoked-permission",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    ctx.reopen({
      policies: policies().map((policy) => ({
        ...policy,
        allowedTools: ["test.read"],
      })),
    });
    await drain(ctx.engine);
    assert.equal(ctx.engine.getRun(operator, run.id).status, "blocked");
    assert.equal(ctx.fixture.effectCount(), 0);
  } finally {
    ctx.close();
  }
});

test("changed tool version after approval cannot inherit the old authorization", async () => {
  const ctx = setup();
  const upgraded = createFixtureTools(ctx.effectsPath, { writeVersion: "2" });
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "changed-tool",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    ctx.reopen({ tools: upgraded.tools });
    await drain(ctx.engine);
    assert.equal(ctx.engine.getRun(operator, run.id).status, "blocked");
    assert.equal(ctx.fixture.executeCount(), 0);
  } finally {
    upgraded.close();
    ctx.close();
  }
});

test("cancelled or rejected approval never authorizes a write", async () => {
  const ctx = setup();
  try {
    const cancelled = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "cancelled",
    );
    const approval = await waitForApproval(ctx.engine, cancelled.id);
    ctx.engine.cancel(operator, cancelled.id);
    expectRefusal(() =>
      ctx.engine.approve(approver, cancelled.id, {
        approvalId: approval.id,
        bindingHash: approval.bindingHash,
        decision: "approved",
      }),
    );
    await drain(ctx.engine);
    assert.equal(ctx.engine.getRun(operator, cancelled.id).status, "cancelled");
    const rejected = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "rejected",
    );
    const rejectedApproval = await waitForApproval(ctx.engine, rejected.id);
    ctx.engine.approve(approver, rejected.id, {
      approvalId: rejectedApproval.id,
      bindingHash: rejectedApproval.bindingHash,
      decision: "rejected",
    });
    await drain(ctx.engine);
    assert.notEqual(
      ctx.engine.getRun(operator, rejected.id).status,
      "completed",
    );
    assert.equal(ctx.fixture.executeCount(), 0);
  } finally {
    ctx.close();
  }
});

test("failed independent verification blocks the run without repeating the effect", async () => {
  const ctx = setup({ failVerification: true });
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "bad-proof",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await drain(ctx.engine);
    const blocked = ctx.engine.getRun(operator, run.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.steps[0]?.verification?.ok, false);
    await drain(ctx.engine);
    assert.equal(ctx.fixture.effectCount(), 1);
    assert.equal(ctx.fixture.executeCount(), 1);
  } finally {
    ctx.close();
  }
});

test("lost response is reconciled from the external effect without executing again", async () => {
  const ctx = setup({ fault: "unknown-after-apply" });
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "lost-response",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await drain(ctx.engine);
    assert.equal(
      ctx.engine.getRun(operator, run.id).status,
      "needs_reconciliation",
    );
    assert.equal(ctx.fixture.effectCount(), 1);
    ctx.engine.retry(operator, run.id);
    await drain(ctx.engine);
    assert.equal(ctx.engine.getRun(operator, run.id).status, "completed");
    assert.equal(
      ctx.fixture.executeCount(),
      1,
      "recovery must read the receipt, not merely rely on target deduplication",
    );
    assert.equal(ctx.fixture.effectCount(), 1);
  } finally {
    ctx.close();
  }
});

test("unknown reconciliation remains visible and never re-executes blindly", async () => {
  const ctx = setup({
    fault: "unknown-before-apply",
    reconciliationUnknown: true,
  });
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "unknown-result",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await drain(ctx.engine);
    for (let index = 0; index < 2; index++) {
      assert.equal(
        ctx.engine.getRun(operator, run.id).status,
        "needs_reconciliation",
      );
      ctx.engine.retry(operator, run.id);
      await drain(ctx.engine);
    }
    assert.equal(
      ctx.engine.getRun(operator, run.id).status,
      "needs_reconciliation",
    );
    assert.equal(ctx.fixture.executeCount(), 1);
    assert.equal(ctx.fixture.effectCount(), 0);
  } finally {
    ctx.close();
  }
});

test("recovery cannot re-execute an absent effect after the approving actor loses their role", async () => {
  const ctx = setup({ fault: "unknown-before-apply" });
  try {
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "revoked-recovery",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await drain(ctx.engine);
    assert.equal(
      ctx.engine.getRun(operator, run.id).status,
      "needs_reconciliation",
    );
    ctx.reopen({
      principals: principals.map((principal) =>
        principal.id === approver.id
          ? { ...principal, roles: ["viewer"] }
          : principal,
      ),
    });
    ctx.engine.retry(operator, run.id);
    await drain(ctx.engine);
    assert.equal(
      ctx.fixture.executeCount(),
      1,
      "a definitely absent effect does not waive current approval authority",
    );
    assert.equal(ctx.fixture.effectCount(), 0);
    assert.notEqual(ctx.engine.getRun(operator, run.id).status, "completed");
  } finally {
    ctx.close();
  }
});

test("a tool ignoring AbortSignal cannot hold the worker forever or authorize a blind retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx = setup({
    afterApply: async () => {
      await gate;
    },
  });
  let work: Promise<boolean> | undefined;
  try {
    // Exercise the adapter deadline without racing lease expiry under CI load.
    // The next test advances the clock to verify fencing after an expired lease.
    ctx.reopen({ leaseMs: 50, clock: () => 1000 });
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "ignored-timeout",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    work = ctx.engine.tick();
    const outcome = await Promise.race([
      work.then(() => "settled" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    assert.equal(
      outcome,
      "settled",
      "engine deadline must terminate its wait even if an adapter ignores abort",
    );
    assert.equal(
      ctx.engine.getRun(operator, run.id).status,
      "needs_reconciliation",
    );
    assert.equal(ctx.fixture.executeCount(), 1);
    assert.equal(ctx.fixture.effectCount(), 1);
    assert.equal(
      await ctx.engine.tick(),
      false,
      "unknown result must await explicit reconciliation",
    );
  } finally {
    release();
    if (work) await Promise.allSettled([work]);
    ctx.close();
  }
});

test("expired worker cannot overwrite the state committed by a recovery worker", async () => {
  let release!: () => void;
  let applied!: () => void;
  const appliedSignal = new Promise<void>((resolve) => {
    applied = resolve;
  });
  const releaseSignal = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx = setup({
    afterApply: async () => {
      applied();
      await releaseSignal;
    },
  });
  let second: Engine | undefined;
  let oldWork: Promise<boolean> | undefined;
  let now = 1000;
  try {
    ctx.reopen({ clock: () => now, leaseMs: 50, workerId: "worker-old" });
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "fenced-lease",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    oldWork = ctx.engine.tick();
    await appliedSignal;
    now = 2000;
    second = new Engine({
      dbPath: ctx.dbPath,
      tools: ctx.fixture.tools,
      policies: policies(),
      principals,
      clock: () => now,
      leaseMs: 50,
      workerId: "worker-new",
    });
    await drain(second);
    assert.equal(second.getRun(operator, run.id).status, "completed");
    release();
    await Promise.allSettled([oldWork]);
    assert.equal(second.getRun(operator, run.id).status, "completed");
    assert.equal(ctx.fixture.executeCount(), 1);
    assert.equal(ctx.fixture.effectCount(), 1);
  } finally {
    release();
    if (oldWork) await Promise.allSettled([oldWork]);
    second?.close();
    ctx.close();
  }
});

test("policy change during an in-flight write preserves the unresolved effect on recovery", async () => {
  let release!: () => void;
  let applied!: () => void;
  const appliedSignal = new Promise<void>((resolve) => {
    applied = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx = setup({
    afterApply: async () => {
      applied();
      await gate;
    },
  });
  let recovering: Engine | undefined;
  let work: Promise<boolean> | undefined;
  let now = 1000;
  try {
    ctx.reopen({
      clock: () => now,
      leaseMs: 50,
      workerId: "old-policy-worker",
    });
    const run = ctx.engine.createRun(
      operator,
      "Zapisz.",
      writePlan(),
      "policy-in-flight",
    );
    const approval = await waitForApproval(ctx.engine, run.id);
    ctx.engine.approve(approver, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    work = ctx.engine.tick();
    await appliedSignal;
    now = 2000;
    recovering = new Engine({
      dbPath: ctx.dbPath,
      tools: ctx.fixture.tools,
      policies: policies("2"),
      principals,
      clock: () => now,
      leaseMs: 50,
    });
    await drain(recovering);
    const unresolved = recovering.getRun(operator, run.id);
    assert.equal(
      unresolved.status,
      "needs_reconciliation",
      "policy refusal cannot erase an already possible external effect",
    );
    assert.equal(unresolved.steps[0]?.status, "unknown");
    assert.equal(ctx.fixture.effectCount(), 1);
    assert.equal(ctx.fixture.executeCount(), 1);
    release();
    await Promise.allSettled([work]);
    assert.equal(
      recovering.getRun(operator, run.id).status,
      "needs_reconciliation",
    );
  } finally {
    release();
    if (work) await Promise.allSettled([work]);
    recovering?.close();
    ctx.close();
  }
});
