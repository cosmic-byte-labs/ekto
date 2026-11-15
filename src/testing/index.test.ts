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
import { checkout, sandbox } from "./index.ts";

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
