import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Database from "better-sqlite3";
import { type Kysely, Kysely as KyselyClass, SqliteDialect, sql } from "kysely";
import { change } from "../changeset.ts";
import { postgres } from "../postgres/index.ts";
import { connectPg, skipWithoutPg } from "../postgres.test-helper.ts";
import { createRepo, type Repo } from "../repo.ts";
import { schema, t } from "../schema.ts";
import { sqlite } from "../sqlite/index.ts";
import { checkout, sandbox, withSandbox } from "./index.ts";

const User = schema("sandbox_users", { id: t.id(), email: t.string() });

const newUser = (email: string) => change(User.new(), { email });

// biome-ignore lint/suspicious/noExplicitAny: any database
type AnyKysely = Kysely<any>;

function suite(
  name: string,
  connect: () => AnyKysely,
  Repo: (db: AnyKysely) => Repo,
  idType: string,
) {
  describe(name, () => {
    const db = connect();
    const repo = Repo(db);
    const box = sandbox(repo);

    before(async () => {
      await sql.raw("DROP TABLE IF EXISTS sandbox_users").execute(db);
      await sql
        .raw(`CREATE TABLE sandbox_users (id ${idType}, email TEXT NOT NULL)`)
        .execute(db);
    });
    after(async () => {
      await sql.raw("DROP TABLE IF EXISTS sandbox_users").execute(db);
      await db.destroy();
    });

    test("writes in a test are visible to it", async () => {
      await box.repo.insertOrThrow(newUser("ann@example.com"));
      const { rows } = await sql<{
        n: number | string;
      }>`SELECT count(*) AS n FROM sandbox_users`.execute(box.repo.kysely);
      assert.equal(Number(rows[0]?.n), 1, "kysely is bound to the sandbox");
      assert.equal((await box.repo.all(User)).length, 1);
    });

    test("and rolled back after it", async () => {
      assert.deepEqual(await box.repo.all(User), []);
    });

    test("the code under test sees no transaction, and transact uses savepoints", async () => {
      assert.equal(box.repo.inTransaction, false);
      await box.repo.insertOrThrow(newUser("kept@example.com"));
      const result = await box.repo.transact(async (tx) => {
        assert.equal(tx.inTransaction, true);
        await tx.insertOrThrow(newUser("gone@example.com"));
        return { ok: false, error: "rollback" } as const;
      });
      assert.equal(result.ok, false);
      assert.deepEqual(
        (await box.repo.all(User)).map((u) => u.email),
        ["kept@example.com"],
      );
    });

    test("the application's Repo runs on the sandbox", async () => {
      await repo.insertOrThrow(newUser("app@example.com"));
      assert.equal(repo.inTransaction, false);
      assert.equal((await box.repo.all(User)).length, 1);
      const { rows } = await sql<{
        n: number | string;
      }>`SELECT count(*) AS n FROM sandbox_users`.execute(repo.kysely);
      assert.equal(Number(rows[0]?.n), 1);
    });

    test("and its writes are rolled back too", async () => {
      assert.deepEqual(await repo.all(User), []);
    });

    test("a second shared sandbox on the Repo is refused", async () => {
      const hooks: (() => Promise<void>)[] = [];
      sandbox(repo, {
        beforeEach: (fn) => hooks.push(fn),
        afterEach: (fn) => hooks.push(fn),
      });
      const [before, afterHook] = hooks;
      await assert.rejects(before?.() ?? Promise.resolve(), /already shared/);
      await afterHook?.();
      assert.deepEqual(await repo.all(User), []);
    });

    test("checkout and checkin", async () => {
      // A checkout inside a sandbox is a savepoint in its transaction.
      const inner = await checkout(box.repo);
      await inner.repo.insertOrThrow(newUser("inner@example.com"));
      assert.equal((await inner.repo.all(User)).length, 1);
      await inner.checkin();
      await inner.checkin();
      assert.deepEqual(await box.repo.all(User), []);
    });
  });
}

