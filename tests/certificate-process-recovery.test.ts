import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jsonChild } from "./helpers/json-child.js";

test(
  "real SIGKILL after certificate renewal preserves the exact key and certificate without another rotation",
  { timeout: 50000 },
  async () => {
    const directory = mkdtempSync(
        join(tmpdir(), "jarvis-certificate-process-"),
      ),
      children: ReturnType<typeof jsonChild>[] = [];
    const script = fileURLToPath(
      new URL("../scripts/it-case-recovery-child.ts", import.meta.url),
    );
    const child = (mode: string, runId?: string) => {
      const c = jsonChild(script, [
        mode,
        directory,
        runId ?? "-",
        "jarvis-local-tls",
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
      for (let i = 0; i < 2; i++) {
        const resume = child("resume", String(waiting.runId));
        assert.deepEqual(await resume.waitFor("finished"), {
          type: "finished",
          certificateMatches: true,
          status: "completed",
          verified: true,
          attempts: 1,
          executeCalls: 1,
          version: 1,
          proofCurrent: true,
          caseNotAccepted: true,
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
