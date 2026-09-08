import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jsonChild } from "./helpers/json-child.js";

test(
  "real SIGKILL before approval and after both replacement writes reconciles the pair once, even after expiry",
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "jarvis-replacement-process-"),
    );
    const children: ReturnType<typeof jsonChild>[] = [];
    const child = (mode: string, runId?: string) => {
      const c = jsonChild(
        fileURLToPath(
          new URL("../scripts/replacement-recovery-child.ts", import.meta.url),
        ),
        [mode, directory, ...(runId ? [runId] : [])],
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
      for (let pass = 0; pass < 2; pass++) {
        const resume = child("resume", String(waiting.runId));
        assert.deepEqual(await resume.waitFor("finished"), {
          type: "finished",
          status: "completed",
          verified: true,
          sourceStatus: "available",
          targetStatus: "reserved",
          sourceVersion: 3,
          targetVersion: 2,
          events: 2,
          receipts: 1,
          executeCalls: 1,
          registerConsistent: true,
        });
        assert.equal((await resume.exited).code, 0);
      }
    } finally {
      await Promise.all(children.map((c) => c.kill()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
