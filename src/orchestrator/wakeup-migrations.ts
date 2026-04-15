import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

type WakeupMigration = {
  version: number;
  name: string;
  sql: string;
};

const INITIAL_WAKEUP_SCHEMA_SQL = readFileSync(
  new URL("./sql/0001_wakeup_initial.sql", import.meta.url),
  "utf8",
);

const WAKEUP_MIGRATIONS: WakeupMigration[] = [
  {
    version: 1,
    name: "initial_wakeup_schema",
    sql: INITIAL_WAKEUP_SCHEMA_SQL,
  },
];

export const WAKEUP_SCHEMA_VERSION =
  WAKEUP_MIGRATIONS[WAKEUP_MIGRATIONS.length - 1]?.version ?? 0;

export function getWakeupSchemaVersion(database: Database.Database): number {
  return Number(database.pragma("user_version", { simple: true }) ?? 0);
}

export function applyWakeupMigrations(database: Database.Database): void {
  const currentVersion = getWakeupSchemaVersion(database);

  for (const migration of WAKEUP_MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }

    const applyMigration = database.transaction(() => {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
    });

    applyMigration();
  }
}
