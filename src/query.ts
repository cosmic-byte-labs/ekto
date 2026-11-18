/**
 * Queries that belong to no Repo, as in Ecto, where a query is data and the
 * Repo runs it. `queries<DB>()` gives the query builders of a database:
 *
 * ```ts
 * export const { from, kysely } = queries<DB>();
 *
 * const posts = await repo.all(
 *   from(Post).where("author", "=", "José").orderBy("published_at", "desc"),
 * );
 * ```
 *
 * The queries are Kysely's builders on a Kysely instance without a
 * database: they compile and run only when given to a Repo, with the
 * Repo's dialect and plugins, in its transaction or test sandbox.
 */

import {
  type CompiledQuery,
  type DatabaseIntrospector,
  type Dialect,
  Kysely,
  type OperationNode,
  PostgresAdapter,
  type QueryCompiler,
  type QueryCreator,
  type QueryId,
  type RootOperationNode,
  type Selectable,
  type SelectQueryBuilder,
  type SelectQueryNode,
} from "kysely";
import { type AnySchema, isSchema } from "./schema.ts";

/** The message of running or printing a query without a Repo. */
const NO_DATABASE =
  "this query has no database of its own: run it with a Repo, e.g. repo.all(query)";

const unbound: unique symbol = Symbol("ekto.unboundQuery");

/**
 * What a query of `queries()` compiles to by itself: its operation node and
 * query id, without SQL, which the Repo running it compiles.
 */
export interface UnboundQuery {
  readonly query: RootOperationNode;
  readonly queryId: QueryId;
  readonly parameters: readonly unknown[];
  readonly sql: string;
  readonly [unbound]: true;
}

/** Whether `value` is what a query of `queries()` compiles to by itself. */
export function isUnboundQuery(value: unknown): value is UnboundQuery {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [unbound]?: unknown })[unbound] === true
  );
}

const noDatabase = (): never => {
  throw new Error(NO_DATABASE);
};

const compiler: QueryCompiler = {
  compileQuery: (node: RootOperationNode, queryId: QueryId) =>
    Object.freeze({
      query: node,
      queryId,
      parameters: Object.freeze([]),
      get sql(): string {
        return noDatabase();
      },
      [unbound]: true,
    }) as unknown as CompiledQuery,
};

const introspector: DatabaseIntrospector = {
  getSchemas: async () => noDatabase(),
  getTables: async () => noDatabase(),
};

/**
 * A dialect without a database: queries compile to their operation node,
 * and running one throws.
 */
const unboundDialect: Dialect = {
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => ({
    init: async () => {},
    acquireConnection: async () => noDatabase(),
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  }),
  createIntrospector: () => introspector,
  createQueryCompiler: () => compiler,
};

declare const schemaBrand: unique symbol;

/**
 * Marks the row type of a `from(Schema)` query, so that `Repo.all` knows
 * its rows are records of the schema. It exists only in types.
 */
export type SchemaRow<S extends AnySchema> = { readonly [schemaBrand]: S };

/** `R` without the `SchemaRow` mark. */
export type Unmarked<R> =
  R extends SchemaRow<AnySchema>
    ? { [K in keyof R as K extends typeof schemaBrand ? never : K]: R[K] }
    : R;

/** The table of a schema in `DB`. */
type TableOf<DB, S extends AnySchema> = S["source"] & keyof DB & string;

/**
 * The query `from(Schema)` returns: a Kysely select of the schema's
 * persisted columns from its table, whose rows `Repo.all` loads as records.
 */
export type FromQuery<DB, S extends AnySchema> = SelectQueryBuilder<
  DB,
  TableOf<DB, S>,
  Selectable<DB[TableOf<DB, S>]> & SchemaRow<S>
>;

/** Kysely's `selectFrom` of `DB`. */
type SelectFromOf<DB> = QueryCreator<DB>["selectFrom"];

/**
 * The `from` of `queries<DB>()`. Given a table instead of a schema, it is
 * Kysely's `selectFrom`: a query of plain rows, selecting nothing yet, from
 * a table (`"posts"`, `"posts as p"`), tables or a subquery.
 *
 * ```ts
 * const counts = await repo.all(
 *   from("posts")
 *     .select(["category", (eb) => eb.fn.countAll().as("count")])
 *     .groupBy("category"),
 * );
 * ```
 */
