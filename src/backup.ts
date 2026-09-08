import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { z } from "zod";

const lockName = ".jarvis-data.lock";
const gateName = ".jarvis-lock-gate";
const restoreMarker = ".restore-in-progress";
const privateMode = 0o600;
const secretName =
  /(^\.env($|\.)|\.pem$|\.key$|(^|[._-])(credentials?|secrets?|tokens?|auth)([._-]|$))/i;
const secretContent =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|(?:authorization\s*[:=]\s*["']?bearer\s+|["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?)[A-Za-z0-9_./+=-]{8,}/i;

export interface DataLock {
  kind: "runtime" | "maintenance";
  release(): void;
}

interface LockOwner {
  pid: number;
  host: string;
  kind: string;
  token: string;
  createdAt: string;
}

function directory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Data path must be a real directory, not a symlink.");
  return realpathSync(path);
}

function lockedGate<T>(dataDir: string, action: () => T): T {
  const gate = join(dataDir, gateName);
  let fd: number;
  try {
    fd = openSync(gate, "wx", privateMode);
  } catch {
    throw new Error(
      "Data lock is being changed; retry after the other operation completes.",
    );
  }
  try {
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(gate);
  }
}

/** Exclusive across runtime, backup and restore; stale PID recovery is serialized. */
export function acquireDataLock(
  dataDir: string,
  kind: "runtime" | "maintenance",
): DataLock {
  const root = directory(dataDir);
  const path = join(root, lockName);
  const token = randomUUID();
  lockedGate(root, () => {
    if (kind === "runtime" && existsSync(join(root, restoreMarker)))
      throw new Error(
        "An interrupted restore requires inspection before runtime startup.",
      );
    if (existsSync(path)) {
      let owner: LockOwner;
      try {
        owner = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
      } catch {
        throw new Error(
          "Malformed data lock; confirm JARVIS is stopped before manual recovery.",
        );
      }
      if (
        !Number.isInteger(owner.pid) ||
        owner.pid <= 0 ||
        owner.host !== hostname() ||
        typeof owner.token !== "string"
      )
        throw new Error(
          "Unverifiable data lock; manual inspection is required.",
        );
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error(
          "JARVIS data is locked. Stop and drain the runtime before backup or restore.",
        );
      unlinkSync(path);
    }
    const owner: LockOwner = {
      pid: process.pid,
      host: hostname(),
      kind,
      token,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(owner), {
      flag: "wx",
      mode: privateMode,
    });
  });
  let released = false;
  return {
    kind,
    release() {
      if (released) return;
      lockedGate(root, () => {
        const owner = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
        if (owner.token !== token)
          throw new Error("Data lock ownership changed.");
        unlinkSync(path);
        released = true;
      });
    },
  };
}

const pathSchema = z
  .string()
  .min(1)
  .max(600)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      !path.includes("\0"),
    "Unsafe backup path",
  );
const entrySchema = z
  .object({
    path: pathSchema,
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["sqlite", "attachment", "evidence"]),
    schemaVersions: z
      .record(
        z.string().regex(/^schema_versions(?:_[a-z0-9_]+)?$/),
        z.number().int().nonnegative(),
      )
      .optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("jarvis-backup"),
    formatVersion: z.literal(1),
    createdAt: z.string().datetime(),
    buildVersion: z.string().min(1).max(160),
    runtime: z.object({ node: z.string(), sqlite: z.string() }).strict(),
    files: z.array(entrySchema).min(1).max(100_000),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
type BackupEntry = BackupManifest["files"][number];

function hash(buffer: Uint8Array | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function syncFile(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateSource(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error("Backup refuses symlinks and nonregular files.");
}

function filesBelow(
  root: string,
  relativeDir = "",
  skipRuntime = false,
): string[] {
  const result: string[] = [];
  for (const name of readdirSync(join(root, relativeDir)).sort()) {
    if (
      skipRuntime &&
      relativeDir === "" &&
      ["voice", "voice-jobs"].includes(name)
    )
      continue;
    const path = relativeDir ? `${relativeDir}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error("Backup refuses symlinks.");
    if (stat.isDirectory()) result.push(...filesBelow(root, path, skipRuntime));
    else if (stat.isFile()) result.push(path);
    else throw new Error("Backup refuses nonregular files.");
  }
  return result;
}

function kindOf(path: string): BackupEntry["kind"] | undefined {
  if (["voice", "voice-jobs"].includes(path.split("/")[0] ?? ""))
    return undefined;
  // Credentials and sessions must be provisioned afresh after restoring business data.
  if (/^(?:accounts|sessions?).*\.sqlite$/i.test(basename(path)))
    return undefined;
  if (path.endsWith(".sqlite")) return "sqlite";
  if (path.startsWith("attachments/")) return "attachment";
  if (path.startsWith("evidence/")) return "evidence";
  return undefined;
}

function ensureNoSecret(path: string, bytes: Uint8Array) {
  if (
    path.split("/").some((part) => secretName.test(part)) ||
    secretContent.test(Buffer.from(bytes).toString("latin1"))
  )
    throw new Error(
      "Backup refuses a credential-like file or plaintext credential. Remove secrets from persisted operational data before retrying.",
    );
}

function sqliteInfo(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok")
      throw new Error("SQLite integrity check failed.");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const schemaVersions: Record<string, number> = {};
    for (const { name } of tables) {
      if (!/^schema_versions(?:_[a-z0-9_]+)?$/.test(name)) continue;
      const row = db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM ${name}`)
        .get() as { version: number };
      schemaVersions[name] = row.version;
    }
    const version = db.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    };
    return { schemaVersions, sqliteVersion: version.version };
  } finally {
    db.close();
  }
}

