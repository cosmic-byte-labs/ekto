/**
 * SQLite support (`ekto/sqlite`), following ecto_sqlite3.
 *
 * @module ekto/sqlite
 */

import type { SQLInputValue } from "node:sqlite";
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import type { Database as Sqlite3Database } from "sqlite3";
import type {
  Adapter,
  ConnectionOptions,
  ConstraintViolation,
} from "../adapter.ts";
import type { DriverValue, KyselyTables } from "../kysely.ts";
import type { AnySchema } from "../schema.ts";
import { quoteIdentifierAnsi, type SqlSyntax } from "../sql.ts";
import type { PrimitiveType } from "../type.ts";
import { sqliteColumnType, sqliteDdl } from "./ddl.ts";
import { describeTables } from "./describe.ts";

/** How SQLite writes `sql` values: `?` placeholders and double-quoted identifiers. */
export const sqliteSyntax: SqlSyntax = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: quoteIdentifierAnsi,
});

/**
 * What node-sqlite3 and `node:sqlite` return, for the storage classes
 * ecto_sqlite3 uses: integers are numbers (past 2^53, node-sqlite3 loses
 * precision and `node:sqlite` throws), blobs are Uint8Arrays (Buffers from
 * node-sqlite3), booleans are integers, dates, times and date-times ISO
 * 8601 text, maps and arrays JSON text, and decimals have numeric affinity,
 * so they usually come back as numbers.
 */
export type SqliteTypes = {
  readonly id: DriverValue<number>;
  readonly integer: DriverValue<number>;
  readonly float: DriverValue<number>;
  readonly decimal: DriverValue<number | string, number | string>;
  readonly boolean: DriverValue<number>;
  readonly string: DriverValue<string>;
  readonly binary: DriverValue<Uint8Array>;
  readonly map: DriverValue<string>;
  readonly uuid: DriverValue<string>;
  readonly date: DriverValue<string>;
  readonly time: DriverValue<string>;
  readonly utc_datetime: DriverValue<string>;
  readonly utc_datetime_msec: DriverValue<string>;
  readonly any: DriverValue<unknown>;
  readonly array: DriverValue<string>;
};

/**
 * The Kysely `DB` type for the given schemas on SQLite, typed with what the
 * driver returns.
 */
export type KyselyDB<Schemas extends readonly AnySchema[]> = KyselyTables<
  Schemas,
  SqliteTypes
>;

// ISO 8601 text as ecto_sqlite3 writes it ("2026-01-02T10:30:00Z") or as
// SQLite's CURRENT_TIMESTAMP does ("2026-01-02 10:30:00"), read as UTC.
const DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

// Codec.bool_decode/1.
function loadBoolean(value: unknown): unknown {
  switch (value) {
    case 0:
    case "0":
    case "FALSE":
      return false;
    case 1:
    case "1":
    case "TRUE":
      return true;
    default:
      return value;
  }
}

// Codec.json_decode/1: text is parsed, anything else is kept (e.g. after
// Kysely's ParseJSONResultsPlugin). Invalid JSON is left for the type to reject.
function loadJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function loadDatetime(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = DATETIME.exec(value);
  if (!match) return value;
  const [, date, time, fraction = "", offset] = match;
  const ms = fraction.slice(0, 3).padEnd(3, "0");
  let zone = offset ?? "Z";
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return new Date(`${date}T${time}.${ms}${zone}`);
}

function loadValue(type: PrimitiveType, value: unknown): unknown {
  if (typeof type !== "string") {
    // Arrays are stored as JSON text (ecto_sqlite3's `{:array, _}` loader).
    const list = loadJson(value);
    return Array.isArray(list)
      ? list.map((item) => (item === null ? null : loadValue(type[1], item)))
      : list;
  }
  switch (type) {
    case "boolean":
      return loadBoolean(value);
    case "map":
      return loadJson(value);
    case "time":
      // Ecto's :time has no fractional seconds.
      return typeof value === "string" ? value.replace(/\.\d+$/, "") : value;
    case "utc_datetime":
    case "utc_datetime_msec":
      return loadDatetime(value);
    default:
      return value;
  }
}

