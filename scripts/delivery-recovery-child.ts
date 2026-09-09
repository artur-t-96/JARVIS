import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { deliveryFixture } from "../tests/helpers/delivery-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
import { hash } from "../src/engine.js";
const [mode, directory, action, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  !["recordDelivery", "registerDeliveredAssets"].includes(action ?? "")
)
  throw Error("Synthetic delivery recovery arguments required");
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (data: object) =>
  process.stdout.write(JSON.stringify(data) + "\n");
let hold: ReturnType<typeof setInterval> | undefined;
const f = deliveryFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  domainClock: () =>
    mode === "resume" ? Date.parse("2026-10-10T10:00:00Z") : custodyNow,
  wrap: (tool) =>
    tool.id !== `ops.purchases.${action}`
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
                  deliveryHash: hash(f.deliveries(proof.orderId)),
                  assetHash: hash(f.workspace.list(f.actor(), "assets")),
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
    const a = await f.order(),
      b = await f.order("synthetic-b");
    const input = f.deliveryInput(a.order.id, "RECOVERY WZ 1", 2);
    if (action === "registerDeliveredAssets") {
      await f.complete("ops.purchases.recordDelivery", input);
      const view = f.deliveries(a.order.id),
        receipt = view.receipts[0]!;
      for (const key of Object.keys(input)) delete input[key];
      Object.assign(input, {
        id: a.order.id,
        expectedVersion: view.order.version,
        receiptId: receipt.id,
        expectedReceiptVersion: receipt.version,
        assets: ["PROCESS-SERIAL-1", "PROCESS-SERIAL-2"].map((serial) => ({
          title: "Synthetic laptop",
          serial,
          assetType: "laptop",
          location: "Stock",
        })),
        evidenceNote: "Synthetic physical serial check",
        humanConfirmed: true,
      });
    }
    const run = await f.stage(`ops.purchases.${action}`, input);
    writeFileSync(
      join(directory, "proof.json"),
      JSON.stringify({
        orderId: a.order.id,
        otherId: b.order.id,
        otherHash: hash(f.deliveries(b.order.id, "synthetic-b")),
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
    view = f.deliveries(proof.orderId),
    assets = f.workspace.list(f.actor(), "assets");
  emit({
    type: "finished",
    status: run.status,
    verified: run.steps[0]!.verification?.ok,
    attempts: run.steps[0]!.attempts,
    executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
    receipts: view.receipts.length,
    assets: assets.length,
    exactCommittedState:
      hash(view) === proof.deliveryHash && hash(assets) === proof.assetHash,
    otherTenantUnchanged:
      hash(f.deliveries(proof.otherId, "synthetic-b")) === proof.otherHash,
  });
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
