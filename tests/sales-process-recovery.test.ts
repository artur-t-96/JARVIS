import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonChild } from "./helpers/json-child.js";
for (const target of ["accept", "step"] as const)
  test(
    `real SIGKILL before approval and after sales ${target} preserves the committed result beyond its deadline`,
    { timeout: 50000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "jarvis-sales-process-")),
        children: ReturnType<typeof jsonChild>[] = [];
      const child = (mode: string, id?: string) => {
        const c = jsonChild(
          fileURLToPath(
            new URL("../scripts/sales-recovery-child.ts", import.meta.url),
          ),
          [mode, directory, target, ...(id ? [id] : [])],
        );
        children.push(c);
        return c;
      };
      try {
        const seed = child("seed"),
          waiting = await seed.waitFor("waiting");
        assert.equal(waiting.executeCalls, 0);
        assert.equal((await seed.kill()).signal, "SIGKILL");
        const apply = child("apply", String(waiting.runId));
        await apply.waitFor("effect_applied");
        assert.equal((await apply.kill()).signal, "SIGKILL");
        for (let i = 0; i < 2; i++) {
          const resume = child("resume", String(waiting.runId));
          assert.deepEqual(await resume.waitFor("finished"), {
            type: "finished",
            status: "completed",
            verified: true,
            attempts: 1,
            executeCalls: 1,
            offerStatus: target === "accept" ? "accepted" : "sent",
            nextStepStatus: target === "step" ? "assigned" : null,
            exactCommittedState: true,
            otherTenantUnchanged: true,
          });
          assert.equal((await resume.exited).code, 0);
        }
      } finally {
        await Promise.all(children.map((c) => c.kill()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
