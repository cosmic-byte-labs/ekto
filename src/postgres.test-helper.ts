/**
 * A Kysely instance on the Postgres database in `EKTO_PG_URL`, for
 * integration tests. Tests that need it are skipped when it is not set.
 */

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { utcTimestamps } from "./postgres/index.ts";

export const pgUrl: string | undefined = process.env.EKTO_PG_URL;

/** The `skip` option for suites that need Postgres. */
export const skipWithoutPg: string | false =
  pgUrl === undefined ? "set EKTO_PG_URL to run Postgres tests" : false;

export function connectPg<DB>({ max = 4 }: { max?: number } = {}): {
  db: Kysely<DB>;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({
    connectionString: pgUrl,
    max,
    types: utcTimestamps(pg.types),
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
