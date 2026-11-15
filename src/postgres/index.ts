/**
 * PostgreSQL support (`ekto/postgres`).
 */

import { type Kysely, sql } from "kysely";
import type { Adapter, ConstraintViolation } from "../adapter.ts";
import type { ConstraintType } from "../changeset.ts";
import type { DriverValue, KyselyTables } from "../kysely.ts";
import type { AnySchema } from "../schema.ts";
import { quoteIdentifierAnsi, type SqlSyntax } from "../sql.ts";
import type { PrimitiveType } from "../type.ts";
import { postgresColumnType, postgresDdl } from "./ddl.ts";
import { describeTables } from "./describe.ts";

/** How PostgreSQL writes `sql` values: `$1`, `$2`… and double-quoted identifiers. */
export const postgresSyntax: SqlSyntax = Object.freeze({
  placeholder: (index: number) => `$${index + 1}`,
  quoteIdentifier: quoteIdentifierAnsi,
});

/**
 * What node-postgres (`pg`, Kysely's `PostgresDialect`) returns with its
 * default type parsers, for the column types Ecto's migrations create:
 * `bigint` keys and `numeric` come back as strings, `date` and `timestamp`
 * as `Date`, `jsonb` parsed, `bytea` as a `Buffer`.
 */
export type PostgresTypes = {
  readonly id: DriverValue<string, string | number | bigint>;
  readonly integer: DriverValue<number>;
  readonly float: DriverValue<number>;
  readonly decimal: DriverValue<string, string | number>;
  readonly boolean: DriverValue<boolean>;
  readonly string: DriverValue<string>;
  readonly binary: DriverValue<Uint8Array>;
  readonly map: DriverValue<unknown>;
  readonly uuid: DriverValue<string>;
  readonly date: DriverValue<Date, Date | string>;
  readonly time: DriverValue<string>;
  readonly utc_datetime: DriverValue<Date, Date | string>;
  readonly utc_datetime_msec: DriverValue<Date, Date | string>;
  readonly any: DriverValue<unknown>;
  readonly array: "elements";
};

/**
 * The Kysely `DB` type for the given schemas on PostgreSQL, typed with what
 * the driver returns:
 *
 * ```ts
 * type DB = KyselyDB<[typeof User, typeof Post]>;
 * const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
 * ```
 */
export type KyselyDB<Schemas extends readonly AnySchema[]> = KyselyTables<
  Schemas,
  PostgresTypes
>;

const INTEGER = /^-?\d+$/;
// `timestamp` text as Postgres writes it: "2026-01-02 10:30:00.123456",
// optionally with an offset ("+00", "+05:30").
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function loadInteger(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }
  // node-postgres returns `int8` as a string so no precision is lost.
  if (typeof value === "string" && INTEGER.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }
  return value;
}

function loadTimestamp(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date, time, fraction = "", offset] = match;
  const ms = fraction.slice(0, 3).padEnd(3, "0");
  // `timestamp` (without time zone) holds UTC, as Ecto writes it.
  let zone = offset ?? "Z";
  if (/^[+-]\d{2}$/.test(zone)) zone += ":00";
  return new Date(`${date}T${time}.${ms}${zone}`);
}

