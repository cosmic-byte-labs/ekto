import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { CompiledQuery, type Kysely, sql as ksql } from "kysely";
import type { QueryEvent } from "./adapter.ts";
import {
  addError,
  Changeset,
  cast,
  change,
  checkConstraint,
  foreignKeyConstraint,
  InvalidChangesetError,
  optimisticLock,
  pipe,
  prepareChanges,
  putChange,
  schemaless,
  uniqueConstraint,
  validateRequired,
} from "./changeset.ts";
import {
  ChangeError,
  ConstraintError,
  MultipleResultsError,
  NoPrimaryKeyValueError,
  NoResultsError,
  SchemaMismatchError,
  StaleEntryError,
} from "./errors.ts";
import { type KyselyDB, postgres } from "./postgres/index.ts";
import { connectPg, skipWithoutPg } from "./postgres.test-helper.ts";
import { createRepo, type Repo } from "./repo.ts";
import { getMeta, type Infer, schema, t } from "./schema.ts";
import { sql } from "./sql.ts";
import { CastError, string } from "./type.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

const User = schema("repo_users", {
  id: t.id(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  score: t.decimal().nullable(),
  tags: t.array(t.string().type).default([]),
  settings: t.map().nullable(),
  birthday: t.date().nullable(),
  wakes_at: t.time().nullable(),
  avatar: t.binary().nullable(),
  token: t.uuid().autogenerate(),
  lock_version: t.integer().default(1),
  visits: t.integer().readAfterWrites(),
  password: t.string().virtual(),
  ...t.timestamps(),
});

const Post = schema("repo_posts", {
  id: t.id(),
  title: t.string(),
  user_id: t.integer(),
});

// As Ecto migrations would create them.
const DDL = `
  DROP TABLE IF EXISTS repo_posts;
  DROP TABLE IF EXISTS repo_users;
  CREATE TABLE repo_users (
    id bigserial PRIMARY KEY,
    email varchar(255) NOT NULL,
    name varchar(255),
    age integer,
    score numeric,
    tags varchar(255)[] NOT NULL DEFAULT '{}',
    settings jsonb,
    birthday date,
    wakes_at time(0),
    avatar bytea,
    token uuid NOT NULL,
    lock_version integer NOT NULL DEFAULT 1,
    visits integer NOT NULL DEFAULT 0,
    inserted_at timestamp(0) NOT NULL,
    updated_at timestamp(0) NOT NULL,
    CONSTRAINT age_must_be_positive CHECK (age >= 0)
  );
  CREATE UNIQUE INDEX repo_users_email_index ON repo_users (email);
  CREATE TABLE repo_posts (
    id bigserial PRIMARY KEY,
    title varchar(255) NOT NULL,
    user_id bigint NOT NULL REFERENCES repo_users (id)
  );
`;

type DB = KyselyDB<[typeof User, typeof Post]>;

const userChangeset = (
  data: Infer<typeof User> | ReturnType<typeof User.new>,
  params: Record<string, unknown>,
) =>
  pipe(
    cast(data, params, [
      "email",
      "name",
      "age",
      "score",
      "tags",
      "settings",
      "birthday",
      "wakes_at",
      "avatar",
      "password",
    ]),
    validateRequired(["email"]),
  );

describe("Repo on Postgres", { skip: skipWithoutPg }, () => {
  let db: Kysely<DB>;
  let close: () => Promise<void>;
  let Repo: Repo<DB>;
  let queries: QueryEvent[] = [];

  const raw = async (text: string) =>
    (await db.executeQuery(CompiledQuery.raw(text))).rows as Record<
      string,
      unknown
    >[];

  before(async () => {
    const conn = connectPg<DB>();
    db = conn.db;
    close = () => db.destroy();
    await raw(DDL);
    Repo = createRepo({
      db,
      adapter: postgres(),
      onQuery: (event) => queries.push(event),
    });
  });

  after(async () => {
    await raw("DROP TABLE IF EXISTS repo_posts, repo_users");
    await close();
  });

  beforeEach(async () => {
    await raw("TRUNCATE repo_posts, repo_users RESTART IDENTITY");
    queries = [];
  });

  const insertUser = (params: Record<string, unknown> = {}) =>
    Repo.insertOrThrow(
      userChangeset(User.new(), { email: "ann@example.com", ...params }),
    );

  describe("insert", () => {
    test("inserts the changes and generated values and reads back the id", async () => {
      const result = await Repo.insert(
        userChangeset(User.new(), {
          email: "ann@example.com",
          age: "42",
          score: "12.50",
          tags: ["a", "b"],
          settings: { theme: "dark" },
          birthday: "1990-02-03",
          wakes_at: "07:30:00",
          avatar: new Uint8Array([1, 2, 3]),
          password: "secret",
        }),
      );
      assert.ok(result.ok);
      const user = result.value;
      assert.equal(user.id, 1);
      assert.equal(user.email, "ann@example.com");
      assert.equal(
        user.password,
        "secret",
        "virtual fields stay on the record",
      );
      assert.match(user.token ?? "", /^[0-9a-f-]{36}$/);
      assert.equal(user.visits, 0, "readAfterWrites fields are read back");
      assert.ok(user.inserted_at instanceof Date);
      assert.ok(user.updated_at instanceof Date);
      assert.equal(user.inserted_at.getMilliseconds(), 0);
      assert.equal(
        user.inserted_at,
        user.updated_at,
        "timestamps share one value",
      );
      assert.equal(getMeta(user)?.state, "loaded");

      const sql = queries.map((q) => q.sql);
      assert.equal(sql.length, 1);
      assert.match(
        sql[0] ?? "",
        /^INSERT INTO "repo_users" \(.*\) RETURNING "id", "visits"$/,
      );

      const loaded = await Repo.getOrThrow(User, user.id);
      assert.deepEqual(
        { ...loaded, password: "secret" },
        { ...user, avatar: loaded.avatar },
      );
      assert.deepEqual([...(loaded.avatar ?? [])], [1, 2, 3]);
      assert.equal(loaded.score, "12.50");
      assert.equal(loaded.birthday, "1990-02-03");
      assert.equal(loaded.wakes_at, "07:30:00");
      assert.equal(loaded.password, null);
    });

    test("stores datetimes as UTC in timestamp columns", async () => {
      const user = await insertUser();
      assert.ok(user.inserted_at);
      const [row] = await raw(
        "SELECT to_char(inserted_at, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS at FROM repo_users",
      );
      assert.equal(`${row?.at}.000Z`, user.inserted_at.toISOString());
    });

    test("inserts a record, taking its non-null fields as changes", async () => {
      const user = await Repo.insertOrThrow(
        User.new({ email: "bob@example.com", age: 30 }),
      );
      assert.equal(user.id, 1);
      const loaded = await Repo.getOrThrow(User, 1);
      assert.equal(loaded.email, "bob@example.com");
      assert.equal(loaded.age, 30);
      assert.equal(loaded.lock_version, 1);
    });

    test("uses an id the changes set", async () => {
      const user = await Repo.insertOrThrow(
        change(User.new({ email: "a@b.c" }), { id: 10 }),
      );
      assert.equal(user.id, 10);
      assert.doesNotMatch(queries[0]?.sql ?? "", /RETURNING "id"/);
    });

    test("returns invalid changesets with the action, without a query", async () => {
      const result = await Repo.insert(userChangeset(User.new(), {}));
      assert.ok(!result.ok);
      assert.equal(result.changeset.action, "insert");
      assert.equal(result.changeset.repo, Repo);
      assert.deepEqual(queries, []);
      await assert.rejects(
        Repo.insertOrThrow(userChangeset(User.new(), {})),
        InvalidChangesetError,
      );
    });

    test("rejects changesets meant for another action", async () => {
      const cs = change(User.new({ email: "a@b.c" }));
      await assert.rejects(
        Repo.insert(new Changeset({ ...cs, action: "update" })),
        /action "update" was given to Repo.insert/,
      );
    });

    test("returning reads back the given fields", async () => {
      const user = await Repo.insertOrThrow(User.new({ email: "a@b.c" }), {
        returning: true,
      });
      assert.equal(user.lock_version, 1);
      assert.match(queries[0]?.sql ?? "", /RETURNING "id", "email", "name"/);
    });

    test("throws ChangeError for values that do not match the type", async () => {
      const cs = putChange(
        change(User.new({ email: "a@b.c" })),
        "age",
        "old" as unknown as number,
      );
      await assert.rejects(
        Repo.insert(cs),
        (e: unknown) =>
          e instanceof ChangeError &&
          e.message ===
            "value 'old' for repo_users.age in insert does not match type integer",
      );
    });

    test("cannot insert schemaless data", async () => {
      const cs = change(schemaless({ email: string }, { email: "a@b.c" }));
      await assert.rejects(Repo.insert(cs), /schemaless data/);
    });
  });

  describe("update", () => {
    test("updates only the changes and the autoupdate fields", async () => {
      const user = await insertUser();
      queries = [];
      const result = await Repo.update(change(user, { name: "Ann" }));
      assert.ok(result.ok);
      assert.equal(result.value.name, "Ann");
      assert.equal(queries.length, 1);
      assert.match(
        queries[0]?.sql ?? "",
        /^UPDATE "repo_users" SET "name" = \$1, "updated_at" = \$2 WHERE "id" = \$3 RETURNING "visits"$/,
      );
      assert.equal((await Repo.getOrThrow(User, user.id)).name, "Ann");
    });

    test("does nothing without changes, unless forced", async () => {
      const user = await insertUser();
      queries = [];
      const unchanged = await Repo.updateOrThrow(change(user));
      assert.equal(unchanged, user);
      assert.equal(queries.length, 0);

      const forced = await Repo.updateOrThrow(change(user), { force: true });
      assert.equal(queries.length, 1);
      assert.match(queries[0]?.sql ?? "", /SET "updated_at" = \$1/);
      assert.ok(forced.updated_at && user.updated_at);
      assert.ok(forced.updated_at >= user.updated_at);
    });

    test("throws when given a record instead of a changeset", async () => {
      const user = await insertUser();
      await assert.rejects(
        Repo.update(user as never),
        /a Changeset must be given/,
      );
    });

    test("throws NoPrimaryKeyValueError without a primary key value", async () => {
      await assert.rejects(
        Repo.update(change(User.new({ email: "a@b.c" }), { name: "x" })),
        NoPrimaryKeyValueError,
      );
    });

    test("stale entries throw, or become errors with staleErrorField", async () => {
      const user = await insertUser();
      await raw("DELETE FROM repo_users");
      const cs = change(user, { name: "Ann" });
      await assert.rejects(Repo.update(cs), StaleEntryError);

      const result = await Repo.update(cs, { staleErrorField: "id" });
      assert.ok(!result.ok);
      assert.deepEqual(result.changeset.errors, [
        { field: "id", message: "is stale", meta: { stale: true } },
      ]);

      const allowed = await Repo.update(cs, { allowStale: true });
      assert.ok(allowed.ok);
    });

    test("optimisticLock detects concurrent updates", async () => {
      const user = await insertUser();
      const first = await Repo.updateOrThrow(
        optimisticLock(change(user, { name: "one" }), "lock_version"),
      );
      assert.equal(first.lock_version, 2);
      await assert.rejects(
        Repo.update(
          optimisticLock(change(user, { name: "two" }), "lock_version"),
        ),
        StaleEntryError,
      );
      assert.equal((await Repo.getOrThrow(User, user.id)).name, "one");
    });
  });

  describe("delete", () => {
    test("deletes a record and marks it deleted", async () => {
      const user = await insertUser();
      const deleted = await Repo.deleteOrThrow(user);
      assert.equal(getMeta(deleted)?.state, "deleted");
      assert.equal(await Repo.get(User, user.id), null);
      await assert.rejects(Repo.delete(user), StaleEntryError);
    });

    test("stale deletes can become errors", async () => {
      const user = await insertUser();
      await Repo.delete(user);
      const result = await Repo.delete(user, { staleErrorField: "id" });
      assert.ok(!result.ok);
      assert.equal(result.changeset.action, "delete");
    });
  });

  describe("constraints", () => {
    test("unique violations become errors when declared", async () => {
      await insertUser();
      const result = await Repo.insert(
        uniqueConstraint(
          userChangeset(User.new(), { email: "ann@example.com" }),
          "email",
        ),
      );
      assert.ok(!result.ok);
      assert.equal(result.changeset.valid, false);
      assert.deepEqual(result.changeset.errors, [
        {
          field: "email",
          message: "has already been taken",
          meta: {
            constraint: "unique",
            constraintName: "repo_users_email_index",
          },
        },
      ]);
    });

    test("undeclared violations throw ConstraintError", async () => {
      await insertUser();
      await assert.rejects(
        Repo.insert(userChangeset(User.new(), { email: "ann@example.com" })),
        (e: unknown) =>
          e instanceof ConstraintError &&
          e.type === "unique" &&
          e.constraint === "repo_users_email_index" &&
          e.message.includes("The changeset has not defined any constraint."),
      );
    });

    test("check constraints, matched by suffix, on update", async () => {
      const user = await insertUser();
      const result = await Repo.update(
        checkConstraint(change(user, { age: -1 }), "age", {
          name: "be_positive",
          match: "suffix",
        }),
      );
      assert.ok(!result.ok);
      assert.deepEqual(result.changeset.errors[0]?.meta, {
        constraint: "check",
        constraintName: "age_must_be_positive",
      });
    });

    test("foreign key constraints, with the conventional name", async () => {
      const result = await Repo.insert(
        foreignKeyConstraint(
          change(Post.new({ title: "Hi", user_id: 42 })),
          "user_id",
        ),
      );
      assert.ok(!result.ok);
      assert.deepEqual(result.changeset.errors, [
        {
          field: "user_id",
          message: "does not exist",
          meta: {
            constraint: "foreign",
            constraintName: "repo_posts_user_id_fkey",
          },
        },
      ]);
    });

    test("rolls back prepare functions' writes", async () => {
      await insertUser();
      const result = await Repo.insert(
        pipe(
          userChangeset(User.new(), { email: "ann@example.com" }),
          uniqueConstraint("email"),
          prepareChanges(async (cs) => {
            await cs.repo?.insert(User.new({ email: "side@effect.com" }));
            return cs;
          }),
        ),
      );
      assert.ok(!result.ok);
      assert.equal(
        (await raw("SELECT count(*)::int AS n FROM repo_users"))[0]?.n,
        1,
      );
    });
  });

  describe("prepareChanges", () => {
    test("runs in a transaction with the repo, before the write", async () => {
      const user = await insertUser();
      queries = [];
      const updated = await Repo.updateOrThrow(
        prepareChanges(change(user, { name: "Ann" }), async (cs) => {
          assert.equal(cs.repo, Repo);
          assert.ok(Repo.inTransaction);
          const count = await raw("SELECT count(*)::int AS n FROM repo_users");
          return putChange(cs, "age", count[0]?.n as number);
        }),
      );
      assert.equal(updated.age, 1);
      assert.ok(!Repo.inTransaction);
    });

    test("rolls back when the write fails", async () => {
      const user = await insertUser();
      const result = await Repo.update(
        prepareChanges(change(user, { name: "Ann" }), async (cs) => {
          await cs.repo?.insert(User.new({ email: "side@effect.com" }));
          return addError(cs, "name", "is taken");
        }),
      );
      assert.ok(!result.ok);
      assert.deepEqual(
        (await raw("SELECT email FROM repo_users")).map((r) => r.email),
        ["ann@example.com"],
      );
    });
  });

  describe("get and getBy", () => {
    test("get casts the id and returns null when missing", async () => {
      const user = await insertUser();
      assert.equal((await Repo.get(User, String(user.id)))?.id, user.id);
      assert.equal(await Repo.get(User, 999), null);
      await assert.rejects(Repo.getOrThrow(User, 999), NoResultsError);
      await assert.rejects(Repo.get(User, "abc"), CastError);
      await assert.rejects(Repo.get(User, null), /given value is null/);
    });

    test("getBy matches all clauses and rejects null", async () => {
      await insertUser({ name: "Ann", age: 30 });
      await insertUser({ email: "bob@example.com", name: "Bob", age: 30 });
      const bob = await Repo.getBy(User, { name: "Bob", age: 30 });
      assert.equal(bob?.email, "bob@example.com");
      assert.equal(await Repo.getBy(User, { name: "Cid" }), null);
      await assert.rejects(Repo.getBy(User, { age: 30 }), MultipleResultsError);
      await assert.rejects(
        Repo.getByOrThrow(User, { name: "Cid" }),
        NoResultsError,
      );
      await assert.rejects(
        Repo.getBy(User, { name: null }),
        /comparison with null is forbidden/,
      );
    });

    test("results are typed as loaded records", async () => {
      const user = await Repo.get(User, 1);
      type _get = Expect<Equal<typeof user, Infer<typeof User> | null>>;
      assert.equal(user, null);
    });
  });

  describe("all, one, query and exec", () => {
    test("all and one load whole schemas", async () => {
      await insertUser({ name: "Ann" });
      await insertUser({ email: "bob@example.com", name: "Bob" });
      const users = await Repo.all(User);
      type _all = Expect<Equal<typeof users, Infer<typeof User>[]>>;
      assert.deepEqual(
        users.map((u) => [u.id, u.name]),
        [
          [1, "Ann"],
          [2, "Bob"],
        ],
      );
      assert.equal(getMeta(users[0] ?? {})?.state, "loaded");
      await assert.rejects(Repo.one(User), MultipleResultsError);
    });

    test("all loads the rows of a Kysely query through the schema", async () => {
      await insertUser({ age: 20 });
      await insertUser({ email: "bob@example.com", age: 40 });
      const adults = Repo.kysely
        .selectFrom("repo_users")
        .selectAll("repo_users")
        .where("age", ">", 30);
      const users = await Repo.all(User, adults);
      assert.deepEqual(
        users.map((u) => u.email),
        ["bob@example.com"],
      );
      assert.equal(users[0]?.id, 2, "int8 ids are loaded as numbers");
      assert.ok(users[0]?.inserted_at instanceof Date);

      const one = await Repo.one(User, adults.limit(1));
      type _one = Expect<Equal<typeof one, Infer<typeof User> | null>>;
      assert.equal(one?.email, "bob@example.com");
      assert.equal(await Repo.one(User, adults.where("age", ">", 99)), null);
      await assert.rejects(
        Repo.oneOrThrow(User, adults.where("age", ">", 99)),
        NoResultsError,
      );
    });

    test("schema queries must return every persisted column", async () => {
      await insertUser();
      const partial = Repo.kysely.selectFrom("repo_users").select(["id"]);
      await assert.rejects(
        // @ts-expect-error: the query does not select the schema's columns
        Repo.all(User, partial),
        (error: unknown) =>
          error instanceof SchemaMismatchError &&
          error.missing.includes("email") &&
          !error.missing.includes("password"),
      );
      await assert.rejects(
        Repo.all(User, sql`SELECT id, email AS "eMail" FROM repo_users`),
        SchemaMismatchError,
      );
      await assert.rejects(
        Repo.all(
          User,
          sql`SELECT id, inserted_at AS "insertedAt" FROM repo_users`,
        ),
        /CamelCasePlugin is not supported/,
      );
      const extra = await Repo.all(
        User,
        sql`SELECT *, 1 AS extra FROM repo_users`,
      );
      assert.ok(
        !Object.hasOwn(extra[0] ?? {}, "extra"),
        "extra columns are dropped",
      );
    });

    test("ekto sql, Kysely sql, Queryables and CompiledQueries all run", async () => {
      await insertUser();
      const email = "ann@example.com";
      const queries = [
        sql`SELECT * FROM repo_users WHERE email = ${email}`,
        ksql`SELECT * FROM repo_users WHERE email = ${email}`,
        { sql: "SELECT * FROM repo_users WHERE email = $1", params: [email] },
        Repo.kysely
          .selectFrom("repo_users")
          .selectAll()
          .where("email", "=", email)
          .compile(),
      ];
      for (const query of queries) {
        const [user] = await Repo.all(User, query);
        assert.equal(user?.email, email);
      }
    });

    test("without a schema, rows are returned as the driver gives them", async () => {
      await insertUser({ name: "Ann" });
      await Repo.insertOrThrow(Post.new({ title: "Hi", user_id: 1 }));
      const rows = await Repo.all(
        Repo.kysely
          .selectFrom("repo_posts")
          .innerJoin("repo_users", "repo_users.id", "repo_posts.user_id")
          .select(["repo_posts.title", "repo_users.name as author"]),
      );
      type _rows = Expect<
        Equal<typeof rows, { title: string; author: string | null }[]>
      >;
      assert.deepEqual(rows, [{ title: "Hi", author: "Ann" }]);

      const count = await Repo.one(
        sql<{ n: string }>`SELECT count(*) AS n FROM repo_users`,
      );
      type _count = Expect<Equal<typeof count, { n: string } | null>>;
      assert.deepEqual(count, { n: "1" }, "no loading: count is int8 text");

      const untyped = await Repo.oneOrThrow(sql`SELECT 1 AS one`);
      type _untyped = Expect<Equal<typeof untyped, Record<string, unknown>>>;
      assert.deepEqual(untyped, { one: 1 });
    });

    test("query returns rows and a row count", async () => {
      await insertUser();
      await insertUser({ email: "bob@example.com" });
      const result = await Repo.query(
        sql<{ email: string }>`SELECT email FROM repo_users ORDER BY id`,
      );
      type _rows = Expect<Equal<typeof result.rows, { email: string }[]>>;
      assert.deepEqual(result, {
        rows: [{ email: "ann@example.com" }, { email: "bob@example.com" }],
        rowCount: 2,
      });
    });

    test("all, one and query reject Kysely writes", async () => {
      const write = Repo.kysely.deleteFrom("repo_users");
      await assert.rejects(
        Repo.all(write),
        /Kysely delete query; run writes with Repo.exec/,
      );
      await assert.rejects(Repo.query(write.compile()), /Repo.exec/);
      // @ts-expect-error: a delete selects no columns
      await assert.rejects(Repo.one(User, write), /Repo.exec/);
      await assert.rejects(
        // @ts-expect-error: not a query
        Repo.all({ text: "SELECT 1" }),
        /Repo.all expects a query/,
      );
      assert.equal(queries.length, 0);
    });

    test("exec runs writes and returns the affected rows", async () => {
      await insertUser({ age: 20 });
      await insertUser({ email: "bob@example.com", age: 40 });
      const updated = await Repo.exec(
        Repo.kysely
          .updateTable("repo_users")
          .set({ name: "adult" })
          .where("age", ">=", 18)
          .returning(["id", "name"]),
      );
      type _updated = Expect<
        Equal<typeof updated.rows, { id: string; name: string | null }[]>
      >;
      assert.equal(updated.rowCount, 2);
      assert.deepEqual(
        updated.rows.map((r) => r.name),
        ["adult", "adult"],
      );

      const deleted = await Repo.exec(
        Repo.kysely.deleteFrom("repo_users").where("age", "<", 30),
      );
      type _deleted = Expect<Equal<typeof deleted.rows, never[]>>;
      assert.deepEqual(deleted, { rowCount: 1, rows: [] });

      const none = await Repo.exec(
        sql`DELETE FROM repo_users WHERE id = ${99}`,
      );
      assert.equal(none.rowCount, 0);
    });

    test("exec throws constraint violations as ConstraintError", async () => {
      await insertUser();
      await assert.rejects(
        Repo.exec(Repo.kysely.updateTable("repo_users").set({ age: -1 })),
        (error: unknown) =>
          error instanceof ConstraintError &&
          error.type === "check" &&
          error.constraint === "age_must_be_positive" &&
          /attempting to update record/.test(error.message) &&
          /bypassed changesets/.test(error.message),
      );
      await assert.rejects(
        Repo.exec(sql`SELECT * FROM missing_table`),
        (error: unknown) => !(error instanceof ConstraintError),
      );
    });

    test("queries run in the current transaction", async () => {
      await insertUser();
      await assert.rejects(
        Repo.updateOrThrow(
          prepareChanges(
            change(await Repo.getOrThrow(User, 1), { name: "x" }),
            async (cs) => {
              await Repo.exec(sql`DELETE FROM repo_users`);
              assert.equal((await Repo.all(User)).length, 0);
              return addError(cs, "name", "rolled back");
            },
          ),
        ),
        InvalidChangesetError,
      );
      assert.equal((await Repo.all(User)).length, 1);
    });
  });

  describe("upserts", () => {
    test("onConflict nothing returns the record without reading back", async () => {
      const ann = await insertUser({ name: "Ann" });
      const result = await Repo.insert(
        userChangeset(User.new(), { email: ann.email, name: "Other" }),
        { onConflict: "nothing", conflictTarget: ["email"] },
      );
      assert.ok(result.ok);
      assert.equal(result.value.id, null, "nothing was inserted");
      assert.equal(result.value.name, "Other");
      assert.match(
        queries.at(-1)?.sql ?? "",
        /ON CONFLICT \("email"\) DO NOTHING/,
      );
      assert.equal((await Repo.getOrThrow(User, ann.id)).name, "Ann");
    });

    test("onConflict replace updates the existing row", async () => {
      const ann = await insertUser({ name: "Ann", age: 30 });
      const result = await Repo.insertOrThrow(
        userChangeset(User.new(), { email: ann.email, name: "Anne", age: 31 }),
        { onConflict: { replace: ["name"] }, conflictTarget: ["email"] },
      );
      assert.equal(result.id, ann.id, "the existing row's id is read back");
      const loaded = await Repo.getOrThrow(User, ann.id);
      assert.equal(loaded.name, "Anne");
      assert.equal(loaded.age, 30, "only the given fields are replaced");

      await Repo.insertOrThrow(
        userChangeset(User.new(), { email: ann.email, name: "Annie" }),
        {
          onConflict: { replaceAllExcept: ["id", "inserted_at", "token"] },
          conflictTarget: { unsafeFragment: "(email)" },
        },
      );
      const replaced = await Repo.getOrThrow(User, ann.id);
      assert.equal(replaced.name, "Annie");
      assert.equal(replaced.age, null, "unset fields are replaced too");
      assert.equal(replaced.token, ann.token);
    });

    test("checks the conflict options like Ecto", async () => {
      const cs = userChangeset(User.new(), { email: "a@b.c" });
      await assert.rejects(
        Repo.insert(cs, { conflictTarget: ["email"] }),
        /conflictTarget is forbidden/,
      );
      await assert.rejects(
        Repo.insert(cs, { onConflict: "replaceAll" }),
        /conflictTarget option is required/,
      );
      await assert.rejects(
        Repo.insert(cs, {
          onConflict: "nothing",
          // @ts-expect-error: not a field
          conflictTarget: ["nope"],
        }),
        /field nope does not exist/,
      );
      assert.equal(queries.length, 0);
    });
  });

  describe("insertAll, updateAll and deleteAll", () => {
    const now = new Date("2026-01-02T03:04:05Z");
    const userRow = (email: string, extra: object = {}) => ({
      email,
      token: "6b1f0f8c-0b8f-4c4e-9d50-6f1a3cbe7a2e",
      inserted_at: now,
      updated_at: now,
      ...extra,
    });

    test("insertAll inserts rows, using column defaults for missing values", async () => {
      const result = await Repo.insertAll(
        User,
        [
          userRow("ann@example.com", { age: 30, tags: ["x"] }),
          userRow("bob@example.com", { settings: { a: 1 } }),
        ],
        { returning: true },
      );
      type _rows = Expect<Equal<typeof result.rows, Infer<typeof User>[]>>;
      assert.equal(result.count, 2);
      const [ann, bob] = result.rows;
      assert.equal(ann?.id, 1);
      assert.deepEqual(ann?.tags, ["x"]);
      assert.deepEqual(bob?.tags, [], "DEFAULT for the missing cell");
      assert.equal(bob?.age, null);
      assert.deepEqual(bob?.settings, { a: 1 });
      assert.deepEqual(bob?.inserted_at, now);
      assert.equal(getMeta(bob ?? {})?.state, "loaded");
      assert.match(queries[0]?.sql ?? "", /, DEFAULT/);

      const plain = await Repo.insertAll(Post, [
        { title: "a", user_id: 1 },
        { title: "b", user_id: 2 },
      ]);
      assert.deepEqual(plain, { count: 2, rows: [] });
      assert.deepEqual(await Repo.insertAll(Post, []), { count: 0, rows: [] });
    });

    test("insertAll dumps without casting and throws on violations", async () => {
      await assert.rejects(
        // @ts-expect-error: insertAll does not cast
        Repo.insertAll(Post, [{ title: "a", user_id: "1" }]),
        ChangeError,
      );
      await assert.rejects(
        // @ts-expect-error: virtual fields cannot be inserted
        Repo.insertAll(User, [{ ...userRow("a@b.c"), password: "x" }]),
        /field password does not exist in schema repo_users or is virtual/,
      );
      await assert.rejects(
        Repo.insertAll(Post, [{ title: "a", user_id: 99 }]),
        (error: unknown) =>
          error instanceof ConstraintError &&
          error.type === "foreign_key" &&
          /attempting to insert/.test(error.message),
      );
    });

    test("insertAll upserts", async () => {
      await Repo.insertAll(User, [userRow("ann@example.com", { age: 1 })]);
      const result = await Repo.insertAll(
        User,
        [
          userRow("ann@example.com", { age: 2 }),
          userRow("bob@example.com", { age: 3 }),
        ],
        {
          onConflict: { replace: ["age"] },
          conflictTarget: ["email"],
          returning: ["email", "age"],
        },
      );
      assert.deepEqual(
        result.rows.map((u) => [u.email, u.age]),
        [
          ["ann@example.com", 2],
          ["bob@example.com", 3],
        ],
      );
      const skipped = await Repo.insertAll(User, [userRow("ann@example.com")], {
        onConflict: "nothing",
      });
      assert.equal(skipped.count, 0);
    });

    test("updateAll casts, dumps and refines with Kysely", async () => {
      await insertUser({ age: 20 });
      await insertUser({ email: "bob@example.com", age: 40 });
      const result = await Repo.updateAll(
        User,
        // @ts-expect-error: like Ecto, values are cast at runtime ("31" → 31)
        { set: { name: "x", age: "31" }, inc: { lock_version: 2 } },
        (q) => q.where("age", "<", 30),
      );
      assert.deepEqual(result, { count: 1 });
      const ann = await Repo.getOrThrow(User, 1);
      assert.deepEqual([ann.name, ann.age, ann.lock_version], ["x", 31, 3]);
      assert.equal((await Repo.getOrThrow(User, 2)).name, null);

      const all = await Repo.updateAll(User, {
        set: { settings: { b: true }, birthday: "2000-01-01" },
      });
      assert.equal(all.count, 2);
      assert.deepEqual((await Repo.getOrThrow(User, 2)).settings, { b: true });
    });

    test("updateAll rejects bad updates before querying", async () => {
      await assert.rejects(
        // @ts-expect-error: not an integer
        Repo.updateAll(User, { set: { age: "abc" } }),
        /value 'abc' in update cannot be cast to type integer/,
      );
      await assert.rejects(Repo.updateAll(User, {}), /at least one field/);
      await assert.rejects(
        // @ts-expect-error: unknown operator
        Repo.updateAll(User, { push: { tags: "x" } }),
        /unknown update operators push/,
      );
      assert.equal(queries.length, 0);
      await insertUser();
      await assert.rejects(
        Repo.updateAll(User, { set: { age: -1 } }),
        (error: unknown) =>
          error instanceof ConstraintError && error.type === "check",
      );
    });

    test("deleteAll deletes all rows or the refined ones", async () => {
      await insertUser({ age: 20 });
      await insertUser({ email: "bob@example.com", age: 40 });
      await insertUser({ email: "cid@example.com", age: 50 });
      assert.deepEqual(
        await Repo.deleteAll(User, (q) => q.where("age", ">", 45)),
        { count: 1 },
      );
      assert.deepEqual(await Repo.deleteAll(User), { count: 2 });
    });
  });

  test("load builds records from raw Kysely rows", async () => {
    await insertUser();
    const row = await db
      .selectFrom("repo_users")
      .selectAll()
      .executeTakeFirstOrThrow();
    assert.equal(typeof row.id, "string", "the driver returns int8 as text");
    const user = Repo.load(User, row);
    assert.equal(user.id, 1);
    assert.equal(getMeta(user)?.state, "loaded");
  });

  test("kysely follows the current transaction", async () => {
    await insertUser();
    await Repo.updateOrThrow(
      prepareChanges(
        change(await Repo.getOrThrow(User, 1), { name: "x" }),
        async (cs) => {
          assert.ok(Repo.kysely.isTransaction);
          return cs;
        },
      ),
    );
    assert.ok(!Repo.kysely.isTransaction);
  });
});
