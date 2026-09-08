import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureIdentity,
  cleanEnvironment,
  observabilityPaths,
  ownsProcess,
  pause,
  privateDirectory,
  privateJson,
  probeHealth,
  requireDiskSpace,
  signalAndWait,
  START_ORDER,
  STOP_ORDER,
  type LaunchPlan,
  type SupervisorState,
} from "./runtime.js";

/** At most (retained + 1) files of maxBytes each, even for one oversized native chunk. */
export function rotatingLogWriter(
  path: string,
  maxBytes = 2 * 1024 * 1024,
  retained = 2,
) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 32 ||
    maxBytes > 20 * 1024 * 1024 ||
    !Number.isInteger(retained) ||
    retained < 1 ||
    retained > 5
  )
    throw new Error("Niepoprawny limit logów.");
  const check = (file: string) => {
    if (
      existsSync(file) &&
      (!lstatSync(file).isFile() ||
        lstatSync(file).isSymbolicLink() ||
        lstatSync(file).nlink !== 1)
    )
      throw new Error("Log nie może być dowiązaniem ani katalogiem.");
  };
  return (chunk: Buffer | string) => {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length > maxBytes)
      bytes = bytes.subarray(bytes.length - maxBytes);
    check(path);
    const size = existsSync(path) ? lstatSync(path).size : 0;
    if (size + bytes.length > maxBytes) {
      for (let i = 1; i <= retained; i++) check(`${path}.${i}`);
      rmSync(`${path}.${retained}`, { force: true });
      for (let i = retained - 1; i >= 1; i--)
        if (existsSync(`${path}.${i}`))
          renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      if (existsSync(path)) renameSync(path, `${path}.1`);
    }
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1)
        throw new Error("Log nie może być dowiązaniem ani katalogiem.");
      fchmodSync(fd, 0o600);
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  };
}

