/**
 * Adapters and the executor: how ekto talks to a database.
 *
 * As Ecto's Repo, a Repo owns its connections: the adapter opens them with
 * the Repo's connection options (Ecto's `Ecto.Adapter.init/1`), in a pool
 * of `poolSize` that ekto keeps, and ekto runs its SQL through a Kysely
 * instance on that pool (`repo.kysely`), so Kysely plugins still apply.
 * The adapter also knows the dialect: how to write SQL and how the driver
 * represents values (Ecto's adapter `loaders/2` and `dumpers/2`).
 */

import type { ConnectionOptions as TlsOptions } from "node:tls";
import {
  CompiledQuery,
  type ControlledTransaction,
  type DatabaseConnection,
  type Dialect,
  isCompiledQuery,
  type Kysely,
} from "kysely";
import type { ConstraintType } from "./changeset.ts";
import type {
  ColumnOptions,
  ColumnType,
  DdlCommand,
  Reference,
} from "./migrate/dsl.ts";
import type { Queryable, SqlSyntax } from "./sql.ts";
import type { PrimitiveType } from "./type.ts";

/**
 * How a Repo connects (Ecto's Repo configuration). Each adapter reads the
 * options it knows: PostgreSQL `url` or `hostname`, `port`, `database`,
 * `username`, `password`, `socketDir` and `ssl`; SQLite `database`,
 * `journalMode`, `busyTimeout` and `foreignKeys`.
 */
export interface ConnectionOptions {
  /** A connection URL, e.g. `postgres://user:pass@localhost/app_dev`. */
  readonly url?: string;
  readonly hostname?: string;
  readonly port?: number;
  /** The database name, or for SQLite the file path (or `":memory:"`). */
  readonly database?: string;
  readonly username?: string;
  readonly password?: string;
  /** The directory of the server's Unix socket, instead of a hostname. */
  readonly socketDir?: string;
  readonly ssl?: boolean | TlsOptions;
  /** SQLite's `journal_mode` (ecto_sqlite3's default: `wal`). */
  readonly journalMode?:
    | "delete"
    | "truncate"
    | "persist"
    | "memory"
    | "wal"
    | "off";
  /** SQLite's `busy_timeout` in ms (default 2000). */
  readonly busyTimeout?: number;
  /** SQLite's `foreign_keys` (default on). */
  readonly foreignKeys?: boolean;
}

/** What an adapter knows of the Repo it runs a migration lock for (Ecto's adapter meta). */
export interface AdapterMeta {
  /** The Repo's Kysely instance, on its pool. */
  // biome-ignore lint/suspicious/noExplicitAny: any database
  readonly kysely: Kysely<any>;
  /** The number of connections in the Repo's pool. */
  readonly poolSize: number;
}

/**
 * How an adapter locks for migrations (Ecto's `:migration_lock` and the
 * `:migration_advisory_lock_*` Repo options).
 */
export interface MigrationLockOptions {
  /**
   * `tableLock` (the default) locks the migrations table in a transaction;
   * `pgAdvisoryLock` (PostgreSQL) takes a session advisory lock, with no
   * transaction open.
   */
  readonly strategy: MigrationLockStrategy;
  /** How long to wait before trying again for a held advisory lock. */
  readonly advisoryLockRetryIntervalMs: number;
  /** How many times to try again for a held advisory lock before failing. */
  readonly advisoryLockMaxTries: number;
}

/** Ecto's `:table_lock` and `:pg_advisory_lock`. */
export type MigrationLockStrategy = "tableLock" | "pgAdvisoryLock";

