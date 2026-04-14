import { mkdirSync } from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { RuntimeError } from "../errors.js";

import { applyRuntimeMigrations } from "./migrations.js";

export type RuntimeDatabase = {
  path: string;
  connection: BetterSqlite3.Database;
  close(): void;
};

export function openRuntimeDatabase(databasePath: string): RuntimeDatabase {
  const resolvedPath = path.resolve(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  let connection: BetterSqlite3.Database;

  try {
    connection = new BetterSqlite3(resolvedPath);
  } catch (error) {
    throw new RuntimeError(
      `Failed to open runtime database '${resolvedPath}'.`,
      {
        code: "database_open_failed",
        cause: error,
      },
    );
  }

  try {
    connection.pragma("foreign_keys = ON");
    connection.pragma("journal_mode = WAL");
    connection.pragma("synchronous = NORMAL");
    applyRuntimeMigrations(connection);
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Best effort cleanup after a failed initialization.
    }

    if (error instanceof RuntimeError) {
      throw error;
    }

    throw new RuntimeError(
      `Failed to initialize runtime database '${resolvedPath}'.`,
      {
        code: "database_open_failed",
        cause: error,
      },
    );
  }

  return {
    path: resolvedPath,
    connection,
    close(): void {
      try {
        connection.close();
      } catch (error) {
        throw new RuntimeError(
          `Failed to close runtime database '${resolvedPath}'.`,
          {
            code: "database_close_failed",
            cause: error,
          },
        );
      }
    },
  };
}
