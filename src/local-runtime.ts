import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDataLock } from "./backup.js";
import { KeychainSecrets, type LocalMode } from "./secrets.js";

export interface RuntimePaths {
  projectDir: string;
  controlDir: string;
  dataDir: string;
  statePath: string;
  logPath: string;
}
interface InstalledBuild {
  formatVersion: 1;
  gitSha: string;
  installedAt: string;
  node: string;
  files: { path: string; sha256: string }[];
}
interface RuntimeState {
  formatVersion: 1;
  pid: number;
  supervisorPid: number;
  mode: LocalMode;
  port: number;
  gitSha: string;
  startedAt: string;
  lockToken: string;
  command: string;
  provider: "disabled" | "anthropic";
}
interface RuntimeOptions {
  nodePath?: string;
  build?: (projectDir: string) => Promise<void>;
  sourceRevision?: () => string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  secrets?: (mode: LocalMode) => Pick<KeychainSecrets, "read">;
}
export function validateNodeVersion(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) !== 22 || Number(match[2]) < 23)
    throw new Error(
      "JARVIS requires Node.js 22.23 or newer within the 22.x series. Use the repository .nvmrc.",
    );
}
export function runtimePaths(
  projectDir: string,
  mode: LocalMode,
): RuntimePaths {
  if (!["lab", "operational"].includes(mode))
    throw new Error("Choose lab or operational mode.");
  const root = resolve(projectDir);
  const controlDir = join(root, ".data", "local-product");
  return {
    projectDir: root,
    controlDir,
    dataDir: join(root, ".data", mode),
    statePath: join(controlDir, `${mode}.json`),
    logPath: join(controlDir, `${mode}.log`),
  };
}
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const wait = (ms: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
function privateJson(path: string, value: unknown) {
  const temporary = `${path}.partial-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
function processCommand(pid: number): string | null {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}
function processParent(pid: number): number | null {
  try {
    return Number(
      execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return null;
  }
}
function filesIn(root: string, path = ""): string[] {
  if (lstatSync(root).isSymbolicLink())
    throw new Error("Build artifacts cannot contain symlinks.");
  return readdirSync(join(root, path))
    .sort()
    .flatMap((name) => {
      const relative = path ? `${path}/${name}` : name;
      const stat = lstatSync(join(root, relative));
      if (stat.isSymbolicLink())
        throw new Error("Build artifacts cannot contain symlinks.");
      return stat.isDirectory()
        ? filesIn(root, relative)
        : stat.isFile()
          ? [relative]
          : [];
    });
}

function buildFiles(root: string): string[] {
  return [
    "dist",
    ...(existsSync(join(root, "assets")) ? ["assets"] : []),
  ].flatMap((directory) =>
    filesIn(join(root, directory)).map((path) => `${directory}/${path}`),
  );
}

export function operationalAccountsReady(dataDir: string): boolean {
  const path = join(dataDir, "accounts.sqlite");
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT tenant_id,roles FROM users WHERE disabled=0")
      .all();
    const actors = new Map<string, Set<string>>();
    for (const row of rows) {
      const roles = JSON.parse(String(row.roles)) as string[];
      const current = actors.get(String(row.tenant_id)) ?? new Set<string>();
      for (const role of roles) current.add(role);
      actors.set(String(row.tenant_id), current);
    }
    return [...actors.values()].some(
      (roles) => roles.has("operator") && roles.has("approver"),
    );
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Host-native process manager scoped to this JARVIS checkout; never changes another repository. */
export class LocalRuntime {
  readonly projectDir: string;
  private readonly nodePath: string;
  private readonly controlDir: string;
  private readonly manifestPath: string;
  constructor(
    projectDir: string,
    private readonly options: RuntimeOptions = {},
  ) {
    this.projectDir = realpathSync(projectDir);
    const pkg = JSON.parse(
      readFileSync(join(this.projectDir, "package.json"), "utf8"),
    ) as { name?: string };
    if (pkg.name !== "jarvis-core")
      throw new Error(
        "The local launcher can operate only inside its own JARVIS project.",
      );
    this.nodePath = realpathSync(options.nodePath ?? process.execPath);
    validateNodeVersion(
      execFileSync(this.nodePath, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    this.controlDir = runtimePaths(this.projectDir, "lab").controlDir;
    mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    this.manifestPath = join(this.controlDir, "install.json");
  }

  async install(): Promise<InstalledBuild> {
    const lock = acquireDataLock(this.controlDir, "maintenance");
    const dataLocks: ReturnType<typeof acquireDataLock>[] = [];
    try {
      dataLocks.push(
        acquireDataLock(join(this.projectDir, ".data"), "maintenance"),
      );
      for (const mode of ["lab", "operational"] as const) {
        if (this.identity(mode).owned)
          throw new Error(
            "Stop both local modes before installing or updating the shared build.",
          );
        dataLocks.push(
          acquireDataLock(
            runtimePaths(this.projectDir, mode).dataDir,
            "maintenance",
          ),
        );
      }
      const before = this.sourceRevision();
      if (this.options.build) await this.options.build(this.projectDir);
      else {
        const npm = join(dirname(this.nodePath), "npm");
        await this.run(npm, ["ci", "--no-audit", "--no-fund"]);
        await this.run(npm, ["run", "build"]);
      }
      if (this.sourceRevision() !== before)
        throw new Error(
          "Source revision changed during the build. Retry after source changes are complete.",
        );
      const metadata = JSON.parse(
        readFileSync(join(this.projectDir, "dist", "build.json"), "utf8"),
      ) as { gitSha?: string; node?: string };
      if (metadata.gitSha !== before)
        throw new Error(
          "Built revision does not match the checked-out source revision.",
        );
      if (
        !existsSync(join(this.projectDir, "dist", "server.js")) ||
        !existsSync(join(this.projectDir, "dist", "web", "index.html"))
      )
        throw new Error("Server or web build is missing.");
      const files = buildFiles(this.projectDir).map((path) => ({
        path,
        sha256: sha256(readFileSync(join(this.projectDir, path))),
      }));
      for (const path of ["package.json", "package-lock.json"])
        files.push({
          path,
          sha256: sha256(readFileSync(join(this.projectDir, path))),
        });
      const manifest: InstalledBuild = {
        formatVersion: 1,
        gitSha: before,
        installedAt: new Date().toISOString(),
        node: process.version,
        files,
      };
      privateJson(this.manifestPath, manifest);
      return manifest;
    } finally {
      for (const dataLock of dataLocks.reverse()) dataLock.release();
      lock.release();
    }
  }

  async update() {
    return this.install();
  }

  installed(): InstalledBuild {
    if (!existsSync(this.manifestPath))
      throw new Error(
        "JARVIS is not installed. Run the local install command first.",
      );
    const manifest = JSON.parse(
      readFileSync(this.manifestPath, "utf8"),
    ) as InstalledBuild;
    if (
      manifest.formatVersion !== 1 ||
      !/^[a-f0-9]{40}(?:-dirty)?$/.test(manifest.gitSha) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length < 3
    )
      throw new Error("Unsupported or invalid local install manifest.");
    for (const file of manifest.files) {
      if (
        !/^(?:(?:dist|assets)\/[a-zA-Z0-9_./-]+|package(?:-lock)?\.json)$/.test(
          file.path,
        ) ||
        file.path.split("/").includes("..") ||
        lstatSync(join(this.projectDir, file.path)).isSymbolicLink() ||
        sha256(readFileSync(join(this.projectDir, file.path))) !== file.sha256
      )
        throw new Error(
          "Installed build changed. Run the local update command before starting it.",
        );
    }
    const actual = buildFiles(this.projectDir);
    if (
      actual.length + 2 !== manifest.files.length ||
      actual.some(
        (path) => !manifest.files.some((entry) => entry.path === path),
      )
    )
      throw new Error("Build contains files outside the install manifest.");
    return manifest;
  }

  async start(input: {
    mode: LocalMode;
    port?: number;
    provider?: "anthropic";
    model?: string;
    observability?: boolean;
  }) {
    const paths = runtimePaths(this.projectDir, input.mode);
    const lock = acquireDataLock(this.controlDir, "maintenance");
    let childPid: number | undefined;
    try {
      const installed = this.installed();
      if (
        input.mode === "operational" &&
        !/^[a-f0-9]{40}$/.test(installed.gitSha)
      )
        throw new Error(
          "Operational mode requires an exact clean commit build. Commit the reviewed JARVIS changes and update first.",
        );
      if (this.identity(input.mode).owned)
        throw new Error("This JARVIS mode is already running.");
      const port = input.port ?? (input.mode === "lab" ? 4310 : 4320);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("Choose an unprivileged localhost port (1024–65535).");
      const exclusive = acquireDataLock(paths.dataDir, "maintenance");
      try {
        if (
          input.mode === "operational" &&
          !operationalAccountsReady(paths.dataDir)
        )
          throw new Error(
            "Operational accounts are required: explicitly provision an active operator and approver in the same company first.",
          );
      } finally {
        exclusive.release();
      }
      const env: NodeJS.ProcessEnv = {
        PATH: `${dirname(this.nodePath)}:/usr/bin:/bin`,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "C.UTF-8",
        HOST: "127.0.0.1",
        PORT: String(port),
        GIT_SHA: installed.gitSha,
        JARVIS_MODE: input.mode === "lab" ? "local" : "accounts",
        JARVIS_DATA_DIR: paths.dataDir,
        JARVIS_VOICE_DIR: join(this.projectDir, ".data", "voice"),
        JARVIS_PLANNER: "demo",
      };
      if (input.observability) env.JARVIS_OBSERVABILITY = input.mode;
      if (input.provider) {
        if (
          input.provider !== "anthropic" ||
          !input.model ||
          !/^[a-zA-Z0-9_.:-]{1,150}$/.test(input.model)
        )
          throw new Error(
            "Explicit provider activation requires an Anthropic model identifier.",
          );
        env.ANTHROPIC_API_KEY = await (
          this.options.secrets?.(input.mode) ??
          new KeychainSecrets(this.projectDir, input.mode)
        ).read();
        env.ANTHROPIC_MODEL = input.model;
        env.JARVIS_PLANNER = "anthropic";
        if (process.env.JARVIS_MODEL_PRICING) {
          let pricing: Record<string, unknown>;
          try {
            pricing = JSON.parse(process.env.JARVIS_MODEL_PRICING) as Record<
              string,
              unknown
            >;
          } catch {
            throw new Error("Invalid JARVIS_MODEL_PRICING configuration.");
          }
          if (
            !pricing ||
            typeof pricing !== "object" ||
            Object.keys(pricing).some(
              (key) =>
                ![
                  "version",
                  "currency",
                  "inputPerMillion",
                  "outputPerMillion",
                ].includes(key),
            ) ||
            typeof pricing.version !== "string" ||
            !/^[a-zA-Z0-9_.:-]{1,100}$/.test(pricing.version) ||
            typeof pricing.currency !== "string" ||
            !/^[A-Z]{3}$/.test(pricing.currency) ||
            typeof pricing.inputPerMillion !== "number" ||
            !Number.isFinite(pricing.inputPerMillion) ||
            pricing.inputPerMillion < 0 ||
            typeof pricing.outputPerMillion !== "number" ||
            !Number.isFinite(pricing.outputPerMillion) ||
            pricing.outputPerMillion < 0
          )
            throw new Error("Invalid JARVIS_MODEL_PRICING configuration.");
          env.JARVIS_MODEL_PRICING = JSON.stringify(pricing);
        }
      }
      const server = join(this.projectDir, "dist", "server.js");
      const supervisor = join(this.projectDir, "dist", "local-supervisor.js");
      if (!existsSync(supervisor))
        throw new Error(
          "The local supervisor build is missing. Update the installation.",
        );
      const child = spawn(this.nodePath, [supervisor, server, paths.logPath], {
        cwd: this.projectDir,
        env,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        /* Startup proof below reports a generic error without environment. */
      });
      child.unref();
      childPid = child.pid;
      if (!childPid)
        throw new Error("JARVIS could not start its local process.");
      const deadline = Date.now() + (this.options.startTimeoutMs ?? 15_000);
      await wait(250);
      while (Date.now() < deadline) {
        if (!processCommand(childPid))
          throw new Error(
            "JARVIS exited before becoming ready. Inspect its private operational log.",
          );
        try {
          const owner = JSON.parse(
            readFileSync(join(paths.dataDir, ".jarvis-data.lock"), "utf8"),
          ) as { pid: number; token: string };
          if (
            processParent(owner.pid) === childPid &&
            typeof owner.token === "string"
          ) {
            const command = processCommand(owner.pid);
            if (!command?.includes(server))
              throw new Error(
                "Process identity does not match the installed JARVIS server.",
              );
            const state: RuntimeState = {
              formatVersion: 1,
              pid: owner.pid,
              supervisorPid: childPid,
              mode: input.mode,
              port,
              gitSha: installed.gitSha,
              startedAt: new Date().toISOString(),
              lockToken: owner.token,
              command,
              provider: input.provider ?? "disabled",
            };
            privateJson(paths.statePath, state);
            const ready = await fetch(`http://127.0.0.1:${port}/api/ready`, {
              signal: AbortSignal.timeout(1000),
              redirect: "error",
            });
            const result = (await ready.json()) as {
              ready?: boolean;
              version?: string;
            };
            if (
              ready.ok &&
              result.ready &&
              result.version === installed.gitSha
            ) {
              return {
                running: true,
                mode: input.mode,
                pid: owner.pid,
                url: `http://127.0.0.1:${port}`,
                gitSha: installed.gitSha,
                provider: state.provider,
                dataDir: paths.dataDir,
              };
            }
          }
        } catch {
          /* Bounded startup retries, no unverified success or error body logging. */
        }
        await wait(100);
      }
      throw new Error(
        "JARVIS did not report readiness with the expected build SHA.",
      );
    } catch (error) {
      // Only the child created by this invocation may receive this startup cleanup signal.
      if (
        childPid &&
        processCommand(childPid)?.includes(
          join(this.projectDir, "dist", "local-supervisor.js"),
        )
      ) {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
      }
      throw error;
    } finally {
      lock.release();
    }
  }

  async status(mode: LocalMode) {
    const paths = runtimePaths(this.projectDir, mode);
    const identity = this.identity(mode);
    let installedSha: string | null = null;
    let buildVerified = false;
    try {
      installedSha = this.installed().gitSha;
      buildVerified = true;
    } catch {
      /* Explicit unverified field. */
    }
    let ready = false;
    let servedSha: string | null = null;
    if (identity.owned && identity.state) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${identity.state.port}/api/ready`,
          { signal: AbortSignal.timeout(1000), redirect: "error" },
        );
        const result = (await response.json()) as {
          ready?: boolean;
          version?: string;
        };
        servedSha = typeof result.version === "string" ? result.version : null;
        ready =
          response.ok &&
          Boolean(result.ready) &&
          result.version === identity.state.gitSha;
      } catch {
        /* Process can be alive while readiness is false. */
      }
    }
    return {
      mode,
      running: identity.owned,
      ready: ready && buildVerified && installedSha === servedSha,
      buildVerified,
      installedSha,
      servedSha,
      pid: identity.owned ? identity.state!.pid : null,
      url: identity.state ? `http://127.0.0.1:${identity.state.port}` : null,
      dataDir: paths.dataDir,
      logPath: paths.logPath,
      reason: identity.reason,
    };
  }

  async stop(mode: LocalMode) {
    const paths = runtimePaths(this.projectDir, mode);
    const lock = acquireDataLock(this.controlDir, "maintenance");
    try {
      const identity = this.identity(mode);
      if (!identity.owned || !identity.state) {
        if (identity.reason === "not_running") {
          rmSync(paths.statePath, { force: true });
          return { stopped: true, mode };
        }
        throw new Error(
          "Process ownership could not be verified. No process was signalled.",
        );
      }
      process.kill(identity.state.pid, "SIGTERM");
      const deadline = Date.now() + (this.options.stopTimeoutMs ?? 65_000);
      while (Date.now() < deadline) {
        if (!processCommand(identity.state.pid)) {
          rmSync(paths.statePath, { force: true });
          return { stopped: true, mode, gitSha: identity.state.gitSha };
        }
        await wait(100);
      }
      throw new Error(
        "JARVIS is still draining. It was not force-killed; check status before backup or update.",
      );
    } finally {
      lock.release();
    }
  }

  private identity(mode: LocalMode): {
    owned: boolean;
    reason: string;
    state?: RuntimeState;
  } {
    const paths = runtimePaths(this.projectDir, mode);
    if (!existsSync(paths.statePath))
      return { owned: false, reason: "not_running" };
    try {
      const state = JSON.parse(
        readFileSync(paths.statePath, "utf8"),
      ) as RuntimeState;
      if (
        state.formatVersion !== 1 ||
        state.mode !== mode ||
        !Number.isInteger(state.pid) ||
        state.pid < 1 ||
        !Number.isInteger(state.port) ||
        state.port < 1024 ||
        state.port > 65535 ||
        typeof state.command !== "string" ||
        !state.command.includes(join(this.projectDir, "dist", "server.js"))
      )
        return { owned: false, reason: "unverified_process" };
      const command = processCommand(state.pid);
      if (!command) return { owned: false, reason: "not_running", state };
      const owner = JSON.parse(
        readFileSync(join(paths.dataDir, ".jarvis-data.lock"), "utf8"),
      ) as { pid: number; token: string };
      return command === state.command &&
        owner.pid === state.pid &&
        owner.token === state.lockToken
        ? { owned: true, reason: "owned", state }
        : { owned: false, reason: "unverified_process", state };
    } catch {
      return { owned: false, reason: "unverified_process" };
    }
  }
  private sourceRevision() {
    if (this.options.sourceRevision) return this.options.sourceRevision();
    const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: this.projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: this.projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return gitSha + (dirty ? "-dirty" : "");
  }
  private run(command: string, args: string[]) {
    return new Promise<void>((resolvePromise, reject) => {
      execFile(
        command,
        args,
        {
          cwd: this.projectDir,
          env: {
            ...process.env,
            PATH: `${dirname(this.nodePath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          },
          timeout: 180_000,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error) =>
          error
            ? reject(
                new Error(
                  "Local dependency install or build failed. Run the documented build command to inspect the failure.",
                ),
              )
            : resolvePromise(),
      );
    });
  }
}
