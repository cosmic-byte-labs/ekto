/**
 * The test sandbox (`ekto/testing`), following Ecto.Adapters.SQL.Sandbox:
 * each test runs in a transaction that is rolled back when it ends, so tests
 * leave the database as they found it.
 *
 * While a test's sandbox is active, the application's Repo (the one made by
 * `createRepo`, and its `kysely`) runs on the sandbox's transaction, so the
 * code under test needs no changes. Queries sent to the application's own
 * Kysely instance bypass ekto and the sandbox.
 *
 * Ecto ties the sandbox's connection to the test process. ekto has two
 * modes, as Ecto does:
 *
 * - `sandbox(Repo)` shares the sandbox with all code while the test runs
 *   (Ecto's shared mode). Tests of one file must run one at a time, which is
 *   `node:test`'s default.
 * - `withSandbox(Repo, fn)` gives the sandbox to the async context of `fn`
 *   only (Ecto's ownership), so tests can run concurrently.
 */

import {
  afterEach as nodeAfterEach,
  beforeEach as nodeBeforeEach,
} from "node:test";
import {
  checkoutSandbox,
  type Repo,
  runInSandbox,
  shareSandbox,
} from "../repo.ts";

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
 * Only the returned Repo runs on the sandbox; `sandbox` and `withSandbox`
 * also redirect the application's Repo. Inside, `repo.inTransaction` is
 * `false` and `repo.transact` uses a savepoint, so the code under test
 * behaves as outside the sandbox. Called while a sandbox is active, it
 * starts a savepoint in it. On a pool (PostgreSQL), the sandbox holds one
 * connection until `checkin`.
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

/**
 * Runs `fn` in a sandbox that is rolled back when it ends. Inside `fn` and
 * the async work it starts, `repo` runs on the sandbox (Ecto's sandbox
 * ownership), so concurrent tests do not see each other's data.
 *
 * ```ts
 * test("inserts a user", () =>
 *   withSandbox(Repo, async () => {
 *     await createUser({ email: "ann@example.com" }); // uses Repo
 *     assert.equal((await Repo.all(User)).length, 1);
 *   }));
 * ```
 */
export async function withSandbox<DB, T>(
  repo: Repo<DB>,
  fn: (repo: Repo<DB>) => Promise<T>,
): Promise<T> {
  const box = await checkout(repo);
  try {
    return await runInSandbox(repo, box.repo, () => fn(box.repo));
  } finally {
    await box.checkin();
  }
}

/** The hooks `sandbox` registers with, `node:test`'s by default. */
export interface SandboxHooks {
  readonly beforeEach: (fn: () => Promise<void>) => void;
  readonly afterEach: (fn: () => Promise<void>) => void;
}

/** The sandbox of the running test. */
export interface Sandbox<DB> {
  /** The sandbox's Repo; read it inside a test or hook. */
  readonly repo: Repo<DB>;
}

/**
 * Runs every test of the enclosing suite (or file) in its own sandbox:
 * `beforeEach` checks out and shares the sandbox, so `repo` runs on it
 * (Ecto's shared mode), and `afterEach` rolls back. Tests must not run
 * concurrently; use `withSandbox` for those. Pass `hooks` to use another
 * test runner's `beforeEach` and `afterEach` (Vitest, Jest…).
 *
 * ```ts
 * sandbox(Repo);
 *
 * test("inserts a user", async () => {
 *   await createUser({ email: "ann@example.com" }); // uses Repo
 *   assert.equal((await Repo.all(User)).length, 1);
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
  let current: { box: SandboxCheckout<DB>; unshare: () => void } | undefined;
  hooks.beforeEach(async () => {
    const box = await checkout(repo);
    try {
      current = { box, unshare: shareSandbox(repo, box.repo) };
    } catch (error) {
      await box.checkin();
      throw error;
    }
  });
  hooks.afterEach(async () => {
    const done = current;
    current = undefined;
    if (done === undefined) return;
    done.unshare();
    await done.box.checkin();
  });
  return {
    get repo() {
      if (current === undefined)
        throw new Error(
          "the sandbox Repo is only available inside a test (between beforeEach and afterEach)",
        );
      return current.box.repo;
    },
  };
}