/** A dialect: connections, SQL syntax and the driver's value representation. */
export interface Adapter {
  readonly name: string;
  readonly syntax: SqlSyntax;
  /** The pool size of a Repo that sets none. */
  readonly defaultPoolSize: number;
  /**
   * The Kysely dialect connecting with `options` (Ecto's
   * `Ecto.Adapter.init/1`). Each driver it creates holds one connection
   * (a DBConnection connection); the Repo's pool creates up to `poolSize`
   * of them.
   */
  connect(options: ConnectionOptions, poolSize: number): Dialect;
  /**
   * Checks an idle connection (DBConnection's `ping/1`); when it throws,
   * the pool closes the connection. Without it, idle connections are left
   * as they are, as Exqlite's ping does.
   */
  ping?(connection: DatabaseConnection): Promise<void>;
  /**
   * Converts a value the driver returned into what the type loads (Ecto's
   * adapter loaders), e.g. a PostgreSQL `int8` string into a number. Never
   * called with `null`.
   */
  load(type: PrimitiveType, value: unknown): unknown;
  /**
   * Converts a dumped value into what the driver accepts (Ecto's adapter
   * dumpers). Never called with `null`.
   */
  dump(type: PrimitiveType, value: unknown): unknown;
  /**
   * The constraints a database error reports as violated, or none when it
   * is not a constraint violation (Ecto's `to_constraints/2`).
   */
  toConstraints(error: unknown): readonly ConstraintViolation[];
  /**
   * The SQL statements for a migration command (Ecto's `execute_ddl/1`).
   * Adapters without it cannot run migrations.
   */
  ddl?(command: DdlCommand): readonly string[];
  /**
   * The database type of a migration column type or reference (Ecto's
   * `column_type/2`), e.g. `varchar(255)` for `string` on PostgreSQL. Used
   * to generate migrations for other tools.
   */
  columnType?(type: ColumnType | Reference, options?: ColumnOptions): string;
  /**
   * Runs `fn` holding the lock that keeps two migrators from running the
   * same migration (Ecto's `lock_for_migrations/3`); `table` is the
   * migrations table. `fn` runs its queries on `meta.kysely`, not on the
   * lock's connection. Adapters without it run migrations unlocked.
   */
  lockForMigrations?<T>(
    meta: AdapterMeta,
    table: string,
    fn: () => Promise<T>,
    options: MigrationLockOptions,
  ): Promise<T>;
  /**
   * The tables of the database (its current schema), with their columns,
   * primary keys, foreign keys and unique indexes. Used to generate schemas
   * for an existing database (`ekto gen.schemas`).
   */
  // biome-ignore lint/suspicious/noExplicitAny: any database
  describeTables?(db: Kysely<any>): Promise<readonly TableDescription[]>;
}

/** A table, as `Adapter.describeTables` finds it. */
export interface TableDescription {
  readonly name: string;
  /** In table order. */
  readonly columns: readonly ColumnDescription[];
  /** Single-column foreign keys. */
  readonly foreignKeys: readonly {
    readonly column: string;
    readonly table: string;
    readonly references: string;
  }[];
  /** Single-column unique indexes (without conditions or expressions). */
  readonly uniqueIndexes: readonly {
    readonly column: string;
    readonly name: string;
  }[];
}

export interface ColumnDescription {
  readonly name: string;
  /** The database's type, e.g. `int8` or `varchar`. */
  readonly dbType: string;
  /** The migration type it corresponds to, if any (e.g. `bigint`, `string`). */
  readonly type: ColumnType | undefined;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly primaryKey: boolean;
  /** Generated by the database (serial, identity or SQLite's rowid). */
  readonly generated: boolean;
}

/** A constraint the database reported as violated. */
export interface ConstraintViolation {
  readonly type: ConstraintType;
  /**
   * The constraint name, or `null` when the database does not report it
   * (SQLite foreign keys). A violation without a name matches no declared
   * constraint, so it is always thrown as a `ConstraintError`.
   */
  readonly constraint: string | null;
}

/** The rows a query returned and the number of rows it affected. */
export interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly numAffectedRows: number | undefined;
}

/** Reported after every query ekto runs (Ecto's telemetry `[:repo, :query]` event). */
export interface QueryEvent {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** The table the query is about, for queries on a schema. */
  readonly source: string | undefined;
  readonly durationMs: number;
  readonly error: unknown;
}