export async function supervise(planPath: string, expectedNonce: string) {
  process.umask(0o077);
  if (
    !/^[a-f0-9]{64}$/.test(expectedNonce) ||
    process.env.JARVIS_OBSERVABILITY_NONCE !== expectedNonce ||
    lstatSync(planPath).isSymbolicLink()
  )
    throw new Error("Niepoprawna tożsamość supervisora.");
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as LaunchPlan;
  const paths = observabilityPaths(plan.projectDir, plan.mode);
  if (
    plan.formatVersion !== 1 ||
    resolve(planPath) !== paths.plan ||
    plan.root !== paths.root ||
    plan.nonce !== expectedNonce ||
    plan.services.length !== 5 ||
    plan.services.some((service, index) => service.id !== START_ORDER[index])
  )
    throw new Error("Niepoprawny plan supervisora.");
  privateDirectory(plan.projectDir, paths.logs);
  privateDirectory(plan.projectDir, join(paths.root, "tmp"));
  const identity = captureIdentity(process.pid, plan.nonce);
  if (!identity)
    throw new Error("Nie udało się odczytać tożsamości supervisora.");
  const now = new Date().toISOString();
  const state: SupervisorState = {
    formatVersion: 1,
    projectDir: plan.projectDir,
    mode: plan.mode,
    nonce: plan.nonce,
    status: "starting",
    supervisor: identity,
    services: [],
    startedAt: now,
    updatedAt: now,
  };
  const writeState = () => {
    state.updatedAt = new Date().toISOString();
    privateJson(paths.state, state);
  };
  writeState();
  const supervisorLog = rotatingLogWriter(
    join(paths.logs, "supervisor.log"),
    plan.logMaxBytes,
    plan.logRetained,
  );
  const children = new Map<string, ChildProcess>();
  let stopping: Promise<void> | undefined;
  let failed = false;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const safeLog = (event: string, id?: string) => {
    try {
      supervisorLog(
        JSON.stringify({
          time: new Date().toISOString(),
          event,
          ...(id ? { component: id } : {}),
        }) + "\n",
      );
    } catch {
      /* Disk errors must not prevent cleanup. */
    }
  };
  async function stop(errorCode?: string) {
    if (stopping) return stopping;
    if (errorCode) {
      failed = true;
      state.errorCode = errorCode;
    }
    stopping = (async () => {
      if (monitor) clearInterval(monitor);
      state.status = "stopping";
      try {
        writeState();
      } catch {
        /* Continue stopping if disk is full. */
      }
      safeLog("stack.stopping");
      for (const id of STOP_ORDER) {
        const service = state.services.find((item) => item.id === id);
        if (service) {
          try {
            if (!(await signalAndWait(service, plan.stopTimeoutMs))) {
              failed = true;
              state.errorCode = "process_identity_changed";
            }
          } catch {
            failed = true;
            state.errorCode = "process_stop_failed";
          }
        }
      }
      state.status = failed ? "failed" : "stopped";
      try {
        writeState();
      } catch {
        /* There is no unbounded logging fallback. */
      }
      safeLog(failed ? "stack.failed" : "stack.stopped");
      process.exitCode = failed ? 1 : 0;
    })();
    return stopping;
  }
  const onSignal = () => {
    void stop();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    for (const service of plan.services) {
      if (stopping) break;
      requireDiskSpace(paths.root, plan.minimumFreeBytes);
      const child = spawn(service.executable, service.args, {
        cwd: service.cwd,
        env: cleanEnvironment(paths.root, plan.nonce, service.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.set(service.id, child);
      const write = rotatingLogWriter(
        join(paths.logs, `${service.id}.log`),
        plan.logMaxBytes,
        plan.logRetained,
      );
      const output = (chunk: Buffer) => {
        try {
          write(chunk);
        } catch {
          void stop("log_storage_failed");
        }
      };
      child.stdout!.on("data", output);
      child.stderr!.on("data", output);
      child.on("exit", () => {
        safeLog("component.exited", service.id);
        if (!stopping) void stop("component_exited");
      });
      await new Promise<void>((done, reject) => {
        child.once("spawn", done);
        child.once("error", () => reject(new Error("component_spawn_failed")));
      });
      if (plan.spawnRecordDelayMs)
        await pause(Math.min(5000, Math.max(0, plan.spawnRecordDelayMs)));
      let owned = captureIdentity(child.pid!, plan.nonce);
      for (let i = 0; i < 20 && !owned && child.exitCode === null; i++) {
        await pause(25);
        owned = captureIdentity(child.pid!, plan.nonce);
      }
      if (!owned) throw new Error("component_identity_unavailable");
      state.services.push({
        ...owned,
        id: service.id,
        executable: service.executable,
        healthUrl: service.healthUrl,
        ports: service.ports,
      });
      writeState();
      // A stop may arrive between spawning and recording the child. Always finish its cleanup.
      if (stopping) {
        await signalAndWait(owned, plan.stopTimeoutMs);
        break;
      }
      const deadline = Date.now() + plan.startupTimeoutMs;
      let healthy = false;
      while (!stopping && Date.now() < deadline) {
        if (child.exitCode !== null || !ownsProcess(owned))
          throw new Error("component_exited");
        if (await probeHealth(service.healthUrl)) {
          healthy = true;
          break;
        }
        await pause(120);
      }
      if (stopping) break;
      if (!healthy) throw new Error("component_start_timeout");
      safeLog("component.ready", service.id);
    }
    if (!stopping) {
      state.status = "ready";
      writeState();
      safeLog("stack.ready");
      monitor = setInterval(() => {
        try {
          requireDiskSpace(paths.root, plan.minimumFreeBytes);
        } catch {
          void stop("disk_space_low");
        }
      }, 5000);
      // Child pipes and this interval keep the supervisor alive until a signal or child failure.
      await new Promise<void>((done) => {
        const timer = setInterval(() => {
          if (stopping) {
            clearInterval(timer);
            void stopping.then(done);
          }
        }, 100);
      });
    } else await stopping;
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "startup_failed";
    await stop(code);
  } finally {
    if (monitor) clearInterval(monitor);
    for (const child of children.values()) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, planPath, nonce] = process.argv.slice(2);
  if (
    process.argv[2] !== "--supervise" ||
    !planPath ||
    !nonce ||
    process.argv.length !== 5
  )
    process.exitCode = 1;
  else
    await supervise(planPath, nonce).catch(() => {
      process.stderr.write(
        "Nie udało się uruchomić lokalnego supervisora obserwowalności.\n",
      );
      process.exitCode = 1;
    });
}
