/**
 * The test sandbox (`ekto/testing`), following Ecto.Adapters.SQL.Sandbox:
 * each test runs in a transaction that is rolled back when it ends, so tests
 * leave the database as they found it.
 *
 * Ecto's sandbox owns the connection of the test process, so every query of
 * the test joins its transaction. ekto has no processes: the test and the
 * code under test must use the sandbox's Repo (`t.repo`, and `t.repo.kysely`
 * for Kysely queries), not the application's Repo or Kysely instance.
 */

import {
  afterEach as nodeAfterEach,
  beforeEach as nodeBeforeEach,
} from "node:test";
import { checkoutSandbox, type Repo } from "../repo.ts";

/** A sandboxed Repo and the function rolling its transaction back. */
export interface SandboxCheckout<DB> {
  /** A Repo on the sandbox transaction; its transactions are savepoints. */
  readonly repo: Repo<DB>;
  /** Rolls back everything done on `repo` (Ecto's `Sandbox.checkin/1`). */
  checkin(): Promise<void>;
}

/**
 * Starts a sandbox transaction on `repo` (Ecto's `Sandbox.checkout/1`).
 * Call `checkin()` when the test ends.
 *
 * Inside, `repo.inTransaction` is `false` and `repo.transact` uses a
 * savepoint, so the code under test behaves as outside the sandbox. On a
 * pool (PostgreSQL), the sandbox holds one connection until `checkin`.
 */
export async function checkout<DB>(
  repo: Repo<DB>,
): Promise<SandboxCheckout<DB>> {
  const { repo: sandboxed, end } = await checkoutSandbox(repo);
  let checkedIn = false;
  return {
    repo: sandboxed,
    async checkin() {
      if (checkedIn) return;
      checkedIn = true;
      await end(false);
    },
  };
}

/** The hooks `sandbox` registers with, `node:test`'s by default. */
export interface SandboxHooks {
  readonly beforeEach: (fn: () => Promise<void>) => void;
  readonly afterEach: (fn: () => Promise<void>) => void;
}

/** The sandbox of the running test. */
export interface Sandbox<DB> {
  /** The Repo of the running test; read it inside a test or hook. */
  readonly repo: Repo<DB>;
}

/**
 * Runs every test of the enclosing suite (or file) in its own sandbox:
 * `beforeEach` checks out, `afterEach` rolls back. Pass `hooks` to use
 * another test runner's `beforeEach` and `afterEach` (Vitest, Jest…).
 *
 * ```ts
 * const t = sandbox(Repo);
 *
 * test("inserts a user", async () => {
 *   await t.repo.insert(changeset);
 *   assert.equal((await t.repo.all(User)).length, 1);
 * });
 * ```
 */
export function sandbox<DB>(
  repo: Repo<DB>,
  hooks: SandboxHooks = {
    beforeEach: (fn) => nodeBeforeEach(fn),
    afterEach: (fn) => nodeAfterEach(fn),
  },
): Sandbox<DB> {
  let current: SandboxCheckout<DB> | undefined;
  hooks.beforeEach(async () => {
    current = await checkout(repo);
  });
  hooks.afterEach(async () => {
    const done = current;
    current = undefined;
    await done?.checkin();
  });
  return {
    get repo() {
      if (current === undefined)
        throw new Error(
          "the sandbox Repo is only available inside a test (between beforeEach and afterEach)",
        );
      return current.repo;
    },
  };
}
