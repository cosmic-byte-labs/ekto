import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  CompiledQuery,
  DummyDriver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import type { QueryEvent } from "./adapter.ts";
import {
  belongsTo,
  hasMany,
  hasOne,
  manyToMany,
  type Preloaded,
} from "./association.ts";
import { type KyselyDB, postgres } from "./postgres/index.ts";
import { connectPg, skipWithoutPg } from "./postgres.test-helper.ts";
import { createRepo, type Repo } from "./repo.ts";
import { getMeta, type Infer, load, schema, t } from "./schema.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

class User extends schema("pl_users", { id: t.id(), email: t.string() }) {
  static associations = {
    posts: hasMany(() => Post, { foreignKey: "author_id" }),
    profile: hasOne(() => Profile, { foreignKey: "user_id" }),
  };
}

class Post extends schema("pl_posts", {
  id: t.id(),
  title: t.string(),
  author_id: t.integer().nullable(),
}) {
  static associations = {
    author: belongsTo(() => User),
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
    tags: manyToMany(() => Tag, {
      joinThrough: "pl_posts_tags",
      joinKeys: { post_id: "id", tag_id: "id" },
    }),
  };
}

class Comment extends schema("pl_comments", {
  id: t.id(),
  body: t.string(),
  post_id: t.integer(),
}) {
  static associations = {
    post: belongsTo(() => Post, { foreignKey: "post_id" }),
  };
}

const Profile = schema("pl_profiles", { id: t.id(), user_id: t.integer() });
const Tag = schema("pl_tags", { id: t.id(), name: t.string() });

type DB = KyselyDB<
  [typeof User, typeof Post, typeof Comment, typeof Profile, typeof Tag]
>;

/** A preload refinement whose query takes 300ms (Postgres). */
// biome-ignore lint/suspicious/noExplicitAny: any query
const sleepy = <Q extends { where(expression: any): Q }>(query: Q): Q =>
  query.where(sql<boolean>`(SELECT true FROM pg_sleep(0.3))`);

/** A Repo whose queries compile but never run, to check their SQL. */
function dummyRepo(): Repo<DB> {
  return createRepo<DB>({
    adapter: {
      ...postgres(),
      connect: () => ({
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      }),
    },
  });
}

describe("Repo.assoc queries", () => {
  const Repo = dummyRepo();
  const post = load(Post, { id: 1, title: "a", author_id: 7 });
  const other = load(Post, { id: 2, title: "b", author_id: null });

  test("filter the related table by the owner keys (Ecto.assoc)", () => {
    assert.deepEqual(Repo.toSql(Repo.assoc(post, "comments")), {
      sql: 'select "pl_comments"."id", "pl_comments"."body", "pl_comments"."post_id" from "pl_comments" where "pl_comments"."post_id" = $1',
      params: [1],
    });

    const authors = Repo.toSql(Repo.assoc([post, other, post], "author"));
    assert.equal(
      authors.sql,
      'select "pl_users"."id", "pl_users"."email" from "pl_users" where "pl_users"."id" = $1',
      "null keys are skipped and keys are unique",
    );

    const both = Repo.toSql(Repo.assoc([post, other], "comments"));
    assert.match(both.sql, /"pl_comments"."post_id" in \(\$1, \$2\)/);
    assert.deepEqual(both.params, [1, 2]);
  });

  test("join the join table for many to many", () => {
    const tags = Repo.toSql(Repo.assoc([post, other], "tags"));
    assert.equal(
      tags.sql,
      'select "pl_tags"."id", "pl_tags"."name" from "pl_tags" ' +
        'inner join "pl_posts_tags" on "pl_posts_tags"."tag_id" = "pl_tags"."id" ' +
        'where "pl_posts_tags"."post_id" in ($1, $2)',
    );
  });

  test("match nothing when no record has a key", () => {
    assert.equal(
      Repo.toSql(Repo.assoc(other, "author")).sql,
      'select "pl_users"."id", "pl_users"."email" from "pl_users" where false',
    );
  });

  test("reject null, empty lists and mixed schemas", () => {
    assert.throws(
      () => Repo.assoc(null as never, "author"),
      /cannot retrieve association author for null/,
    );
    assert.throws(
      () => Repo.assoc([] as (typeof post)[], "author"),
      /cannot retrieve association author for empty list/,
    );
    assert.throws(
      () =>
        Repo.assoc(
          [post, load(User, { id: 1, email: "x" })] as never,
          "author",
        ),
      /expected a homogeneous list containing records of the same schema, got: pl_posts and pl_users/,
    );
    assert.throws(
      () => Repo.assoc({ id: 1 } as never, "author"),
      /associations need records created by a schema/,
    );
  });
});

