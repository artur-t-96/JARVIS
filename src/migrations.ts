import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  /** Rebuild a referenced table using SQLite's copy/drop/rename procedure. */
  rebuildTables?: boolean;
  up(database: DatabaseSync): void;
}

export interface MigrationOptions {
  namespace: string;
  migrations: readonly Migration[];
}

/** The core ledger retains the two columns used by JARVIS v0.1. */
export function migrateDatabase(
  database: DatabaseSync,
  { namespace, migrations }: MigrationOptions,
): { version: number; applied: number[] } {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(namespace))
    throw new Error("Invalid migration namespace.");
  if (
    migrations.length === 0 ||
    migrations.some(
      (migration, index) =>
        migration.version !== index + 1 || !migration.name.trim(),
    )
  )
    throw new Error(
      "Migrations must be named and numbered consecutively from 1.",
    );

  const table =
    namespace === "core" ? "schema_versions" : `schema_versions_${namespace}`;
  const applied: number[] = [];
  const hasLedger = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
    .get(table);
  const previous = hasLedger
    ? Number(
        database
          .prepare(`SELECT coalesce(max(version),0) AS v FROM ${table}`)
          .get()!.v,
      )
    : 0;
  const rebuild = migrations.some(
    (m) => m.version > previous && m.rebuildTables,
  );
  const foreignKeys = Number(
    database.prepare("PRAGMA foreign_keys").get()!.foreign_keys,
  );
  // PRAGMA foreign_keys must be changed before BEGIN. The final integrity check
  // and migration ledger are committed together, and enforcement is restored.
  if (rebuild && foreignKeys) database.exec("PRAGMA foreign_keys=OFF");
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    database.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const rows = database
      .prepare(`SELECT version FROM ${table} ORDER BY version`)
      .all() as { version: number }[];
    const current = rows.at(-1)?.version ?? 0;
    if (current > migrations.length)
      throw new Error(
        `Database schema ${namespace} v${current} is newer than supported v${migrations.length}.`,
      );
    if (rows.some((row, index) => row.version !== index + 1))
      throw new Error(
        `Database schema ${namespace} has a nonconsecutive migration ledger.`,
      );
    const record = database.prepare(
      `INSERT INTO ${table} (version, applied_at) VALUES (?, ?)`,
    );
    for (const migration of migrations.slice(current)) {
      migration.up(database);
      record.run(migration.version, new Date().toISOString());
      applied.push(migration.version);
    }
    if (rebuild && database.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error(
        `Migration ${namespace} would break foreign key references.`,
      );
    database.exec("COMMIT");
    transaction = false;
    return { version: migrations.length, applied };
  } catch (error) {
    if (transaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    if (rebuild && foreignKeys) database.exec("PRAGMA foreign_keys=ON");
  }
}
