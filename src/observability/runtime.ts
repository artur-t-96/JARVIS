import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDataLock } from "../backup.js";
import type {
  ComponentId,
  ObservabilityMode,
  PreparedConfiguration,
} from "./contracts.js";

export const START_ORDER: readonly ComponentId[] = [
  "prometheus",
  "loki",
  "jaeger",
  "collector",
  "grafana",
];
export const STOP_ORDER: readonly ComponentId[] = [
  "grafana",
  "collector",
  "jaeger",
  "loki",
  "prometheus",
];
export interface ProcessIdentity {
  pid: number;
  command: string;
  started: string;
  nonce: string;
}
export interface ManagedService extends ProcessIdentity {
  id: ComponentId;
  executable: string;
  healthUrl: string;
  ports: number[];
}
export interface SupervisorState {
  formatVersion: 1;
  projectDir: string;
  mode: ObservabilityMode;
  nonce: string;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  supervisor: ProcessIdentity;
  services: ManagedService[];
  startedAt: string;
  updatedAt: string;
  errorCode?: string;
}
export interface LaunchService {
  id: ComponentId;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  healthUrl: string;
  ports: number[];
}
export interface LaunchPlan {
  formatVersion: 1;
  projectDir: string;
  root: string;
  mode: ObservabilityMode;
  nonce: string;
  services: LaunchService[];
  minimumFreeBytes: number;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
  logMaxBytes: number;
  logRetained: number;
  /** Deterministic crash-window fixture, never selected by CLI or environment. */
  spawnRecordDelayMs?: number;
}
interface RuntimeOptions {
  prepare?: (options: {
    projectDir: string;
    mode: ObservabilityMode;
  }) => PreparedConfiguration | Promise<PreparedConfiguration>;
  resolveComponent?: (
    projectDir: string,
    id: ComponentId,
  ) => { executable: string; home: string; version: string };
  supervisorPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  minimumFreeBytes?: number;
  logMaxBytes?: number;
  logRetained?: number;
  spawnRecordDelayMs?: number;
}
export const pause = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));
export function observabilityPaths(
  projectDir: string,
  mode: ObservabilityMode,
) {
  if (mode !== "lab" && mode !== "operational")
    throw new Error("Wybierz jawnie tryb lab albo operational.");
  const root = join(resolve(projectDir), ".data", "observability", mode);
  return {
    root,
    state: join(root, "runtime.json"),
    plan: join(root, "launch.json"),
    logs: join(root, "logs"),
    control: join(root, "control"),
  };
}
export function privateDirectory(projectDir: string, directory: string) {
  const root = realpathSync(projectDir);
  const target = resolve(directory);
  if (target !== root && !target.startsWith(root + sep))
    throw new Error("Ścieżka wykracza poza ten projekt JARVIS.");
  let current = root;
  for (const part of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Katalog obserwowalności nie może być dowiązaniem.");
  }
}
export function privateJson(path: string, value: unknown) {
  const temporary = `${path}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}
// Process start dates must not depend on the invoking shell or supervisor timezone.
function ps(pid: number, column: string): string | null {
  try {
    return (
      execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", `${column}=`], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
      }).trim() || null
    );
  } catch {
    return null;
  }
}
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return ps(pid, "stat")?.startsWith("Z") !== true;
  } catch {
    return false;
  }
}
export function captureIdentity(
  pid: number,
  nonce: string,
): ProcessIdentity | null {
  const command = ps(pid, "command");
  const started = ps(pid, "lstart");
  return command && started ? { pid, nonce, command, started } : null;
}
function hasNonce(pid: number, nonce: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(nonce)) return false;
  try {
    if (process.platform === "linux")
      return readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .includes(`JARVIS_OBSERVABILITY_NONCE=${nonce}`);
    if (process.platform === "darwin") {
      const environment = execFileSync(
        "/bin/ps",
        ["eww", "-p", String(pid), "-o", "command="],
        {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 512 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
        },
      );
      return new RegExp(
        `(?:^|\\s)JARVIS_OBSERVABILITY_NONCE=${nonce}(?:\\s|$)`,
      ).test(environment);
    }
  } catch {
    /* Never log another process's environment. */
  }
  return false;
}
export function ownsProcess(identity: ProcessIdentity): boolean {
  if (!identity || !processAlive(identity.pid)) return false;
  const current = captureIdentity(identity.pid, identity.nonce);
  return (
    !!current &&
    current.command === identity.command &&
    current.started === identity.started &&
    hasNonce(identity.pid, identity.nonce)
  );
}
export function cleanEnvironment(
  root: string,
  nonce: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(extra))
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "JARVIS_OBSERVABILITY_NONCE",
      ].includes(key)
    )
      throw new Error("Niedozwolona konfiguracja środowiska usługi.");
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "C.UTF-8",
    TZ: "UTC",
    TMPDIR: join(root, "tmp"),
    ...extra,
    JARVIS_OBSERVABILITY_NONCE: nonce,
  };
}
export function requireDiskSpace(root: string, minimum: number) {
  const stat = statfsSync(root);
  const free = stat.bavail * stat.bsize;
  if (free < minimum)
    throw new Error("Za mało wolnego miejsca na lokalną obserwowalność.");
  return free;
}
export async function assertPortsFree(ports: number[]) {
  const reservations: ReturnType<typeof createServer>[] = [];
  try {
    for (const port of ports) {
      const server = createServer();
      reservations.push(server);
      await new Promise<void>((done, reject) => {
        server.once("error", () =>
          reject(
            new Error(
              `Port loopback ${port} jest zajęty. Nie zatrzymano żadnego obcego procesu.`,
            ),
          ),
        );
        server.listen({ host: "127.0.0.1", port, exclusive: true }, done);
      });
    }
  } finally {
    await Promise.all(
      reservations.map(
        (server) => new Promise<void>((done) => server.close(() => done())),
      ),
    );
  }
}
export async function probeHealth(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
      return false;
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
export function readState(
  projectDir: string,
  mode: ObservabilityMode,
): SupervisorState | null {
  const path = observabilityPaths(projectDir, mode).state;
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink())
    throw new Error("Stan procesów nie może być dowiązaniem.");
  const state = JSON.parse(readFileSync(path, "utf8")) as SupervisorState;
  const validIdentity = (value: ProcessIdentity) =>
    value &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    typeof value.command === "string" &&
    typeof value.started === "string" &&
    value.nonce === state.nonce;
  if (
    state.formatVersion !== 1 ||
    state.projectDir !== realpathSync(projectDir) ||
    state.mode !== mode ||
    !/^[a-f0-9]{64}$/.test(state.nonce) ||
    !["starting", "ready", "stopping", "stopped", "failed"].includes(
      state.status,
    ) ||
    !validIdentity(state.supervisor) ||
    !Array.isArray(state.services) ||
    state.services.length > 5 ||
    new Set(state.services.map((s) => s.id)).size !== state.services.length ||
    state.services.some((s) => !START_ORDER.includes(s.id) || !validIdentity(s))
  )
    throw new Error(
      "Stan obserwowalności jest niespójny. Nie wysłano sygnału do procesów.",
    );
  return state;
}

/** Recover a child whose supervisor died after spawn but before its PID receipt. */
export function recoverServices(state: SupervisorState): ManagedService[] {
  const paths = observabilityPaths(state.projectDir, state.mode);
  const file = lstatSync(paths.plan);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)
    throw new Error("Plan odzyskiwania musi być zwykłym prywatnym plikiem.");
  const plan = JSON.parse(readFileSync(paths.plan, "utf8")) as LaunchPlan;
  if (
    plan.formatVersion !== 1 ||
    plan.projectDir !== state.projectDir ||
    plan.root !== paths.root ||
    plan.mode !== state.mode ||
    plan.nonce !== state.nonce ||
    !Array.isArray(plan.services) ||
    plan.services.length !== START_ORDER.length ||
    plan.services.some(
      (service, index) =>
        service.id !== START_ORDER[index] ||
        typeof service.executable !== "string" ||
        !isAbsolute(service.executable) ||
        /[\r\n\0]/.test(service.executable) ||
        !Array.isArray(service.args) ||
        service.args.some(
          (arg) => typeof arg !== "string" || /[\r\n\0]/.test(arg),
        ),
    )
  )
    throw new Error("Plan odzyskiwania nie odpowiada temu uruchomieniu.");
  // Inspect command lines first. Read an environment only for an exact closed-plan
  // candidate; never emit command inventories or any process environment.
  const inventory = execFileSync(
    "/bin/ps",
    ["-axww", "-o", "pid=", "-o", "command="],
    {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
    },
  );
  const recovered = [...state.services];
  const commands = new Map(
    plan.services.map((service) => [
      [service.executable, ...service.args].join(" "),
      service,
    ]),
  );
  for (const line of inventory.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const service = commands.get(match[2]!);
    if (!service) continue;
    const identity = captureIdentity(Number(match[1]), state.nonce);
    if (!identity || identity.command !== match[2] || !ownsProcess(identity))
      continue;
    const index = recovered.findIndex((item) => item.id === service.id);
    if (index >= 0) {
      if (recovered[index]!.pid === identity.pid) continue;
      if (processAlive(recovered[index]!.pid))
        throw new Error(
          "Niejednoznaczne procesy komponentu; nie wysłano sygnału.",
        );
    }
    const item: ManagedService = {
      ...identity,
      id: service.id,
      executable: service.executable,
      healthUrl: service.healthUrl,
      ports: service.ports,
    };
    if (index >= 0) recovered[index] = item;
    else recovered.push(item);
  }
  return recovered;
}
export async function signalAndWait(
  identity: ProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  // During exit, /proc/environ or the command can disappear before the PID is
  // reported dead/zombie. Once ownership is uncertain, only observe: never
  // signal that PID again. A reused live PID still returns false.
  const waitForExitOnly = async () => {
    for (let index = 0; index < 20; index++) {
      if (!processAlive(identity.pid)) return true;
      await pause(25);
    }
    return !processAlive(identity.pid);
  };
  if (!processAlive(identity.pid)) return true;
  if (!ownsProcess(identity)) return waitForExitOnly();
  try {
    process.kill(identity.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && ownsProcess(identity)) await pause(80);
  if (!processAlive(identity.pid)) return true;
  if (!ownsProcess(identity)) return waitForExitOnly();
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  for (let index = 0; index < 30 && ownsProcess(identity); index++)
    await pause(50);
  return waitForExitOnly();
}

export class ObservabilityRuntime {
  readonly projectDir: string;
  constructor(
    projectDir: string,
    private readonly options: RuntimeOptions = {},
  ) {
    this.projectDir = realpathSync(projectDir);
    if (
      JSON.parse(readFileSync(join(this.projectDir, "package.json"), "utf8"))
        .name !== "jarvis-core"
    )
      throw new Error("Launcher działa wyłącznie we własnym projekcie JARVIS.");
    if (!["darwin", "linux"].includes(process.platform))
      throw new Error("Ten launcher wymaga macOS albo Linux.");
  }
  private controlLock() {
    const control = join(this.projectDir, ".data", "observability", "control");
    privateDirectory(this.projectDir, control);
    return acquireDataLock(control, "maintenance");
  }
  async install() {
    const lock = this.controlLock();
    try {
      for (const mode of ["lab", "operational"] as const) {
        const state = readState(this.projectDir, mode);
        if (
          state &&
          [state.supervisor, ...recoverServices(state)].some((item) =>
            processAlive(item.pid),
          )
        )
          throw new Error(
            "Przed instalacją zatrzymaj oba tryby obserwowalności.",
          );
      }
      return await (
        await import("./installer.js")
      ).installComponents(this.projectDir);
    } finally {
      lock.release();
    }
  }
  async start(mode: ObservabilityMode) {
    const paths = observabilityPaths(this.projectDir, mode);
    privateDirectory(this.projectDir, paths.control);
    const lock = this.controlLock();
    let started: ProcessIdentity | null = null;
    let nonce = "";
    try {
      const existing = readState(this.projectDir, mode);
      if (
        existing &&
        [existing.supervisor, ...recoverServices(existing)].some((item) =>
          processAlive(item.pid),
        )
      ) {
        if (
          existing.status === "ready" &&
          ownsProcess(existing.supervisor) &&
          existing.services.length === 5 &&
          existing.services.every(ownsProcess)
        )
          return await this.status(mode);
        throw new Error(
          "Tryb ma aktywne lub nierozpoznane procesy. Użyj stop i doctor; nie uruchomiono duplikatu.",
        );
      }
      const resolveComponent =
        this.options.resolveComponent ??
        (await import("./installer.js")).getInstalledComponent;
      const installed = new Map(
        START_ORDER.map((id) => [id, resolveComponent(this.projectDir, id)]),
      );
      const prepare =
        this.options.prepare ??
        (await import("./config.js")).prepareConfiguration;
      const configuration: PreparedConfiguration = await prepare({
        projectDir: this.projectDir,
        mode,
      });
      if (resolve(configuration.root) !== paths.root)
        throw new Error("Konfiguracja wskazuje katalog innego trybu.");
      privateDirectory(this.projectDir, paths.logs);
      privateDirectory(this.projectDir, join(paths.root, "tmp"));
      const minimumFreeBytes = this.options.minimumFreeBytes ?? 2 * 1024 ** 3;
      requireDiskSpace(paths.root, minimumFreeBytes);
      const services: LaunchService[] = START_ORDER.map((id) => {
        const matches = configuration.services.filter(
          (service) => service.id === id,
        );
        if (matches.length !== 1)
          throw new Error(
            "Konfiguracja wymaga dokładnie pięciu zamkniętych komponentów.",
          );
        const service = matches[0]!;
        const component = installed.get(id)!;
        if (
          !Array.isArray(service.args) ||
          service.args.some(
            (arg) => typeof arg !== "string" || arg.includes("\0"),
          )
        )
          throw new Error("Niepoprawne argumenty usługi.");
        const url = new URL(service.healthUrl);
        const base = mode === "lab" ? 15300 : 15400;
        if (
          !service.ports.length ||
          service.ports.some(
            (port) =>
              !Number.isInteger(port) || port < base || port > base + 14,
          ) ||
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" ||
          !service.ports.includes(Number(url.port))
        )
          throw new Error(
            "Porty i healthcheck muszą należeć do loopback wybranego trybu.",
          );
        const cwd = realpathSync(service.cwd);
        if (
          !cwd.startsWith(paths.root + sep) &&
          cwd !== paths.root &&
          !cwd.startsWith(
            join(this.projectDir, ".data", "observability", "bin") + sep,
          )
        )
          throw new Error(
            "Katalog roboczy usługi wykracza poza lokalną obserwowalność.",
          );
        return {
          ...service,
          executable: realpathSync(component.executable),
          cwd,
        };
      });
      if (configuration.services.length !== 5)
        throw new Error("Nieznany dodatkowy komponent w konfiguracji.");
      const ports = services.flatMap((service) => service.ports);
      if (new Set(ports).size !== ports.length)
        throw new Error("Komponenty mają kolidujące porty.");
      await assertPortsFree(ports);
      nonce = randomBytes(32).toString("hex");
      const plan: LaunchPlan = {
        formatVersion: 1,
        projectDir: this.projectDir,
        root: paths.root,
        mode,
        nonce,
        services,
        minimumFreeBytes,
        startupTimeoutMs: this.options.startupTimeoutMs ?? 45_000,
        stopTimeoutMs: this.options.stopTimeoutMs ?? 8000,
        logMaxBytes: this.options.logMaxBytes ?? 2 * 1024 * 1024,
        logRetained: this.options.logRetained ?? 2,
        ...(this.options.spawnRecordDelayMs
          ? { spawnRecordDelayMs: this.options.spawnRecordDelayMs }
          : {}),
      };
      services.forEach((service) =>
        cleanEnvironment(paths.root, nonce, service.env),
      );
      privateJson(paths.plan, plan);
      const defaultScript = fileURLToPath(
        new URL("./supervisor.js", import.meta.url),
      );
      const script =
        this.options.supervisorPath ??
        (existsSync(defaultScript)
          ? defaultScript
          : defaultScript.replace(/\.js$/, ".ts"));
      const args = [
        ...(script.endsWith(".ts")
          ? ["--import", createRequire(import.meta.url).resolve("tsx")]
          : []),
        script,
        "--supervise",
        paths.plan,
        nonce,
      ];
      const child = spawn(process.execPath, args, {
        cwd: this.projectDir,
        env: cleanEnvironment(paths.root, nonce),
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((done, reject) => {
        child.once("spawn", done);
        child.once("error", () =>
          reject(new Error("Nie udało się uruchomić supervisora.")),
        );
      });
      for (let index = 0; index < 20 && !started; index++) {
        started = captureIdentity(child.pid!, nonce);
        if (!started) await pause(25);
      }
      child.unref();
      const deadline = Date.now() + plan.startupTimeoutMs * 5 + 3000;
      while (Date.now() < deadline) {
        const state = readState(this.projectDir, mode);
        if (state?.nonce === nonce && state.status === "ready") {
          const result = await this.status(mode);
          if (!result.ready)
            throw new Error(
              "Nie można potwierdzić tożsamości lub gotowości uruchomionych komponentów.",
            );
          return result;
        }
        if (
          state?.nonce === nonce &&
          ["failed", "stopped"].includes(state.status)
        )
          throw new Error(
            `Uruchomienie przerwane (${state.errorCode ?? "startup_failed"}). Sprawdź prywatne logi komponentów.`,
          );
        if (!processAlive(child.pid!))
          throw new Error(
            "Supervisor zakończył się podczas uruchamiania. Sprawdź konfigurację.",
          );
        await pause(100);
      }
      throw new Error("Upłynął limit uruchomienia obserwowalności.");
    } catch (error) {
      if (started && ownsProcess(started))
        await signalAndWait(
          started,
          (this.options.stopTimeoutMs ?? 8000) * 5 + 1000,
        );
      const state = readState(this.projectDir, mode);
      if (nonce && state?.nonce === nonce) {
        const services = recoverServices(state);
        for (const id of STOP_ORDER) {
          const service = services.find((s) => s.id === id);
          if (service)
            await signalAndWait(service, this.options.stopTimeoutMs ?? 8000);
        }
      }
      throw error;
    } finally {
      lock.release();
    }
  }
  async stop(mode: ObservabilityMode) {
    const paths = observabilityPaths(this.projectDir, mode);
    privateDirectory(this.projectDir, paths.control);
    const lock = this.controlLock();
    try {
      const state = readState(this.projectDir, mode);
      if (!state) return { mode, stopped: true, status: "not_started" };
      if (processAlive(state.supervisor.pid)) {
        if (!ownsProcess(state.supervisor))
          throw new Error(
            "Tożsamość PID supervisora nie zgadza się. Nie wysłano sygnału.",
          );
        await signalAndWait(
          state.supervisor,
          (this.options.stopTimeoutMs ?? 8000) * 5 + 2000,
        );
      }
      const services = recoverServices(state);
      let foreign = false;
      for (const id of STOP_ORDER) {
        const service = services.find((s) => s.id === id);
        if (
          service &&
          !(await signalAndWait(service, this.options.stopTimeoutMs ?? 8000))
        )
          foreign = true;
      }
      if (foreign)
        throw new Error(
          "Nie można potwierdzić tożsamości części PID. Obce procesy pozostały nietknięte.",
        );
      privateJson(paths.state, {
        ...state,
        services,
        status: "stopped",
        updatedAt: new Date().toISOString(),
      });
      return { mode, stopped: true, status: "stopped" };
    } finally {
      lock.release();
    }
  }
  async status(mode: ObservabilityMode) {
    const state = readState(this.projectDir, mode);
    if (!state)
      return {
        mode,
        running: false,
        ready: false,
        status: "not_started",
        services: [],
      };
    const supervisorOwned = ownsProcess(state.supervisor);
    const services = await Promise.all(
      state.services.map(async (service) => {
        const owned = ownsProcess(service);
        return {
          id: service.id,
          pid: service.pid,
          owned,
          healthy: owned && (await probeHealth(service.healthUrl)),
          ports: service.ports,
        };
      }),
    );
    return {
      mode,
      running: supervisorOwned,
      ready:
        supervisorOwned &&
        state.status === "ready" &&
        services.length === 5 &&
        services.every((s) => s.owned && s.healthy),
      status: state.status,
      ...(state.errorCode ? { errorCode: state.errorCode } : {}),
      supervisorPid: state.supervisor.pid,
      services,
      logs: observabilityPaths(this.projectDir, mode).logs,
    };
  }
  async doctor(mode: ObservabilityMode) {
    const paths = observabilityPaths(this.projectDir, mode);
    const resolveComponent =
      this.options.resolveComponent ??
      (await import("./installer.js")).getInstalledComponent;
    const installed = START_ORDER.map((id) => {
      try {
        const result = resolveComponent(this.projectDir, id);
        return { id, integrity: "verified", version: result.version };
      } catch {
        return { id, integrity: "missing_or_changed" };
      }
    });
    let freeBytes: number | null = null;
    try {
      freeBytes = requireDiskSpace(
        existsSync(paths.root) ? paths.root : this.projectDir,
        0,
      );
    } catch {
      /* Read-only diagnostics. */
    }
    return {
      ...(await this.status(mode)),
      installed,
      disk: {
        freeBytes,
        minimumFreeBytes: this.options.minimumFreeBytes ?? 2 * 1024 ** 3,
      },
      logRetention: {
        bytesPerFile: this.options.logMaxBytes ?? 2 * 1024 * 1024,
        rotatedFiles: this.options.logRetained ?? 2,
      },
      notice:
        "Tylko odczyt. Dane dostępowe pozostają w prywatnych plikach konfiguracji.",
    };
  }
}
