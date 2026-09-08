import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";
import { seedOnboarding } from "../tests/helpers/onboarding-fixture.js";

const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw new Error("Synthetic onboarding recovery arguments required");
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
    tool.id !== "ops.people.activate"
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
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
  if (mode === "seed") {
    const a = await seedOnboarding(f),
      documentId = await a.documents();
    await a.equipment();
    await a.access();
    await a.managerReview();
    await a.accept();
    const run = await f.stage("ops.people.activate", a.activationInput());
    writeFileSync(
      join(directory, "seed.json"),
      JSON.stringify({
        personId: a.personId,
        caseId: a.caseId,
        episodeId: a.episodeId,
        personVersion: f.get("people", a.personId).version,
        assetId: a.assetId,
        documentId,
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
    throw new Error("Expected SIGKILL after the domain commit");
  }
  for (let i = 0; i < 6; i++) await f.engine.tick();
  const seed = JSON.parse(
      readFileSync(join(directory, "seed.json"), "utf8"),
    ) as {
      personId: string;
      caseId: string;
      episodeId: string;
      personVersion: number;
      assetId: string;
      documentId: string;
    },
    run = f.engine.getRun(f.actor(), runId),
    episodes = f.workspace.listEmploymentEpisodes(f.actor(), seed.personId),
    overview = f.workspace.onboarding(f.actor(), seed.caseId),
    files = f.workspace.documentFiles(f.actor(), seed.documentId),
    db = new DatabaseSync(join(directory, "operations.sqlite"), {
      readOnly: true,
    });
  try {
    emit({
      type: "finished",
      status: run.status,
      verified: run.steps.every((s) => s.verification?.ok),
      attempts: run.steps[0]!.attempts,
      executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
      episodes: episodes.length,
      episodeStatus: episodes[0]!.status,
      episodeVersion: episodes[0]!.version,
      personChanges:
        f.get("people", seed.personId).version - seed.personVersion,
      allocations: (f.get("assets", seed.assetId).data.allocations as unknown[])
        .length,
      acceptances: (f.get("cases", seed.caseId).data.acceptances as unknown[])
        .length,
      grants: f.workspace.caseAccess(f.actor(), seed.caseId).grants.length,
      files: files.length,
      filesValid: files.every((file) => file.valid),
      stage: overview.stage.id,
      acceptanceCurrent: overview.acceptanceCurrent,
      receipts: db
        .prepare(
          "SELECT count(*) n FROM ops_commands WHERE tool_id='ops.people.activate' AND operation_key IN(SELECT operation_key FROM ops_audit WHERE run_id=?)",
        )
        .get(runId)!.n,
    });
  } finally {
    db.close();
  }
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
