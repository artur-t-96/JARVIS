import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { stocktakeFixture } from "../tests/helpers/stocktake-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
import { hash } from "../src/engine.js";
const [mode, directory, operation, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  !["observe", "resolve"].includes(operation ?? "")
)
  throw Error("Synthetic stocktake recovery arguments required");
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (v: object) => process.stdout.write(JSON.stringify(v) + "\n");
const target =
  operation === "observe"
    ? "ops.inventory.recordObservation"
    : "ops.inventory.resolveDiscrepancy";
let hold: ReturnType<typeof setInterval> | undefined;
const f = stocktakeFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  domainClock: () => custodyNow + (mode === "resume" ? 20 * 86400000 : 0),
  wrap: (tool) =>
    tool.id !== target
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const result = await tool.execute(...args);
            if (mode === "apply") {
              const path = join(directory, "proof.json"),
                proof = JSON.parse(readFileSync(path, "utf8"));
              writeFileSync(
                path,
                JSON.stringify({
                  ...proof,
                  committedHash: hash(f.workspace.list(f.actor(), "inventory")),
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
    const a = await f.newAsset(),
      b = await f.newAsset("synthetic-b"),
      spis = await f.open([a.id]);
    await f.open([b.id], "synthetic-b");
    const missing = f.observeInput(spis.id, a.id, { present: false });
    delete missing.location;
    delete missing.condition;
    if (operation === "resolve") {
      await f.complete("ops.inventory.recordObservation", missing);
      await f.complete(
        "ops.inventory.recordObservation",
        f.observeInput(spis.id, a.id),
      );
    }
    const r = await f.stage(
      target,
      operation === "observe" ? missing : f.resolveInput(spis.id, a.id),
    );
    writeFileSync(
      join(directory, "proof.json"),
      JSON.stringify({
        stocktakeId: spis.id,
        assetId: a.id,
        assetsHash: hash([
          f.workspace.list(f.actor(), "assets"),
          f.workspace.list(f.actor("manager", "synthetic-b"), "assets"),
        ]),
        otherHash: hash(
          f.workspace.list(f.actor("manager", "synthetic-b"), "inventory"),
        ),
      }),
    );
    hold = setInterval(() => {}, 1000);
    emit({ type: "waiting", runId: r.id });
    await new Promise<void>(() => {});
  }
  if (!runId) throw Error("Run required");
  if (mode === "apply") {
    f.approve(f.engine.getRun(f.actor(), runId));
    await f.engine.tick();
  }
  for (let i = 0; i < 5; i++) await f.engine.tick();
  const r = f.engine.getRun(f.actor(), runId),
    proof = JSON.parse(readFileSync(join(directory, "proof.json"), "utf8"));
  emit({
    type: "finished",
    status: r.status,
    verified: r.steps[0]!.verification?.ok,
    attempts: r.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    unresolved: f.workspace.assetInventoryHolds(f.actor(), proof.assetId)
      .length,
    exactCommittedState:
      hash(f.workspace.list(f.actor(), "inventory")) === proof.committedHash,
    otherTenantUnchanged:
      hash(f.workspace.list(f.actor("manager", "synthetic-b"), "inventory")) ===
      proof.otherHash,
    equipmentUnchanged:
      hash([
        f.workspace.list(f.actor(), "assets"),
        f.workspace.list(f.actor("manager", "synthetic-b"), "assets"),
      ]) === proof.assetsHash,
  });
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
