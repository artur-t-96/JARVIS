import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jsonChild } from "./helpers/json-child.js";
const script = fileURLToPath(
  new URL("../scripts/document-recovery-child.ts", import.meta.url),
);
for (const phase of [
  "create",
  "revise",
  "approve",
  "attachFile",
  "detachFile",
  "approveFile",
])
  test(
    `real SIGKILL after document ${phase} preserves one effect after the source scope changes`,
    { timeout: 50000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "jarvis-document-process-")),
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
            documentChanges: 1,
            revisions:
              phase === "detachFile"
                ? 3
                : ["revise", "attachFile", "approveFile"].includes(phase)
                  ? 2
                  : 1,
            currentFiles: ["attachFile", "approveFile"].includes(phase) ? 1 : 0,
            validFiles: true,
            sourceCurrent: false,
            executeCalls: 1,
            receipts: 1,
          });
          assert.equal((await resume.exited).code, 0);
        }
      } finally {
        await Promise.all(children.map((c) => c.kill()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
