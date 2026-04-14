import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

import { RuntimeError } from "../errors.js";

type RuntimeMigration = {
  version: number;
  name: string;
  sql: string;
};

const INITIAL_SCHEMA_SQL = readFileSync(
  new URL("./sql/0001_initial.sql", import.meta.url),
  "utf8",
);

const RUNTIME_MIGRATIONS: RuntimeMigration[] = [
  {
    version: 1,
    name: "initial_runtime_schema",
    sql: INITIAL_SCHEMA_SQL,
  },
];

export const RUNTIME_SCHEMA_VERSION =
  RUNTIME_MIGRATIONS[RUNTIME_MIGRATIONS.length - 1]?.version ?? 0;

export function getRuntimeSchemaVersion(database: Database.Database): number {
  return Number(database.pragma("user_version", { simple: true }) ?? 0);
}

export function applyRuntimeMigrations(database: Database.Database): void {
  const currentVersion = getRuntimeSchemaVersion(database);

  for (const migration of RUNTIME_MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }

    try {
      const applyMigration = database.transaction(() => {
        database.exec(migration.sql);
        database.pragma(`user_version = ${migration.version}`);
      });

      applyMigration();
    } catch (error) {
      throw new RuntimeError(
        `Failed to apply runtime migration ${migration.version} (${migration.name}).`,
        {
          code: "migration_failed",
          cause: error,
        },
      );
    }
  }
}