function dumpValue(type: PrimitiveType, value: unknown): unknown {
  if (typeof type !== "string") {
    // Codec.json_encode/1; the elements are already dumped by their type.
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  switch (type) {
    case "boolean":
      // Codec.bool_encode/1.
      return value === true ? 1 : value === false ? 0 : value;
    case "map":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "utc_datetime":
      // DateTime.to_iso8601/1 of a second-precision datetime: no fraction.
      return value instanceof Date
        ? value.toISOString().replace(/\.000Z$/, "Z")
        : value;
    case "utc_datetime_msec":
      return value instanceof Date ? value.toISOString() : value;
    default:
      return value;
  }
}

/**
 * The index name ecto_sqlite3 derives from the columns SQLite reports, by
 * Ecto's convention (`constraint_name_hack/1`): "users.email" becomes
 * "users_email_index", "users.a, users.b" becomes "users_a_b_index".
 * SQLite does not report the index name, so an index named otherwise must
 * be matched by this name.
 */
function indexName(columns: string): string {
  return [
    ...columns
      .split(", ")
      .map((column, i) =>
        i === 0 ? column.replace(".", "_") : column.split(".").at(-1),
      ),
    "index",
  ].join("_");
}

/**
 * The constraint violated by a node-sqlite3 or `node:sqlite` error
 * (ecto_sqlite3's `to_constraints/2`).
 */
function toConstraints(error: unknown): readonly ConstraintViolation[] {
  if (typeof error !== "object" || error === null) return [];
  const {
    code,
    errcode,
    message: full,
  } = error as { code?: unknown; errcode?: unknown; message?: unknown };
  // node-sqlite3 gives the code's name, node:sqlite the extended result code.
  const constraint =
    code === "SQLITE_CONSTRAINT" ||
    (typeof errcode === "number" && (errcode & 0xff) === SQLITE_CONSTRAINT);
  if (!constraint || typeof full !== "string") return [];
  // node-sqlite3 prefixes SQLite's message with the code.
  const message = full.replace(/^SQLITE_CONSTRAINT: /, "");
  const unique = /^UNIQUE constraint failed: (.+)$/.exec(message)?.[1];
  if (unique !== undefined) {
    // Expression indexes are reported by name: "index 'users_lower_email'".
    const named = /^index '(.+)'$/.exec(unique)?.[1];
    return [{ type: "unique", constraint: named ?? indexName(unique) }];
  }
  // SQLite does not say which foreign key failed.
  if (message === "FOREIGN KEY constraint failed")
    return [{ type: "foreign_key", constraint: null }];
  const check = /^CHECK constraint failed: (.+)$/.exec(message)?.[1];
  if (check !== undefined) return [{ type: "check", constraint: check }];
  return [];
}

const SQLITE_CONSTRAINT = 19;

type Row = Record<string, unknown>;

/** An open SQLite database, as ekto's driver uses it. */
interface SqliteHandle {
  /** Runs one statement and returns its rows (none for most writes). */
  all(sql: string, parameters: readonly unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

/** Opens `file` with node-sqlite3, which runs statements on libuv's thread pool. */
async function openSqlite3(file: string): Promise<SqliteHandle> {
  const { default: sqlite3 } = await import("sqlite3");
  const db = await new Promise<Sqlite3Database>((resolve, reject) => {
    const db: Sqlite3Database = new sqlite3.Database(file, (error) =>
      error ? reject(error) : resolve(db),
    );
  });
  return {
    all: (sql, parameters) =>
      new Promise((resolve, reject) =>
        db.all(sql, parameters, (error: Error | null, rows: Row[]) =>
          error ? reject(error) : resolve(rows),
        ),
      ),
    close: () =>
      new Promise((resolve, reject) =>
        db.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Opens `file` with Node's `node:sqlite`, which runs statements on the event loop's thread. */
async function openNodeSqlite(file: string): Promise<SqliteHandle> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  return {
    all: async (sql, parameters) =>
      db
        .prepare(sql)
        .all(...(parameters as SQLInputValue[]))
        // Its rows have no prototype; the other drivers' are plain objects.
        .map((row) => ({ ...row })),
    close: async () => db.close(),
  };
}

const WRITES = new Set([
  "InsertQueryNode",
  "UpdateQueryNode",
  "DeleteQueryNode",
]);

/**
 * Whether the statement is an insert, update or delete, whose result counts
 * the rows it changed. Kysely's queries say so, as ecto_sqlite3 passes the
 * command to Exqlite; raw SQL is looked at as Exqlite.Query looks at it.
 */
function writes({ query, sql }: CompiledQuery): boolean {
  if (WRITES.has(query.kind)) return true;
  return query.kind === "RawNode" && /INSERT|DELETE|UPDATE/.test(sql);
}

/** One SQLite database, as an Exqlite connection. */
class SqliteConnection implements DatabaseConnection {
  readonly #db: SqliteHandle;

  constructor(db: SqliteHandle) {
    this.#db = db;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const rows = (await this.#db.all(compiled.sql, compiled.parameters)) as R[];
    if (!writes(compiled)) return { rows };
    // Exqlite's num_rows for a write: sqlite3_changes(), on the same connection.
    const [result] = await this.#db.all("SELECT changes() AS changes", []);
    return { rows, numAffectedRows: BigInt(result?.changes as number) };
  }

  async *streamQuery<R>(
    compiled: CompiledQuery,
    chunkSize = 50,
  ): AsyncIterableIterator<QueryResult<R>> {
    const { rows } = await this.executeQuery<R>(compiled);
    for (let i = 0; i < rows.length; i += chunkSize)
      yield { rows: rows.slice(i, i + chunkSize) };
  }
}

/** A Kysely driver holding one SQLite database, as Kysely's SqliteDriver holds one. */
class SqliteHandleDriver implements Driver {
  readonly #open: () => Promise<SqliteHandle>;
  #db: SqliteHandle | undefined;
  #connection: SqliteConnection | undefined;

  constructor(open: () => Promise<SqliteHandle>) {
    this.#open = open;
  }

  async init(): Promise<void> {
    this.#db = await this.#open();
    this.#connection = new SqliteConnection(this.#db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.#connection === undefined)
      throw new Error("the SQLite driver is not initialized");
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async savepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await connection.executeQuery(
      CompiledQuery.raw(`savepoint ${quoteIdentifierAnsi(name)}`),
    );
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    name: string,
  ): Promise<void> {
    await connection.executeQuery(
      CompiledQuery.raw(`rollback to ${quoteIdentifierAnsi(name)}`),
    );
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    name: string,
  ): Promise<void> {
    await connection.executeQuery(
      CompiledQuery.raw(`release ${quoteIdentifierAnsi(name)}`),
    );
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    const db = this.#db;
    this.#db = undefined;
    this.#connection = undefined;
    await db?.close();
  }
}

/** The SQLite library the adapter connects with. */
export type SqliteDriverName = "sqlite3" | "node:sqlite";

export interface SqliteOptions {
  /**
   * `"sqlite3"` (node-sqlite3, the default) runs queries on libuv's thread
   * pool; `"node:sqlite"`, built into Node, runs them on the event loop's
   * thread and needs no package.
   */
  readonly driver?: SqliteDriverName;
}

/**
 * Connections to the `database` file, set up as ecto_sqlite3 and Exqlite
 * set them up: a `busy_timeout` of 2000 ms, `journal_mode` WAL, and
 * foreign keys on.
 */
function connector(driver: SqliteDriverName) {
  const openFile = driver === "node:sqlite" ? openNodeSqlite : openSqlite3;
  return (options: ConnectionOptions, poolSize: number): Dialect => {
    const {
      database,
      journalMode = "wal",
      busyTimeout = 2000,
      foreignKeys = true,
    } = options;
    if (database === undefined)
      throw new TypeError(
        'No SQLite database path specified. Give the Repo a database: createRepo({ adapter: sqlite(), database: "path/to/database.db" })',
      );
    if (database === ":memory:" && poolSize !== 1)
      throw new TypeError("In memory databases must have a poolSize of 1");
    const open = async () => {
      const db = await openFile(database);
      try {
        for (const pragma of [
          `busy_timeout = ${busyTimeout}`,
          `journal_mode = ${journalMode}`,
          `foreign_keys = ${foreignKeys ? "ON" : "OFF"}`,
        ])
          await db.all(`PRAGMA ${pragma}`, []);
      } catch (error) {
        await db.close().catch(() => {});
        throw error;
      }
      return db;
    };
    return {
      // One database per driver, so per pooled connection.
      createDriver: () => new SqliteHandleDriver(open),
      createQueryCompiler: () => new SqliteQueryCompiler(),
      createAdapter: () => new SqliteAdapter(),
      createIntrospector: (db) => new SqliteIntrospector(db),
    };
  };
}

/**
 * The SQLite adapter, connecting to the `database` file with node-sqlite3
 * (the `sqlite3` package, which the application installs):
 *
 * ```ts
 * const repo = createRepo<DB>({ adapter: sqlite(), database: "app.db" });
 * ```
 *
 * The pool has 5 connections unless `poolSize` says otherwise, as
 * ecto_sqlite3's. node-sqlite3 runs queries on libuv's thread pool, as
 * Exqlite runs them on dirty schedulers, so a connection waiting
 * `busyTimeout` for another's write lock does not block the event loop.
 * `":memory:"` databases must have a pool of one, as each connection would
 * open its own.
 *
 * `sqlite({ driver: "node:sqlite" })` connects with Node's built-in
 * `node:sqlite` instead, which needs no package (earlier Node 24 releases
 * print that it is experimental). It runs each query on the event loop's thread: a long
 * query, or a wait of up to `busyTimeout` for a write lock another process
 * holds, stops everything else meanwhile. Its pool has one connection, as
 * with more, one waiting for another's write lock would hold the thread
 * the other needs to commit.
 *
 * Values are stored as ecto_sqlite3 stores them: booleans as 0 and 1,
 * maps and arrays as JSON text, date-times as ISO 8601 text in UTC.
 *
 * Unique violations are matched by the index name Ecto's conventions give
 * the reported columns (`users_email_index`); foreign key violations carry
 * no name and are always thrown.
 */
export function sqlite(options: SqliteOptions = {}): Adapter {
  const driver = options.driver ?? "sqlite3";
  if (driver !== "sqlite3" && driver !== "node:sqlite")
    throw new TypeError(
      `unknown SQLite driver ${String(driver)}, expected "sqlite3" or "node:sqlite"`,
    );
  return Object.freeze({
    name: "sqlite",
    syntax: sqliteSyntax,
    defaultPoolSize: driver === "node:sqlite" ? 1 : 5,
    connect: connector(driver),
    load: loadValue,
    dump: dumpValue,
    toConstraints,
    ddl: sqliteDdl,
    columnType: sqliteColumnType,
    describeTables,
  });
}

export { sqliteDdl };
