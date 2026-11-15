/**
 * Multi: database operations to run together in one transaction, as data
 * (Ecto.Multi). Building a Multi runs nothing; `Repo.transact(multi)` runs
 * its operations in order and stops at the first failure.
 *
 * ```ts
 * const multi = Multi.new()
 *   .insert("user", userChangeset)
 *   .insert("profile", ({ user }) => profileChangeset(user, params))
 *   .run("email", async (tx, { user }) => sendWelcome(user));
 *
 * const result = await Repo.transact(multi);
 * if (result.ok) result.value.user;
 * else console.log(result.step, result.error, result.changesSoFar);
 * ```
 *
 * Each operation has a unique name; later operations receive the results of
 * earlier ones as `changes`, keyed by name.
 */

import type {
  Compilable,
  DeleteQueryBuilder,
  UpdateQueryBuilder,
} from "kysely";
import {
  type Action,
  type AnyChangeset,
  Changeset,
  isChangeset,
} from "./changeset.ts";
import type {
  DeleteOptions,
  InsertAllEntry,
  InsertAllOptions,
  InsertAllResult,
  InsertOptions,
  Repo,
  UpdateAll,
  UpdateOptions,
} from "./repo.ts";
import type { AnySchema, Inserted } from "./schema.ts";

/** The result of a `run` function (Ecto's `{:ok, value}` / `{:error, value}`). */
export type RunResult<T, E = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** The result of `Repo.transact(multi)`. */
export type MultiResult<C> =
  | { readonly ok: true; readonly value: C }
  | {
      readonly ok: false;
      /** The name of the operation that failed. */
      readonly step: keyof C & string;
      /** Its error: an invalid changeset, or what `run` or `error` gave. */
      readonly error: unknown;
      /** The results of the operations before it (rolled back). */
      readonly changesSoFar: Partial<C>;
    };

type Changes = Record<string, unknown>;
type Input<C, D extends object> =
  | Changeset<D>
  | D
  | ((changes: C) => Changeset<D> | D);
type Add<C, N extends string, V> = C & { readonly [K in N]: V };
type TableOf<DB, S extends AnySchema> = S["source"] & keyof DB & string;

/** One operation of a Multi; see `Multi.toList()`. */
export type Operation =
  | {
      readonly kind: "changeset";
      readonly action: "insert" | "update" | "delete" | "insertOrUpdate";
      readonly input: object | ((changes: Changes) => object);
      readonly options: object;
    }
  | {
      readonly kind: "insertAll";
      readonly schema: AnySchema;
      readonly entries:
        | readonly object[]
        | ((changes: Changes) => readonly object[]);
      readonly options: object;
    }
  | {
      readonly kind: "updateAll";
      readonly schema: AnySchema;
      readonly updates: object;
      readonly refine:
        | ((query: never, changes: Changes) => Compilable<unknown>)
        | undefined;
    }
  | {
      readonly kind: "deleteAll";
      readonly schema: AnySchema;
      readonly refine:
        | ((query: never, changes: Changes) => Compilable<unknown>)
        | undefined;
    }
  | {
      readonly kind: "run";
      readonly fn: (
        repo: Repo,
        changes: Changes,
      ) => Promise<RunResult<unknown>> | RunResult<unknown>;
    }
  | { readonly kind: "put"; readonly value: unknown }
  | { readonly kind: "error"; readonly value: unknown }
  | {
      readonly kind: "merge";
      /** Returns a Multi; checked when it runs. */
      readonly fn: (changes: Changes) => unknown;
    };

type Named = readonly [name: string, operation: Operation];

const mergeName = Symbol("merge");

/**
 * A sequence of named operations (Ecto.Multi). Immutable: every method
 * returns a new Multi. `DB` is the Kysely database type, for `updateAll` and
 * `deleteAll` refinements; `C` the results of the operations so far.
 */
