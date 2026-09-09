import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { licenseFixture } from "../tests/helpers/license-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
import { hash } from "../src/engine.js";
const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw Error("Synthetic license recovery arguments required");
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (v: object) => process.stdout.write(JSON.stringify(v) + "\n");
let hold: ReturnType<typeof setInterval> | undefined;
const f = licenseFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  domainClock: () =>
    mode === "resume" ? Date.parse("2028-01-01T10:00:00Z") : custodyNow,
  wrap: (tool) =>
    tool.id !== "ops.licenses.confirmTerms"
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const result = await tool.execute(...args);
            if (mode === "apply") {
              const file = join(directory, "proof.json"),
                proof = JSON.parse(readFileSync(file, "utf8"));
              writeFileSync(
                file,
                JSON.stringify({
                  ...proof,
                  hash: hash(f.workspace.list(f.actor(), "licenses")),
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
    const a = await f.seedLicense(),
      b = await f.seedLicense("synthetic-b");
    const p = await f.licenseAction(a.pool.id, "proposeTerms", {
      terms: a.terms,
    });
    await f.decision(p.id);
    const r = await f.stage("ops.licenses.confirmTerms", f.confirmInput(p.id));
    writeFileSync(
      join(directory, "proof.json"),
      JSON.stringify({
        poolId: a.pool.id,
        otherId: b.pool.id,
        otherHash: hash(
          f.workspace.list(f.actor("manager", "synthetic-b"), "licenses"),
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
  const run = f.engine.getRun(f.actor(), runId),
    proof = JSON.parse(readFileSync(join(directory, "proof.json"), "utf8"));
  emit({
    type: "finished",
    status: run.status,
    verified: run.steps[0]!.verification?.ok,
    attempts: run.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    terms: f.licenseView(proof.poolId).terms.length,
    seats: f.get("licenses", proof.poolId).data.totalSeats,
    exactCommittedState:
      hash(f.workspace.list(f.actor(), "licenses")) === proof.hash,
    otherTenantUnchanged:
      hash(f.workspace.list(f.actor("manager", "synthetic-b"), "licenses")) ===
      proof.otherHash,
  });
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
