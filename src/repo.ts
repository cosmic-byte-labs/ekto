/**
 * The Repo: the only part of ekto that touches the database. Modelled on
 * `Ecto.Repo` (and `Ecto.Repo.Schema` for writes).
 *
 * ```ts
 * const Repo = createRepo({ db, adapter: postgres() });
 * const result = await Repo.insert(changeset);
 * if (result.ok) console.log(result.value.id);
 * else console.log(traverseErrors(result.changeset));
 * ```
 *
 * Writes return `{ ok: true, value }` or `{ ok: false, changeset }` like
 * Ecto's `{:ok, struct}` / `{:error, changeset}`; each has an `…OrThrow`
 * variant (Ecto's `insert!`). Unexpected failures (a stale entry, a value
 * that cannot be dumped, a database error) are thrown.
 */

import { inspect } from "node:util";
import {
  type Compilable,
  CompiledQuery,
  type DeleteQueryBuilder,
  type DeleteResult,
  type InsertResult,
  isCompilable,
  isCompiledQuery,
  type Kysely,
  type MergeResult,
  type RawBuilder,
  type UpdateQueryBuilder,
  type UpdateResult,
} from "kysely";
import {
  type Adapter,
  type ConstraintViolation,
  Executor,
  type QueryEvent,
  type QueryResult,
} from "./adapter.ts";
import {
  type Action,
  type AnyChangeset,
  addError,
  Changeset,
  type ChangesetError,
  type Constraint,
  change,
  InvalidChangesetError,
  isChangeset,
} from "./changeset.ts";
import {
  ChangeError,
  ConstraintError,
  MultiplePrimaryKeyError,
  MultipleResultsError,
  NoPrimaryKeyFieldError,
  NoPrimaryKeyValueError,
  NoResultsError,
  SchemaMismatchError,
  StaleEntryError,
} from "./errors.ts";
import type { DriverTypes, KyselyTable } from "./kysely.ts";
import {
  type AnyField,
  type AnySchema,
  getMeta,
  type Infer,
  isSchema,
  type Loader,
  load,
  putMeta,
  type RecordState,
} from "./schema.ts";
import { isQueryable, type Queryable, Sql, sql } from "./sql.ts";
import {
  CastError,
  castValue,
  dumpValue,
  formatType,
  loadValue,
  type Type,
} from "./type.ts";

/** The result of a write: the written record, or the changeset with errors. */
export type WriteResult<D extends object> =
  | { readonly ok: true; readonly value: D }
  | { readonly ok: false; readonly changeset: Changeset<D> };

interface ReturningOptions<D> {
  /**
   * Fields to read back from the database after the write: `true` for all
   * of them (Ecto's `:returning`). Fields marked `.readAfterWrites()` are
   * always read back.
   */
  readonly returning?: boolean | readonly (keyof D & string)[];
}

interface StaleOptions<D> {
  /** Treat a write that matched no row as successful (Ecto's `:allow_stale`). */
  readonly allowStale?: boolean;
  /**
   * Return an error on this field instead of throwing `StaleEntryError`
   * (Ecto's `:stale_error_field`).
   */
  readonly staleErrorField?: keyof D & string;
  /** The message of that error; defaults to "is stale". */
  readonly staleErrorMessage?: string;
}

/**
 * What to do when an insert violates a unique constraint (Ecto's
 * `:on_conflict`): raise (the default), do nothing, or update the existing
 * row with the inserted values of some or all fields. Replacing all fields
 * includes the primary key and fields the insert did not set.
 */
export type OnConflict<D> =
  | "raise"
  | "nothing"
  | "replaceAll"
  | { readonly replace: readonly (keyof D & string)[] }
  | { readonly replaceAllExcept: readonly (keyof D & string)[] };

interface ConflictOptions<D> {
  readonly onConflict?: OnConflict<D>;
  /**
   * The columns of the unique index the conflict is on (Ecto's
   * `:conflict_target`), or a raw SQL fragment such as
   * `"(email) WHERE deleted_at IS NULL"`. Required by Postgres to update.
   */
  readonly conflictTarget?:
    | readonly (keyof D & string)[]
    | { readonly unsafeFragment: string };
}

/**
 * With `onConflict: "nothing"`, an insert that conflicted returns the record
 * without reading anything back (so without a generated id), as Ecto does.
 */
export interface InsertOptions<D>
  extends ReturningOptions<D>,
    ConflictOptions<D> {}

/** The persisted fields of a schema (its Kysely table's columns). */
export type PersistedName<S extends AnySchema> = keyof KyselyTable<
  S,
  DriverTypes
> &
  string;

/** A row for `insertAll`: values of persisted fields; missing ones get their column default. */
export type InsertAllEntry<S extends AnySchema> = {
  readonly [K in PersistedName<S>]?: Infer<S>[K];
};

export interface InsertAllOptions<S extends AnySchema>
  extends ConflictOptions<Infer<S>> {
  /** Fields to read back, `true` for all; they are loaded as records. */
  readonly returning?: boolean | readonly PersistedName<S>[];
}

/** The result of `insertAll`. */
export interface InsertAllResult<S extends AnySchema> {
  /** The rows inserted (or updated, on conflict). */
  readonly count: number;
  /** The records read back with `returning`; empty without it. */
  readonly rows: Infer<S>[];
}

/** The updates of `updateAll` (Ecto's `update_all` keyword list). */
export interface UpdateAll<S extends AnySchema> {
  /** Values to set; cast and dumped through the field types. */
  readonly set?: { readonly [K in PersistedName<S>]?: Infer<S>[K] };
  /** Amounts to add to numeric fields. */
  readonly inc?: { readonly [K in PersistedName<S>]?: number };
}

type TableOf<DB, S extends AnySchema> = S["source"] & keyof DB & string;