function outside(root: string, destination: string) {
  const rel = relative(root, destination);
  if (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  )
    throw new Error("Backup destination must be outside the data directory.");
}

function canonicalDestination(path: string): string {
  const absolute = resolve(path);
  // Parents are prepared before taking a snapshot, and resolved to prevent symlink escapes.
  const parent = directory(dirname(absolute));
  return join(parent, basename(absolute));
}

export async function createBackup(options: {
  dataDir: string;
  destination: string;
  buildVersion: string;
}): Promise<{
  manifest: BackupManifest;
  manifestHash: string;
  destination: string;
}> {
  const dataDir = directory(options.dataDir);
  const destination = canonicalDestination(options.destination);
  outside(dataDir, destination);
  if (existsSync(destination))
    throw new Error(
      "Backup destination already exists; choose a new directory.",
    );
  const lock = acquireDataLock(dataDir, "maintenance");
  const nestedLocks: DataLock[] = [];
  const stage = `${destination}.partial-${randomUUID()}`;
  try {
    if (existsSync(join(dataDir, restoreMarker)))
      throw new Error(
        "Complete or discard the interrupted restore before backup.",
      );
    mkdirSync(stage, { mode: 0o700 });
    const selected = filesBelow(dataDir, "", true).filter((path) =>
      kindOf(path),
    );
    // Local product modes can sit below a shared .data directory. Every included
    // database parent must stay quiescent for the entire cross-database snapshot.
    const databaseParents = [
      ...new Set(
        selected
          .filter((path) => path.endsWith(".sqlite"))
          .map((path) => dirname(join(dataDir, path))),
      ),
    ]
      .filter((path) => path !== dataDir)
      .sort();
    for (const parent of databaseParents)
      nestedLocks.push(acquireDataLock(parent, "maintenance"));
    if (!selected.some((path) => path.endsWith(".sqlite")))
      throw new Error("No SQLite database found in data directory.");
    const files: BackupEntry[] = [];
    let sqliteVersion = "unknown";
    for (const path of selected) {
      const source = join(dataDir, path);
      const target = join(stage, "payload", path);
      ensurePrivateSource(source);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const kind = kindOf(path)!;
      let schemaVersions: Record<string, number> | undefined;
      if (kind === "sqlite") {
        const db = new DatabaseSync(source, { readOnly: true });
        try {
          await sqliteBackup(db, target);
        } finally {
          db.close();
        }
        const info = sqliteInfo(target);
        schemaVersions = info.schemaVersions;
        sqliteVersion = info.sqliteVersion;
      } else copyFileSync(source, target);
      chmodSync(target, privateMode);
      const bytes = readFileSync(target);
      ensureNoSecret(path, bytes);
      syncFile(target);
      files.push({
        path,
        size: bytes.length,
        sha256: hash(bytes),
        kind,
        ...(schemaVersions ? { schemaVersions } : {}),
      });
    }
    const manifest = manifestSchema.parse({
      format: "jarvis-backup",
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      buildVersion: options.buildVersion,
      runtime: { node: process.version, sqlite: sqliteVersion },
      files,
    });
    writeFileSync(
      join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: privateMode },
    );
    syncFile(join(stage, "manifest.json"));
    const verified = verifyBackup(stage);
    renameSync(stage, destination);
    const statusTemp = join(dataDir, `.backup-status-${randomUUID()}.json`);
    writeFileSync(
      statusTemp,
      JSON.stringify({
        status: "verified",
        createdAt: manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        manifestHash: verified.manifestHash,
      }),
      { mode: privateMode },
    );
    syncFile(statusTemp);
    renameSync(statusTemp, join(dataDir, "backup-status.json"));
    return { ...verified, destination };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    for (const nested of nestedLocks.reverse()) nested.release();
    lock.release();
  }
}

