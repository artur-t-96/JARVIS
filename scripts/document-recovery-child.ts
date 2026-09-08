import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "../src/contracts.js";
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";
import {
  approveDocument,
  seedDocumentCase,
} from "../tests/helpers/document-fixture.js";
const [mode, directory, phase, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  !["create", "revise", "approve"].includes(phase ?? "")
)
  throw Error("Synthetic document recovery arguments required");
const target = "ops.documents." + phase,
  calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (event: object) =>
  process.stdout.write(JSON.stringify(event) + "\n");
let hold: ReturnType<typeof setInterval> | undefined;
const f = custodyFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
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
    const { caseId, prepared } = await seedDocumentCase(f);
    let input = prepared,
      documentId: string | undefined,
      beforeVersion = 0;
    if (phase !== "create") {
      const result = await f.complete("ops.documents.create", prepared);
      documentId = String(result.steps[0]!.output!.data.entityId);
      if (phase === "revise") {
        await approveDocument(f, documentId);
        input = {
          ...JSON.parse(
            JSON.stringify(f.workspace.documentRefresh(f.actor(), documentId)),
          ),
          content: "Synthetic explicitly revised document",
          changeNote: "Synthetic crash test",
        };
      } else {
        await f.complete("ops.documents.submit", {
          id: documentId,
          expectedVersion: 1,
        });
        input = {
          id: documentId,
          expectedVersion: f.get("documents", documentId).version,
          decision: "approved",
          note: "Synthetic checked version",
          humanDecision: true,
        };
      }
      beforeVersion = f.get("documents", documentId).version;
    }
    calls.prepare("DELETE FROM calls").run();
    const run = await f.stage(target, input);
    writeFileSync(
      join(directory, "seed.json"),
      JSON.stringify({ caseId, documentId, beforeVersion }),
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
    readFileSync(join(directory, "seed.json"), "utf8"),
  ) as { caseId: string; documentId?: string; beforeVersion: number };
  const c = f.get("cases", seed.caseId);
  if (c.data.scopeRevision === 1) {
    // Explicit synthetic domain operation after the crash, before Core reconciliation.
    const tool = f.workspace.tools().find((t) => t.id === "ops.cases.revise")!;
    const input: JsonObject = {
      id: c.id,
      expectedVersion: c.version,
      brief: "Source scope changed while execution was interrupted",
      acceptanceCriteria: String(c.data.acceptanceCriteria),
      reason: "Synthetic restart source change",
    };
    await tool.execute(
      {
        tenantId: "synthetic-a",
        actorId: "manager",
        approvedBy: "reviewer",
        runId: "synthetic-source-change",
        stepId: "scope",
        operationKey: randomUUID(),
        signal: new AbortController().signal,
      },
      tool.prepareInput?.(input, "synthetic-a") ?? input,
    );
  }
  for (let i = 0; i < 6; i++) await f.engine.tick();
  const run = f.engine.getRun(f.actor(), runId),
    id = seed.documentId ?? String(run.steps[0]!.output!.data.entityId),
    doc = f.get("documents", id),
    db = new DatabaseSync(join(directory, "operations.sqlite"), {
      readOnly: true,
    });
  try {
    emit({
      type: "finished",
      status: run.status,
      verified: run.steps.every((s) => s.verification?.ok),
      documentChanges: doc.version - seed.beforeVersion,
      revisions: doc.data.revision,
      sourceCurrent: f.workspace.documentReadiness(f.actor(), id)
        .readyForReview,
      executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
      receipts: db
        .prepare(
          "SELECT count(*) n FROM ops_commands WHERE tool_id=? AND operation_key IN(SELECT operation_key FROM ops_audit WHERE run_id=?)",
        )
        .get(target, runId)!.n,
    });
  } finally {
    db.close();
  }
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
