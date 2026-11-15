/**
 * A Kysely instance on the Postgres database in `EKTO_PG_URL`, for
 * integration tests. Tests that need it are skipped when it is not set.
 */

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

export const pgUrl: string | undefined = process.env.EKTO_PG_URL;

/** The `skip` option for suites that need Postgres. */
export const skipWithoutPg: string | false =
  pgUrl === undefined ? "set EKTO_PG_URL to run Postgres tests" : false;

// Read `timestamp` (without time zone) as text: it holds UTC (see `postgres()`).
const TIMESTAMP_OID = 1114;

export function connectPg<DB>(): { db: Kysely<DB>; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: pgUrl,
    max: 4,
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === TIMESTAMP_OID
          ? (value: string) => value
          : pg.types.getTypeParser(
              oid,
              format,
            )) as typeof pg.types.getTypeParser,
    },
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
