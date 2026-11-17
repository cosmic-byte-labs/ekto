/**
 * Runs migrations, following Ecto.Migrator: the versions that ran are kept
 * in the `schema_migrations` table (Ecto.Migration.SchemaMigration), each
 * migration runs in its own transaction, and a lock is held while it runs.
 */

import { readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Kysely, sql } from "kysely";
import type { Adapter, MigrationLockStrategy } from "../adapter.ts";
import type { Repo } from "../repo.ts";
import {
  type Command,
  type Executable,
  isMigration,
  type Migration,
  MigrationError,
  record,
  table,
} from "./dsl.ts";

/**
 * The migrations, keyed `<version>_<name>` (e.g.
 * `20260115103000_create_users`); they run in the order of their versions.
 */
export type Migrations = Readonly<Record<string, Migration>>;

export interface MigratorOptions {
  /** The Repo to migrate; its adapter must implement `ddl`. */
  readonly repo: Repo;
  /** The migrations, or a function loading them (e.g. `fileMigrations`). */
  readonly migrations: Migrations | (() => Promise<Migrations>);
  /** The table of executed versions, `schema_migrations` by default (Ecto's `:migration_source`). */
  readonly migrationSource?: string;
  /**
   * Whether and how to lock while migrating so that two migrators never
   * run the same migration (Ecto's `:migration_lock`): `true` (the
   * default) is `"tableLock"`, and `"pgAdvisoryLock"` takes a PostgreSQL
   * advisory lock instead, which keeps no transaction open while a
   * migration runs (so a server's `idle_in_transaction_session_timeout`
   * cannot end it). Either lets migrations create indexes concurrently.
   * Some PostgreSQL-compatible
   * systems do not support session-level locks well: PgBouncer in a pool
   * mode other than session, or CockroachDB. On PostgreSQL, the lock holds
   * a connection, so the Repo's pool needs at least two, and migrations
   * fail on a pool of one.
   */
  readonly migrationLock?: boolean | MigrationLockStrategy;
  /**
   * With `"pgAdvisoryLock"`, how long to wait before trying again when
   * another migrator holds the lock, 5000 by default (Ecto's
   * `:migration_advisory_lock_retry_interval_ms`).
   */
  readonly migrationAdvisoryLockRetryIntervalMs?: number;
  /**
   * With `"pgAdvisoryLock"`, how many times to try again before the
   * migration fails, `Infinity` by default (Ecto's
   * `:migration_advisory_lock_max_tries`).
   */
  readonly migrationAdvisoryLockMaxTries?: number;
}

/** A migration: its version and name. */
export interface MigrationInfo {
  readonly version: number;
  readonly name: string;
}

export interface MigrationStatus extends MigrationInfo {
  readonly status: "up" | "down";
}

function integer(name: string, value: number | undefined) {
  if (value !== undefined && !Number.isInteger(value))
    throw new TypeError(`${name} must be an integer version, got ${value}`);
}

/** Which migrations to run (Ecto.Migrator's strategies). */
export interface RunOptions {
  /** Runs every pending migration. */
  readonly all?: boolean;
  /** Runs the migrations up to (or, rolling back, down to) this version, inclusive. */
  readonly to?: number;
  /** As `to`, but the migration with this version is left out. */
  readonly toExclusive?: number;
  /** Runs this many migrations. */
  readonly step?: number;
}

/** The migrations that ran, in the order they ran. */
export type MigrationRun = readonly MigrationInfo[];

export interface EktoMigrator {
  /** Runs pending migrations, all of them by default (`mix ecto.migrate`). */
  migrate(options?: RunOptions): Promise<MigrationRun>;
  /** Rolls back executed migrations, the last one by default (`mix ecto.rollback`). */
  rollback(options?: RunOptions): Promise<MigrationRun>;
  /** Every migration and whether it ran (`mix ecto.migrations`). */
  status(): Promise<readonly MigrationStatus[]>;
}

/** The name of executed versions whose migration is missing (as Ecto shows them). */
export const FILE_NOT_FOUND = "** FILE NOT FOUND **";

interface Entry extends MigrationInfo {
  readonly key: string;
  readonly migration: Migration;
}

const KEY = /^(\d+)_(.+)$/;