export interface UpdateOptions<D> extends ReturningOptions<D>, StaleOptions<D> {
  /**
   * Update even without changes, e.g. to bump `updated_at` (Ecto's `:force`).
   */
  readonly force?: boolean;
}

export interface DeleteOptions<D>
  extends ReturningOptions<D>,
    StaleOptions<D> {}

/**
 * A query the Repo runs: a `Queryable` (`{ sql, params }`), ekto's `sql`
 * tag, or a Kysely query (a builder, its `CompiledQuery`, or Kysely's own
 * `sql` tag).
 */
export type Query<Row = unknown> =
  | Queryable<Row>
  | Sql<Row>
  | Compilable<Row>
  | CompiledQuery<Row>
  | RawBuilder<Row>;

/** The row type of a query; untyped queries give `Record<string, unknown>`. */
export type RowOf<Q> = RowType<
  Q extends Sql<infer R>
    ? R
    : Q extends RawBuilder<infer R>
      ? R
      : Q extends Compilable<infer R>
        ? R
        : Q extends CompiledQuery<infer R>
          ? R
          : Q extends Queryable<infer R>
            ? R
            : unknown
>;
type RowType<R> = unknown extends R ? Record<string, unknown> : R;

/**
 * Type check for `Repo.all(Schema, query)`: a typed query must select every
 * persisted column of the schema. Untyped queries are checked at runtime.
 */
export type SchemaQuery<S extends AnySchema, Q> =
  RowOf<Q> extends Record<string, unknown>
    ? Record<string, unknown> extends RowOf<Q>
      ? Q
      : MissingColumns<S, Q>
    : MissingColumns<S, Q>;
type MissingColumns<S extends AnySchema, Q> = [
  Exclude<keyof KyselyTable<S, DriverTypes>, keyof RowOf<Q>>,
] extends [never]
  ? Q
  : Q & {
      readonly "query does not select the columns": Exclude<
        keyof KyselyTable<S, DriverTypes>,
        keyof RowOf<Q>
      >;
    };

/** Kysely's results of writes without `returning`, which return no rows. */
type ExecRow<R> = [R] extends [
  InsertResult | UpdateResult | DeleteResult | MergeResult,
]
  ? never
  : R;

/** The result of `Repo.query`. */
export interface QueryRows<R> {
  readonly rows: R[];
  /** The rows returned, or affected by a write. */
  readonly rowCount: number;
}

/** The result of `Repo.exec`. */
export interface ExecResult<R> {
  /** The rows the write affected. */
  readonly rowCount: number;
  /** The rows it returned (with `returning`). */
  readonly rows: R[];
}

export interface RepoConfig<DB> {
  /** The application's Kysely instance; ekto runs its queries through it. */
  readonly db: Kysely<DB>;
  /** The dialect, e.g. `postgres()` from `ekto/postgres`. */
  readonly adapter: Adapter;
  /** Called after every query ekto runs, e.g. for logging. */
  readonly onQuery?: (event: QueryEvent) => void;
}

// biome-ignore lint/suspicious/noExplicitAny: a Repo over any database type
export interface Repo<DB = any> {
  readonly adapter: Adapter;
  /**
   * The Kysely instance for the current transaction (or the root one), for
   * queries ekto does not build.
   */
  readonly kysely: Kysely<DB>;
  /** Whether the current async context is inside a transaction. */
  readonly inTransaction: boolean;

  /**
   * Inserts a record or a changeset (Ecto's `Repo.insert/2`). Non-null
   * fields of the record are inserted along with the changes.
   */
  insert<D extends object>(
    input: Changeset<D> | D,
    options?: InsertOptions<D>,
  ): Promise<WriteResult<D>>;
  /** Like `insert`, but throws `InvalidChangesetError` instead of returning an error. */
  insertOrThrow<D extends object>(
    input: Changeset<D> | D,
    options?: InsertOptions<D>,
  ): Promise<D>;

  /**
   * Updates the changes of a changeset by primary key (Ecto's
   * `Repo.update/2`). Without changes, no query runs.
   */
  update<D extends object>(
    changeset: Changeset<D>,
    options?: UpdateOptions<D>,
  ): Promise<WriteResult<D>>;
  updateOrThrow<D extends object>(
    changeset: Changeset<D>,
    options?: UpdateOptions<D>,
  ): Promise<D>;

  /** Deletes a record or a changeset's record by primary key (Ecto's `Repo.delete/2`). */
  delete<D extends object>(
    input: Changeset<D> | D,
    options?: DeleteOptions<D>,
  ): Promise<WriteResult<D>>;
  deleteOrThrow<D extends object>(
    input: Changeset<D> | D,
    options?: DeleteOptions<D>,
  ): Promise<D>;

  /** Fetches a record by primary key, or `null` (Ecto's `Repo.get/3`). */
  get<S extends AnySchema>(schema: S, id: unknown): Promise<Infer<S> | null>;
  /** Like `get`, but throws `NoResultsError` when there is no such record. */
  getOrThrow<S extends AnySchema>(schema: S, id: unknown): Promise<Infer<S>>;
  /**
   * Fetches the record whose fields equal the given values, or `null`
   * (Ecto's `Repo.get_by/3`). Throws `MultipleResultsError` when more than
   * one matches.
   */
  getBy<S extends AnySchema>(
    schema: S,
    clauses: Readonly<Partial<Infer<S>>>,
  ): Promise<Infer<S> | null>;
  getByOrThrow<S extends AnySchema>(
    schema: S,
    clauses: Readonly<Partial<Infer<S>>>,
  ): Promise<Infer<S>>;

