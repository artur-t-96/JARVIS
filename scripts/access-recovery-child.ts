import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";
import { seedAccess, accessInput } from "../tests/helpers/access-fixture.js";
const [mode, directory, phase, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  !["attestAccess", "renewAccess", "revokeAccess"].includes(phase ?? "")
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
    const s = await seedAccess(f);
    let input = accessInput(f, s);
    if (phase !== "attestAccess") {
      await f.complete("ops.cases.attestAccess", input);
      const g = f.workspace.caseAccess(f.actor(), s.caseId).grants[0]!;
      input =
        phase === "renewAccess"
          ? {
              ...accessInput(f, s),
              grantId: g.id,
              expectedGrantVersion: g.version,
            }
          : {
              id: s.caseId,
              expectedVersion: f.get("cases", s.caseId).version,
              grantId: g.id,
              expectedGrantVersion: g.version,
              revokedOn: "2026-09-08",
              verificationMethod: "Synthetic removal check",
              note: "Synthetic recovery only",
              humanConfirmed: true,
            };
    }
    const run = await f.stage(target, input);
    writeFileSync(
      join(directory, "seed.json"),
      JSON.stringify({
        caseId: s.caseId,
        caseVersion: f.get("cases", s.caseId).version,
      }),
    );
    hold = setInterval(() => {}, 1000);
    emit({ type: "waiting", runId: run.id });
    await new Promise<void>(() => {});
  }
  if (!runId) throw new Error("Run identity required");
  if (mode === "apply") {
    f.approve(f.engine.getRun(f.actor(), runId));
    await f.engine.tick();
    throw new Error("Expected SIGKILL");
  }
  for (let i = 0; i < 6; i++) await f.engine.tick();
  const seed = JSON.parse(
    readFileSync(join(directory, "seed.json"), "utf8"),
  ) as { caseId: string; caseVersion: number };
  const run = f.engine.getRun(f.actor(), runId),
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
      events: grants[0]!.events.length,
      grantVersion: grants[0]!.version,
      grantStatus: grants[0]!.status,
      caseChanges: f.get("cases", seed.caseId).version - seed.caseVersion,
      receipts: db
        .prepare("SELECT count(*) n FROM ops_commands WHERE tool_id=?")
        .get(target)!.n,
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
