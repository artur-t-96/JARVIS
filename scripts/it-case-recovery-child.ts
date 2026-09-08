import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { itCaseFixture } from "../tests/helpers/it-case-fixture.js";
import { custodyNow } from "../tests/helpers/custody-fixture.js";
import {
  laboratoryTargetSchema,
  laboratoryTarget,
  laboratoryTlsTarget,
  laboratoryDefinition,
} from "../src/laboratory-contract.js";
import { hash } from "../src/engine.js";
const [mode, directory, runId, selectedTarget] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw Error("Synthetic lab recovery arguments required");
const target = laboratoryTargetSchema.parse(selectedTarget ?? laboratoryTarget);
const renewalTool = laboratoryDefinition(target).procedureId;
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (data: object) =>
  process.stdout.write(`${JSON.stringify(data)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const f = await itCaseFixture(directory, {
  target,
  engineClock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  wrap: (tool) =>
    tool.id !== renewalTool
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const result = await tool.execute(...args);
            if (mode === "apply") {
              if (target === laboratoryTlsTarget) {
                const path = join(directory, "proof.json"),
                  saved = JSON.parse(readFileSync(path, "utf8"));
                const db = new DatabaseSync(
                  join(directory, "laboratory.sqlite"),
                  { readOnly: true },
                );
                const row = db
                  .prepare(
                    "SELECT encrypted_key FROM laboratory_tls_state WHERE tenant_id=?",
                  )
                  .get(args[0].tenantId)!;
                db.close();
                writeFileSync(
                  path,
                  JSON.stringify({
                    ...saved,
                    appliedFingerprint: (result.data.certificate as any)
                      .fingerprint,
                    appliedKeyHash: hash(String(row.encrypted_key)),
                  }),
                );
              }
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
      run = await f.stage(renewalTool, f.view(caseId).repairInput);
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
  const saved = JSON.parse(readFileSync(join(directory, "proof.json"), "utf8"));
  const db = new DatabaseSync(join(directory, "laboratory.sqlite"), {
    readOnly: true,
  });
  const row =
    target === laboratoryTlsTarget
      ? db
          .prepare(
            "SELECT encrypted_key FROM laboratory_tls_state WHERE tenant_id=?",
          )
          .get("synthetic-a")
      : undefined;
  db.close();
  emit({
    type: "finished",
    ...(target === laboratoryTlsTarget
      ? {
          certificateMatches:
            f.view(caseId).laboratory.observed?.tls?.configuredCertificate
              .fingerprint === saved.appliedFingerprint &&
            hash(String(row!.encrypted_key)) === saved.appliedKeyHash,
        }
      : {}),
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