function loadValue(type: PrimitiveType, value: unknown): unknown {
  if (typeof type !== "string") {
    return Array.isArray(value)
      ? value.map((item) => (item === null ? null : loadValue(type[1], item)))
      : value;
  }
  switch (type) {
    case "id":
    case "integer":
      return loadInteger(value);
    case "float":
      // `numeric` columns read into float fields come back as strings.
      return typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : value;
    case "date":
      // node-postgres parses `date` into a Date at local midnight.
      return value instanceof Date
        ? `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
        : value;
    case "time":
      // Ecto's :time has no fractional seconds; `time` columns may.
      return typeof value === "string" ? value.replace(/\.\d+$/, "") : value;
    case "utc_datetime":
    case "utc_datetime_msec":
      return loadTimestamp(value);
    default:
      return value;
  }
}

function dumpValue(type: PrimitiveType, value: unknown): unknown {
  if (typeof type !== "string") {
    return Array.isArray(value)
      ? value.map((item) => (item === null ? null : dumpValue(type[1], item)))
      : value;
  }
  switch (type) {
    case "utc_datetime":
    case "utc_datetime_msec":
      // An explicit UTC string, so `timestamp` columns store UTC whatever
      // the client's time zone (node-postgres would send local time).
      return value instanceof Date ? value.toISOString() : value;
    case "binary":
      return value instanceof Uint8Array && !Buffer.isBuffer(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : value;
    case "map":
      // node-postgres would send a top-level array as a Postgres array.
      return JSON.stringify(value);
    default:
      return value;
  }
}

// SQLSTATE codes of constraint violations (Postgrex's error code names).
const CONSTRAINT_ERRORS: Readonly<Record<string, ConstraintType>> = {
  "23505": "unique", // unique_violation
  "23503": "foreign_key", // foreign_key_violation
  "23001": "foreign_key", // restrict_violation
  "23P01": "exclusion", // exclusion_violation
  "23514": "check", // check_violation
};

/** The violated constraint of a node-postgres `DatabaseError` (Ecto's `to_constraints/2`). */
function toConstraints(error: unknown): readonly ConstraintViolation[] {
  if (typeof error !== "object" || error === null) return [];
  const { code, constraint, message } = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  const type = typeof code === "string" ? CONSTRAINT_ERRORS[code] : undefined;
  if (type === undefined) return [];
  if (typeof constraint === "string") return [{ type, constraint }];
  // Without the constraint field, take the name from the message, as Ecto
  // does for old servers.
  const quoted =
    type === "unique" && typeof message === "string"
      ? /unique constraint "(.+)"/.exec(message)?.[1]
      : undefined;
  return quoted === undefined ? [] : [{ type, constraint: quoted }];
}

// The OIDs of `timestamp`, `timestamp[]` and `text[]`.
const TIMESTAMP_OID = 1114;
const TIMESTAMP_ARRAY_OID = 1115;
const TEXT_ARRAY_OID = 1009;

/** node-postgres's `types` (`pg.types`): the parser of each type OID. */
export type TypeParsers = {
  // biome-ignore lint/suspicious/noExplicitAny: the parsers' results
  getTypeParser(oid: number, format?: "text" | "binary"): any;
};

const parseUtc = (value: string | null): unknown =>
  value === null ? null : loadTimestamp(value);

/**
 * node-postgres type parsers that read `timestamp` (without time zone) and
 * `timestamp[]` columns as UTC, as Ecto writes them, instead of in the
 * client's local time zone. The other types keep the given parsers:
 *
 * ```ts
 * import pg from "pg";
 * const pool = new pg.Pool({ connectionString, types: utcTimestamps(pg.types) });
 * ```
 */
export function utcTimestamps(types: TypeParsers): TypeParsers {
  const getTypeParser = (oid: number, format?: "text" | "binary") => {
    if (format === "binary") return types.getTypeParser(oid, format);
    if (oid === TIMESTAMP_OID) return parseUtc;
    if (oid === TIMESTAMP_ARRAY_OID) {
      const parseArray = types.getTypeParser(TEXT_ARRAY_OID, "text") as (
        value: string,
      ) => (string | null)[];
      return (value: string) => parseArray(value).map(parseUtc);
    }
    return types.getTypeParser(oid, format);
  };
  return { getTypeParser };
}

/**
 * The PostgreSQL adapter, for Kysely's `PostgresDialect` with node-postgres.
 *
 * Columns created as Ecto creates them (`timestamp` without time zone,
 * holding UTC) must be read as UTC, or node-postgres reads them in the
 * client's local time zone. Configure the pool with {@link utcTimestamps}:
 *
 * ```ts
 * import pg from "pg";
 * new pg.Pool({ connectionString, types: utcTimestamps(pg.types) });
 * ```
 *
 * `timestamptz` columns work either way.
 */
export function postgres(): Adapter {
  return Object.freeze({
    name: "postgres",
    syntax: postgresSyntax,
    load: loadValue,
    dump: dumpValue,
    toConstraints,
    ddl: postgresDdl,
    columnType: postgresColumnType,
    describeTables,
    lockForMigrations,
  });
}

/**
 * Ecto's `:table_lock` strategy: a transaction on its own connection locks
 * the migrations table in SHARE UPDATE EXCLUSIVE mode, which conflicts with
 * itself but not with the inserts and deletes of the migration running on
 * another connection.
 */
async function lockForMigrations<T>(
  // biome-ignore lint/suspicious/noExplicitAny: any database
  db: Kysely<any>,
  table: string,
  fn: () => Promise<T>,
): Promise<T> {
  const trx = await db.startTransaction().execute();
  try {
    await sql`LOCK TABLE ${sql.table(table)} IN SHARE UPDATE EXCLUSIVE MODE`.execute(
      trx,
    );
    const result = await fn();
    await trx.commit().execute();
    return result;
  } catch (error) {
    await trx.rollback().execute();
    throw error;
  }
}

export { postgresDdl };