describe("Repo.preload spec errors", () => {
  const Repo = dummyRepo();
  const post = load(Post, { id: 1, title: "a", author_id: null });

  test("rejects invalid specs and conflicting queries", async () => {
    await assert.rejects(
      Repo.preload(post, 1 as never),
      /invalid preload 1 in 1; preload expects an association name/,
    );
    await assert.rejects(
      Repo.preload(post, { comments: false } as never),
      /invalid preload false/,
    );
    await assert.rejects(
      Repo.preload(post, "nope" as never),
      /schema pl_posts does not have association "nope"/,
    );
    await assert.rejects(
      Repo.preload(post, [{ comments: (q) => q }, { comments: (q) => q }]),
      /cannot preload comments as it has been supplied more than once with different queries/,
    );
    await assert.rejects(
      Repo.preload(post, { comments: (() => "x") as never }),
      /the preload query for comments must return a Kysely select query/,
    );
  });

  test("returns null and empty lists as they are, without queries", async () => {
    assert.equal(await Repo.preload(null, "author"), null);
    assert.deepEqual(await Repo.preload([] as (typeof post)[], "author"), []);
    assert.deepEqual(await Repo.preload([null], "author" as never), [null]);
  });
});

// As Ecto migrations would create them.
const DDL = `
  DROP TABLE IF EXISTS pl_posts_tags, pl_tags, pl_comments, pl_profiles, pl_posts, pl_users;
  CREATE TABLE pl_users (id bigserial PRIMARY KEY, email text NOT NULL);
  CREATE TABLE pl_posts (
    id bigserial PRIMARY KEY,
    title text NOT NULL,
    author_id bigint REFERENCES pl_users (id)
  );
  CREATE TABLE pl_comments (
    id bigserial PRIMARY KEY,
    body text NOT NULL,
    post_id bigint NOT NULL REFERENCES pl_posts (id)
  );
  CREATE TABLE pl_profiles (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES pl_users (id)
  );
  CREATE TABLE pl_tags (id bigserial PRIMARY KEY, name text NOT NULL);
  CREATE TABLE pl_posts_tags (
    post_id bigint NOT NULL REFERENCES pl_posts (id),
    tag_id bigint NOT NULL REFERENCES pl_tags (id)
  );
`;

