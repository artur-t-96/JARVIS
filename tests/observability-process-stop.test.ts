import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  captureIdentity,
  cleanEnvironment,
  pause,
  processAlive,
  signalAndWait,
} from "../src/observability/runtime.js";

async function child() {
  const nonce = randomBytes(32).toString("hex");
  const processHandle = spawn(
    process.execPath,
    [
      "-e",
      `
    process.on('SIGTERM', () => {
      process.title = 'jarvis-fixture-exiting';
      setTimeout(() => process.exit(0), 250);
    });
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `,
    ],
    {
      env: cleanEnvironment(tmpdir(), nonce),
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    processHandle.once("error", reject);
    processHandle.stdout.once("data", () => resolve());
    processHandle.once("exit", () =>
      reject(new Error("Fixture ended before ready")),
    );
  });
  const identity = captureIdentity(processHandle.pid!, nonce)!;
  assert.ok(identity);
  return { processHandle, identity };
}

test("stop observes exit after command identity disappears without signalling the uncertain PID again", async () => {
  const { processHandle, identity } = await child();
  try {
    assert.equal(await signalAndWait(identity, 1000), true);
    assert.equal(processAlive(identity.pid), false);
    // The handler changed its command and exited normally; no SIGKILL was sent.
    for (let i = 0; i < 20 && processHandle.exitCode === null; i++)
      await pause(10);
    assert.equal(processHandle.exitCode, 0);
    assert.equal(processHandle.signalCode, null);
  } finally {
    if (processAlive(identity.pid)) processHandle.kill("SIGKILL");
  }
});

test("an uncertain live identity stays untouched while stop reports failure", async () => {
  const { processHandle, identity } = await child();
  try {
    assert.equal(
      await signalAndWait(
        { ...identity, command: identity.command + " foreign" },
        1000,
      ),
      false,
    );
    assert.equal(processAlive(identity.pid), true);
    assert.equal(processHandle.exitCode, null);
    assert.equal(
      captureIdentity(identity.pid, identity.nonce)?.command,
      identity.command,
    );
  } finally {
    processHandle.kill("SIGKILL");
  }
});
