import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";
import {
  replacementAsset,
  replacementInput,
} from "../tests/helpers/replacement-fixture.js";

const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw new Error("Synthetic replacement recovery arguments required");
const target = "ops.assets.replaceReservation";
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (event: object) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const h = custodyFixture(directory, {
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
    const source = await h.seed(),
      replacement = await replacementAsset(h);
    const seed = { sourceId: source.assetId, targetId: replacement.id };
    writeFileSync(join(directory, "seed.json"), JSON.stringify(seed));
    const run = await h.stage(
      target,
      replacementInput(h, seed.sourceId, seed.targetId),
    );
    hold = setInterval(() => {}, 1000);
    emit({ type: "waiting", runId: run.id });
    await new Promise<void>(() => {});
  }
  if (!runId) throw new Error("Run identity required");
  if (mode === "apply") {
    h.approve(h.engine.getRun(h.actor(), runId));
    await h.engine.tick();
    throw new Error("Expected SIGKILL");
  }
  for (let i = 0; i < 6; i++) await h.engine.tick();
  const seed = JSON.parse(
    readFileSync(join(directory, "seed.json"), "utf8"),
  ) as { sourceId: string; targetId: string };
  const run = h.engine.getRun(h.actor(), runId);
  const db = new DatabaseSync(join(directory, "operations.sqlite"), {
    readOnly: true,
  });
  try {
    emit({
      type: "finished",
      status: run.status,
      verified: run.steps.every((s) => s.verification?.ok),
      sourceStatus: h.get("assets", seed.sourceId).status,
      targetStatus: h.get("assets", seed.targetId).status,
      sourceVersion: h.get("assets", seed.sourceId).version,
      targetVersion: h.get("assets", seed.targetId).version,
      events: db
        .prepare("SELECT count(*) n FROM ops_asset_events WHERE run_id=?")
        .get(runId)!.n,
      receipts: db
        .prepare("SELECT count(*) n FROM ops_commands WHERE tool_id=?")
        .get(target)!.n,
      executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
      registerConsistent: [seed.sourceId, seed.targetId].every(
        (id) => h.workspace.assetRegister(h.actor(), id).consistent,
      ),
    });
  } finally {
    db.close();
  }
} finally {
  if (hold) clearInterval(hold);
  h.close();
  calls.close();
}
