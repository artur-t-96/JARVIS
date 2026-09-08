import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { purchasingFixture } from "../tests/helpers/purchasing-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
import { hash } from "../src/engine.js";
const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw Error("Synthetic recovery arguments required");
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (data: object) =>
  process.stdout.write(JSON.stringify(data) + "\n");
let hold: ReturnType<typeof setInterval> | undefined;
const f = purchasingFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  domainClock: () =>
    mode === "resume" ? Date.parse("2026-10-10T10:00:00Z") : custodyNow,
  wrap: (tool) =>
    tool.id !== "ops.purchases.placeOrder"
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const result = await tool.execute(...args);
            if (mode === "apply") {
              const path = join(directory, "proof.json"),
                proof = JSON.parse(readFileSync(path, "utf8")),
                request = f.get("purchases", proof.requestId);
              writeFileSync(
                path,
                JSON.stringify({
                  ...proof,
                  requestHash: hash(request),
                  orderHash: hash(
                    f.get("purchases", String(request.data.orderId)),
                  ),
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
    const a = await f.seedPurchase(),
      b = await f.seedPurchase("synthetic-b");
    await f.select(a.request.id, a.quote.id);
    await f.approveCost(a.request.id, a.quote.id);
    const run = await f.stage(
      "ops.purchases.placeOrder",
      f.orderInput(a.request.id),
    );
    writeFileSync(
      join(directory, "proof.json"),
      JSON.stringify({
        requestId: a.request.id,
        otherId: b.request.id,
        otherHash: hash(f.get("purchases", b.request.id, "synthetic-b")),
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
    proof = JSON.parse(readFileSync(join(directory, "proof.json"), "utf8")),
    request = f.get("purchases", proof.requestId),
    order = f.get("purchases", String(request.data.orderId));
  emit({
    type: "finished",
    status: run.status,
    verified: run.steps[0]!.verification?.ok,
    attempts: run.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    orders: f.workspace
      .list(f.actor(), "purchases")
      .filter((x) => x.data.kind === "order").length,
    exactCommittedState:
      hash(request) === proof.requestHash && hash(order) === proof.orderHash,
    otherTenantUnchanged:
      hash(f.get("purchases", proof.otherId, "synthetic-b")) ===
      proof.otherHash,
    expiredOfferCannotBeNewDecision: !f.view(request.id).costDecisionCurrent,
  });
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
