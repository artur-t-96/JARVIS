import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonChild } from "./helpers/json-child.js";
test(
  "real SIGKILL before CSV approval and after batch commit preserves original source and one import beyond staging expiry",
  { timeout: 50000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-import-process-")),
      children: ReturnType<typeof jsonChild>[] = [];
    const child = (mode: string, id?: string) => {
      const c = jsonChild(
        fileURLToPath(
          new URL("../scripts/asset-import-recovery-child.ts", import.meta.url),
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
        const resumed = child("resume", String(waiting.runId));
        assert.deepEqual(await resumed.waitFor("finished"), {
          type: "finished",
          status: "completed",
          verified: true,
          attempts: 1,
          executeCalls: 1,
          exactCommittedState: true,
          otherTenantUnchanged: true,
          imports: 1,
          sourcePreserved: true,
        });
        assert.equal((await resumed.exited).code, 0);
      }
    } finally {
      await Promise.all(children.map((c) => c.kill()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
