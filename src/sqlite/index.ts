/**
 * SQLite support (`ekto/sqlite`).
 */

import type { DriverValue, KyselyTables } from "../kysely.ts";
import type { AnySchema } from "../schema.ts";

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
