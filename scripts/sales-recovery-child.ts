import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { salesFixture } from "../tests/helpers/sales-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
import { hash } from "../src/engine.js";
const [mode, directory, target, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  !["accept", "step"].includes(target ?? "")
)
  throw Error("Synthetic sales recovery arguments required");
const toolId =
  target === "accept" ? "ops.sales.acceptOffer" : "ops.sales.scheduleNextStep";
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (v: object) => process.stdout.write(JSON.stringify(v) + "\n");
let hold: ReturnType<typeof setInterval> | undefined;
const file = join(directory, "proof.json");
const f = salesFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  domainClock: () =>
    mode === "resume" ? Date.parse("2028-01-01T10:00:00Z") : custodyNow,
  wrap: (tool) =>
    tool.id !== toolId
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const result = await tool.execute(...args);
            if (mode === "apply") {
              const p = JSON.parse(readFileSync(file, "utf8"));
              writeFileSync(
                file,
                JSON.stringify({
                  ...p,
                  hash: hash(f.workspace.list(f.actor(), "sales")),
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
    const a = await f.salesSeed();
    await f.salesSeed("synthetic-b");
    const sent = await f.salesSend(a.offer.id);
    const input =
      target === "accept"
        ? {
            id: sent.id,
            expectedVersion: sent.version,
            acceptedOn: "2026-09-08",
            acceptanceNote: "Synthetic client decision",
            evidenceReference: "SYNTHETIC",
            humanDecision: true,
          }
        : {
            id: a.deal.id,
            expectedVersion: a.deal.version,
            title: "SYNTHETIC next step",
            description: "Synthetic follow-up",
            ownerPrincipalId: "manager",
            dueDate: "2026-09-09",
          };
    const run = await f.stage(toolId, input);
    writeFileSync(
      file,
      JSON.stringify({
        offerId: a.offer.id,
        dealId: a.deal.id,
        otherHash: hash(
          f.workspace.list(f.actor("manager", "synthetic-b"), "sales"),
        ),
      }),
    );
    hold = setInterval(() => {}, 1000);
    emit({
      type: "waiting",
      runId: run.id,
      executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    });
    await new Promise<void>(() => {});
  }
  if (!runId) throw Error("Run required");
  if (mode === "apply") {
    f.approve(f.engine.getRun(f.actor(), runId));
    await f.engine.tick();
  }
  for (let i = 0; i < 5; i++) await f.engine.tick();
  const run = f.engine.getRun(f.actor(), runId),
    p = JSON.parse(readFileSync(file, "utf8"));
  const deal = f.get("sales", p.dealId),
    step = deal.data.nextStepId
      ? f.get("sales", String(deal.data.nextStepId))
      : null;
  emit({
    type: "finished",
    status: run.status,
    verified: run.steps[0]!.verification?.ok,
    attempts: run.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    offerStatus: f.get("sales", p.offerId).status,
    nextStepStatus: step?.status ?? null,
    exactCommittedState: hash(f.workspace.list(f.actor(), "sales")) === p.hash,
    otherTenantUnchanged:
      hash(f.workspace.list(f.actor("manager", "synthetic-b"), "sales")) ===
      p.otherHash,
  });
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