  /**
   * Fetches all records of a schema (Ecto's `Repo.all/2`). With a query,
   * its rows are loaded through the schema; they must contain every
   * persisted column (else `SchemaMismatchError`), and other columns are
   * dropped. Without a schema, the rows are returned as the driver gives
   * them. Writes are rejected; use `exec`.
   */
  all<S extends AnySchema>(schema: S): Promise<Infer<S>[]>;
  all<S extends AnySchema, Q extends Query>(
    schema: S,
    query: SchemaQuery<S, Q>,
  ): Promise<Infer<S>[]>;
  all<Q extends Query>(query: Q): Promise<RowOf<Q>[]>;

  /**
   * Like `all`, but returns one record (or row) or `null`, and throws
   * `MultipleResultsError` when the query returns more (Ecto's `Repo.one/2`).
   */
  one<S extends AnySchema>(schema: S): Promise<Infer<S> | null>;
  one<S extends AnySchema, Q extends Query>(
    schema: S,
    query: SchemaQuery<S, Q>,
  ): Promise<Infer<S> | null>;
  one<Q extends Query>(query: Q): Promise<RowOf<Q> | null>;
  /** Like `one`, but throws `NoResultsError` instead of returning `null`. */
  oneOrThrow<S extends AnySchema>(schema: S): Promise<Infer<S>>;
  oneOrThrow<S extends AnySchema, Q extends Query>(
    schema: S,
    query: SchemaQuery<S, Q>,
  ): Promise<Infer<S>>;
  oneOrThrow<Q extends Query>(query: Q): Promise<RowOf<Q>>;

  /**
   * Runs a query and returns its rows as the driver gives them (Ecto's
   * `Repo.query/3`). Kysely writes are rejected; use `exec`.
   */
  query<Q extends Query>(query: Q): Promise<QueryRows<RowOf<Q>>>;

  /**
   * Runs a write such as a Kysely `deleteFrom` and returns the number of
   * affected rows. Such writes bypass changesets: nothing is cast,
   * validated or generated, and constraint violations are thrown as
   * `ConstraintError`.
   */
  exec<Q extends Query>(query: Q): Promise<ExecResult<ExecRow<RowOf<Q>>>>;

  /**
   * Inserts many rows in one query (Ecto's `Repo.insert_all/3`). Values are
   * dumped through the field types but not cast or validated, and nothing
   * is generated (no timestamps). Constraint violations are thrown as
   * `ConstraintError`.
   */
  insertAll<S extends AnySchema>(
    schema: S,
    entries: readonly InsertAllEntry<S>[],
    options?: InsertAllOptions<S>,
  ): Promise<InsertAllResult<S>>;

  /**
   * Updates all rows of a schema's table, or those the Kysely query
   * `refine` returns selects (Ecto's `Repo.update_all/3`). Values are cast
   * and dumped through the field types; `updated_at` is not touched.
   */
  updateAll<S extends AnySchema>(
    schema: S,
    updates: UpdateAll<S>,
    refine?: (
      query: UpdateQueryBuilder<
        DB,
        TableOf<DB, S>,
        TableOf<DB, S>,
        UpdateResult
      >,
    ) => Compilable<unknown>,
  ): Promise<{ readonly count: number }>;

  /** Deletes all rows of a schema's table, or those `refine` selects (Ecto's `Repo.delete_all/2`). */
  deleteAll<S extends AnySchema>(
    schema: S,
    refine?: (
      query: DeleteQueryBuilder<DB, TableOf<DB, S>, DeleteResult>,
    ) => Compilable<unknown>,
  ): Promise<{ readonly count: number }>;

  /** Builds a loaded record from a raw database row (Ecto's `Repo.load/2`). */
  load<S extends AnySchema>(
    schema: S,
    row: Readonly<Record<string, unknown>>,
  ): Infer<S>;
}

type Entries = readonly (readonly [string, unknown])[];
type Values = Readonly<Record<string, unknown>>;

type ApplyResult =
  | { readonly ok: true; readonly values: Values }
  | { readonly ok: false; readonly changeset: AnyChangeset };