suite(
  "sandbox on SQLite",
  () =>
    new KyselyClass({
      dialect: new SqliteDialect({ database: new Database(":memory:") }),
    }),
  (db) => createRepo({ db, adapter: sqlite() }),
  "INTEGER PRIMARY KEY AUTOINCREMENT",
);

describe("sandbox on Postgres", { skip: skipWithoutPg }, () => {
  if (skipWithoutPg) return;
  suite(
    "pool",
    () => connectPg().db,
    (db) => createRepo({ db, adapter: postgres() }),
    "bigserial PRIMARY KEY",
  );
});

function ownership(
  name: string,
  connect: () => AnyKysely,
  Repo: (db: AnyKysely) => Repo,
  idType: string,
) {
  describe(name, () => {
    const db = connect();
    const repo = Repo(db);

    before(async () => {
      await sql.raw("DROP TABLE IF EXISTS owned_users").execute(db);
      await sql
        .raw(`CREATE TABLE owned_users (id ${idType}, email TEXT NOT NULL)`)
        .execute(db);
    });
    after(async () => {
      await sql.raw("DROP TABLE IF EXISTS owned_users").execute(db);
      await db.destroy();
    });

    const Owned = schema("owned_users", { id: t.id(), email: t.string() });

    test("withSandbox redirects the Repo in its async context only", async () => {
      const result = await withSandbox(repo, async (sandboxed) => {
        await repo.insertOrThrow(change(Owned.new(), { email: "a@x" }));
        assert.equal(repo.inTransaction, false);
        const inside = await new Promise<number>((resolve) =>
          setTimeout(async () => resolve((await repo.all(Owned)).length), 1),
        );
        assert.equal((await sandboxed.all(Owned)).length, 1);
        return inside;
      });
      assert.equal(result, 1, "async work started inside sees the sandbox");
      assert.deepEqual(await repo.all(Owned), [], "rolled back");
    });

    test("transactions inside are savepoints", async () => {
      await withSandbox(repo, async () => {
        const result = await repo.transact(async (tx) => {
          await tx.insertOrThrow(change(Owned.new(), { email: "b@x" }));
          return { ok: false } as const;
        });
        assert.equal(result.ok, false);
        assert.deepEqual(await repo.all(Owned), []);
        // A checkout of the redirected Repo nests in the sandbox.
        const inner = await checkout(repo);
        await inner.repo.insertOrThrow(change(Owned.new(), { email: "c@x" }));
        await inner.checkin();
        assert.deepEqual(await repo.all(Owned), []);
      });
    });

    test("only Repos made by createRepo can be sandboxed this way", async () => {
      await withSandbox(repo, async (sandboxed) => {
        await assert.rejects(
          withSandbox(sandboxed, async () => {}),
          /expected the Repo created with createRepo/,
        );
      });
    });
  });
}

ownership(
  "withSandbox on SQLite",
  () =>
    new KyselyClass({
      dialect: new SqliteDialect({ database: new Database(":memory:") }),
    }),
  (db) => createRepo({ db, adapter: sqlite() }),
  "INTEGER PRIMARY KEY AUTOINCREMENT",
);

describe("withSandbox on Postgres", { skip: skipWithoutPg }, () => {
  if (skipWithoutPg) return;
  ownership(
    "pool",
    () => connectPg().db,
    (db) => createRepo({ db, adapter: postgres() }),
    "bigserial PRIMARY KEY",
  );
});

describe("sandbox outside tests", () => {
  test("the Repo is only available in a test", () => {
    const repo = createRepo({
      db: new KyselyClass({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      }),
      adapter: sqlite(),
    });
    const box = sandbox(repo, { beforeEach: () => {}, afterEach: () => {} });
    assert.throws(() => box.repo, /only available inside a test/);
  });

  test("checkout expects a Repo", async () => {
    await assert.rejects(
      checkout({} as Repo),
      /expected a Repo created with createRepo/,
    );
  });
});
