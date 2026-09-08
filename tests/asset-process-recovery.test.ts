import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jsonChild } from "./helpers/json-child.js";

const script = fileURLToPath(
  new URL("../scripts/asset-recovery-child.ts", import.meta.url),
);
test(
  "real SIGKILL after issue and after separate binding preserves one witnessed asset effect and independent proof",
  { timeout: 50_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-asset-process-"));
    const children: ReturnType<typeof jsonChild>[] = [];
    const child = (...args: string[]) => {
      const c = jsonChild(script, [args[0]!, directory, ...args.slice(1)]);
      children.push(c);
      return c;
    };
    try {
      for (const phase of ["issue", "bind"]) {
        const seed = child(phase === "issue" ? "seed" : "stage-bind", phase),
          waiting = await seed.waitFor("waiting");
        assert.equal(
          waiting.assetStatus,
          phase === "issue" ? "reserved" : "issued",
        );
        assert.equal((await seed.kill()).signal, "SIGKILL");
        const apply = child("apply", phase, String(waiting.runId));
        await apply.waitFor("effect_applied");
        assert.equal((await apply.kill()).signal, "SIGKILL");
        const expected = {
          type: "finished",
          status: "completed",
          verified: true,
          assetStatus: "issued",
          issueEvents: 1,
          bindings: phase === "bind" ? 1 : 0,
          issueTaskEvents: 1,
          bindingTaskEvents: phase === "bind" ? 1 : 0,
          issueCalls: 1,
          bindCalls: phase === "bind" ? 1 : 0,
          performedBy: "it-one",
          approvedBy: "reviewer",
          ready: false,
        };
        for (let pass = 0; pass < 2; pass++) {
          const resume = child("resume", phase, String(waiting.runId));
          assert.deepEqual(await resume.waitFor("finished"), expected);
          assert.equal((await resume.exited).code, 0);
        }
      }
    } finally {
      await Promise.all(children.map((c) => c.kill()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
