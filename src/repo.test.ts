import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { CompiledQuery, type Kysely } from "kysely";
import type { QueryEvent } from "./adapter.ts";
import {
  addError,
  Changeset,
  cast,
  change,
  InvalidChangesetError,
  optimisticLock,
  pipe,
  prepareChanges,
  putChange,
  schemaless,
  validateRequired,
} from "./changeset.ts";
import {
  ChangeError,
  MultipleResultsError,
  NoPrimaryKeyValueError,
  NoResultsError,
  StaleEntryError,
} from "./errors.ts";
import { type KyselyDB, postgres } from "./postgres/index.ts";
import { connectPg, skipWithoutPg } from "./postgres.test-helper.ts";
import { createRepo, type Repo } from "./repo.ts";
import { getMeta, type Infer, schema, t } from "./schema.ts";
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

// As an Ecto migration would create it.
const DDL = `
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
    updated_at timestamp(0) NOT NULL
  );
`;

type DB = KyselyDB<[typeof User]>;

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
    await raw("DROP TABLE IF EXISTS repo_users");
    await close();
  });

  beforeEach(async () => {
    await raw("TRUNCATE repo_users RESTART IDENTITY");
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