/** Creates a Repo running on the given Kysely instance (Ecto's `use Ecto.Repo`). */
export function createRepo<DB>(config: RepoConfig<DB>): Repo<DB> {
  const { adapter } = config;
  const executor = new Executor(config.db, config.onQuery);
  const loader: Loader = (type, value) => adapter.load(type.type, value);

  // -------------------------------------------------------------------------
  // Helpers (Ecto.Repo.Schema)
  // -------------------------------------------------------------------------

  function schemaOf(data: object, action: string): AnySchema {
    const meta = getMeta(data);
    if (!meta) {
      throw new TypeError(
        `cannot ${action} schemaless data; Repo writes need a record created by a schema`,
      );
    }
    return meta.schema;
  }

  function putRepoAndAction(
    changeset: AnyChangeset,
    action: Action,
  ): AnyChangeset {
    if (changeset.action === "ignore") {
      if (changeset.valid) {
        throw new TypeError(
          `a valid changeset with action "ignore" was given to Repo.${action}. ` +
            "Changesets can only be ignored in a repository action if they are also invalid",
        );
      }
    } else if (changeset.action !== null && changeset.action !== action) {
      throw new TypeError(
        `a changeset with action "${changeset.action}" was given to Repo.${action}`,
      );
    }
    return new Changeset({ ...changeset, action, repo });
  }

  /** On insert, non-null record fields count as changes (Ecto's `surface_changes`). */
  function surfaceChanges(
    changeset: AnyChangeset,
    fields: readonly string[],
  ): AnyChangeset {
    const changes: Record<string, unknown> = { ...changeset.changes };
    const data = changeset.data as Record<string, unknown>;
    for (const field of fields) {
      if (Object.hasOwn(changes, field)) continue;
      const value = data[field];
      if (value !== null && value !== undefined) changes[field] = value;
    }
    return new Changeset({ ...changeset, changes });
  }

  async function runPrepare(changeset: AnyChangeset): Promise<AnyChangeset> {
    let current = changeset;
    for (const fn of changeset.prepare) {
      const result: unknown = await fn(current);
      if (!isChangeset(result)) {
        throw new TypeError(
          `expected the function given to prepareChanges to return a Changeset, got: ${inspect(result)}`,
        );
      }
      current = result;
    }
    return current;
  }

  /**
   * Runs a write in a transaction when it has prepare functions, rolling
   * back when it fails (Ecto's `wrap_in_transaction`).
   */
  function wrapInTransaction<D extends object>(
    changeset: AnyChangeset,
    fn: () => Promise<WriteResult<D>>,
  ): Promise<WriteResult<D>> {
    if (changeset.prepare.length === 0 || executor.inTransaction) return fn();
    return executor.transaction(async () => {
      const result = await fn();
      if (!result.ok) executor.rollback(result);
      return result;
    });
  }

  function returningFields(
    schema: AnySchema,
    returning: boolean | readonly string[] | undefined,
  ): string[] {
    let fields: string[];
    if (returning === true) fields = [...schema.persistedFields];
    else if (Array.isArray(returning)) {
      for (const field of returning) persistedField(schema, field);
      fields = [...returning];
    } else fields = [];
    for (const field of schema.readAfterWrites) {
      if (!fields.includes(field)) fields.push(field);
    }
    return fields;
  }

  function persistedField(schema: AnySchema, field: string): Type<unknown> {
    const definition = schema.fields[field] as AnyField | undefined;
    if (!definition || definition.options.virtual) {
      throw new TypeError(
        `field ${field} does not exist in schema ${schema.source} or is virtual`,
      );
    }
    return definition.type;
  }

  /** Dumps values for the database, throwing `ChangeError` (Ecto's `dump_fields!`). */
  function dumpFields(
    action: string,
    schema: AnySchema,
    entries: Entries,
  ): [string, unknown][] {
    return entries.map(([field, value]) => {
      const type = persistedField(schema, field);
      const result = dumpValue(type, value);
      if (!result.ok) {
        throw new ChangeError(
          `value ${inspect(value)} for ${schema.source}.${field} in ${action} ` +
            `does not match type ${formatType(type.type)}`,
        );
      }
      const dumped = result.value;
      return [field, dumped === null ? null : adapter.dump(type.type, dumped)];
    });
  }

  /**
   * Values generated by ekto for fields without a change, one value per
   * generator, so `inserted_at` and `updated_at` match (Ecto's
   * `autogenerate_changes`).
   */
  function autogenerateChanges(
    schema: AnySchema,
    action: "insert" | "update",
    changes: Values,
  ): Record<string, unknown> {
    const groups = new Map<() => unknown, string[]>();
    const fields =
      action === "insert" ? schema.autogenerateFields : schema.autoupdateFields;
    for (const field of fields) {
      if (Object.hasOwn(changes, field)) continue;
      const { options } = schema.fields[field] as AnyField;
      const generate = (
        action === "insert" ? options.autogenerate : options.autoupdate
      ) as () => unknown;
      groups.set(generate, [...(groups.get(generate) ?? []), field]);
    }
    const generated: Record<string, unknown> = {};
    for (const [generate, group] of groups) {
      const value = generate();
      for (const field of group) generated[field] = value;
    }
    return generated;
  }

  function addPkFilter(
    filters: Values,
    data: Record<string, unknown>,
    schema: AnySchema,
  ): Record<string, unknown> {
    if (schema.primaryKey.length === 0)
      throw new NoPrimaryKeyFieldError(schema.source);
    const result: Record<string, unknown> = { ...filters };
    for (const field of schema.primaryKey) {
      const value = data[field];
      if (value === null || value === undefined)
        throw new NoPrimaryKeyValueError(data);
      result[field] = value;
    }
    return result;
  }

  function loadField(schema: AnySchema, field: string, raw: unknown): unknown {
    const type = persistedField(schema, field);
    const result = loadValue(
      type,
      raw === null || raw === undefined ? raw : adapter.load(type.type, raw),
    );
    if (!result.ok) {
      throw new TypeError(
        `cannot load ${inspect(raw)} as type ${formatType(type.type)} ` +
          `for field ${field} in schema ${schema.source}`,
      );
    }
    return result.value;
  }

  /** The written record: data, changes and generated values (Ecto's `load_changes`). */
  function loadChanges(
    changeset: AnyChangeset,
    state: RecordState,
    values: Values,
    autogen: Values,
    schema: AnySchema,
  ): object {
    const record = Object.assign(
      putMeta(changeset.data, { state }),
      changeset.changes,
      autogen,
    ) as Record<string, unknown>;
    for (const [field, raw] of Object.entries(values)) {
      record[field] = loadField(schema, field, raw);
    }
    return record;
  }

  /** Runs a write and interprets the result (Ecto's `apply` and the adapter's `struct`). */
  async function applyWrite(
    changeset: AnyChangeset,
    action: Action,
    query: Queryable,
    returning: readonly string[],
    options: StaleOptions<object> & { readonly conflictNothing?: boolean },
    source: string,
  ): Promise<ApplyResult> {
    let result: QueryResult;
    try {
      result = await executor.execute(query, source);
    } catch (error) {
      const violations = adapter.toConstraints(error);
      if (violations.length === 0) throw error;
      return {
        ok: false,
        changeset: constraintsToErrors(changeset, action, violations),
      };
    }
    const count =
      returning.length > 0
        ? result.rows.length
        : (result.numAffectedRows ?? result.rows.length);
    if (count === 1) return { ok: true, values: result.rows[0] ?? {} };
    if (count > 1) throw new MultiplePrimaryKeyError(action, source, count);
    if (options.allowStale || options.conflictNothing)
      return { ok: true, values: {} };
    if (options.staleErrorField !== undefined) {
      return {
        ok: false,
        changeset: addError(
          changeset,
          options.staleErrorField,
          options.staleErrorMessage ?? "is stale",
          { stale: true },
        ),
      };
    }
    throw new StaleEntryError(action, changeset);
  }

  /**
   * Turns violated constraints into errors, using the constraints the
   * changeset declares; throws `ConstraintError` for undeclared ones (Ecto's
   * `constraints_to_errors`).
   */
  function constraintsToErrors(
    changeset: AnyChangeset,
    action: Action,
    violations: readonly ConstraintViolation[],
  ): AnyChangeset {
    const errors: ChangesetError[] = violations.map(({ type, constraint }) => {
      const declared = changeset.constraints.find(
        (c) => c.type === type && constraintMatches(c, constraint),
      );
      if (!declared)
        throw new ConstraintError(action, type, constraint, changeset);
      return {
        field: declared.field,
        message: declared.errorMessage,
        meta: { constraint: declared.errorType, constraintName: constraint },
      };
    });
    return new Changeset({
      ...changeset,
      errors: [...errors, ...changeset.errors],
      valid: false,
    });
  }

  // -------------------------------------------------------------------------
  // SQL (Ecto.Adapters.Postgres.Connection; the same text works on SQLite)
  // -------------------------------------------------------------------------

  const ident = (name: string) => sql.identifier(name);

  function withReturning(query: Sql, returning: readonly string[]): Queryable {
    const full =
      returning.length === 0
        ? query
        : sql`${query} RETURNING ${sql.splice(returning.map(ident))}`;
    return full.compile(adapter.syntax);
  }

  function where(filters: Entries): Sql {
    return filters
      .map(([field, value]) =>
        value === null
          ? sql`${ident(field)} IS NULL`
          : sql`${ident(field)} = ${value}`,
      )
      .reduce((acc, condition) => sql`${acc} AND ${condition}`);
  }

  /** A cell `insertAll` has no value for, filled with the column default. */
  const DEFAULT = sql`DEFAULT`;

  function insertSql(
    source: string,
    header: readonly string[],
    rows: readonly (readonly unknown[])[],
    onConflict: Sql | undefined,
    returning: readonly string[],
  ): Queryable {
    let query =
      header.length === 0
        ? sql`INSERT INTO ${ident(source)} DEFAULT VALUES`
        : sql`INSERT INTO ${ident(source)} (${sql.splice(header.map(ident))}) VALUES ${sql.splice(
            rows.map((row) => sql`(${sql.splice(row)})`),
          )}`;
    if (onConflict) query = sql`${query} ${onConflict}`;
    return withReturning(query, returning);
  }

  /** The `ON CONFLICT` clause (Ecto's `on_conflict/2` in the Postgres connection). */
  function onConflictSql(
    schema: AnySchema,
    options: ConflictOptions<Values>,
  ): Sql | undefined {
    const { onConflict = "raise", conflictTarget } = options;
    if (onConflict === "raise") {
      if (conflictTarget !== undefined) {
        throw new TypeError(
          'conflictTarget is forbidden when onConflict is "raise"',
        );
      }
      return undefined;
    }
    let target = sql``;
    if (conflictTarget !== undefined) {
      if (Array.isArray(conflictTarget)) {
        for (const field of conflictTarget) persistedField(schema, field);
        target = sql` (${sql.splice(conflictTarget.map(ident))})`;
      } else {
        const { unsafeFragment } = conflictTarget as { unsafeFragment: string };
        target = new Sql([{ kind: "text", text: ` ${unsafeFragment}` }]);
      }
    }
    if (onConflict === "nothing") return sql`ON CONFLICT${target} DO NOTHING`;

    let fields: readonly string[];
    if (onConflict === "replaceAll") fields = schema.persistedFields;
    else if ("replace" in onConflict) {
      fields = onConflict.replace;
      for (const field of fields) persistedField(schema, field);
    } else {
      for (const field of onConflict.replaceAllExcept)
        persistedField(schema, field);
      fields = schema.persistedFields.filter(
        (field) => !onConflict.replaceAllExcept.includes(field),
      );
    }
    if (fields.length === 0)
      throw new TypeError("onConflict needs at least one field to replace");
    if (conflictTarget === undefined) {
      throw new TypeError(
        "the conflictTarget option is required when onConflict replaces fields",
      );
    }
    const set = sql.splice(
      fields.map((f) => sql`${ident(f)} = EXCLUDED.${ident(f)}`),
    );
    return sql`ON CONFLICT${target} DO UPDATE SET ${set}`;
  }

  function updateSql(
    source: string,
    values: Entries,
    filters: Entries,
    returning: readonly string[],
  ): Queryable {
    const set = sql.splice(
      values.map(([field, value]) => sql`${ident(field)} = ${value}`),
    );
    return withReturning(
      sql`UPDATE ${ident(source)} SET ${set} WHERE ${where(filters)}`,
      returning,
    );
  }

  function deleteSql(
    source: string,
    filters: Entries,
    returning: readonly string[],
  ): Queryable {
    return withReturning(
      sql`DELETE FROM ${ident(source)} WHERE ${where(filters)}`,
      returning,
    );
  }

  function selectSql(schema: AnySchema, filters: Entries): Queryable {
    const columns = sql.splice(schema.persistedFields.map(ident));
    const query =
      filters.length === 0
        ? sql`SELECT ${columns} FROM ${ident(schema.source)}`
        : sql`SELECT ${columns} FROM ${ident(schema.source)} WHERE ${where(filters)}`;
    return query.compile(adapter.syntax);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async function insert(
    input: object,
    options: InsertOptions<object> = {},
  ): Promise<WriteResult<object>> {
    let changeset: AnyChangeset = isChangeset(input) ? input : change(input);
    if (!changeset.valid)
      return { ok: false, changeset: putRepoAndAction(changeset, "insert") };

    const schema = schemaOf(changeset.data, "insert");
    const returning = returningFields(schema, options.returning);
    const onConflict = onConflictSql(
      schema,
      options as ConflictOptions<Values>,
    );
    changeset = putRepoAndAction(changeset, "insert");
    changeset = surfaceChanges(changeset, schema.persistedFields);

    return wrapInTransaction(changeset, async () => {
      const prepared = await runPrepare(changeset);
      if (!prepared.valid) return { ok: false, changeset: prepared };

      const id = schema.autogenerateId;
      const returnFields =
        id !== undefined && !Object.hasOwn(prepared.changes, id)
          ? [id, ...returning.filter((field) => field !== id)]
          : returning;
      const changes = pick(prepared.changes, schema.persistedFields);
      const autogen = autogenerateChanges(schema, "insert", changes);
      const values = [
        ...dumpFields("insert", schema, Object.entries(changes)),
        ...dumpFields("insert", schema, Object.entries(autogen)),
      ];
      const query = insertSql(
        schema.source,
        values.map(([field]) => field),
        [values.map(([, value]) => value)],
        onConflict,
        returnFields,
      );
      const result = await applyWrite(
        prepared,
        "insert",
        query,
        returnFields,
        { conflictNothing: options.onConflict === "nothing" },
        schema.source,
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: loadChanges(prepared, "loaded", result.values, autogen, schema),
      };
    });
  }

  async function update(
    changeset: AnyChangeset,
    options: UpdateOptions<object> = {},
  ): Promise<WriteResult<object>> {
    if (!isChangeset(changeset)) {
      throw new TypeError(
        "giving a record to Repo.update is not supported; ekto cannot track " +
          "changes when a record is given, a Changeset must be given instead",
      );
    }
    if (!changeset.valid)
      return { ok: false, changeset: putRepoAndAction(changeset, "update") };

    const schema = schemaOf(changeset.data, "update");
    const force = options.force === true;
    const filters = addPkFilter(
      changeset.filters,
      changeset.data as Record<string, unknown>,
      schema,
    );
    const returning = returningFields(schema, options.returning);
    // Unlike insert, update does not copy record fields into the changes.
    const current = putRepoAndAction(changeset, "update");
    if (Object.keys(current.changes).length === 0 && !force)
      return { ok: true, value: current.data };

    return wrapInTransaction(current, async () => {
      const prepared = await runPrepare(current);
      if (!prepared.valid) return { ok: false, changeset: prepared };

      const changes = pick(prepared.changes, schema.persistedFields);
      let autogen = autogenerateChanges(schema, "update", changes);
      let values: Values = {};
      // With no changes, or only generated ones and no `force`, skip the query.
      if (
        Object.keys(changes).length > 0 ||
        (Object.keys(autogen).length > 0 && force)
      ) {
        const query = updateSql(
          schema.source,
          [
            ...dumpFields("update", schema, Object.entries(changes)),
            ...dumpFields("update", schema, Object.entries(autogen)),
          ],
          dumpFields("update", schema, Object.entries(filters)),
          returning,
        );
        const result = await applyWrite(
          prepared,
          "update",
          query,
          returning,
          options,
          schema.source,
        );
        if (!result.ok) return result;
        values = result.values;
      } else {
        autogen = {};
      }
      return {
        ok: true,
        value: loadChanges(prepared, "loaded", values, autogen, schema),
      };
    });
  }

  async function remove(
    input: object,
    options: DeleteOptions<object> = {},
  ): Promise<WriteResult<object>> {
    const changeset: AnyChangeset = isChangeset(input) ? input : change(input);
    if (!changeset.valid)
      return { ok: false, changeset: putRepoAndAction(changeset, "delete") };

    const schema = schemaOf(changeset.data, "delete");
    const returning = returningFields(schema, options.returning);
    const current = putRepoAndAction(changeset, "delete");

    return wrapInTransaction(current, async () => {
      const prepared = await runPrepare(current);
      if (!prepared.valid) return { ok: false, changeset: prepared };

      const filters = addPkFilter(
        prepared.filters,
        prepared.data as Record<string, unknown>,
        schema,
      );
      const query = deleteSql(
        schema.source,
        dumpFields("delete", schema, Object.entries(filters)),
        returning,
      );
      const result = await applyWrite(
        prepared,
        "delete",
        query,
        returning,
        options,
        schema.source,
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: loadChanges(prepared, "deleted", result.values, {}, schema),
      };
    });
  }

  async function orThrow(
    action: Action,
    result: Promise<WriteResult<object>>,
  ): Promise<object> {
    const written = await result;
    if (written.ok) return written.value;
    throw new InvalidChangesetError(action, written.changeset);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Casts and dumps a value compared in a query, as Ecto's planner does. */
  function queryParam(
    schema: AnySchema,
    field: string,
    value: unknown,
    kind = "where",
  ) {
    const type = persistedField(schema, field);
    const cast = castValue(type, value);
    if (!cast.ok) {
      throw new CastError(
        type.type,
        value,
        `value ${inspect(value)} in ${kind} cannot be cast to type ${formatType(type.type)} in query`,
      );
    }
    return cast.value;
  }

  async function one(
    schema: AnySchema,
    query: Queryable,
  ): Promise<object | null> {
    const { rows } = await executor.execute(query, schema.source);
    if (rows.length > 1) throw new MultipleResultsError(query.sql, rows.length);
    const row = rows[0];
    return row === undefined ? null : load(schema, row, loader);
  }

  function getByQuery(schema: AnySchema, clauses: Values): Queryable {
    const filters = Object.entries(clauses).map(([field, value]) => {
      if (value === null || value === undefined) {
        throw new TypeError(
          `${String(value)} given for ${field}; comparison with null is forbidden ` +
            "as it is unsafe. Write a query with an IS NULL condition instead",
        );
      }
      return [field, queryParam(schema, field, value)] as const;
    });
    return selectSql(schema, dumpFields("query", schema, filters));
  }

  function getQuery(schema: AnySchema, id: unknown): Queryable {
    const [key, ...rest] = schema.primaryKey;
    if (key === undefined || rest.length > 0) {
      throw new TypeError(
        `Repo.get requires the schema ${schema.source} to have exactly one ` +
          `primary key, got: ${schema.primaryKey.join(", ") || "none"}`,
      );
    }
    if (id === null || id === undefined) {
      throw new TypeError(
        "cannot perform Repo.get because the given value is null",
      );
    }
    return getByQuery(schema, { [key]: id });
  }

  async function oneOrThrow(
    schema: AnySchema,
    query: Queryable,
  ): Promise<object> {
    const record = await one(schema, query);
    if (record === null) throw new NoResultsError(query.sql);
    return record;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  const writeKinds: Readonly<Record<string, string>> = {
    InsertQueryNode: "insert",
    UpdateQueryNode: "update",
    DeleteQueryNode: "delete",
    MergeQueryNode: "merge",
  };

  function compileQuery(query: unknown, fn: string): CompiledQuery {
    if (query instanceof Sql) {
      const { sql: text, params } = query.compile(adapter.syntax);
      return CompiledQuery.raw(text, [...params]);
    }
    if (isCompiledQuery(query)) return query;
    if (isRawBuilder(query)) return query.compile(executor.db);
    if (isCompilable(query)) return query.compile();
    if (isQueryable(query))
      return CompiledQuery.raw(query.sql, [...query.params]);
    throw new TypeError(
      `Repo.${fn} expects a query ({ sql, params }, sql\`…\` or a Kysely query), got: ${inspect(query)}`,
    );
  }

  /** Compiles a query that must not write (Repo.all/one/query). */
  function compileRead(query: unknown, fn: string): CompiledQuery {
    const compiled = compileQuery(query, fn);
    const write = writeKinds[compiled.query.kind];
    if (write !== undefined) {
      throw new TypeError(
        `Repo.${fn} was given a Kysely ${write} query; run writes with Repo.exec`,
      );
    }
    return compiled;
  }

  async function allRows(
    fn: string,
    first: unknown,
    second: unknown,
    hasQuery: boolean,
  ): Promise<{ rows: readonly object[]; sql: string }> {
    if (!isSchema(first)) {
      if (hasQuery) {
        throw new TypeError(
          `Repo.${fn} expects a schema as its first argument when given a query, got: ${inspect(first)}`,
        );
      }
      const compiled = compileRead(first, fn);
      const { rows } = await executor.execute(compiled);
      return { rows, sql: compiled.sql };
    }
    const compiled = hasQuery
      ? compileRead(second, fn)
      : compileQuery(selectSql(first, []), fn);
    const { rows } = await executor.execute(compiled, first.source);
    return {
      rows: rows.map((row) => loadRow(first, row)),
      sql: compiled.sql,
    };
  }

  /** Loads a row of a schema query, checking that no column is missing. */
  function loadRow(schema: AnySchema, row: Values): object {
    const missing = schema.persistedFields.filter(
      (field) => !Object.hasOwn(row, field),
    );
    if (missing.length > 0) {
      const camel = missing.some((field) =>
        Object.hasOwn(
          row,
          field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()),
        ),
      );
      throw new SchemaMismatchError(
        schema.source,
        missing,
        camel
          ? "; the row has camelCase keys, and Kysely's CamelCasePlugin is not supported"
          : "",
      );
    }
    return load(schema, row, loader);
  }

  async function all(
    ...args: [unknown] | [unknown, unknown]
  ): Promise<readonly object[]> {
    return (await allRows("all", args[0], args[1], args.length > 1)).rows;
  }

  async function oneRow(
    fn: string,
    args: [unknown] | [unknown, unknown],
  ): Promise<{ row: object | null; sql: string }> {
    const { rows, sql: text } = await allRows(
      fn,
      args[0],
      args[1],
      args.length > 1,
    );
    if (rows.length > 1) throw new MultipleResultsError(text, rows.length);
    return { row: rows[0] ?? null, sql: text };
  }

  async function query(input: unknown): Promise<QueryRows<object>> {
    const result = await executor.execute(compileRead(input, "query"));
    return {
      rows: [...result.rows],
      rowCount: result.numAffectedRows ?? result.rows.length,
    };
  }

  /** Runs a write without a changeset; constraint violations are thrown. */
  async function runWrite(
    compiled: CompiledQuery,
    source: string | undefined,
    action = writeKinds[compiled.query.kind] ?? "write",
  ): Promise<QueryResult> {
    try {
      return await executor.execute(compiled, source);
    } catch (error) {
      const [violation] = adapter.toConstraints(error);
      if (violation === undefined) throw error;
      throw new ConstraintError(
        action,
        violation.type,
        violation.constraint,
        undefined,
      );
    }
  }

  async function exec(input: unknown): Promise<ExecResult<object>> {
    const result = await runWrite(compileQuery(input, "exec"), undefined);
    return {
      rowCount: result.numAffectedRows ?? result.rows.length,
      rows: [...result.rows],
    };
  }

  // -------------------------------------------------------------------------
  // Bulk writes (insert_all, update_all, delete_all)
  // -------------------------------------------------------------------------

  async function insertAll(
    schema: AnySchema,
    entries: readonly Values[],
    options: InsertAllOptions<AnySchema> = {},
  ): Promise<InsertAllResult<AnySchema>> {
    const returning =
      options.returning === true
        ? [...schema.persistedFields]
        : Array.isArray(options.returning)
          ? options.returning
          : [];
    for (const field of returning) persistedField(schema, field);
    const onConflict = onConflictSql(schema, options);
    if (entries.length === 0) return { count: 0, rows: [] };

    const dumped = entries.map((entry) =>
      Object.fromEntries(
        dumpFields(
          "insertAll",
          schema,
          Object.entries(entry).filter(([, value]) => value !== undefined),
        ),
      ),
    );
    const header = [...new Set(dumped.flatMap((row) => Object.keys(row)))];
    const rows = dumped.map((row) =>
      header.map((field) => (Object.hasOwn(row, field) ? row[field] : DEFAULT)),
    );
    const query = insertSql(schema.source, header, rows, onConflict, returning);
    const result = await runWrite(
      CompiledQuery.raw(query.sql, [...query.params]),
      schema.source,
      "insert",
    );
    return {
      count: result.numAffectedRows ?? result.rows.length,
      rows: result.rows.map((row) => load(schema, row, loader)),
    };
  }

  async function updateAll(
    schema: AnySchema,
    updates: UpdateAll<AnySchema>,
    refine: (query: never) => Compilable<unknown> = (q) => q,
  ): Promise<{ count: number }> {
    const { set = {}, inc = {}, ...rest } = updates;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) {
      throw new TypeError(
        `unknown update operators ${unknown.join(", ")} in updateAll; use set or inc`,
      );
    }
    const values = dumpFields(
      "updateAll",
      schema,
      Object.entries(set).map(([field, value]) => [
        field,
        queryParam(schema, field, value, "update"),
      ]),
    );
    const increments = dumpFields(
      "updateAll",
      schema,
      Object.entries(inc).map(([field, value]) => {
        if (typeof value !== "number") {
          throw new TypeError(
            `inc of ${field} in updateAll must be a number, got: ${inspect(value)}`,
          );
        }
        return [field, value];
      }),
    );
    if (values.length + increments.length === 0)
      throw new TypeError("updateAll needs at least one field to update");

    // biome-ignore lint/suspicious/noExplicitAny: built for any table
    const builder = (executor.db as Kysely<any>)
      .updateTable(schema.source)
      // biome-ignore lint/suspicious/noExplicitAny: Kysely's expression builder
      .set((eb: any) => ({
        ...Object.fromEntries(values),
        ...Object.fromEntries(
          increments.map(([field, n]) => [field, eb(field, "+", n)]),
        ),
      }));
    const result = await runWrite(
      compileQuery(refine(builder as never), "updateAll"),
      schema.source,
    );
    return { count: result.numAffectedRows ?? result.rows.length };
  }

  async function deleteAll(
    schema: AnySchema,
    refine: (query: never) => Compilable<unknown> = (q) => q,
  ): Promise<{ count: number }> {
    // biome-ignore lint/suspicious/noExplicitAny: built for any table
    const builder = (executor.db as Kysely<any>).deleteFrom(schema.source);
    const result = await runWrite(
      compileQuery(refine(builder as never), "deleteAll"),
      schema.source,
    );
    return { count: result.numAffectedRows ?? result.rows.length };
  }

  const repo: Repo<DB> = {
    adapter,
    get kysely() {
      return executor.db;
    },
    get inTransaction() {
      return executor.inTransaction;
    },
    insert: insert as Repo["insert"],
    insertOrThrow: ((input: object, options?: InsertOptions<object>) =>
      orThrow("insert", insert(input, options))) as Repo["insertOrThrow"],
    update: update as Repo["update"],
    updateOrThrow: ((
      changeset: AnyChangeset,
      options?: UpdateOptions<object>,
    ) =>
      orThrow("update", update(changeset, options))) as Repo["updateOrThrow"],
    delete: remove as Repo["delete"],
    deleteOrThrow: ((input: object, options?: DeleteOptions<object>) =>
      orThrow("delete", remove(input, options))) as Repo["deleteOrThrow"],
    get: (async (schema: AnySchema, id: unknown) =>
      one(schema, getQuery(schema, id))) as Repo["get"],
    getOrThrow: (async (schema: AnySchema, id: unknown) =>
      oneOrThrow(schema, getQuery(schema, id))) as Repo["getOrThrow"],
    getBy: (async (schema: AnySchema, clauses: Values) =>
      one(schema, getByQuery(schema, clauses))) as Repo["getBy"],
    getByOrThrow: (async (schema: AnySchema, clauses: Values) =>
      oneOrThrow(schema, getByQuery(schema, clauses))) as Repo["getByOrThrow"],
    all: all as Repo["all"],
    one: (async (...args: [unknown] | [unknown, unknown]) =>
      (await oneRow("one", args)).row) as Repo["one"],
    oneOrThrow: (async (...args: [unknown] | [unknown, unknown]) => {
      const { row, sql: text } = await oneRow("oneOrThrow", args);
      if (row === null) throw new NoResultsError(text);
      return row;
    }) as Repo["oneOrThrow"],
    query: query as Repo["query"],
    exec: exec as Repo["exec"],
    insertAll: insertAll as Repo["insertAll"],
    updateAll: updateAll as Repo["updateAll"],
    deleteAll: deleteAll as Repo["deleteAll"],
    load: ((schema: AnySchema, row: Values) =>
      load(schema, row, loader)) as Repo["load"],
  };
  return Object.freeze(repo);
}

/** Kysely's own `sql` tag, which compiles with a Kysely instance. */
function isRawBuilder(value: unknown): value is RawBuilder<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isRawBuilder?: unknown }).isRawBuilder === true
  );
}

function constraintMatches(declared: Constraint, name: string): boolean {
  const { constraint, match } = declared;
  if (constraint instanceof RegExp) return constraint.test(name);
  if (match === "suffix") return name.endsWith(constraint);
  if (match === "prefix") return name.startsWith(constraint);
  return name === constraint;
}

function pick(
  values: Values,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(values, key)) result[key] = values[key];
  }
  return result;
}
