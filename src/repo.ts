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
import type { Kysely } from "kysely";
import { type Adapter, Executor, type QueryEvent } from "./adapter.ts";
import {
  type Action,
  type AnyChangeset,
  addError,
  Changeset,
  change,
  InvalidChangesetError,
  isChangeset,
} from "./changeset.ts";
import {
  ChangeError,
  MultiplePrimaryKeyError,
  MultipleResultsError,
  NoPrimaryKeyFieldError,
  NoPrimaryKeyValueError,
  NoResultsError,
  StaleEntryError,
} from "./errors.ts";
import {
  type AnyField,
  type AnySchema,
  getMeta,
  type Infer,
  type Loader,
  load,
  putMeta,
  type RecordState,
} from "./schema.ts";
import { type Queryable, type Sql, sql } from "./sql.ts";
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

export type InsertOptions<D> = ReturningOptions<D>;

export interface UpdateOptions<D> extends ReturningOptions<D>, StaleOptions<D> {
  /**
   * Update even without changes, e.g. to bump `updated_at` (Ecto's `:force`).
   */
  readonly force?: boolean;
}

export interface DeleteOptions<D>
  extends ReturningOptions<D>,
    StaleOptions<D> {}

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
    action: Action | "query",
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
    options: StaleOptions<object>,
    source: string,
  ): Promise<ApplyResult> {
    const result = await executor.execute(query, source);
    const count =
      returning.length > 0
        ? result.rows.length
        : (result.numAffectedRows ?? result.rows.length);
    if (count === 1) return { ok: true, values: result.rows[0] ?? {} };
    if (count > 1) throw new MultiplePrimaryKeyError(action, source, count);
    if (options.allowStale) return { ok: true, values: {} };
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

  function insertSql(
    source: string,
    values: Entries,
    returning: readonly string[],
  ): Queryable {
    const query =
      values.length === 0
        ? sql`INSERT INTO ${ident(source)} DEFAULT VALUES`
        : sql`INSERT INTO ${ident(source)} (${sql.splice(values.map(([f]) => ident(f)))}) VALUES (${sql.splice(values.map(([, v]) => v))})`;
    return withReturning(query, returning);
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
      const query = insertSql(schema.source, values, returnFields);
      const result = await applyWrite(
        prepared,
        "insert",
        query,
        returnFields,
        {},
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
  function queryParam(schema: AnySchema, field: string, value: unknown) {
    const type = persistedField(schema, field);
    const cast = castValue(type, value);
    if (!cast.ok) {
      throw new CastError(
        type.type,
        value,
        `value ${inspect(value)} in where cannot be cast to type ${formatType(type.type)} in query`,
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
    load: ((schema: AnySchema, row: Values) =>
      load(schema, row, loader)) as Repo["load"],
  };
  return Object.freeze(repo);
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
