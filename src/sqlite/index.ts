/**
 * SQLite support (`ekto/sqlite`), following ecto_sqlite3.
 */

import Database from "better-sqlite3";
import { type Dialect, SqliteDialect, SqliteDriver } from "kysely";
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
 * What better-sqlite3 (Kysely's `SqliteDialect`) returns, for the storage
 * classes ecto_sqlite3 uses: booleans are integers, dates, times and
 * date-times ISO 8601 text, maps and arrays JSON text, and decimals have
 * numeric affinity, so they usually come back as numbers.
 */
export type SqliteTypes = {
  readonly id: DriverValue<number, number | bigint>;
  readonly integer: DriverValue<number, number | bigint>;
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

function loadInteger(value: unknown): unknown {
  // better-sqlite3 returns bigints with `safeIntegers` on.
  if (typeof value !== "bigint") return value;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}

// Codec.bool_decode/1.
function loadBoolean(value: unknown): unknown {
  switch (value) {
    case 0:
    case 0n:
    case "0":
    case "FALSE":
      return false;
    case 1:
    case 1n:
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
    case "id":
    case "integer":
      return loadInteger(value);
    case "float":
      return typeof value === "bigint" ? Number(value) : value;
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
      // better-sqlite3 cannot bind booleans (Codec.bool_encode/1).
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
    case "binary":
      // better-sqlite3 binds Buffers as blobs.
      return value instanceof Uint8Array && !Buffer.isBuffer(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : value;
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

/** The constraint violated by a better-sqlite3 `SqliteError` (ecto_sqlite3's `to_constraints/2`). */
function toConstraints(error: unknown): readonly ConstraintViolation[] {
  if (typeof error !== "object" || error === null) return [];
  const { message } = error as { message?: unknown };
  if (typeof message !== "string") return [];
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

/**
 * Connections to the `database` file with better-sqlite3, set up as
 * ecto_sqlite3 and Exqlite set them up: `journal_mode` WAL, a
 * `busy_timeout` of 2000 ms, and foreign keys on.
 */
function connect(options: ConnectionOptions, poolSize: number): Dialect {
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
    const db = new Database(database);
    db.pragma(`journal_mode = ${journalMode}`);
    db.pragma(`busy_timeout = ${busyTimeout}`);
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    return db;
  };
  const dialect = new SqliteDialect({ database: open });
  return {
    // One better-sqlite3 database per driver, so per pooled connection.
    createDriver: () => new SqliteDriver({ database: open }),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: (db) => dialect.createIntrospector(db),
  };
}

/**
 * The SQLite adapter, connecting with better-sqlite3 (which the application
 * installs) to the `database` file:
 *
 * ```ts
 * const repo = createRepo<DB>({ adapter: sqlite(), database: "app.db" });
 * ```
 *
 * The pool has one connection unless `poolSize` says otherwise, where
 * ecto_sqlite3 has 5: better-sqlite3 runs queries on the event loop's
 * thread, so a connection waiting for another's write lock blocks the
 * thread for up to `busyTimeout`, and the other cannot finish its
 * transaction meanwhile. One connection queues transactions instead.
 * `":memory:"` databases must have a pool of one, as each connection would
 * open its own.
 *
 * Values are stored as ecto_sqlite3 stores them: booleans as 0 and 1,
 * maps and arrays as JSON text, date-times as ISO 8601 text in UTC.
 *
 * Unique violations are matched by the index name Ecto's conventions give
 * the reported columns (`users_email_index`); foreign key violations carry
 * no name and are always thrown.
 */
export function sqlite(): Adapter {
  return Object.freeze({
    name: "sqlite",
    syntax: sqliteSyntax,
    defaultPoolSize: 1,
    connect,
    load: loadValue,
    dump: dumpValue,
    toConstraints,
    ddl: sqliteDdl,
    columnType: sqliteColumnType,
    describeTables,
  });
}

export { sqliteDdl };
