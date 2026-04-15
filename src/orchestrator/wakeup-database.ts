import { mkdirSync } from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { applyWakeupMigrations } from "./wakeup-migrations.js";

export type WakeupDatabase = {
  path: string;
  connection: BetterSqlite3.Database;
  close(): void;
};

export function openWakeupDatabase(databasePath: string): WakeupDatabase {
  const resolvedPath = path.resolve(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const connection = new BetterSqlite3(resolvedPath);

  try {
    connection.pragma("foreign_keys = ON");
    connection.pragma("journal_mode = WAL");
    connection.pragma("synchronous = NORMAL");
    applyWakeupMigrations(connection);
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Best effort cleanup after a failed initialization.
    }

    throw error;
  }

  return {
    path: resolvedPath,
    connection,
    close(): void {
      connection.close();
    },
  };
}
