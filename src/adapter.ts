/**
 * Adapters and the executor: how ekto talks to a database.
 *
 * ekto does not open connections. It runs its SQL through the Kysely
 * instance the application already has (`db.executeQuery`), so pools,
 * dialects, plugins and logging stay the application's. The adapter only
 * knows the dialect: how to write SQL and how the driver represents values
 * (Ecto's adapter `loaders/2` and `dumpers/2`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CompiledQuery, type Kysely } from "kysely";
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

/** Thrown inside a transaction to roll it back with a value (Ecto's `rollback/1`). */
class Rollback {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

/**
 * Runs queries on a Kysely instance, following the transaction the current
 * async context is in (Ecto keeps the connection in the process dictionary;
 * Node has `AsyncLocalStorage`).
 */
export class Executor<DB = unknown> {
  readonly #root: Kysely<DB>;
  readonly #current = new AsyncLocalStorage<Kysely<DB>>();
  readonly #onQuery: ((event: QueryEvent) => void) | undefined;

  constructor(db: Kysely<DB>, onQuery?: (event: QueryEvent) => void) {
    this.#root = db;
    this.#onQuery = onQuery;
  }

  /** The Kysely instance of the current transaction, or the root one. */
  get db(): Kysely<DB> {
    return this.#current.getStore() ?? this.#root;
  }

  get inTransaction(): boolean {
    return this.db.isTransaction;
  }

  async execute(
    query: Queryable,
    source: string | undefined = undefined,
  ): Promise<QueryResult> {
    const start = performance.now();
    let error: unknown;
    try {
      const result = await this.db.executeQuery<Record<string, unknown>>(
        CompiledQuery.raw(query.sql, [...query.params]),
      );
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
        sql: query.sql,
        params: query.params,
        source,
        durationMs: performance.now() - start,
        error,
      });
    }
  }

  /**
   * Runs `fn` in a transaction. Inside a transaction already, `fn` runs in
   * that one, as Ecto's nested transactions do. Throwing rolls back and
   * rethrows; `rollback(value)` rolls back and makes this return `value`.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn();
    try {
      return await this.#root
        .transaction()
        .execute((trx) => this.#current.run(trx, fn));
    } catch (e) {
      if (e instanceof Rollback) return e.value as T;
      throw e;
    }
  }

  /** Rolls back the current transaction; `transaction` returns `value`. */
  rollback(value: unknown): never {
    if (!this.inTransaction)
      throw new Error("cannot call rollback outside of transaction");
    throw new Rollback(value);
  }
}
