import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
/** Immutable delivered schema, never derived from the current constructor. */
export function operationsV7(path: string) {
  const db = new DatabaseSync(path);
  db.exec(
    readFileSync(
      new URL("../fixtures/operations-v7.sql", import.meta.url),
      "utf8",
    ),
  );
  return db;
}
