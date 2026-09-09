import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonChild } from "./helpers/json-child.js";
test(
  "real SIGKILL before approval and after license confirmation preserves one contract beyond its expiry",
  { timeout: 50000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-license-process-")),
      children: ReturnType<typeof jsonChild>[] = [];
    const child = (mode: string, id?: string) => {
      const c = jsonChild(
        fileURLToPath(
          new URL("../scripts/license-recovery-child.ts", import.meta.url),
        ),
        [mode, directory, ...(id ? [id] : [])],
      );
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
          status: "completed",
          verified: true,
          attempts: 1,
          executeCalls: 1,
          terms: 1,
          seats: 3,
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
