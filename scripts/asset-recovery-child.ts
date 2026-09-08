import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";

const [mode, directory, phase = "issue", runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "stage-bind", "apply", "resume"].includes(mode ?? "") ||
  !["issue", "bind"].includes(phase)
)
  throw new Error("Synthetic asset recovery arguments required");
const target = `ops.assets.${phase === "issue" ? "issueForTask" : "bindAssetForTask"}`;
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY,tool TEXT NOT NULL)",
);
const emit = (event: object) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const h = custodyFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  wrap: (tool) =>
    tool.id !== target
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls(tool) VALUES(?)").run(tool.id);
            const result = await tool.execute(...args);
            if (mode === "apply") {
              hold = setInterval(() => {}, 1000);
              emit({ type: "effect_applied" });
              await new Promise<void>(() => {});
            }
            return result;
          },
        },
});
try {
  if (mode === "seed")
    writeFileSync(join(directory, "seed.json"), JSON.stringify(await h.seed()));
  const seed = JSON.parse(
    readFileSync(join(directory, "seed.json"), "utf8"),
  ) as { taskId: string; assetId: string; caseId: string };
  if (mode === "seed" || mode === "stage-bind") {
    const equipment = h.workspace.taskEquipment(h.actor("it-one"), seed.taskId);
    const action = phase === "issue" ? "issueForTask" : "bindAssetForTask";
    const binding = equipment.allocations[0]!.commandBindings[action];
    assert.ok(binding);
    const input =
      phase === "issue"
        ? {
            ...binding,
            issuedOn: "2026-09-08",
            location: "Synthetic fixture only",
            condition: "good",
            handoverNote: "Synthetic witness; not real equipment",
            humanConfirmed: true,
          }
        : binding;
    const run = await h.stage(target, input, "it-one");
    hold = setInterval(() => {}, 1000);
    emit({
      type: "waiting",
      runId: run.id,
      assetStatus: h.get("assets", seed.assetId).status,
    });
    await new Promise<void>(() => {});
  }
  if (!runId) throw new Error("Run identity required");
  if (mode === "apply") {
    h.approve(h.engine.getRun(h.actor("it-one"), runId));
    await h.engine.tick();
    throw new Error("Expected SIGKILL");
  }
  for (let i = 0; i < 6; i++) await h.engine.tick();
  const run = h.engine.getRun(h.actor("it-one"), runId),
    db = new DatabaseSync(join(directory, "operations.sqlite"), {
      readOnly: true,
    });
  try {
    const count = (sql: string) => Number(db.prepare(sql).get()!.n);
    const issue = db
      .prepare(
        "SELECT performed_by,approved_by FROM ops_asset_events WHERE kind='issue'",
      )
      .get();
    emit({
      type: "finished",
      status: run.status,
      verified: run.steps.every((s) => s.verification?.ok),
      assetStatus: h.get("assets", seed.assetId).status,
      issueEvents: count(
        "SELECT COUNT(*) n FROM ops_asset_events WHERE kind='issue'",
      ),
      bindings: count("SELECT COUNT(*) n FROM ops_requirement_bindings"),
      issueTaskEvents: count(
        "SELECT COUNT(*) n FROM ops_task_events WHERE action='issueForTask'",
      ),
      bindingTaskEvents: count(
        "SELECT COUNT(*) n FROM ops_task_events WHERE action='bindAssetForTask'",
      ),
      issueCalls: Number(
        calls
          .prepare(
            "SELECT COUNT(*) n FROM calls WHERE tool='ops.assets.issueForTask'",
          )
          .get()!.n,
      ),
      bindCalls: Number(
        calls
          .prepare(
            "SELECT COUNT(*) n FROM calls WHERE tool='ops.assets.bindAssetForTask'",
          )
          .get()!.n,
      ),
      performedBy: issue?.performed_by,
      approvedBy: issue?.approved_by,
      ready: h.workspace.readiness(h.actor(), seed.caseId).ready,
    });
  } finally {
    db.close();
  }
} finally {
  if (hold) clearInterval(hold);
  h.close();
  calls.close();
}