describe("Repo.preload on Postgres", { skip: skipWithoutPg }, () => {
  let db: Kysely<DB>;
  let Repo: Repo<DB>;
  let queries: QueryEvent[] = [];

  const raw = (text: string) => db.executeQuery(CompiledQuery.raw(text));

  before(async () => {
    Repo = connectPg<DB>({ onQuery: (event) => queries.push(event) });
    db = Repo.kysely;
    await raw(DDL);
  });

  after(async () => {
    await raw(
      "DROP TABLE IF EXISTS pl_posts_tags, pl_tags, pl_comments, pl_profiles, pl_posts, pl_users",
    );
    await Repo.stop();
  });

  beforeEach(async () => {
    await raw(
      "TRUNCATE pl_posts_tags, pl_tags, pl_comments, pl_profiles, pl_posts, pl_users RESTART IDENTITY",
    );
    await raw(`
      INSERT INTO pl_users (email) VALUES ('ann@x'), ('bob@x'), ('cid@x');
      INSERT INTO pl_posts (title, author_id) VALUES ('a1', 1), ('a2', 1), ('b1', 2), ('orphan', NULL);
      INSERT INTO pl_comments (body, post_id) VALUES ('c1', 1), ('c2', 1), ('c3', 3);
      INSERT INTO pl_profiles (user_id) VALUES (2);
      INSERT INTO pl_tags (name) VALUES ('red'), ('blue');
      INSERT INTO pl_posts_tags VALUES (1, 1), (1, 2), (3, 2);
    `);
    queries = [];
  });

  const posts = () =>
    Repo.all(Post, db.selectFrom("pl_posts").selectAll().orderBy("id"));
  const users = () =>
    Repo.all(User, db.selectFrom("pl_users").selectAll().orderBy("id"));

  test("belongsTo: one query for all records; null keys load null", async () => {
    const list = await posts();
    queries = [];
    const loaded = await Repo.preload(list, "author");
    assert.deepEqual(
      loaded.map((p) => p.author?.email ?? null),
      ["ann@x", "ann@x", "bob@x", null],
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /"pl_users"."id" in \(\$1, \$2\)/);
    assert.deepEqual(queries[0]?.params, [1, 2], "unique keys");

    assert.equal(Object.hasOwn(list[0] as object, "author"), false, "copies");
    assert.equal(getMeta(loaded[0] as object)?.state, "loaded");
    assert.equal(getMeta(loaded[0]?.author as object)?.schema, User);

    type _author = Expect<
      Equal<(typeof loaded)[number]["author"], Infer<typeof User> | null>
    >;
  });

  test("hasMany and hasOne: grouped by owner, [] or null when none", async () => {
    const loaded = await Repo.preload(await users(), ["posts", "profile"]);
    assert.deepEqual(
      loaded.map((u) => u.posts.map((p) => p.title)),
      [["a1", "a2"], ["b1"], []],
    );
    assert.deepEqual(
      loaded.map((u) => u.profile?.id ?? null),
      [null, 1, null],
    );
    assert.equal(queries.length - 1, 2, "one query per association");

    queries = [];
    const one = await Repo.preload(loaded[1] as Infer<typeof User>, "posts", {
      force: true,
    });
    assert.deepEqual(
      one.posts.map((p) => p.title),
      ["b1"],
    );
    assert.match(queries[0]?.sql ?? "", /"pl_posts"."author_id" = \$1/);
  });

  test("manyToMany: through the join table", async () => {
    const loaded = await Repo.preload(await posts(), "tags");
    assert.deepEqual(
      loaded.map((p) => p.tags.map((tag) => tag.name).sort()),
      [["blue", "red"], [], ["blue"], []],
    );
    const [first] = loaded;
    assert.deepEqual(
      Object.keys(first?.tags[0] ?? {}).sort(),
      ["id", "name"],
      "the join key is not part of the record",
    );
  });

  test("nested preloads run once per level", async () => {
    const loaded = await Repo.preload(await users(), {
      posts: { comments: "post", author: true },
    });
    assert.equal(queries.length - 1, 4);
    const [ann] = loaded;
    assert.deepEqual(
      ann?.posts.map((p) => p.comments.map((c) => c.body)),
      [["c1", "c2"], []],
    );
    assert.equal(ann?.posts[0]?.comments[0]?.post?.title, "a1");
    assert.equal(ann?.posts[0]?.author?.email, "ann@x");
    type _nested = Expect<
      Equal<
        NonNullable<typeof ann>["posts"][number]["comments"][number]["post"],
        Infer<typeof Post> | null
      >
    >;
  });

  test("refines the query with a function, and nests with a tuple", async () => {
    const loaded = await Repo.preload(await users(), {
      posts: [
        (q) => q.orderBy("id", "desc"),
        { comments: (q) => q.where("body", "!=", "c2") },
      ],
    });
    assert.deepEqual(
      loaded[0]?.posts.map((p) => [p.title, p.comments.map((c) => c.body)]),
      [
        ["a2", []],
        ["a1", ["c1"]],
      ],
    );
    assert.match(queries[1]?.sql ?? "", /order by "id" desc/);
  });

  test("a refined query must keep every column", async () => {
    await assert.rejects(
      Repo.preload(await users(), {
        posts: (q) => q.clearSelect().select("id"),
      }),
      /pl_posts/,
    );
  });

  test("keeps loaded associations unless forced, still running nested preloads", async () => {
    const [post] = await posts();
    const first = await Repo.preload(post as Infer<typeof Post>, "comments");
    // A copy keeping the metadata, with only the first comment loaded.
    const withMeta = Object.assign(
      await Repo.preload(post as Infer<typeof Post>, "comments"),
      { comments: first.comments.slice(0, 1) },
    );

    queries = [];
    const again = await Repo.preload(withMeta, { comments: "post" });
    assert.deepEqual(
      again.comments.map((c) => c.body),
      ["c1"],
      "not reloaded",
    );
    assert.equal(again.comments[0]?.post?.title, "a1", "nested preloaded");
    assert.equal(queries.length, 1, "only the nested query");

    const forced = await Repo.preload(withMeta, "comments", { force: true });
    assert.deepEqual(
      forced.comments.map((c) => c.body),
      ["c1", "c2"],
    );
  });

  test("lists may contain null; mixed schemas are rejected", async () => {
    const [post] = await posts();
    const loaded = await Repo.preload([null, post ?? null], "author");
    assert.equal(loaded[0], null);
    assert.equal(loaded[1]?.author?.email, "ann@x");

    const [user] = await users();
    await assert.rejects(
      Repo.preload([post, user] as never, "author"),
      /expected a homogeneous list containing records of the same schema, got: pl_posts and pl_users/,
    );
  });

  test("Repo.assoc builds a query to refine and run", async () => {
    const [post] = await posts();
    const comments = await Repo.all(
      Repo.assoc(post as Infer<typeof Post>, "comments").orderBy("id", "desc"),
    );
    type _loaded = Expect<Equal<typeof comments, Infer<typeof Comment>[]>>;
    assert.ok(comments.every((c) => getMeta(c)?.schema === Comment));
    assert.deepEqual(
      comments.map((c) => c.body),
      ["c2", "c1"],
    );
    const tags = await Repo.all(Repo.assoc(await posts(), "tags"));
    assert.ok(tags.every((tag) => getMeta(tag)?.schema === Tag));
    assert.deepEqual(
      await Repo.all(Tag, Repo.assoc(await posts(), "tags")),
      tags,
      "it runs with a schema too",
    );
    assert.deepEqual(tags.map((tag) => tag.name).sort(), [
      "blue",
      "blue",
      "red",
    ]);
  });

  test("loads sibling associations concurrently, except in a transaction", async () => {
    // Each query waits 300ms in the database.
    const slow = { posts: sleepy, profile: sleepy };
    const timed = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };
    const [user] = await users();
    assert.ok(user);
    assert.ok((await timed(() => Repo.preload(user, slow))) < 550);
    const inTx = await timed(() =>
      Repo.transact(async (tx) => {
        await tx.preload(user, slow);
        return { ok: true, value: null } as const;
      }),
    );
    assert.ok(inTx >= 600, `ran in turn in a transaction (${inTx}ms)`);
  });

  test("works in a transaction", async () => {
    const result = await Repo.transact(async (tx) => {
      const [post] = await tx.all(Post, db.selectFrom("pl_posts").selectAll());
      const loaded = await tx.preload(post as Infer<typeof Post>, "author");
      return { ok: true, value: loaded.author?.email } as const;
    });
    assert.deepEqual(result, { ok: true, value: "ann@x" });
  });

  test("Preloaded names the record type", async () => {
    const [post] = await Repo.preload(await posts(), { comments: "post" });
    const typed: Preloaded<typeof Post, { comments: "post" }> | undefined =
      post;
    assert.ok(typed);
  });
});
