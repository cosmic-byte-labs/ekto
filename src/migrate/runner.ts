/**
 * Runs migrations (Ecto.Migrator) on Kysely's `Migrator`, which keeps track
 * of the executed migrations in its `kysely_migration` table and holds a
 * lock while migrating.
 */

import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Kysely, sql } from "kysely";
import {
  type Migration as KyselyMigration,
  type MigrationResultSet,
  Migrator,
  NO_MIGRATIONS,
} from "kysely/migration";
import type { Adapter } from "../adapter.ts";
import {
  type Command,
  type Executable,
  isMigration,
  type Migration,
  MigrationError,
} from "./dsl.ts";

/** The migrations by name; names sort in the order they run. */
export type Migrations = Readonly<Record<string, Migration>>;

export interface MigratorOptions {
  // biome-ignore lint/suspicious/noExplicitAny: any database
  readonly db: Kysely<any>;
  /** Turns commands into SQL; must implement `ddl`. */
  readonly adapter: Adapter;
  /** The migrations, or a function loading them (e.g. `fileMigrations`). */
  readonly migrations: Migrations | (() => Promise<Migrations>);
  /** Kysely's migration table, `kysely_migration` by default. */
  readonly migrationTableName?: string;
  readonly migrationLockTableName?: string;
}

export interface MigrationStatus {
  readonly name: string;
  readonly status: "up" | "down";
  readonly executedAt: Date | undefined;
}

export interface MigrateOptions {
  /** Runs this many pending migrations instead of all. */
  readonly step?: number;
  /** Runs the pending migrations up to and including this one. */
  readonly to?: string;
}

export interface RollbackOptions {
  /** Rolls back this many migrations, 1 by default. */
  readonly step?: number;
  /** Rolls back the migrations down to and including this one. */
  readonly to?: string;
  /** Rolls back every executed migration. */
  readonly all?: boolean;
}

/** The migrations that ran, in the order they ran. */
export type MigrationRun = readonly string[];

export interface EktoMigrator {
  /** Runs pending migrations, all by default (`mix ecto.migrate`). */
  migrate(options?: MigrateOptions): Promise<MigrationRun>;
  /** Rolls back executed migrations, the last one by default (`mix ecto.rollback`). */
  rollback(options?: RollbackOptions): Promise<MigrationRun>;
  /** Every migration and whether it ran (`mix ecto.migrations`). */
  status(): Promise<readonly MigrationStatus[]>;
}

async function run(
  // biome-ignore lint/suspicious/noExplicitAny: any database
  db: Kysely<any>,
  adapter: Adapter,
  commands: readonly Command[],
): Promise<void> {
  const ddl = adapter.ddl;
  if (ddl === undefined)
    throw new MigrationError(
      `the ${adapter.name} adapter does not support migrations`,
    );
  const execute = async (executable: Executable) => {
    if (typeof executable === "string") await sql.raw(executable).execute(db);
    else await executable(db);
  };
  for (const command of commands) {
    if (command.command === "executeReversible") {
      await execute(command.up);
      continue;
    }
    for (const statement of ddl(command)) await execute(statement);
  }
}

function toKysely(migration: Migration, adapter: Adapter): KyselyMigration {
  return {
    up: (db) => run(db, adapter, migration.up()),
    down: async (db) => {
      if (migration.down === undefined)
        throw new MigrationError(
          "it defines up but no down, so it cannot be rolled back",
        );
      await run(db, adapter, migration.down());
    },
  };
}

function check(result: MigrationResultSet): MigrationRun {
  if (result.error !== undefined) {
    const failed = result.results?.find((r) => r.status === "Error");
    const error = result.error;
    if (failed && error instanceof Error)
      error.message = `migration ${failed.migrationName} failed: ${error.message}`;
    throw error;
  }
  return (result.results ?? [])
    .filter((r) => r.status === "Success")
    .map((r) => r.migrationName);
}

