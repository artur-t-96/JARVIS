import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  captureIdentity,
  cleanEnvironment,
  observabilityPaths,
  ObservabilityRuntime,
  ownsProcess,
  pause,
  privateJson,
  processAlive,
  recoverServices,
  readState,
  START_ORDER,
  type SupervisorState,
} from "../src/observability/runtime.js";
import { acquireDataLock } from "../src/backup.js";
import { rotatingLogWriter } from "../src/observability/supervisor.js";
import type {
  ComponentId,
  ObservabilityMode,
  PreparedConfiguration,
} from "../src/observability/contracts.js";

const supervisorPath = fileURLToPath(
  new URL("../src/observability/supervisor.ts", import.meta.url),
);
function fixture(
  options: {
    failure?: ComponentId;
    collision?: boolean;
    integrityFailure?: boolean;
    minimumFreeBytes?: number;
  } = {},
) {
  const projectDir = realpathSync(
    mkdtempSync(join(tmpdir(), "jarvis-obs-runtime-")),
  );
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "jarvis-core", type: "module" }),
  );
  const executableScript = join(projectDir, "fixture.mjs");
  writeFileSync(
    executableScript,
    `import{createServer}from'node:http';import{appendFileSync,writeFileSync}from'node:fs';const[id,port,record,fail]=process.argv.slice(2);if(process.env.ANTHROPIC_API_KEY||process.env.GITHUB_TOKEN)process.exit(91);if(fail==='yes')process.exit(92);appendFileSync(record,'start:'+id+'\\n');writeFileSync(record+'.'+id+'.pid',String(process.pid));writeFileSync(record+'.'+id+'.env',JSON.stringify(Object.keys(process.env)));const server=createServer((req,res)=>{res.end('ok');});server.listen(Number(port),'127.0.0.1');process.on('SIGTERM',()=>{appendFileSync(record,'stop:'+id+'\\n');server.close(()=>process.exit(0));});`,
  );
  const prepare = ({
    mode,
  }: {
    projectDir: string;
    mode: ObservabilityMode;
  }): PreparedConfiguration => {
    const root = observabilityPaths(projectDir, mode).root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const base = mode === "lab" ? 15300 : 15400;
    return {
      root,
      ports: {} as PreparedConfiguration["ports"],
      grafanaCredentialPath: join(root, "password"),
      services: START_ORDER.map((id, index) => {
        const port = base + (options.collision ? 0 : index);
        return {
          id,
          args: [
            executableScript,
            id,
            String(port),
            join(root, "order.log"),
            options.failure === id ? "yes" : "no",
          ],
          cwd: root,
          env: {},
          healthUrl: `http://127.0.0.1:${port}/health`,
          ports: [port],
        };
      }),
    };
  };
  const runtime = new ObservabilityRuntime(projectDir, {
    prepare,
    supervisorPath,
    startupTimeoutMs: 2500,
    stopTimeoutMs: 1000,
    minimumFreeBytes: options.minimumFreeBytes ?? 0,
    logMaxBytes: 256,
    resolveComponent: () => {
      if (options.integrityFailure) throw new Error("checksum failed");
      return {
        executable: process.execPath,
        home: dirname(process.execPath),
        version: "fixture",
      };
    },
  });
  return {
    projectDir,
    runtime,
    prepare,
    async cleanup() {
      for (const mode of ["lab", "operational"] as const) {
        try {
          await runtime.stop(mode);
        } catch {
          /* Tests asserting ownership never signal foreign PIDs. */
        }
      }
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

test("observability owns five fixture processes, separates modes, restarts and flushes collector before backends", async () => {
  const ctx = fixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-be-inherited";
  try {
    const started = await ctx.runtime.start("lab");
    assert.equal(started.ready, true, JSON.stringify(started));
    assert.equal(started.services.length, 5);
    const first = readState(ctx.projectDir, "lab")!;
    assert.ok(ownsProcess(first.supervisor));
    assert.ok(first.services.every(ownsProcess));
    const duplicate = await ctx.runtime.start("lab");
    assert.equal(duplicate.supervisorPid, first.supervisor.pid);
    const operational = await ctx.runtime.start("operational");
    assert.equal(operational.ready, true);
    assert.notEqual(operational.supervisorPid, first.supervisor.pid);
    const root = observabilityPaths(ctx.projectDir, "lab").root;
    writeFileSync(join(root, "persistent-test-record"), "keep");
    const keys = JSON.parse(
      readFileSync(join(root, "order.log.collector.env"), "utf8"),
    ) as string[];
    assert.ok(keys.includes("JARVIS_OBSERVABILITY_NONCE"));
    assert.ok(!keys.includes("ANTHROPIC_API_KEY"));
    assert.ok(!keys.includes("GITHUB_TOKEN"));
    await ctx.runtime.stop("lab");
    assert.equal((await ctx.runtime.status("lab")).running, false);
    assert.equal((await ctx.runtime.status("operational")).ready, true);
    const events = readFileSync(join(root, "order.log"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(
      events.slice(0, 5),
      START_ORDER.map((id) => `start:${id}`),
    );
    assert.ok(events.indexOf("stop:collector") < events.indexOf("stop:jaeger"));
    assert.ok(events.indexOf("stop:collector") < events.indexOf("stop:loki"));
    assert.ok(
      events.indexOf("stop:collector") < events.indexOf("stop:prometheus"),
    );
    const restarted = await ctx.runtime.start("lab");
    assert.equal(restarted.ready, true);
    assert.notEqual(restarted.supervisorPid, first.supervisor.pid);
    assert.equal(
      readFileSync(join(root, "persistent-test-record"), "utf8"),
      "keep",
    );
    const doctor = await ctx.runtime.doctor("lab");
    assert.ok(doctor.installed.every((item) => item.integrity === "verified"));
    assert.ok(!JSON.stringify(doctor).includes("must-not-be-inherited"));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    await ctx.cleanup();
  }
});

test("occupied ports, invalid configuration and failed integrity launch no processes", async () => {
  const ctx = fixture();
  const server = createServer();
  try {
    await new Promise<void>((done) => server.listen(15302, "127.0.0.1", done));
    await assert.rejects(ctx.runtime.start("lab"), /15302.*zajęty/);
    assert.equal(readState(ctx.projectDir, "lab"), null);
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await ctx.cleanup();
  }
  const collision = fixture({ collision: true });
  try {
    await assert.rejects(collision.runtime.start("lab"), /kolidujące/);
    assert.equal(readState(collision.projectDir, "lab"), null);
  } finally {
    await collision.cleanup();
  }
  const corrupt = fixture({ integrityFailure: true });
  try {
    await assert.rejects(corrupt.runtime.start("lab"), /checksum/);
    assert.equal(readState(corrupt.projectDir, "lab"), null);
  } finally {
    await corrupt.cleanup();
  }
});

test("partial start cleans only its own children and preserves a separate mode", async () => {
  const ctx = fixture({ failure: "collector" });
  const foreign = createServer();
  try {
    await new Promise<void>((done) => foreign.listen(15413, "127.0.0.1", done));
    await assert.rejects(ctx.runtime.start("lab"), /przerwane|zakończył/);
    const state = readState(ctx.projectDir, "lab")!;
    assert.ok(state.services.length >= 3);
    assert.ok(state.services.every((service) => !processAlive(service.pid)));
    assert.equal(processAlive(state.supervisor.pid), false);
    assert.equal(foreign.listening, true);
  } finally {
    await new Promise<void>((done) => foreign.close(() => done()));
    await ctx.cleanup();
  }
});

test("mismatched nonce or arguments refuse signalling; orphaned owned children can be stopped", async () => {
  const ctx = fixture();
  const nonce = randomBytes(32).toString("hex");
  const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env: cleanEnvironment(tmpdir(), nonce),
    stdio: "ignore",
  });
  await new Promise<void>((done) => foreign.once("spawn", done));
  try {
    const identity = captureIdentity(foreign.pid!, nonce)!;
    assert.ok(ownsProcess(identity));
    assert.equal(
      ownsProcess({ ...identity, command: `${identity.command} changed` }),
      false,
    );
    const paths = observabilityPaths(ctx.projectDir, "lab");
    mkdirSync(paths.root, { recursive: true });
    const forgedNonce = "0".repeat(64);
    const forged: SupervisorState = {
      formatVersion: 1,
      mode: "lab",
      projectDir: ctx.projectDir,
      nonce: forgedNonce,
      status: "ready",
      supervisor: { ...identity, nonce: forgedNonce },
      services: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    privateJson(paths.state, forged);
    await assert.rejects(ctx.runtime.stop("lab"), /Nie wysłano sygnału/);
    assert.equal(processAlive(foreign.pid!), true);
    rmSync(paths.state);
    await ctx.runtime.start("lab");
    const state = readState(ctx.projectDir, "lab")!;
    process.kill(state.supervisor.pid, "SIGKILL");
    for (let i = 0; i < 40 && processAlive(state.supervisor.pid); i++)
      await pause(50);
    assert.equal(processAlive(state.supervisor.pid), false);
    await ctx.runtime.stop("lab");
    assert.ok(state.services.every((service) => !processAlive(service.pid)));
    assert.equal(processAlive(foreign.pid!), true);
  } finally {
    foreign.kill("SIGTERM");
    await ctx.cleanup();
  }
});

test("logs are bounded/private and reject symlinks; control paths cannot escape the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-obs-log-"));
  try {
    const path = join(root, "component.log");
    const write = rotatingLogWriter(path, 64, 2);
    for (let i = 0; i < 20; i++) write(Buffer.alloc(200, 65));
    assert.equal(readdirSync(root).length, 3);
    for (const file of readdirSync(root)) {
      const stat = lstatSync(join(root, file));
      assert.ok(stat.size <= 64);
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const target = join(root, "untouched");
    writeFileSync(target, "keep");
    const link = join(root, "bad.log");
    symlinkSync(target, link);
    assert.throws(() => rotatingLogWriter(link)("change"), /dowiązaniem/);
    assert.equal(readFileSync(target, "utf8"), "keep");
    const hardLink = join(root, "hard.log");
    const originalMode = lstatSync(target).mode;
    linkSync(target, hardLink);
    assert.throws(() => rotatingLogWriter(hardLink)("change"), /dowiązaniem/);
    assert.equal(readFileSync(target, "utf8"), "keep");
    assert.equal(lstatSync(target).mode, originalMode);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const ctx = fixture();
  const outside = mkdtempSync(join(tmpdir(), "jarvis-obs-outside-"));
  try {
    mkdirSync(join(ctx.projectDir, ".data"));
    symlinkSync(outside, join(ctx.projectDir, ".data", "observability"));
    await assert.rejects(ctx.runtime.start("lab"), /dowiązaniem/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(ctx.projectDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false);
});

test("administrative operations share a lock and insufficient disk refuses startup", async () => {
  const ctx = fixture();
  const control = join(ctx.projectDir, ".data", "observability", "control");
  mkdirSync(control, { recursive: true });
  const lock = acquireDataLock(control, "maintenance");
  try {
    await assert.rejects(ctx.runtime.start("lab"), /locked/);
    await assert.rejects(ctx.runtime.start("operational"), /locked/);
    await assert.rejects(ctx.runtime.install(), /locked/);
    await assert.rejects(ctx.runtime.stop("lab"), /locked/);
    assert.equal((await ctx.runtime.status("lab")).status, "not_started");
  } finally {
    lock.release();
    await ctx.cleanup();
  }
  const full = fixture({ minimumFreeBytes: Number.MAX_SAFE_INTEGER });
  try {
    await assert.rejects(full.runtime.start("lab"), /mało wolnego miejsca/);
    assert.equal(readState(full.projectDir, "lab"), null);
  } finally {
    await full.cleanup();
  }
});

test("stop recovers a child after supervisor and launcher SIGKILL before the PID receipt", async () => {
  const ctx = fixture();
  const configuration = ctx.prepare({
    projectDir: ctx.projectDir,
    mode: "lab",
  });
  const runtimeModule = fileURLToPath(
    new URL("../src/observability/runtime.ts", import.meta.url),
  );
  const script = `import { ObservabilityRuntime } from ${JSON.stringify(runtimeModule)};
    const runtime = new ObservabilityRuntime(${JSON.stringify(ctx.projectDir)}, {
      prepare: () => (${JSON.stringify(configuration)}),
      resolveComponent: () => ({ executable: process.execPath, home: ${JSON.stringify(dirname(process.execPath))}, version: "fixture" }),
      supervisorPath: ${JSON.stringify(supervisorPath)},
      minimumFreeBytes: 0, startupTimeoutMs: 2500, stopTimeoutMs: 1000,
      spawnRecordDelayMs: 5000,
    });
    await runtime.start("lab");`;
  const launcher = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: ctx.projectDir,
      env: cleanEnvironment(tmpdir(), randomBytes(32).toString("hex")),
      stdio: "ignore",
    },
  );
  await new Promise<void>((done) => launcher.once("spawn", done));
  let foreign: ReturnType<typeof spawn> | undefined;
  try {
    const root = observabilityPaths(ctx.projectDir, "lab").root;
    const pidFile = join(root, "order.log.prometheus.pid");
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await pause(30);
    assert.ok(
      existsSync(pidFile),
      "Fixture actually spawned before supervisor receipt",
    );
    const state = readState(ctx.projectDir, "lab")!;
    assert.equal(state.services.length, 0);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(processAlive(childPid), true);
    assert.ok(ownsProcess(state.supervisor));
    launcher.kill("SIGKILL");
    await new Promise<void>((done) => {
      if (launcher.exitCode !== null || launcher.signalCode !== null) done();
      else launcher.once("exit", () => done());
    });
    process.kill(state.supervisor.pid, "SIGKILL");
    for (let i = 0; i < 40 && processAlive(state.supervisor.pid); i++)
      await pause(30);
    assert.equal(processAlive(state.supervisor.pid), false);
    assert.equal(readState(ctx.projectDir, "lab")!.services.length, 0);
    assert.deepEqual(
      recoverServices(state).map((item) => item.pid),
      [childPid],
    );
    // A similar process with this nonce but different arguments is not part of the plan.
    foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: cleanEnvironment(tmpdir(), state.nonce),
      stdio: "ignore",
    });
    await new Promise<void>((done) => foreign!.once("spawn", done));
    await ctx.runtime.stop("lab");
    assert.equal(processAlive(childPid), false);
    assert.equal(processAlive(foreign.pid!), true);
    assert.equal(readState(ctx.projectDir, "lab")!.services[0]?.pid, childPid);
  } finally {
    launcher.kill("SIGKILL");
    foreign?.kill("SIGTERM");
    await ctx.cleanup();
  }
});
