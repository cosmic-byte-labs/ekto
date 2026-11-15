/**
 * A Repo on the Postgres database in `EKTO_PG_URL`, for integration tests.
 * Tests that need it are skipped when it is not set.
 */

import { postgres } from "./postgres/index.ts";
import { createRepo, type Repo, type RepoConfig } from "./repo.ts";

export const pgUrl: string | undefined = process.env.EKTO_PG_URL;

/** The `skip` option for suites that need Postgres. */
export const skipWithoutPg: string | false =
  pgUrl === undefined ? "set EKTO_PG_URL to run Postgres tests" : false;

/** A Repo on the test database, with a pool of 4 unless `options` say otherwise. */
export function connectPg<DB>(
  options: Partial<Omit<RepoConfig, "adapter">> = {},
): Repo<DB> {
  return createRepo<DB>({
    adapter: postgres(),
    url: pgUrl,
    poolSize: 4,
    ...options,
  });
}
