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
const RUN_PROMPT_ENVELOPE_SQL = readFileSync(
  new URL("./sql/0002_run_prompt_envelope.sql", import.meta.url),
  "utf8",
);
const RUN_OUTCOME_DETAILS_SQL = readFileSync(
  new URL("./sql/0003_run_outcome_details.sql", import.meta.url),
  "utf8",
);

const RUNTIME_MIGRATIONS: RuntimeMigration[] = [
  {
    version: 1,
    name: "initial_runtime_schema",
    sql: INITIAL_SCHEMA_SQL,
  },
  {
    version: 2,
    name: "run_prompt_envelope",
    sql: RUN_PROMPT_ENVELOPE_SQL,
  },
  {
    version: 3,
    name: "run_outcome_details",
    sql: RUN_OUTCOME_DETAILS_SQL,
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
