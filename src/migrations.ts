import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
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
  database.exec("BEGIN IMMEDIATE");
  try {
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
    database.exec("COMMIT");
    return { version: migrations.length, applied };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
