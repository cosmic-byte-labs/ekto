import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Kysely } from "kysely";
import sqlite3 from "sqlite3";
import { hasMany } from "../association.ts";
import {
  cast,
  change,
  checkConstraint,
  foreignKeyConstraint,
  pipe,
  uniqueConstraint,
  validateRequired,
} from "../changeset.ts";
import { ConstraintError } from "../errors.ts";
import { createRepo, type Repo } from "../repo.ts";
import { type Infer, type New, schema, t } from "../schema.ts";
import { type KyselyDB, sqlite } from "./index.ts";

const adapter = sqlite();

describe("sqlite adapter", () => {
  test("loads integers, booleans and JSON as ecto_sqlite3 does", () => {
    assert.equal(adapter.load("id", 42), 42);
    for (const v of [1, "1", "TRUE"])
      assert.equal(adapter.load("boolean", v), true);
    for (const v of [0, "0", "FALSE"])
      assert.equal(adapter.load("boolean", v), false);
    assert.equal(adapter.load("boolean", 2), 2, "left for the type to reject");
    assert.deepEqual(adapter.load("map", '{"a":[1]}'), { a: [1] });
    assert.deepEqual(adapter.load("map", { a: 1 }), { a: 1 });
    assert.equal(adapter.load("map", "{nope"), "{nope");
    assert.deepEqual(
      adapter.load(["array", "utc_datetime"], '["2026-01-02T10:30:00Z",null]'),
      [new Date("2026-01-02T10:30:00Z"), null],
    );
  });

  test("loads date-times as UTC and drops fractional seconds of times", () => {
    assert.deepEqual(
      adapter.load("utc_datetime", "2026-01-02 10:30:00"),
      new Date("2026-01-02T10:30:00Z"),
      "CURRENT_TIMESTAMP text",
    );
    assert.deepEqual(
      adapter.load("utc_datetime_msec", "2026-01-02T10:30:00.123456+0200"),
      new Date("2026-01-02T08:30:00.123Z"),
    );
    assert.equal(adapter.load("time", "07:30:00.5"), "07:30:00");
  });

  test("dumps what node-sqlite3 can bind", () => {
    assert.equal(adapter.dump("boolean", true), 1);
    assert.equal(adapter.dump("boolean", false), 0);
    assert.equal(adapter.dump("map", { a: [1] }), '{"a":[1]}');
    assert.equal(adapter.dump(["array", "string"], ["a", null]), '["a",null]');
    const date = new Date("2026-01-02T10:30:00Z");
    assert.equal(adapter.dump("utc_datetime", date), "2026-01-02T10:30:00Z");
    assert.equal(
      adapter.dump("utc_datetime_msec", date),
      "2026-01-02T10:30:00.000Z",
    );
  });

  test("maps constraint violations like ecto_sqlite3", () => {
    const error = (message: string) =>
      Object.assign(new Error(message), { code: "SQLITE_CONSTRAINT" });
    assert.deepEqual(
      adapter.toConstraints(error("UNIQUE constraint failed: users.email")),
      [{ type: "unique", constraint: "users_email_index" }],
    );
    assert.deepEqual(
      adapter.toConstraints(
        error("SQLITE_CONSTRAINT: UNIQUE constraint failed: users.email"),
      ),
      [{ type: "unique", constraint: "users_email_index" }],
      "as node-sqlite3 reports it",
    );
    assert.deepEqual(
      adapter.toConstraints(
        error("UNIQUE constraint failed: users.org_id, users.email"),
      ),
      [{ type: "unique", constraint: "users_org_id_email_index" }],
    );
    assert.deepEqual(
      adapter.toConstraints(
        error("UNIQUE constraint failed: index 'users_lower_email'"),
      ),
      [{ type: "unique", constraint: "users_lower_email" }],
    );
    assert.deepEqual(
      adapter.toConstraints(error("CHECK constraint failed: age_positive")),
      [{ type: "check", constraint: "age_positive" }],
    );
    assert.deepEqual(
      adapter.toConstraints(error("FOREIGN KEY constraint failed")),
      [{ type: "foreign_key", constraint: null }],
    );
    assert.deepEqual(
      adapter.toConstraints(error("NOT NULL constraint failed: users.email")),
      [],
    );
    assert.deepEqual(adapter.toConstraints("boom"), []);
  });

  test("maps node:sqlite's errors, which carry the extended result code", () => {
    const error = Object.assign(
      new Error("UNIQUE constraint failed: users.email"),
      { code: "ERR_SQLITE_ERROR", errcode: 2067 },
    );
    assert.deepEqual(adapter.toConstraints(error), [
      { type: "unique", constraint: "users_email_index" },
    ]);
    const other = Object.assign(new Error("no such table: users"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 1,
    });
    assert.deepEqual(adapter.toConstraints(other), []);
  });

  test("connects with node-sqlite3 or node:sqlite", () => {
    assert.equal(sqlite().defaultPoolSize, 5);
    assert.equal(sqlite({ driver: "node:sqlite" }).defaultPoolSize, 1);
    assert.throws(
      () => sqlite({ driver: "better-sqlite3" as "sqlite3" }),
      /unknown SQLite driver/,
    );
  });
});

