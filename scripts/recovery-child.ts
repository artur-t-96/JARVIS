import { join } from "node:path";
import { Engine } from "../src/engine.js";
import {
  approver,
  createFixtureTools,
  operator,
  plan,
  policies,
  principals,
} from "../tests/helpers/engine-fixture.js";

const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw new Error("Expected mode and fixture directory.");
const emit = (message: object) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const fixture = createFixtureTools(join(directory, "effects.sqlite"), {
  afterApply:
    mode === "apply"
      ? async () => {
          hold = setInterval(() => {}, 1000);
          emit({ type: "effect_applied" });
          await new Promise<void>(() => {});
        }
      : undefined,
});
const now = mode === "seed" ? 1000 : mode === "apply" ? 2000 : 3000;
const engine = new Engine({
  dbPath: join(directory, "engine.sqlite"),
  tools: fixture.tools,
  policies: policies(),
  principals,
  clock: () => now,
  leaseMs: 50,
  workerId: `child-${mode}`,
});

try {
  if (mode === "seed") {
    const run = engine.createRun(
      operator,
      "Przygotuj pakiet i potwierdź zapis.",
      plan(),
      "process-recovery",
    );
    engine.start(operator, run.id);
    for (let index = 0; index < 8; index++) {
      const current = engine.getRun(operator, run.id);
      if (current.status === "waiting_approval") {
        hold = setInterval(() => {}, 1000);
        emit({
          type: "waiting",
          runId: run.id,
          status: current.status,
          effects: fixture.effectCount(),
        });
        await new Promise<void>(() => {});
      }
      // Creating a wait is a durable transition, but does not claim a tool.
      await engine.tick();
    }
    throw new Error("Approval wait was not reached.");
  }
  if (!runId) throw new Error("runId is required for resume.");
  if (mode === "apply") {
    const run = engine.getRun(operator, runId);
    if (run.status !== "waiting_approval")
      throw new Error(`Expected durable approval wait; got ${run.status}.`);
    const approval = run.steps.find(
      (step) => step.approval?.status === "pending",
    )?.approval;
    if (!approval) throw new Error("Pending approval missing.");
    engine.approve(approver, runId, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await engine.tick();
    throw new Error(
      "The process should have been killed after the external effect.",
    );
  }
  for (let index = 0; index < 12; index++) {
    if (!(await engine.tick())) break;
  }
  const current = engine.getRun(operator, runId);
  emit({
    type: "finished",
    status: current.status,
    effects: fixture.effectCount(),
    calls: fixture.executeCount(),
    verified: current.steps.every((step) => step.verification?.ok === true),
  });
} finally {
  if (hold) clearInterval(hold);
  engine.close();
  fixture.close();
}
