import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jsonChild } from "./helpers/json-child.js";

for (const operation of ["configure", "start"])
  test(
    `real SIGKILL after ${operation} with two onboarding variants reconciles one durable effect`,
    { timeout: 50000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "jarvis-variant-process-"));
      const children: ReturnType<typeof jsonChild>[] = [];
      const script = fileURLToPath(
        new URL(
          "../scripts/onboarding-variants-recovery-child.ts",
          import.meta.url,
        ),
      );
      const child = (mode: string, runId?: string) => {
        const c = jsonChild(script, [
          mode,
          directory,
          operation,
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
        for (let i = 0; i < 2; i++) {
          const resume = child("resume", String(waiting.runId));
          assert.deepEqual(await resume.waitFor("finished"), {
            type: "finished",
            status: "completed",
            verified: true,
            attempts: 1,
            executeCalls: 1,
            profileVersion: 1,
            definitionVersion: "4",
            variants: ["contractor", "internal"],
            episodes: operation === "start" ? 1 : 0,
            tasks: operation === "start" ? 4 : 0,
            requirements: operation === "start" ? 3 : 0,
            otherTenantVersion: 0,
          });
          assert.equal((await resume.exited).code, 0);
        }
      } finally {
        await Promise.all(children.map((c) => c.kill()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