/**
 * Runs `migrations` on `db`. Each migration's commands go through the
 * adapter's `ddl`; Kysely runs the migrations of one call in a single
 * transaction where the database supports transactional DDL.
 *
 * ```ts
 * const migrator = createMigrator({
 *   db,
 *   adapter: postgres(),
 *   migrations: fileMigrations("migrations"),
 * });
 * await migrator.migrate();
 * ```
 */
export function createMigrator(options: MigratorOptions): EktoMigrator {
  const { db, adapter } = options;
  const load = async (): Promise<Migrations> =>
    typeof options.migrations === "function"
      ? options.migrations()
      : options.migrations;

  const migrator = (migrations: Migrations) => {
    const entries = Object.entries(migrations);
    for (const [name, migration] of entries)
      if (!isMigration(migration))
        throw new TypeError(
          `migration ${name} must be created with migration()`,
        );
    return new Migrator({
      db,
      provider: {
        getMigrations: async () =>
          Object.fromEntries(
            entries.map(([name, m]) => [name, toKysely(m, adapter)]),
          ),
      },
      ...(options.migrationTableName && {
        migrationTableName: options.migrationTableName,
      }),
      ...(options.migrationLockTableName && {
        migrationLockTableName: options.migrationLockTableName,
      }),
    });
  };

  const positiveStep = (step: number | undefined) => {
    if (step !== undefined && !(Number.isInteger(step) && step > 0))
      throw new TypeError(`step must be a positive integer, got ${step}`);
  };

  return {
    async migrate(opts = {}) {
      positiveStep(opts.step);
      const m = migrator(await load());
      if (opts.step === undefined && opts.to === undefined)
        return check(await m.migrateToLatest());
      const infos = await m.getMigrations();
      const pending = infos.filter((i) => i.executedAt === undefined);
      let target: string | undefined;
      if (opts.to !== undefined) {
        if (!infos.some((i) => i.name === opts.to))
          throw new MigrationError(`unknown migration ${opts.to}`);
        // Ecto never rolls back on migrate: an executed target is a no-op.
        target = pending.find((i) => i.name === opts.to)?.name;
      } else {
        target = pending[Math.min(opts.step ?? 1, pending.length) - 1]?.name;
      }
      if (target === undefined) return [];
      return check(await m.migrateTo(target));
    },

    async rollback(opts = {}) {
      positiveStep(opts.step);
      const m = migrator(await load());
      const infos = await m.getMigrations();
      const executed = infos.filter((i) => i.executedAt !== undefined);
      if (executed.length === 0) return [];
      let keep: number;
      if (opts.all) keep = 0;
      else if (opts.to !== undefined) {
        keep = executed.findIndex((i) => i.name === opts.to);
        if (keep === -1) return [];
      } else keep = Math.max(executed.length - (opts.step ?? 1), 0);
      if (keep === executed.length) return [];
      const target = executed[keep - 1]?.name ?? NO_MIGRATIONS;
      return check(await m.migrateTo(target));
    },

    async status() {
      const infos = await migrator(await load()).getMigrations();
      return infos.map((i) => ({
        name: i.name,
        status: i.executedAt === undefined ? "down" : "up",
        executedAt: i.executedAt,
      }));
    },
  };
}

const MIGRATION_FILE = /\.(m|c)?(j|t)s$/;

/**
 * Loads the migrations in `folder`: every `.ts`, `.js`, `.mts`… file
 * (declaration files excepted) whose default export is a `migration()`,
 * named by its file name without the extension.
 */
export function fileMigrations(folder: string): () => Promise<Migrations> {
  return async () => {
    const dir = resolve(folder);
    const files = (await readdir(dir))
      .filter((f) => MIGRATION_FILE.test(f) && !/\.d\.(m|c)?ts$/.test(f))
      .sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const module = await import(pathToFileURL(join(dir, file)).href);
      const migration = module.default;
      if (!isMigration(migration))
        throw new TypeError(
          `${file} must export a migration() as its default export`,
        );
      migrations[file.slice(0, -extname(file).length)] = migration;
    }
    return migrations;
  };
}
