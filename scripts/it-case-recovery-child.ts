import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { itCaseFixture } from "../tests/helpers/it-case-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw Error("Synthetic lab recovery arguments required");
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (data: object) =>
  process.stdout.write(`${JSON.stringify(data)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const f = await itCaseFixture(directory, {
  engineClock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  wrap: (tool) =>
    tool.id !== "lab.repairCase"
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
    const caseId = await f.open(),
      otherCaseId = await f.open("synthetic-b"),
      run = await f.stage("lab.repairCase", f.view(caseId).repairInput);
    writeFileSync(
      join(directory, "proof.json"),
      JSON.stringify({ caseId, otherCaseId }),
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
    { caseId, otherCaseId } = JSON.parse(
      readFileSync(join(directory, "proof.json"), "utf8"),
    ),
    proof = f.view(caseId).proofs[0];
  emit({
    type: "finished",
    status: run.status,
    verified: run.steps[0]!.verification?.ok,
    attempts: run.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    version: (await f.inspect()).version,
    proofCurrent: proof?.identity.current,
    caseNotAccepted: f.get("cases", caseId).status === "open",
    otherTenantUnchanged:
      f.get("cases", otherCaseId, "synthetic-b").version === 1 &&
      (await f.inspect("synthetic-b")).version === 0,
  });
} finally {
  if (hold) clearInterval(hold);
  await f.close();
  calls.close();
}