function entries(migrations: Migrations): Entry[] {
  const list = Object.entries(migrations).map(([key, migration]) => {
    const match = KEY.exec(key);
    if (match === null)
      throw new MigrationError(
        `migration ${key} must be named <version>_<name>, e.g. 20260115103000_create_users`,
      );
    if (!isMigration(migration))
      throw new TypeError(`migration ${key} must be created with migration()`);
    return {
      key,
      version: Number(match[1]),
      name: match[2] as string,
      migration,
    };
  });
  list.sort((a, b) => a.version - b.version);
  // Ecto's ensure_no_duplication!/1.
  for (const [i, entry] of list.entries())
    for (const other of list.slice(i + 1)) {
      if (other.version === entry.version)
        throw new MigrationError(
          `migrations can't be executed, migration version ${entry.version} is duplicated`,
        );
      if (other.name === entry.name)
        throw new MigrationError(
          `migrations can't be executed, migration name ${entry.name} is duplicated`,
        );
    }
  return list;
}

async function runCommands(
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

function positive(name: string, value: number | undefined) {
  if (value !== undefined && !(Number.isInteger(value) && value > 0))
    throw new TypeError(`${name} must be a positive integer, got ${value}`);
}

/**
 * Runs `migrations` on the Repo's database, following Ecto.Migrator. Each migration runs
 * in its own transaction (unless it sets `disableDdlTransaction`) together
 * with recording its version, so a failed migration leaves nothing behind.
 * Pending migrations run whatever their order relative to the executed ones.
 *
 * ```ts
 * const migrator = createMigrator({
 *   repo,
 *   migrations: fileMigrations("migrations"),
 * });
 * await migrator.migrate();
 * ```
 */
export function createMigrator(options: MigratorOptions): EktoMigrator {
  const { repo } = options;
  const { adapter } = repo;
  const source = options.migrationSource ?? "schema_migrations";
  const lock = options.migrationLock ?? true;
  const lockOptions = {
    strategy: lock === "pgAdvisoryLock" ? lock : "tableLock",
    advisoryLockRetryIntervalMs:
      options.migrationAdvisoryLockRetryIntervalMs ?? 5000,
    advisoryLockMaxTries: options.migrationAdvisoryLockMaxTries ?? Infinity,
  } as const;
  const load = async (): Promise<Entry[]> =>
    entries(
      typeof options.migrations === "function"
        ? await options.migrations()
        : options.migrations,
    );

  // Ecto.Migration.SchemaMigration.ensure_schema_migrations_table!/3.
  const ensureTable = () =>
    runCommands(
      repo.kysely,
      adapter,
      record("up", (m) =>
        m.createIfNotExists(table(source), (t) => {
          t.add("version", "bigint", { primaryKey: true });
          t.add("inserted_at", "utc_datetime");
        }),
      ),
    );

  const versions = async (): Promise<Set<number>> => {
    const { rows } = await sql<{
      version: unknown;
    }>`SELECT version FROM ${sql.table(source)}`.execute(repo.kysely);
    return new Set(rows.map((row) => Number(row.version)));
  };

  /** Runs `fn` with the executed versions, holding the lock unless the migration disables it. */
  const locked = async <T>(
    entry: Entry,
    fn: (executed: Set<number>) => Promise<T>,
  ): Promise<T> =>
    lock !== false &&
    !entry.migration.disableMigrationLock &&
    adapter.lockForMigrations !== undefined
      ? adapter.lockForMigrations(
          { kysely: repo.kysely, poolSize: repo.config.poolSize },
          source,
          async () => fn(await versions()),
          lockOptions,
        )
      : fn(await versions());

  const execute = async (entry: Entry, direction: "up" | "down") => {
    try {
      let commands: Command[];
      if (direction === "up") commands = entry.migration.up();
      else if (entry.migration.down === undefined)
        throw new MigrationError(
          "it defines up but no down, so it cannot be rolled back",
        );
      else commands = entry.migration.down();
      warnConcurrentIndexes(entry, commands);
      // biome-ignore lint/suspicious/noExplicitAny: any database
      const body = async (q: Kysely<any>) => {
        await runCommands(q, adapter, commands);
        if (direction === "up")
          await sql`INSERT INTO ${sql.table(source)} (version, inserted_at) VALUES (${entry.version}, ${adapter.dump("utc_datetime", new Date())})`.execute(
            q,
          );
        else
          await sql`DELETE FROM ${sql.table(source)} WHERE version = ${entry.version}`.execute(
            q,
          );
      };
      if (entry.migration.disableDdlTransaction) await body(repo.kysely);
      else await repo.kysely.transaction().execute(body);
    } catch (error) {
      if (error instanceof Error)
        error.message = `migration ${entry.key} failed: ${error.message}`;
      throw error;
    }
  };

  /**
   * Ecto's runner warning for indexes created or dropped concurrently
   * without disabling the DDL transaction. Ecto also warns when the
   * migration lock is on, as its lock transaction holds a snapshot that
   * `CONCURRENTLY` waits for; ekto's runs nothing but `LOCK TABLE`, so it
   * holds none, and the lock can stay.
   */
  const warnConcurrentIndexes = (entry: Entry, commands: Command[]) => {
    if (entry.migration.disableDdlTransaction) return;
    for (const command of commands) {
      if (
        command.command === "executeReversible" ||
        !("object" in command) ||
        command.object.kind !== "index" ||
        !command.object.concurrently
      )
        continue;
      const index = command.object;
      process.emitWarning(
        `Migration ${entry.key} has set index \`${index.name}\` on table \`${index.table}\` to concurrently but did not disable ddl transaction. Please set:\n\n    migration({ disableDdlTransaction: true, ... })\n`,
      );
    }
  };

  /** Ecto.Migrator.run/4: picks the pending migrations, then runs each under the lock. */
  const run = async (
    direction: "up" | "down",
    opts: RunOptions,
  ): Promise<MigrationRun> => {
    positive("step", opts.step);
    integer("to", opts.to);
    integer("toExclusive", opts.toExclusive);
    const all = await load();
    await ensureTable();
    const executed = await versions();
    let pending =
      direction === "up"
        ? all.filter((e) => !executed.has(e.version))
        : all.filter((e) => executed.has(e.version)).reverse();
    const within = (target: number, inclusive: boolean) => (e: Entry) =>
      direction === "up"
        ? inclusive
          ? e.version <= target
          : e.version < target
        : inclusive
          ? e.version >= target
          : e.version > target;
    if (opts.all) {
      // every pending migration
    } else if (opts.to !== undefined)
      pending = pending.filter(within(opts.to, true));
    else if (opts.toExclusive !== undefined)
      pending = pending.filter(within(opts.toExclusive, false));
    else if (opts.step !== undefined) pending = pending.slice(0, opts.step);
    else
      throw new TypeError(
        "expected one of the all, to, toExclusive or step options",
      );
    const ran: MigrationInfo[] = [];
    for (const entry of pending) {
      const done = await locked(entry, async (current) => {
        // Another migrator may have run it since the pending ones were read.
        if (current.has(entry.version) === (direction === "up")) return false;
        await execute(entry, direction);
        return true;
      });
      if (done) ran.push({ version: entry.version, name: entry.name });
    }
    return ran;
  };

  return {
    migrate: (opts = { all: true }) =>
      run(
        "up",
        opts.to === undefined &&
          opts.toExclusive === undefined &&
          opts.step === undefined
          ? { all: true }
          : opts,
      ),
    rollback: (opts = { step: 1 }) =>
      run(
        "down",
        opts.all ||
          opts.to !== undefined ||
          opts.toExclusive !== undefined ||
          opts.step !== undefined
          ? opts
          : { step: 1 },
      ),

    async status() {
      const all = await load();
      await ensureTable();
      const executed = await versions();
      const known = new Set(all.map((e) => e.version));
      const statuses: MigrationStatus[] = all.map((e) => ({
        status: executed.has(e.version) ? "up" : "down",
        version: e.version,
        name: e.name,
      }));
      for (const version of executed)
        if (!known.has(version))
          statuses.push({ status: "up", version, name: FILE_NOT_FOUND });
      return statuses.sort((a, b) => a.version - b.version);
    },
  };
}

const MIGRATION_FILE = /\.(m|c)?(j|t)s$/;

/**
 * Loads the migrations in `folders` and their subfolders, as Ecto's
 * `migrations_paths`: every `.ts`, `.js`, `.mts`… file (declaration files
 * excepted) named `<version>_<name>` whose default export is a
 * `migration()`. Other files are ignored, as Ecto does.
 */
export function fileMigrations(
  folders: string | readonly string[],
): () => Promise<Migrations> {
  return async () => {
    const files: string[] = [];
    for (const folder of typeof folders === "string" ? [folders] : folders) {
      const dir = resolve(folder);
      let found: string[];
      try {
        found = await readdir(dir, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new MigrationError(
            `could not find migrations directory ${folder}`,
          );
        throw error;
      }
      for (const file of found) {
        const name = basename(file);
        if (
          MIGRATION_FILE.test(name) &&
          !/\.d\.(m|c)?ts$/.test(name) &&
          KEY.test(name.slice(0, -extname(name).length))
        )
          files.push(join(dir, file));
      }
    }
    const migrations: Record<string, Migration> = {};
    for (const file of files.sort()) {
      const key = basename(file, extname(file));
      if (key in migrations)
        throw new MigrationError(
          `migrations can't be executed, migration ${key} is duplicated`,
        );
      const module = await import(pathToFileURL(file).href);
      const migration = module.default;
      if (!isMigration(migration))
        throw new TypeError(
          `${basename(file)} must export a migration() as its default export`,
        );
      migrations[key] = migration;
    }
    return migrations;
  };
}
