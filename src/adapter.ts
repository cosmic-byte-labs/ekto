/**
 * Adapters and the executor: how ekto talks to a database.
 *
 * ekto does not open connections. It runs its SQL through the Kysely
 * instance the application already has (`db.executeQuery`), so pools,
 * dialects, plugins and logging stay the application's. The adapter only
 * knows the dialect: how to write SQL and how the driver represents values
 * (Ecto's adapter `loaders/2` and `dumpers/2`).
 */

import {
  CompiledQuery,
  type ControlledTransaction,
  isCompiledQuery,
  type Kysely,
} from "kysely";
import type { ConstraintType } from "./changeset.ts";
import type { DdlCommand } from "./migrate/dsl.ts";
import type { Queryable, SqlSyntax } from "./sql.ts";
import type { PrimitiveType } from "./type.ts";

/** A dialect: SQL syntax and the driver's value representation. */
export interface Adapter {
  readonly name: string;
  readonly syntax: SqlSyntax;
  /**
   * Converts a value the driver returned into what the type loads (Ecto's
   * adapter loaders), e.g. a Postgres `int8` string into a number. Never
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

/**
 * Runs queries on one Kysely handle: the application's instance, or a
 * transaction or savepoint ekto started on it. Ecto finds the transaction
 * of the calling process implicitly; ekto passes it explicitly, as a Repo
 * bound to an `Executor` (design D7).
 */
export class Executor<DB = unknown> {
  readonly db: Kysely<DB>;
  readonly #onQuery: ((event: QueryEvent) => void) | undefined;
  /** 0 outside a transaction, 1 in one, more in savepoints. */
  readonly #depth: number;

  constructor(
    db: Kysely<DB>,
    onQuery?: (event: QueryEvent) => void,
    depth = 0,
  ) {
    this.db = db;
    this.#onQuery = onQuery;
    this.#depth = depth;
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
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
      this.#onQuery?.({
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
    const depth = this.#depth + 1;
    let done: (ok: boolean) => Promise<unknown>;
    let handle: Kysely<DB>;
    if (this.#depth === 0) {
      const trx = await this.db.startTransaction().execute();
      handle = trx;
      done = (ok) => (ok ? trx.commit() : trx.rollback()).execute();
    } else {
      const name = `ekto_savepoint_${depth}`;
      const trx = this.db as ControlledTransaction<DB>;
      const savepoint = await trx.savepoint(name).execute();
      handle = savepoint;
      done = (ok) =>
        (ok
          ? savepoint.releaseSavepoint(name)
          : savepoint.rollbackToSavepoint(name)
        ).execute();
    }
    let result: T;
    try {
      result = await fn(new Executor(handle, this.#onQuery, depth));
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