export interface From<DB> extends SelectFromOf<DB> {
  /**
   * A query of a schema's records (Ecto's `from p in Post`): a Kysely
   * select of the schema's persisted columns, qualified with its table so
   * that joins do not clash. `Repo.all`, `one` and `oneOrThrow` load its
   * rows as records, unless its selection was cleared (`clearSelect()`),
   * which makes it a query of plain rows.
   *
   * ```ts
   * const posts = await repo.all(from(Post).where("title", "like", "Ecto%"));
   * ```
   */
  <S extends AnySchema & { readonly source: keyof DB & string }>(
    schema: S,
  ): FromQuery<DB, S>;
}

/** The query builders of a database, made by `queries<DB>()`. */
export interface Queries<DB> {
  /**
   * A query of a schema's records, `from(Post)`, or of a table,
   * `from("posts")` (Kysely's `selectFrom`). See {@link From}.
   */
  readonly from: From<DB>;
  /**
   * A Kysely instance without a database, for queries that do not start
   * with a select: writes (`kysely.deleteFrom(…)`, run with `repo.exec`),
   * `with` (CTEs) and the like. Its queries run only when given to a Repo;
   * their `execute()` throws.
   */
  readonly kysely: Kysely<DB>;
}

/** The schema and original selections of each `from(Schema)` query, by query id. */
const schemaQueries = new WeakMap<
  QueryId,
  { readonly schema: AnySchema; readonly selections: readonly OperationNode[] }
>();

/**
 * The query builders of the database `DB` (the Kysely database type, e.g.
 * `KyselyDB` of `ekto/postgres`): `from` and a Kysely instance without a
 * database, `kysely`. Define them once, beside the Repo:
 *
 * ```ts
 * export const repo = createRepo<DB>({ adapter: postgres(), url: process.env.DATABASE_URL });
 * export const { from, kysely } = queries<DB>();
 * ```
 *
 * Their queries belong to no Repo: give them to one to run them, e.g.
 * `repo.all(from(Post))`. Each Repo compiles them with its own dialect and
 * plugins, in its transaction or test sandbox.
 */
export function queries<DB>(): Queries<DB> {
  const kysely = new Kysely<DB>({ dialect: unboundDialect });
  // biome-ignore lint/suspicious/noExplicitAny: built for any table
  const db = kysely as Kysely<any>;
  function from(source: unknown): unknown {
    if (!isSchema(source)) {
      if (
        source === null ||
        (typeof source !== "string" && typeof source !== "object")
      ) {
        throw new TypeError(
          `from expects a schema or a table, got: ${String(source)}`,
        );
      }
      return db.selectFrom(source as string);
    }
    const table = source.source;
    const builder = db
      .selectFrom(table)
      .select(source.persistedFields.map((field) => `${table}.${field}`));
    const compiled = builder.compile() as unknown as UnboundQuery;
    schemaQueries.set(compiled.queryId, {
      schema: source,
      selections: (compiled.query as SelectQueryNode).selections ?? [],
    });
    return builder;
  }
  return Object.freeze({ from: from as From<DB>, kysely });
}

/**
 * The schema of a `from(Schema)` query, when its selection still begins
 * with the schema's columns (not after `clearSelect()`).
 */
export function schemaOfQuery(query: UnboundQuery): AnySchema | undefined {
  const remembered = schemaQueries.get(query.queryId);
  if (remembered === undefined) return undefined;
  const selections = (query.query as SelectQueryNode).selections ?? [];
  const kept = remembered.selections.every((s, i) => selections[i] === s);
  return kept ? remembered.schema : undefined;
}

/**
 * Compiles a query of `queries()` with `db`, a Repo's Kysely instance, so
 * that its dialect and plugins apply.
 */
export function bindQuery(
  query: UnboundQuery,
  // biome-ignore lint/suspicious/noExplicitAny: any database
  db: Kysely<any>,
): CompiledQuery {
  const executor = db.getExecutor();
  return executor.compileQuery(
    executor.transformQuery(query.query, query.queryId),
    query.queryId,
  );
}
