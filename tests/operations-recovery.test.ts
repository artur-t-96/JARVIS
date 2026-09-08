import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const childScript = fileURLToPath(
  new URL("../scripts/operations-recovery-child.ts", import.meta.url),
);
interface ChildMessage {
  type: string;
  runId?: string;
  status?: string;
  effects?: number;
  calls?: number;
  verified?: boolean;
  audit?: number;
  outbox?: number;
}

function startChild(mode: string, directory: string, runId?: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childScript,
      mode,
      directory,
      ...(runId ? [runId] : []),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  const messages: ChildMessage[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line.trim()) messages.push(JSON.parse(line) as ChildMessage);
    }
    for (const wake of waiters) wake();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      ended = true;
      reject(error);
      for (const wake of waiters) wake();
    });
    child.once("close", (code, signal) => {
      ended = true;
      resolve({ code, signal });
      for (const wake of waiters) wake();
    });
  });
  return {
    child,
    exited,
    async waitFor(type: string): Promise<ChildMessage> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Child timed out waiting for ${type}. ${stderr}`));
        }, 10_000);
        const check = () => {
          const message = messages.find((item) => item.type === type);
          if (message || ended) {
            clearTimeout(timeout);
            waiters.delete(check);
            if (message) resolve(message);
            else reject(new Error(`Child exited before ${type}. ${stderr}`));
          }
        };
        waiters.add(check);
        check();
      });
    },
    async kill() {
      if (!ended) child.kill("SIGKILL");
      return exited;
    },
  };
}

test(
  "SIGKILL after committed real operations effect preserves audit/outbox and never repeats execute",
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-ops-process-test-"));
    const children: ReturnType<typeof startChild>[] = [];
    try {
      const first = startChild("seed", directory);
      children.push(first);
      const waiting = await first.waitFor("waiting");
      assert.equal(waiting.status, "waiting_approval");
      assert.equal(waiting.effects, 0);
      assert.ok(waiting.runId);
      assert.equal((await first.kill()).signal, "SIGKILL");

      const second = startChild("apply", directory, waiting.runId);
      children.push(second);
      await second.waitFor("effect_applied");
      assert.equal((await second.kill()).signal, "SIGKILL");

      const third = startChild("resume", directory, waiting.runId);
      children.push(third);
      const recovered = await third.waitFor("finished");
      assert.deepEqual(recovered, {
        type: "finished",
        status: "completed",
        effects: 1,
        calls: 1,
        verified: true,
        audit: 1,
        outbox: 1,
      });
      assert.equal((await third.exited).code, 0);

      const fourth = startChild("resume", directory, waiting.runId);
      children.push(fourth);
      assert.deepEqual(
        await fourth.waitFor("finished"),
        recovered,
        "another restart must not rerun completed effects",
      );
      assert.equal((await fourth.exited).code, 0);
    } finally {
      await Promise.all(children.map((child) => child.kill()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
