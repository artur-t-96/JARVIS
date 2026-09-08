import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jsonChild } from "./helpers/json-child.js";
const script = fileURLToPath(
  new URL("../scripts/task-access-recovery-child.ts", import.meta.url),
);
for (const phase of [
  "attestAccessForTask",
  "renewAccessForTask",
  "revokeAccessForTask",
  "bindAccessForTask",
])
  test(
    `real SIGKILL after ${phase} reconciles one durable effect even after validity expiry`,
    { timeout: 50000 },
    async () => {
      const directory = mkdtempSync(
          join(tmpdir(), "jarvis-task-access-process-"),
        ),
        children: ReturnType<typeof jsonChild>[] = [];
      const child = (mode: string, runId?: string) => {
        const c = jsonChild(script, [
          mode,
          directory,
          phase,
          ...(runId ? [runId] : []),
        ]);
        children.push(c);
        return c;
      };
      try {
        const seed = child("seed"),
          waiting = await seed.waitFor("waiting");
        assert.equal((await seed.kill()).signal, "SIGKILL");
        const apply = child("apply", String(waiting.runId));
        await apply.waitFor("effect_applied");
        assert.equal((await apply.kill()).signal, "SIGKILL");
        for (let pass = 0; pass < 2; pass++) {
          const resume = child("resume", String(waiting.runId));
          assert.deepEqual(await resume.waitFor("finished"), {
            type: "finished",
            status: "completed",
            verified: true,
            grants: phase === "bindAccessForTask" ? 2 : 1,
            events: phase === "attestAccessForTask" ? 1 : 2,
            grantVersion: ["attestAccessForTask", "bindAccessForTask"].includes(
              phase,
            )
              ? 1
              : 2,
            grantStatus: phase === "revokeAccessForTask" ? "revoked" : "active",
            caseChanges: 1,
            taskChanges: 1,
            receipts: 1,
            executeCalls: 1,
            performedBy: "it-one",
            approvedBy: "reviewer",
          });
          assert.equal((await resume.exited).code, 0);
        }
      } finally {
        await Promise.all(children.map((c) => c.kill()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