// biome-ignore lint/suspicious/noExplicitAny: the database type defaults to any, as for Repo
// biome-ignore lint/complexity/noBannedTypes: no operations yet
export class Multi<DB = any, C extends Changes = {}> {
  readonly #operations: readonly (
    | Named
    | readonly [typeof mergeName, Operation]
  )[];
  readonly #names: ReadonlySet<string>;

  private constructor(
    operations: readonly (Named | readonly [typeof mergeName, Operation])[],
    names: ReadonlySet<string>,
  ) {
    this.#operations = operations;
    this.#names = names;
    Object.freeze(this);
  }

  /** An empty Multi (Ecto's `Multi.new/0`). */
  // biome-ignore lint/suspicious/noExplicitAny: the database type defaults to any, as for Repo
  // biome-ignore lint/complexity/noBannedTypes: no operations yet
  static new<DB = any>(): Multi<DB, {}> {
    return new Multi([], new Set());
  }

  #add<V, N extends string>(
    name: N,
    operation: Operation,
  ): Multi<DB, Add<C, N, V>> {
    if (this.#names.has(name)) {
      throw new TypeError(
        `${JSON.stringify(name)} is already a member of the Multi`,
      );
    }
    return new Multi(
      [...this.#operations, [name, operation]],
      new Set([...this.#names, name]),
    );
  }

  #changeset<V, N extends string>(
    action: "insert" | "update" | "delete" | "insertOrUpdate",
    name: N,
    input: object,
    options: object,
  ): Multi<DB, Add<C, N, V>> {
    const prepared =
      typeof input === "function"
        ? (input as (changes: Changes) => object)
        : isChangeset(input)
          ? putAction(input, action === "insertOrUpdate" ? null : action)
          : input;
    return this.#add(name, {
      kind: "changeset",
      action,
      input: prepared,
      options,
    });
  }

  /** Inserts a changeset or record (Ecto's `Multi.insert/4`); the result is the record. */
  insert<N extends string, D extends object>(
    name: N,
    input: Input<C, D>,
    options?: InsertOptions<D>,
  ): Multi<DB, Add<C, N, Inserted<D>>> {
    return this.#changeset("insert", name, input, options ?? {});
  }

  /** Updates a changeset (Ecto's `Multi.update/4`). */
  update<N extends string, D extends object>(
    name: N,
    changeset: Changeset<D> | ((changes: C) => Changeset<D>),
    options?: UpdateOptions<D>,
  ): Multi<DB, Add<C, N, D>> {
    return this.#changeset("update", name, changeset, options ?? {});
  }

  /** Deletes a record or changeset (Ecto's `Multi.delete/4`). */
  delete<N extends string, D extends object>(
    name: N,
    input: Input<C, D>,
    options?: DeleteOptions<D>,
  ): Multi<DB, Add<C, N, D>> {
    return this.#changeset("delete", name, input, options ?? {});
  }

  /** Inserts or updates a changeset by its record's state (Ecto's `Multi.insert_or_update/4`). */
  insertOrUpdate<N extends string, D extends object>(
    name: N,
    changeset: Changeset<D> | ((changes: C) => Changeset<D>),
    options?: InsertOptions<D> & UpdateOptions<D>,
  ): Multi<DB, Add<C, N, D>> {
    return this.#changeset("insertOrUpdate", name, changeset, options ?? {});
  }

  /** Inserts many rows (Ecto's `Multi.insert_all/5`); the result is `{ count, rows }`. */
  insertAll<N extends string, S extends AnySchema>(
    name: N,
    schema: S,
    entries:
      | readonly InsertAllEntry<S>[]
      | ((changes: C) => readonly InsertAllEntry<S>[]),
    options?: InsertAllOptions<S>,
  ): Multi<DB, Add<C, N, InsertAllResult<S>>> {
    return this.#add(name, {
      kind: "insertAll",
      schema,
      entries: entries as never,
      options: options ?? {},
    });
  }

  /** Updates many rows (Ecto's `Multi.update_all/5`); the result is `{ count }`. */
  updateAll<N extends string, S extends AnySchema>(
    name: N,
    schema: S,
    updates: UpdateAll<S>,
    refine?: (
      query: UpdateQueryBuilder<DB, TableOf<DB, S>, TableOf<DB, S>, never>,
      changes: C,
    ) => Compilable<unknown>,
  ): Multi<DB, Add<C, N, { readonly count: number }>> {
    return this.#add(name, {
      kind: "updateAll",
      schema,
      updates,
      refine: refine as (query: never, changes: Changes) => Compilable<unknown>,
    });
  }

  /** Deletes many rows (Ecto's `Multi.delete_all/4`); the result is `{ count }`. */
  deleteAll<N extends string, S extends AnySchema>(
    name: N,
    schema: S,
    refine?: (
      query: DeleteQueryBuilder<DB, TableOf<DB, S>, never>,
      changes: C,
    ) => Compilable<unknown>,
  ): Multi<DB, Add<C, N, { readonly count: number }>> {
    return this.#add(name, {
      kind: "deleteAll",
      schema,
      refine: refine as (query: never, changes: Changes) => Compilable<unknown>,
    });
  }

  /**
   * Runs a function in the transaction (Ecto's `Multi.run/3`). It gets the
   * transaction's Repo and the changes so far, and returns `{ ok: true,
   * value }` or `{ ok: false, error }`.
   */
  run<N extends string, T>(
    name: N,
    fn: (repo: Repo<DB>, changes: C) => Promise<RunResult<T>> | RunResult<T>,
  ): Multi<DB, Add<C, N, T>> {
    return this.#add(name, { kind: "run", fn: fn as never });
  }

  /** Adds a value to the changes (Ecto's `Multi.put/3`). */
  put<N extends string, T>(name: N, value: T): Multi<DB, Add<C, N, T>> {
    return this.#add(name, { kind: "put", value });
  }

  /** Fails at this step with `value` (Ecto's `Multi.error/3`). */
  error<N extends string>(
    name: N,
    value: unknown,
  ): Multi<DB, Add<C, N, never>> {
    return this.#add(name, { kind: "error", value });
  }

  /**
   * Runs the Multi `fn` returns, built from the changes so far, in the same
   * transaction (Ecto's `Multi.merge/2`). Its names must not clash.
   */
  merge<M extends Changes>(
    fn: (changes: C) => Multi<DB, M> | Promise<Multi<DB, M>>,
  ): Multi<DB, C & M> {
    return new Multi(
      [...this.#operations, [mergeName, { kind: "merge", fn: fn as never }]],
      this.#names,
    );
  }

  /** This Multi's operations followed by `other`'s (Ecto's `Multi.append/2`). */
  append<M extends Changes>(other: Multi<DB, M>): Multi<DB, C & M> {
    return Multi.#join(this, other);
  }

  /** `other`'s operations followed by this Multi's (Ecto's `Multi.prepend/2`). */
  prepend<M extends Changes>(other: Multi<DB, M>): Multi<DB, M & C> {
    return Multi.#join(other, this);
  }

  static #join<DB, R extends Changes>(
    // biome-ignore lint/suspicious/noExplicitAny: any changes
    first: Multi<DB, any>,
    // biome-ignore lint/suspicious/noExplicitAny: any changes
    second: Multi<DB, any>,
  ): Multi<DB, R> {
    const common = [...second.#names].filter((name) => first.#names.has(name));
    if (common.length > 0) {
      throw new TypeError(
        `both Multis have operations named ${common.map((n) => JSON.stringify(n)).join(", ")}`,
      );
    }
    return new Multi(
      [...first.#operations, ...second.#operations],
      new Set([...first.#names, ...second.#names]),
    );
  }

  /**
   * The operations with their names, in order (Ecto's `Multi.to_list/1`).
   * Merges have no name (`undefined`).
   */
  toList(): readonly (readonly [string | undefined, Operation])[] {
    return this.#operations.map(([name, operation]) => [
      typeof name === "string" ? name : undefined,
      operation,
    ]);
  }

  /** Whether an operation has this name. */
  has(name: string): boolean {
    return this.#names.has(name);
  }
}

/** Sets a changeset's action, rejecting a different one (Ecto's `put_action`). */
function putAction(
  changeset: AnyChangeset,
  action: Action | null,
): AnyChangeset {
  if (action === null || changeset.action === action) return changeset;
  if (changeset.action !== null) {
    throw new TypeError(
      `a changeset with action "${changeset.action}" was given to Multi.${action}`,
    );
  }
  return new Changeset({ ...changeset, action });
}