/** What the executors of a Repo share. */
export interface ExecutorContext {
  /** The Repo's configuration, with its pool size. */
  readonly config: { readonly poolSize: number };
  readonly onQuery: ((event: QueryEvent) => void) | undefined;
  /** Closes the Repo's connections. */
  readonly stop: () => Promise<void>;
}

/**
 * Runs queries on one Kysely handle: the Repo's instance, or a
 * transaction or savepoint ekto started on it. Ecto finds the transaction
 * of the calling process implicitly; ekto passes it explicitly, as a Repo
 * bound to an `Executor` (design D7).
 */
export class Executor<DB = unknown> {
  readonly db: Kysely<DB>;
  /** Shared by the executors of a Repo and its transactions. */
  readonly context: ExecutorContext;
  /** 0 outside a transaction, 1 in one, more in savepoints. */
  readonly #depth: number;
  /**
   * The depth that counts as "not in a transaction": 1 in the test sandbox,
   * whose transaction is invisible to the code under test.
   */
  readonly #base: number;

  constructor(db: Kysely<DB>, context: ExecutorContext, depth = 0, base = 0) {
    this.db = db;
    this.context = context;
    this.#depth = depth;
    this.#base = base;
  }

  get inTransaction(): boolean {
    return this.#depth > this.#base;
  }

  /**
   * Starts a transaction, or a savepoint when this executor is already in
   * one, and returns an executor on it with the function that ends it:
   * `end(true)` commits (or releases the savepoint), `end(false)` rolls
   * back. With `sandbox`, the new executor reports no transaction, as code
   * in Ecto's SQL sandbox sees none.
   */
  async begin(
    sandbox = false,
  ): Promise<{ executor: Executor<DB>; end: (ok: boolean) => Promise<void> }> {
    const depth = this.#depth + 1;
    const base = sandbox ? depth : this.#base;
    if (this.#depth === 0) {
      const trx = await this.db.startTransaction().execute();
      return {
        executor: new Executor(trx, this.context, depth, base),
        end: async (ok) => {
          await (ok ? trx.commit() : trx.rollback()).execute();
        },
      };
    }
    const name = `ekto_savepoint_${depth}`;
    const trx = this.db as ControlledTransaction<DB>;
    const savepoint = await trx.savepoint(name).execute();
    return {
      executor: new Executor(savepoint, this.context, depth, base),
      end: async (ok) => {
        await (ok
          ? savepoint.releaseSavepoint(name)
          : savepoint.rollbackToSavepoint(name)
        ).execute();
      },
    };
  }

  /**
   * Runs a query on this handle. A Kysely `CompiledQuery` is run as is, so
   * plugins see the query they compiled.
   */
  async execute(
    query: Queryable | CompiledQuery,
    source: string | undefined = undefined,
  ): Promise<QueryResult> {
    const compiled = isCompiledQuery(query)
      ? query
      : CompiledQuery.raw(query.sql, [...(query as Queryable).params]);
    const start = performance.now();
    let error: unknown;
    try {
      const result =
        await this.db.executeQuery<Record<string, unknown>>(compiled);
      return {
        rows: result.rows,
        numAffectedRows:
          result.numAffectedRows === undefined
            ? undefined
            : Number(result.numAffectedRows),
      };
    } catch (e) {
      error = e;
      throw e;
    } finally {
      this.context.onQuery?.({
        sql: compiled.sql,
        params: compiled.parameters,
        source,
        durationMs: performance.now() - start,
        error,
      });
    }
  }

  /**
   * Runs `fn` with an executor in a new transaction, or in a savepoint when
   * this one is already in a transaction. Commits (or releases the
   * savepoint) when `commit(result)` holds, rolls back otherwise, and rolls
   * back and rethrows when `fn` throws.
   */
  async transaction<T>(
    fn: (executor: Executor<DB>) => Promise<T>,
    commit: (result: T) => boolean,
  ): Promise<T> {
    const { executor, end: done } = await this.begin();
    let result: T;
    try {
      result = await fn(executor);
    } catch (error) {
      try {
        await done(false);
      } catch {
        // Keep the original error; the connection is likely broken.
      }
      throw error;
    }
    await done(commit(result));
    return result;
  }
}
