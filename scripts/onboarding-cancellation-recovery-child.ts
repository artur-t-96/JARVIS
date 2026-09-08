import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";
import { seedOnboarding } from "../tests/helpers/onboarding-fixture.js";
import {
  cancellationInput,
  clearOnboardingResources,
} from "../tests/helpers/cancellation-fixture.js";

const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw Error("Synthetic cancellation recovery arguments required");
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (event: object) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const f = custodyFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  wrap: (tool) =>
    tool.id !== "ops.people.cancelStart"
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
const db = new DatabaseSync(join(directory, "operations.sqlite"), {
  readOnly: true,
});
const resourcesHash = () =>
  digest(
    [
      "ops_allocations",
      "ops_license_seats",
      "ops_access_grants",
      "ops_access_events",
      "ops_asset_events",
    ].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY tenant_id,id`).all(),
    ),
  );
try {
  if (mode === "seed") {
    const a = await seedOnboarding(f),
      b = await seedOnboarding(f, {
        tenant: "synthetic-b",
        kind: "contractor",
      });
    await a.documents();
    await a.equipment();
    await a.access();
    await clearOnboardingResources(f, a);
    const run = await f.stage(
      "ops.people.cancelStart",
      cancellationInput(f, a.caseId),
    );
    writeFileSync(
      join(directory, "cancellation-proof.json"),
      JSON.stringify({
        personId: a.personId,
        episodeId: a.episodeId,
        caseId: a.caseId,
        otherCaseId: b.caseId,
        otherCaseHash: digest(b.getCase()),
        resourcesHash: resourcesHash(),
      }),
    );
    hold = setInterval(() => {}, 1000);
    emit({ type: "waiting", runId: run.id });
    await new Promise<void>(() => {});
  }
  if (!runId) throw Error("Run required");
  if (mode === "apply") {
    f.approve(f.engine.getRun(f.actor(), runId));
    await f.engine.tick();
    throw Error("Expected SIGKILL");
  }
  for (let i = 0; i < 6; i++) await f.engine.tick();
  const proof = JSON.parse(
      readFileSync(join(directory, "cancellation-proof.json"), "utf8"),
    ),
    run = f.engine.getRun(f.actor(), runId),
    episode = f.workspace
      .listEmploymentEpisodes(f.actor(), proof.personId)
      .find((e) => e.id === proof.episodeId)!,
    c = f.get("cases", proof.caseId);
  emit({
    type: "finished",
    status: run.status,
    verified: run.steps[0]!.verification?.ok,
    attempts: run.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    personStatus: f.get("people", proof.personId).status,
    episodeStatus: episode.status,
    endDate: episode.endDate,
    episodeVersion: episode.version,
    caseStatus: c.status,
    tasksClosed: (c.data.tasks as { status: string }[]).every((t) =>
      ["completed", "cancelled"].includes(t.status),
    ),
    resourcesUnchanged: resourcesHash() === proof.resourcesHash,
    otherTenantUnchanged:
      digest(f.get("cases", proof.otherCaseId, "synthetic-b")) ===
      proof.otherCaseHash,
  });
} finally {
  if (hold) clearInterval(hold);
  db.close();
  f.close();
  calls.close();
}
