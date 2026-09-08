import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "../src/contracts.js";
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";
import {
  seedTaskAccess,
  taskWitness,
} from "../tests/helpers/task-access-fixture.js";
const [mode, directory, phase, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  ![
    "attestAccessForTask",
    "renewAccessForTask",
    "revokeAccessForTask",
    "bindAccessForTask",
  ].includes(phase ?? "")
)
  throw new Error("Synthetic access recovery arguments required");
const target = `ops.cases.${phase}`;
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (event: object) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const f = custodyFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  domainClock: () =>
    mode === "resume" ? Date.parse("2026-10-01T10:00:00Z") : custodyNow,
  wrap: (tool) =>
    tool.id !== target
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const r = await tool.execute(...args);
            if (mode === "apply") {
              hold = setInterval(() => {}, 1000);
              emit({ type: "effect_applied" });
              await new Promise<void>(() => {});
            }
            return r;
          },
        },
});
try {
  if (mode === "seed") {
    const s = await seedTaskAccess(f);
    const view = () =>
      f.workspace.taskAccess(f.actor("it-one"), s.accessTaskId);
    const member = () => view().requirements[0]!.members[0]!;
    let input: JsonObject = {
      ...member().commandBindings.attestAccessForTask!,
      ...taskWitness(),
      licenseSeatId: s.licenseSeatId!,
    };
    if (phase !== "attestAccessForTask") {
      await f.complete("ops.cases.attestAccessForTask", input, "it-one");
      if (phase === "bindAccessForTask") {
        await f.complete(
          "ops.cases.attestAccessForTask",
          {
            ...view().requirements[0]!.members[1]!.commandBindings
              .attestAccessForTask!,
            ...taskWitness(1),
          },
          "it-one",
        );
        input = { ...view().requirements[0]!.bindInput!, humanConfirmed: true };
      } else
        input =
          phase === "renewAccessForTask"
            ? {
                ...member().commandBindings.renewAccessForTask!,
                ...taskWitness(),
                licenseSeatId: s.licenseSeatId!,
              }
            : {
                ...member().commandBindings.revokeAccessForTask!,
                revokedOn: "2026-09-08",
                verificationMethod: "Synthetic removal check",
                note: "Synthetic recovery only",
                humanConfirmed: true,
              };
    }
    // Setup may use the target tool before the held command; count only the latter.
    calls.prepare("DELETE FROM calls").run();
    const taskVersion = view().task.version;
    const run = await f.stage(target, input, "it-one");
    writeFileSync(
      join(directory, "seed.json"),
      JSON.stringify({
        caseId: s.caseId,
        taskId: s.accessTaskId,
        taskVersion,
        caseVersion: f.get("cases", s.caseId).version,
      }),
    );
    hold = setInterval(() => {}, 1000);
    emit({ type: "waiting", runId: run.id });
    await new Promise<void>(() => {});
  }
  if (!runId) throw new Error("Run identity required");
  if (mode === "apply") {
    f.approve(f.engine.getRun(f.actor("it-one"), runId));
    await f.engine.tick();
    throw new Error("Expected SIGKILL");
  }
  for (let i = 0; i < 6; i++) await f.engine.tick();
  const seed = JSON.parse(
    readFileSync(join(directory, "seed.json"), "utf8"),
  ) as {
    caseId: string;
    caseVersion: number;
    taskId: string;
    taskVersion: number;
  };
  const run = f.engine.getRun(f.actor("it-one"), runId),
    grants = f.workspace.caseAccess(f.actor(), seed.caseId).grants;
  const db = new DatabaseSync(join(directory, "operations.sqlite"), {
    readOnly: true,
  });
  try {
    emit({
      type: "finished",
      status: run.status,
      verified: run.steps.every((s) => s.verification?.ok),
      grants: grants.length,
      events: grants.reduce((n, g) => n + g.events.length, 0),
      grantVersion: Math.max(...grants.map((g) => g.version)),
      grantStatus: grants[0]!.status,
      caseChanges: f.get("cases", seed.caseId).version - seed.caseVersion,
      taskChanges:
        Number(
          (
            f.get("cases", seed.caseId).data.tasks as {
              id: string;
              version: number;
            }[]
          ).find((t) => t.id === seed.taskId)!.version,
        ) - seed.taskVersion,
      receipts: db
        .prepare(
          "SELECT count(*) n FROM ops_commands WHERE tool_id=? AND operation_key IN (SELECT operation_key FROM ops_task_events WHERE run_id=?)",
        )
        .get(target, runId)!.n,
      executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
      performedBy: grants[0]!.performedBy,
      approvedBy: grants[0]!.approvedBy,
    });
  } finally {
    db.close();
  }
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
