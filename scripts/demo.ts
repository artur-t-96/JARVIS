import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../src/engine.js";
import { DemoPlanner } from "../src/planner.js";
import { createDemoTools } from "../src/tools.js";
import type { Policy, Principal } from "../src/contracts.js";

const dir = mkdtempSync(join(tmpdir(), "jarvis-demo-"));
const principal: Principal = {
  id: "demo-operator",
  tenantId: "demo-tenant",
  roles: ["operator", "approver"],
};
const policy: Policy = {
  tenantId: principal.tenantId,
  name: "Dane syntetyczne",
  version: "v1",
  allowedTools: ["demo.inspect", "demo.publish"],
  approvalTools: [],
  allowSelfApproval: true,
};
let demo = createDemoTools(join(dir, "effects.sqlite"), {
  testFaultAfterPublishOnce: true,
});
const open = () =>
  new Engine({
    dbPath: join(dir, "engine.sqlite"),
    tools: demo.tools,
    policies: [policy],
    principals: [principal],
  });
let engine = open();
try {
  const request =
    "Sprawdź plan i zapisz wyłącznie lokalny rekord demonstracyjny";
  let run = engine.createRun(
    principal,
    request,
    await new DemoPlanner().plan(request, demo.tools),
    "demo-recovery-1",
  );
  engine.start(principal, run.id);
  await engine.tick();
  await engine.tick();
  run = engine.getRun(principal, run.id);
  if (run.status !== "waiting_approval")
    throw new Error("Approval was not required");
  engine.close();
  engine = open();
  run = engine.getRun(principal, run.id);
  const approval = run.steps.find(
    (s) => s.approval?.status === "pending",
  )?.approval;
  if (!approval) throw new Error("Approval did not survive restart");
  engine.approve(principal, run.id, {
    approvalId: approval.id,
    bindingHash: approval.bindingHash,
    decision: "approved",
  });
  await engine.tick();
  if (engine.getRun(principal, run.id).status !== "needs_reconciliation")
    throw new Error("Lost acknowledgement was not preserved");
  engine.close();
  demo.close();
  demo = createDemoTools(join(dir, "effects.sqlite"));
  engine = open();
  engine.retry(principal, run.id);
  await engine.tick();
  run = engine.getRun(principal, run.id);
  if (run.status !== "completed" || run.steps[1]?.attempts !== 1)
    throw new Error("Recovery failed or repeated effect");
  process.stdout.write(
    JSON.stringify(
      {
        mode: "synthetic-local-data-only",
        status: run.status,
        restarts: 2,
        writeAttempts: run.steps[1].attempts,
        evidence: run.steps[1].verification,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  engine.close();
  demo.close();
  rmSync(dir, { recursive: true, force: true });
}
