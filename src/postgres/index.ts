/**
 * PostgreSQL support (`ekto/postgres`).
 */

import type { DriverValue, KyselyTables } from "../kysely.ts";
import type { AnySchema } from "../schema.ts";

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
