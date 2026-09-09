import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  assetImportFixture,
  csvBody,
} from "../tests/helpers/asset-import-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
import { hash } from "../src/engine.js";
const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw Error("Synthetic import recovery arguments required");
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (value: object) =>
  process.stdout.write(JSON.stringify(value) + "\n");
let hold: ReturnType<typeof setInterval> | undefined;
const f = assetImportFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  domainClock: () => custodyNow + (mode === "resume" ? 20 * 86400000 : 0),
  wrap: (tool) =>
    tool.id !== "ops.assets.importBatch"
      ? tool
      : {
          ...tool,
          async execute(...args) {
            if (args[0].tenantId === "synthetic-a")
              calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const result = await tool.execute(...args);
            if (mode === "apply" && args[0].tenantId === "synthetic-a") {
              const path = join(directory, "proof.json"),
                proof = JSON.parse(readFileSync(path, "utf8"));
              writeFileSync(
                path,
                JSON.stringify({
                  ...proof,
                  committedHash: hash(f.workspace.list(f.actor(), "assets")),
                  importId: result.data.importId,
                }),
              );
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
    await f.complete(
      "ops.assets.importBatch",
      f.prepare("synthetic-b"),
      "manager",
      "synthetic-b",
    );
    const input = f.prepare(),
      run = await f.stage("ops.assets.importBatch", input);
    writeFileSync(
      join(directory, "proof.json"),
      JSON.stringify({
        otherHash: hash(
          f.workspace.list(f.actor("manager", "synthetic-b"), "assets"),
        ),
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
  }
  for (let i = 0; i < 5; i++) await f.engine.tick();
  const run = f.engine.getRun(f.actor(), runId),
    proof = JSON.parse(readFileSync(join(directory, "proof.json"), "utf8"));
  emit({
    type: "finished",
    status: run.status,
    verified: run.steps[0]!.verification?.ok,
    attempts: run.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    exactCommittedState:
      hash(f.workspace.list(f.actor(), "assets")) === proof.committedHash,
    otherTenantUnchanged:
      hash(f.workspace.list(f.actor("manager", "synthetic-b"), "assets")) ===
      proof.otherHash,
    imports: f.workspace.assetImports(f.actor(), { limit: 20, offset: 0 })
      .total,
    sourcePreserved: f.workspace
      .assetImportSource(f.actor(), proof.importId)
      .body.equals(csvBody),
  });
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
