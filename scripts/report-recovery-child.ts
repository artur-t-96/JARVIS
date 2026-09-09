import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reportFixture } from "../tests/helpers/report-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
const [mode, directory, phase, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  !["createReport", "refreshReport"].includes(phase ?? "")
)
  throw Error("Synthetic report recovery arguments required");
const target = "ops.documents." + phase,
  calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (event: object) =>
  process.stdout.write(JSON.stringify(event) + "\n");
let hold: ReturnType<typeof setInterval> | undefined;
const f = reportFixture(directory, {
  clock: () =>
    custodyNow +
    (mode === "apply" ? 1000 : mode === "resume" ? 8 * 86400_000 : 0),
  domainClock: () => custodyNow + (mode === "resume" ? 8 * 86400_000 : 0),
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
    await f.newAsset();
    await f.newAsset("synthetic-b");
    const previous = phase === "refreshReport" ? await f.createReport() : null;
    const input = f.prepare(
      "synthetic-a",
      { kind: "equipment" },
      previous?.document.id,
    );
    calls.prepare("DELETE FROM calls").run();
    const run = await f.stage(target, input);
    writeFileSync(
      join(directory, "report-seed.json"),
      JSON.stringify({
        previewId: input.previewId,
        version: previous?.document.version ?? 0,
        other: f.workspace.list(f.actor("manager", "synthetic-b"), "assets"),
      }),
    );
    hold = setInterval(() => {}, 1000);
    emit({ type: "waiting", runId: run.id });
    await new Promise<void>(() => {});
  }
  if (!runId) throw Error("Run identity required");
  if (mode === "apply") {
    f.approve(f.engine.getRun(f.actor(), runId));
    await f.engine.tick();
    throw Error("Expected SIGKILL");
  }
  const seed = JSON.parse(
    readFileSync(join(directory, "report-seed.json"), "utf8"),
  );
  // A separate durable domain write changes membership before Core reconciles the lost response.
  await f.workspace
    .tools()
    .find((t) => t.id === "ops.assets.create")!
    .execute(
      {
        tenantId: "synthetic-a",
        actorId: "manager",
        approvedBy: "reviewer",
        runId: "synthetic-report-member",
        stepId: "asset",
        operationKey: "synthetic-report-member",
        signal: new AbortController().signal,
      },
      {
        title: "Synthetic new report member",
        data: {
          assetType: "monitor",
          serial: "REPORT-RESTART-MEMBER",
          location: "Synthetic stock",
          condition: "good",
        },
      },
    );
  for (let i = 0; i < 6; i++) await f.engine.tick();
  const run = f.engine.getRun(f.actor(), runId),
    document = f.get("documents", String(run.steps[0]!.output!.data.entityId)),
    db = new DatabaseSync(join(directory, "operations.sqlite"), {
      readOnly: true,
    });
  try {
    emit({
      type: "finished",
      status: run.status,
      verified: run.steps[0]!.verification?.ok,
      attempts: run.steps[0]!.attempts,
      documentChanges: document.version - seed.version,
      revisions: document.data.revision,
      sourceCurrent: f.workspace.documentReadiness(f.actor(), document.id)
        .reportCurrent,
      executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
      receipts: db
        .prepare(
          "SELECT count(*) n FROM ops_commands WHERE operation_key IN(SELECT operation_key FROM ops_audit WHERE run_id=?)",
        )
        .get(runId)!.n,
      previewRetained: !!db
        .prepare(
          "SELECT id FROM ops_report_previews WHERE id=? AND document_id=?",
        )
        .get(seed.previewId, document.id),
      otherTenantUnchanged:
        JSON.stringify(
          f.workspace.list(f.actor("manager", "synthetic-b"), "assets"),
        ) === JSON.stringify(seed.other),
    });
  } finally {
    db.close();
  }
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