/** Validate the complete artifact, not merely the manifest's declared members. */
export function verifyBackup(source: string): {
  manifest: BackupManifest;
  manifestHash: string;
} {
  const root = resolve(source);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("Backup source must be a real directory.");
  // Validate the entire tree before opening any SQLite file through its path.
  const actual = filesBelow(root);
  ensurePrivateSource(join(root, "manifest.json"));
  const raw = readFileSync(join(root, "manifest.json"));
  const manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
  const declared = new Set<string>();
  for (const entry of manifest.files) {
    if (declared.has(entry.path) || kindOf(entry.path) !== entry.kind)
      throw new Error("Duplicate or unsupported backup member.");
    declared.add(entry.path);
    const path = join(root, "payload", entry.path);
    ensurePrivateSource(path);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256)
      throw new Error("Backup checksum mismatch; refusing corrupted data.");
    ensureNoSecret(entry.path, bytes);
    if (entry.kind === "sqlite") {
      const info = sqliteInfo(path);
      if (
        JSON.stringify(info.schemaVersions) !==
        JSON.stringify(entry.schemaVersions ?? {})
      )
        throw new Error("Backup schema metadata does not match SQLite.");
    }
  }
  const expected = new Set([
    "manifest.json",
    ...[...declared].map((path) => `payload/${path}`),
  ]);
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  )
    throw new Error("Backup contains undeclared files.");
  return { manifest, manifestHash: hash(raw) };
}

export async function restoreBackup(options: {
  source: string;
  targetDir: string;
}): Promise<{
  manifest: BackupManifest;
  manifestHash: string;
  targetDir: string;
}> {
  const source = realpathSync(options.source);
  const verified = verifyBackup(source);
  const targetDir = canonicalDestination(options.targetDir);
  outside(source, targetDir);
  if (
    existsSync(targetDir) &&
    (!lstatSync(targetDir).isDirectory() || readdirSync(targetDir).length !== 0)
  )
    throw new Error("Restore requires an empty target directory.");
  directory(targetDir);
  const lock = acquireDataLock(targetDir, "maintenance");
  let successful = false;
  try {
    writeFileSync(
      join(targetDir, restoreMarker),
      JSON.stringify({
        startedAt: new Date().toISOString(),
        manifestHash: verified.manifestHash,
      }),
      { flag: "wx", mode: privateMode },
    );
    syncFile(join(targetDir, restoreMarker));
    for (const entry of verified.manifest.files) {
      const destination = join(targetDir, entry.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, "payload", entry.path), destination);
      chmodSync(destination, privateMode);
      const bytes = readFileSync(destination);
      if (hash(bytes) !== entry.sha256)
        throw new Error("Restored file checksum mismatch.");
      if (entry.kind === "sqlite") sqliteInfo(destination);
      syncFile(destination);
    }
    writeFileSync(
      join(targetDir, "backup-status.json"),
      JSON.stringify({
        status: "verified",
        createdAt: verified.manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        manifestHash: verified.manifestHash,
      }),
      { mode: privateMode },
    );
    unlinkSync(join(targetDir, restoreMarker));
    successful = true;
    return { ...verified, targetDir };
  } finally {
    // On failure, keep the marker: even after PID recovery the runtime must refuse partial data.
    lock.release();
    if (!successful && !existsSync(join(targetDir, restoreMarker)))
      writeFileSync(join(targetDir, restoreMarker), "restore failed\n", {
        mode: privateMode,
      });
  }
}