class User extends schema("users", {
  id: t.id(),
  email: t.string(),
  admin: t.boolean().default(false),
  score: t.decimal().nullable(),
  tags: t.array(t.string().type).default([]),
  settings: t.map().nullable(),
  birthday: t.date().nullable(),
  avatar: t.binary().nullable(),
  token: t.uuid().autogenerate(),
  age: t.integer().nullable(),
  ...t.timestamps(),
}) {
  static associations = {
    posts: hasMany(() => Post, { foreignKey: "user_id" }),
  };
}

const Post = schema("posts", {
  id: t.id(),
  title: t.string(),
  user_id: t.integer(),
});

// As ecto_sqlite3 migrations would create them.
const DDL = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    admin INTEGER NOT NULL DEFAULT 0,
    score DECIMAL,
    tags TEXT NOT NULL DEFAULT '[]',
    settings TEXT,
    birthday TEXT,
    avatar BLOB,
    token TEXT NOT NULL,
    age INTEGER CONSTRAINT age_must_be_positive CHECK (age >= 0),
    inserted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX users_email_index ON users (email);
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users (id)
  );
`;

type DB = KyselyDB<[typeof User, typeof Post]>;

const userChangeset = (
  data: Infer<typeof User> | New<typeof User>,
  params: Record<string, unknown>,
) =>
  pipe(
    cast(data, params, [
      "email",
      "admin",
      "score",
      "tags",
      "settings",
      "birthday",
      "avatar",
      "age",
    ]),
    validateRequired(["email"]),
    uniqueConstraint("email"),
  );

/** A second connection to the file, beside the Repo's. */
function side(file: string) {
  const db = new sqlite3.Database(file);
  const call = <T>(
    fn: (done: (error: Error | null, result?: T) => void) => void,
  ) =>
    new Promise<T>((resolve, reject) =>
      fn((error, result) => (error ? reject(error) : resolve(result as T))),
    );
  return {
    exec: (sql: string) => call<void>((done) => db.exec(sql, done)),
    get: (sql: string) =>
      call<Record<string, unknown>>((done) => db.get(sql, done)),
    close: () => call<void>((done) => db.close(done)),
  };
}

for (const driver of ["sqlite3", "node:sqlite"] as const)
  describe(`Repo on SQLite (${driver})`, () => {
    let sqliteDb: ReturnType<typeof side>;
    let db: Kysely<DB>;
    let Repo: Repo<DB>;

    const dir = mkdtempSync(join(tmpdir(), "ekto-sqlite-"));

    before(async () => {
      // The Repo's connections and this one share the file.
      sqliteDb = side(join(dir, "test.db"));
      await sqliteDb.exec(DDL);
      Repo = createRepo<DB>({
        adapter: sqlite({ driver }),
        database: join(dir, "test.db"),
      });
      db = Repo.kysely;
    });

    after(async () => {
      await Repo.stop();
      await sqliteDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await sqliteDb.exec("DELETE FROM posts; DELETE FROM users;");
    });

    const insertUser = (params: Record<string, unknown> = {}) =>
      Repo.insertOrThrow(
        userChangeset(User.new(), { email: "ann@example.com", ...params }),
      );

    test("round-trips every type through the storage classes", async () => {
      const user = await insertUser({
        admin: true,
        score: "12.5",
        tags: ["a", "b"],
        settings: { theme: "dark" },
        birthday: "1990-05-01",
        avatar: new Uint8Array([1, 2, 3]),
        age: 42,
      });
      assert.equal(typeof user.id, "number");
      const row = await sqliteDb.get("SELECT * FROM users");
      assert.equal(row.admin, 1);
      assert.equal(row.tags, '["a","b"]');
      assert.equal(row.settings, '{"theme":"dark"}');
      assert.match(
        String(row.inserted_at),
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );

      const loaded = await Repo.getOrThrow(User, user.id);
      assert.equal(loaded.admin, true);
      assert.equal(loaded.score, "12.5");
      assert.deepEqual(loaded.tags, ["a", "b"]);
      assert.deepEqual(loaded.settings, { theme: "dark" });
      assert.equal(loaded.birthday, "1990-05-01");
      assert.deepEqual([...(loaded.avatar ?? [])], [1, 2, 3]);
      assert.deepEqual(loaded.inserted_at, user.inserted_at);
      assert.equal(loaded.token, user.token);
    });

    test("updates and deletes", async () => {
      const user = await insertUser();
      const updated = await Repo.updateOrThrow(change(user, { admin: true }));
      assert.equal(updated.admin, true);
      assert.equal((await Repo.getOrThrow(User, user.id)).admin, true);
      await Repo.deleteOrThrow(updated);
      assert.equal(await Repo.get(User, user.id), null);
    });

    test("unique violations become changeset errors", async () => {
      await insertUser();
      const result = await Repo.insert(
        userChangeset(User.new(), { email: "ann@example.com" }),
      );
      assert.ok(!result.ok);
      assert.deepEqual(result.changeset.errors, [
        {
          field: "email",
          message: "has already been taken",
          meta: { constraint: "unique", constraintName: "users_email_index" },
        },
      ]);
    });

    test("check violations become changeset errors", async () => {
      const user = await insertUser();
      const result = await Repo.update(
        checkConstraint(change(user, { age: -1 }), "age", {
          name: "age_must_be_positive",
        }),
      );
      assert.ok(!result.ok);
      assert.equal(result.changeset.errors[0]?.field, "age");
    });

    test("foreign key violations are always thrown, without a name", async () => {
      await assert.rejects(
        Repo.insert(
          foreignKeyConstraint(
            change(Post.new({ title: "Hi", user_id: 42 })),
            "user_id",
          ),
        ),
        (e: unknown) =>
          e instanceof ConstraintError &&
          e.type === "foreign_key" &&
          e.constraint === null,
      );
    });

    test("transactions and savepoints roll back", async () => {
      await Repo.transact(async (tx) => {
        await tx.insertOrThrow(
          userChangeset(User.new(), { email: "kept@example.com" }),
        );
        await assert.rejects(
          tx.transact(async (inner) => {
            await inner.insertOrThrow(
              userChangeset(User.new(), { email: "gone@example.com" }),
            );
            throw new Error("rollback");
          }),
          /rollback/,
        );
        return { ok: true } as const;
      });
      const emails = (await Repo.all(User)).map((u) => u.email);
      assert.deepEqual(emails, ["kept@example.com"]);
    });

    test("insertAll with upserts, and preloads", async () => {
      const user = await insertUser();
      const userId = user.id;
      assert.ok(userId !== null);
      await Repo.insertAll(Post, [
        { title: "One", user_id: userId },
        { title: "Two", user_id: userId },
      ]);
      const loaded = await Repo.preload(user, "posts");
      assert.deepEqual(loaded.posts.map((p) => p.title).sort(), ["One", "Two"]);

      const { count } = await Repo.insertAll(
        User,
        [
          {
            email: "ann@example.com",
            token: crypto.randomUUID(),
            inserted_at: new Date(0),
            updated_at: new Date(0),
          },
        ],
        { onConflict: "nothing", conflictTarget: ["email"] },
      );
      assert.equal(count, 0);
    });

    test("Repo.all loads schema rows from Kysely queries", async () => {
      await insertUser({ admin: true });
      const admins = await Repo.all(
        User,
        db.selectFrom("users").selectAll().where("admin", "=", 1),
      );
      assert.equal(admins.length, 1);
      assert.equal(admins[0]?.admin, true);
    });

    test("exists and aggregate", async () => {
      assert.equal(await Repo.exists(User), false);
      assert.equal(await Repo.aggregate(User, "max", "age"), null);
      await insertUser({ age: 20, admin: true });
      await insertUser({ email: "b@example.com", age: 25 });
      assert.equal(await Repo.exists(User), true);
      assert.equal(
        await Repo.exists(
          db.selectFrom("users").where("admin", "=", 1).select("id"),
        ),
        true,
      );
      assert.equal(await Repo.aggregate(User, "count"), 2);
      assert.equal(await Repo.aggregate(User, "avg", "age"), 22.5);
      assert.equal(await Repo.aggregate(User, "sum", "age"), 45);
      assert.equal(await Repo.aggregate(User, "max", "admin"), true);
      assert.equal(
        await Repo.aggregate(
          db.selectFrom("users").select("age").where("age", ">", 21),
          "count",
        ),
        1,
      );
    });
  });
