import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  type CompiledQuery,
  type KyselyPlugin,
  sql as ksql,
  type QueryId,
  type SelectQueryBuilder,
} from "kysely";
import type { QueryEvent } from "./adapter.ts";
import { hasMany } from "./association.ts";
import { change } from "./changeset.ts";
import {
  MultipleResultsError,
  NoResultsError,
  SchemaMismatchError,
} from "./errors.ts";
import { Multi } from "./multi.ts";
import { connectPg, skipWithoutPg } from "./postgres.test-helper.ts";
import {
  type FromQuery,
  isUnboundQuery,
  queries,
  type SchemaRow,
  schemaOfQuery,
  type UnboundQuery,
} from "./query.ts";
import {
  createRepo,
  type Repo,
  type RepoConfig,
  type ResultOf,
  type RowOf,
} from "./repo.ts";
import { getMeta, type Infer, schema, t } from "./schema.ts";
import { sql } from "./sql.ts";
import { type KyselyDB, sqlite } from "./sqlite/index.ts";
import { sandbox } from "./testing/index.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

class User extends schema("q_users", { id: t.id(), email: t.string() }) {
  static associations = {
    posts: hasMany(() => Post, { foreignKey: "user_id" }),
  };
}

const Post = schema("q_posts", {
  id: t.id(),
  title: t.string(),
  user_id: t.integer(),
  views: t.integer().default(0),
  draft: t.boolean().virtual(),
  score: t.integer().virtual(),
});

const Other = schema("q_others", { id: t.id() });

type DB = KyselyDB<[typeof User, typeof Post]>;

const { from, kysely } = queries<DB>();

const compileUnbound = (query: { compile(): unknown }): UnboundQuery => {
  const compiled = query.compile();
  assert.ok(isUnboundQuery(compiled));
  return compiled;
};

describe("queries", () => {
  test("from(Schema) selects the persisted columns, qualified with the table", () => {
    const { query } = compileUnbound(from(Post));
    assert.equal(query.kind, "SelectQueryNode");
    const selections = (
      query as unknown as {
        selections: {
          selection: {
            table: { table: { identifier: { name: string } } };
            column: { column: { name: string } };
          };
        }[];
      }
    ).selections.map(
      ({ selection }) =>
        `${selection.table.table.identifier.name}.${selection.column.column.name}`,
    );
    assert.deepEqual(selections, [
      "q_posts.id",
      "q_posts.title",
      "q_posts.user_id",
      "q_posts.views",
    ]);
  });

  test("remembers the schema while its selection is kept", () => {
    const base = from(Post);
    const filtered = base.where("id", "=", 1).orderBy("id");
    assert.equal(schemaOfQuery(compileUnbound(base)), Post);
    assert.equal(schemaOfQuery(compileUnbound(filtered)), Post);
    assert.equal(
      schemaOfQuery(compileUnbound(base.select(ksql<string>`'x'`.as("title")))),
      Post,
      "a column of a field overrides it",
    );
    assert.equal(
      schemaOfQuery(compileUnbound(base.clearSelect().select("id"))),
      undefined,
      "clearSelect makes it a query of plain rows",
    );
    assert.equal(
      schemaOfQuery(compileUnbound(base)),
      Post,
      "branches of one query do not affect each other",
    );
    assert.equal(schemaOfQuery(compileUnbound(from("q_posts"))), undefined);
    assert.equal(
      schemaOfQuery(compileUnbound(kysely.selectFrom("q_posts").selectAll())),
      undefined,
    );
  });

  test("selects besides only fields of the schema, like Ecto's select_merge", () => {
    const fields = (query: { compile(): unknown }) =>
      schemaOfQuery(compileUnbound(query as never));
    assert.equal(fields(from(Post).select("title")), Post);
    assert.equal(
      fields(from(Post).select(ksql<boolean>`true`.as("draft"))),
      Post,
      "a virtual field",
    );
    const notAField = (name: string) =>
      new RegExp(
        `^TypeError: from\\(q_posts\\) selects ${name.replace(/[.*]/g, "\\$&")}, which is not a field of its schema`,
      );
    assert.throws(
      () => fields(from(Post).select(ksql<number>`1`.as("one"))),
      notAField("one"),
    );
    assert.throws(
      () =>
        fields(
          from(Post)
            .innerJoin("q_users", "q_users.id", "q_posts.user_id")
            .select("q_users.email"),
        ),
      notAField("email"),
    );
    assert.throws(() => fields(from(Post).selectAll()), notAField("*"));
    assert.throws(
      () => fields(from(Post).selectAll("q_posts")),
      notAField("q_posts.*"),
    );
    assert.equal(
      fields(from(Post).clearSelect().select(ksql<number>`1`.as("one"))),
      undefined,
      "after clearSelect, any column: a query of plain rows",
    );
  });

  test("its queries have no database of their own", async () => {
    const message = /this query has no database of its own: run it with a Repo/;
    await assert.rejects(from(Post).execute(), message);
    await assert.rejects(
      from("q_posts").selectAll().executeTakeFirst(),
      message,
    );
    await assert.rejects(
      kysely.deleteFrom("q_posts").where("id", "=", 1).execute(),
      message,
    );
    await assert.rejects(ksql`SELECT 1`.execute(kysely), message);
    await assert.rejects(
      kysely.transaction().execute(async () => {}),
      message,
    );
    assert.throws(() => from(Post).compile().sql, message);
  });

  test("from expects a schema or a table", () => {
    assert.throws(
      () => from(42 as unknown as "q_posts"),
      /from expects a schema or a table, got: 42/,
    );
    assert.throws(
      () => from(null as unknown as "q_posts"),
      /from expects a schema or a table, got: null/,
    );
  });

  test("each call to queries() is its own Kysely instance", () => {
    const other = queries<DB>();
    assert.notEqual(other.kysely, kysely);
    assert.ok(Object.isFrozen(other));
  });

  test("types: a from(Schema) query selects besides only the schema's fields", () => {
    const repo = undefined as unknown as Repo<DB>;
    const typeOnly = () => {
      repo.all(from(Post).select("title"));
      repo.all(from(Post).select(ksql<boolean>`true`.as("draft")));
      repo.all(from(Post).clearSelect().select(ksql<number>`1`.as("one")));
      repo.all(from("q_posts").select(ksql<number>`1`.as("one")));
      repo.all(
        // @ts-expect-error: email is not a field of Post
        from(Post)
          .innerJoin("q_users", "q_users.id", "q_posts.user_id")
          .select("q_users.email"),
      );
      // @ts-expect-error: one is not a field of Post
      repo.one(from(Post).select(ksql<number>`1`.as("one")));
      // @ts-expect-error: one is not a field of Post
      repo.oneOrThrow(from(Post).select(ksql<number>`1`.as("one")));
      Multi.new<DB>()
        // @ts-expect-error: one is not a field of Post
        .all("posts", from(Post).select(ksql<number>`1`.as("one")))
        // @ts-expect-error: one is not a field of Post
        .one("post", () => from(Post).select(ksql<number>`1`.as("one")));
    };
    assert.equal(typeof typeOnly, "function");
  });

  test("types", () => {
    const posts = from(Post).where("title", "like", "E%").orderBy("id");
    type _row = Expect<Equal<ResultOf<typeof posts>, Infer<typeof Post>>>;
    type _plain = Expect<
      Equal<
        RowOf<typeof posts>,
        {
          id: number;
          title: string;
          user_id: number;
          views: number;
        }
      >
    >;
    const joined = from(Post).innerJoin("q_users", "q_users.id", "user_id");
    type _joined = Expect<Equal<ResultOf<typeof joined>, Infer<typeof Post>>>;
    const cleared = from(Post).clearSelect().select("user_id");
    type _cleared = Expect<
      Equal<ResultOf<typeof cleared>, { user_id: number }>
    >;
    const counted = from(Post)
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .groupBy("id");
    type _counted = Expect<
      Equal<keyof RowOf<typeof counted>, keyof DB["q_posts"] | "n">
    >;
    const table = from("q_users").select("email");
    type _table = Expect<Equal<ResultOf<typeof table>, { email: string }>>;
    const aliased = from("q_users as u").select("u.email");
    type _aliased = Expect<Equal<ResultOf<typeof aliased>, { email: string }>>;
    const nested = from(from(Post).as("p")).select("p.title");
    type _nested = Expect<Equal<ResultOf<typeof nested>, { title: string }>>;
    // biome-ignore lint/suspicious/noExplicitAny: a query of any rows
    type AnyRows = SelectQueryBuilder<DB, "q_posts", any>;
    type _any = Expect<Equal<ResultOf<AnyRows>, RowOf<AnyRows>>>;
    type _untyped = Expect<
      Equal<ResultOf<CompiledQuery>, Record<string, unknown>>
    >;
    const raw = kysely.selectFrom("q_users").select("id");
    type _raw = Expect<Equal<ResultOf<typeof raw>, { id: number }>>;
    const fromPost: FromQuery<DB, typeof Post> = from(Post);
    void fromPost;
    const marked: SelectQueryBuilder<
      DB,
      "q_posts",
      SchemaRow<typeof Post>
    > = from(Post);
    void marked;
    // A function of plain post queries takes a from(Post) query.
    const published = <O>(q: SelectQueryBuilder<DB, "q_posts", O>) =>
      q.where("views", ">", 0);
    const called = from(Post).$call(published);
    type _called = Expect<Equal<ResultOf<typeof called>, Infer<typeof Post>>>;

    // @ts-expect-error unknown column
    assert.throws(() => from(Post).where("nope", "=", 1).compile().sql);
    // @ts-expect-error wrong value type
    from(Post).where("id", "=", "x");
    // @ts-expect-error a schema of another database
    from(Other);
    // @ts-expect-error a table of another database
    from("q_others");
  });
});

/**
 * Records the queries a Repo's plugin sees, and marks the rows of those
 * queries (the Repo's own queries do not go through plugins).
 */
function spyPlugin(seen: QueryId[]): KyselyPlugin {
  return {
    transformQuery: ({ node, queryId }) => {
      seen.push(queryId);
      return node;
    },
    transformResult: async ({ result, queryId }) =>
      seen.includes(queryId)
        ? {
            ...result,
            rows: result.rows.map((row) => ({ ...row, plugged: true })),
          }
        : result,
  };
}

const DDL = (idType: string) => [
  "DROP TABLE IF EXISTS q_posts",
  "DROP TABLE IF EXISTS q_users",
  `CREATE TABLE q_users (id ${idType}, email TEXT NOT NULL)`,
  `CREATE TABLE q_posts (id ${idType}, title TEXT NOT NULL, user_id INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0)`,
];

function suite(
  name: string,
  connect: (options: Partial<Omit<RepoConfig, "adapter">>) => Repo<DB>,
  idType: string,
) {
  describe(name, () => {
    const seen: QueryId[] = [];
    const events: QueryEvent[] = [];
    const repo = connect({
      plugins: [spyPlugin(seen)],
      onQuery: (event) => events.push(event),
    });
    let ann: { readonly id: number };
    let bob: { readonly id: number };

    const insertPost = (title: string, user_id: number, views = 0) =>
      repo.insertOrThrow(change(Post.new(), { title, user_id, views }));

    before(async () => {
      for (const statement of DDL(idType)) await repo.exec(ksql.raw(statement));
    });
    after(async () => {
      await repo.exec(ksql.raw("DROP TABLE IF EXISTS q_posts"));
      await repo.exec(ksql.raw("DROP TABLE IF EXISTS q_users"));
      await repo.stop();
    });
    beforeEach(async () => {
      await repo.exec(kysely.deleteFrom("q_posts"));
      await repo.exec(kysely.deleteFrom("q_users"));
      ann = await repo.insertOrThrow(change(User.new(), { email: "ann@x" }));
      bob = await repo.insertOrThrow(change(User.new(), { email: "bob@x" }));
      await insertPost("Ecto", ann.id, 3);
      await insertPost("Elixir", ann.id, 1);
      await insertPost("Kysely", bob.id, 0);
      seen.length = 0;
      events.length = 0;
    });

    test("columns of fields override them and set virtual fields (select_merge)", async () => {
      const [post] = await repo.all(
        from(Post)
          .select((eb) => [
            eb.fn<string>("upper", ["title"]).as("title"),
            eb.lit(true).as("draft"),
            // a bigint, which node-postgres returns as a string
            ksql<string>`cast(views * 10 as bigint)`.as("score"),
          ])
          .where("title", "=", "Ecto"),
      );
      assert.equal(post?.title, "ECTO");
      assert.equal(post?.draft, true, "loaded with the field's type");
      assert.equal(post?.score, 30, "loaded with the field's type");
      assert.equal(getMeta(post ?? {})?.schema, Post);
      const [plain] = await repo.all(from(Post).where("title", "=", "Ecto"));
      assert.equal(plain?.draft, Post.new().draft, "not selected: its default");

      events.length = 0;
      const notAField = /from\(q_posts\) selects one, which is not a field/;
      await assert.rejects(
        // @ts-expect-error: one is not a field of Post
        repo.all(from(Post).select(ksql<number>`1`.as("one"))),
        notAField,
      );
      assert.throws(
        // @ts-expect-error: one is not a field of Post
        () => repo.toSql(from(Post).select(ksql<number>`1`.as("one"))),
        notAField,
      );
      assert.deepEqual(events, [], "it throws before running the query");
    });

    test("all loads the records of a from(Schema) query", async () => {
      const posts = await repo.all(
        from(Post).where("title", "like", "E%").orderBy("views", "desc"),
      );
      type _ = Expect<Equal<typeof posts, Infer<typeof Post>[]>>;
      assert.deepEqual(
        posts.map((p) => p.title),
        ["Ecto", "Elixir"],
      );
      const [post] = posts;
      assert.equal(getMeta(post ?? {})?.state, "loaded");
      assert.equal(getMeta(post ?? {})?.schema, Post);
      assert.equal(
        (post as unknown as Record<string, unknown>).plugged,
        undefined,
        "columns the schema does not have are dropped",
      );
      assert.equal(events.at(-1)?.source, "q_posts");
      assert.match(
        events.at(-1)?.sql ?? "",
        /select "q_posts"\."id", "q_posts"\."title", "q_posts"\."user_id", "q_posts"\."views" from "q_posts"/,
      );
    });

    test("one and oneOrThrow", async () => {
      const post = await repo.one(from(Post).where("title", "=", "Ecto"));
      type _one = Expect<Equal<typeof post, Infer<typeof Post> | null>>;
      assert.equal(post?.views, 3);
      assert.equal(getMeta(post ?? {})?.state, "loaded");
      assert.equal(
        await repo.one(from(Post).where("title", "=", "none")),
        null,
      );
      const thrown = await repo.oneOrThrow(
        from(Post).where("title", "=", "Kysely"),
      );
      type _thrown = Expect<Equal<typeof thrown, Infer<typeof Post>>>;
      assert.equal(thrown.user_id, bob.id);
      await assert.rejects(
        repo.oneOrThrow(from(Post).where("title", "=", "none")),
        NoResultsError,
      );
      await assert.rejects(repo.one(from(Post)), MultipleResultsError);
    });

    test("joins keep the schema's columns", async () => {
      const posts = await repo.all(
        from(Post)
          .innerJoin("q_users", "q_users.id", "q_posts.user_id")
          .where("q_users.email", "=", "bob@x"),
      );
      assert.deepEqual(
        posts.map((p) => p.title),
        ["Kysely"],
      );
      assert.equal(posts[0]?.user_id, bob.id);
      const all = await repo.all(from(Post).orderBy("q_posts.id"));
      assert.equal(posts[0]?.id, all[2]?.id, "the post's id, not the user's");
    });

    test("plain rows after clearSelect, and from a table", async () => {
      const ids = await repo.all(
        from(Post)
          .clearSelect()
          .select("user_id")
          .distinct()
          .orderBy("user_id"),
      );
      assert.deepEqual(
        ids.map(({ user_id }) => Number(user_id)),
        [ann.id, bob.id],
      );
      assert.equal(getMeta(ids[0] ?? {}), undefined);
      const counts = await repo.all(
        from("q_posts")
          .select(["user_id", (eb) => eb.fn.countAll<number>().as("count")])
          .groupBy("user_id")
          .orderBy("user_id"),
      );
      assert.deepEqual(
        counts.map((row) => [Number(row.user_id), Number(row.count)]),
        [
          [ann.id, 2],
          [bob.id, 1],
        ],
      );
      assert.equal(
        (counts[0] as Record<string, unknown>).plugged,
        true,
        "the Repo's plugins transform the result",
      );
      const aliased = await repo.all(
        from("q_users as u").select("u.email").orderBy("u.email"),
      );
      assert.deepEqual(aliased, [
        { email: "ann@x", plugged: true },
        { email: "bob@x", plugged: true },
      ]);
      const titles = await repo.all(
        from(from(Post).where("views", ">", 0).as("p"))
          .select("p.title")
          .orderBy("p.title"),
      );
      assert.deepEqual(
        titles.map(({ title }) => title),
        ["Ecto", "Elixir"],
      );
      assert.equal(events.at(-1)?.source, undefined);
    });

    test("an explicit schema wins over the remembered one", async () => {
      const posts = await repo.all(Post, from(Post).orderBy("id"));
      assert.equal(posts.length, 3);
      await assert.rejects(
        repo.all(User, from(Post) as never),
        SchemaMismatchError,
      );
      const users = await repo.all(
        User,
        from(User).where("email", "=", "ann@x"),
      );
      assert.equal(users[0]?.email, "ann@x");
      assert.deepEqual(
        await repo
          .query(from(Post).where("title", "=", "Ecto"))
          .then(({ rows }) => rows.map((row) => row.title)),
        ["Ecto"],
        "Repo.query gives rows as the driver does",
      );
    });

    test("subqueries", async () => {
      const authors = await repo.all(
        from(User)
          .where(
            "id",
            "in",
            from(Post).clearSelect().select("user_id").where("views", ">", 0),
          )
          .orderBy("id"),
      );
      type _ = Expect<Equal<typeof authors, Infer<typeof User>[]>>;
      assert.deepEqual(
        authors.map((u) => u.email),
        ["ann@x"],
      );
      const bound = await repo.all(
        User,
        repo.kysely
          .selectFrom("q_users")
          .selectAll()
          .where(
            "id",
            "in",
            from(Post)
              .clearSelect()
              .select("user_id")
              .where("title", "=", "Kysely"),
          ),
      );
      assert.deepEqual(
        bound.map((u) => u.email),
        ["bob@x"],
      );
    });

    test("a compiled query, and Kysely's sql tag around one", async () => {
      const posts = await repo.all(from(Post).where("id", ">", 0).compile());
      assert.equal(posts.length, 3);
      assert.equal(getMeta(posts[0] ?? {})?.schema, Post);
      const titles = await repo.all(
        ksql<{
          title: string;
        }>`SELECT title FROM (${from(Post).where("views", ">", 0)}) AS p ORDER BY title`,
      );
      assert.deepEqual(
        titles.map((row) => row.title),
        ["Ecto", "Elixir"],
      );
    });

    test("toSql gives the SQL the Repo runs, without running it", async () => {
      const p = /serial/i.test(idType) ? (n: number) => `$${n}` : () => "?";
      const columns = `"q_posts"."id", "q_posts"."title", "q_posts"."user_id", "q_posts"."views"`;
      const query = from(Post).where("title", "=", "Ecto").limit(1);
      events.length = 0;
      assert.deepEqual(repo.toSql(query), {
        sql: `select ${columns} from "q_posts" where "title" = ${p(1)} limit ${p(2)}`,
        params: ["Ecto", 1],
      });
      assert.equal(events.length, 0);
      await repo.all(query);
      assert.equal(events.at(-1)?.sql, repo.toSql(query).sql);
      assert.ok(seen.includes(compileUnbound(query).queryId));

      assert.match(
        repo.toSql(Post).sql,
        /^SELECT "id", "title", "user_id", "views" FROM "q_posts"$/,
      );
      assert.deepEqual(
        repo.toSql(kysely.deleteFrom("q_posts").where("id", "=", 1)),
        { sql: `delete from "q_posts" where "id" = ${p(1)}`, params: [1] },
      );
      assert.deepEqual(repo.toSql(sql`SELECT ${1} AS one`).params, [1]);
      assert.throws(
        () => repo.toSql(42 as never),
        /Repo\.toSql expects a query/,
      );
    });

    test("the Repo's plugins see the query", async () => {
      const query = from(Post).where("id", ">", 0);
      await repo.all(query);
      assert.ok(seen.includes(compileUnbound(query).queryId));
    });

    test("exists and aggregate", async () => {
      assert.equal(
        await repo.exists(from(Post).where("title", "=", "Ecto")),
        true,
      );
      assert.equal(
        await repo.exists(from(Post).where("title", "=", "none")),
        false,
      );
      assert.equal(
        await repo.aggregate(from(Post).where("user_id", "=", ann.id), "count"),
        2,
      );
      assert.equal(
        Number(
          await repo.aggregate(
            from(Post).where("user_id", "=", ann.id),
            "sum",
            "views",
          ),
        ),
        4,
      );
    });

    test("writes run with exec, and are rejected by reads", async () => {
      const updated = await repo.exec(
        kysely
          .updateTable("q_posts")
          .set((eb) => ({ views: eb("views", "+", 10) }))
          .where("user_id", "=", ann.id),
      );
      assert.equal(updated.rowCount, 2);
      const inserted = await repo.exec(
        kysely
          .insertInto("q_posts")
          .values({ title: "New", user_id: bob.id, views: 0 })
          .returning(["id", "title"]),
      );
      type _ = Expect<
        Equal<typeof inserted.rows, { id: number; title: string }[]>
      >;
      assert.equal(inserted.rows[0]?.title, "New");
      const views = await repo.all(
        from(Post).where("user_id", "=", ann.id).orderBy("id"),
      );
      assert.deepEqual(
        views.map((p) => p.views),
        [13, 11],
      );
      await assert.rejects(
        repo.all(kysely.deleteFrom("q_posts")),
        /Repo.all was given a Kysely delete query; run writes with Repo.exec/,
      );
      await assert.rejects(
        repo.query(kysely.deleteFrom("q_posts")),
        /run writes with Repo.exec/,
      );
      await assert.rejects(
        repo.exists(kysely.deleteFrom("q_posts")),
        /run writes with Repo.exec/,
      );
      assert.equal((await repo.all(Post)).length, 4);
    });

    test("updateAll and deleteAll refine with a from() subquery", async () => {
      const bobs = from(User)
        .clearSelect()
        .select("id")
        .where("email", "=", "bob@x");
      const { count } = await repo.updateAll(Post, { inc: { views: 1 } }, (q) =>
        q.where("user_id", "in", bobs),
      );
      assert.equal(count, 1);
      const deleted = await repo.deleteAll(Post, (q) =>
        q.where("user_id", "in", bobs),
      );
      assert.equal(deleted.count, 1);
    });

    test("preload refinements may use from() subqueries", async () => {
      const users = await repo.all(from(User).orderBy("id"));
      const loaded = await repo.preload(users, {
        posts: (q) =>
          q
            .where(
              "id",
              "in",
              from(Post).clearSelect().select("id").where("views", ">", 0),
            )
            .orderBy("id"),
      });
      assert.deepEqual(
        loaded.map((u) => u.posts.map((p) => p.title)),
        [["Ecto", "Elixir"], []],
      );
    });

    test("in a transaction, on its connection", async () => {
      const result = await repo.transact(async (tx) => {
        await tx.insertOrThrow(
          change(Post.new(), { title: "Draft", user_id: ann.id }),
        );
        const posts = await tx.all(from(Post).where("title", "=", "Draft"));
        const nested = await tx.transact(async (inner) => ({
          ok: true,
          value: await inner.oneOrThrow(
            from(Post).where("title", "=", "Draft"),
          ),
        }));
        return { ok: false, error: [posts.length, nested.ok] } as const;
      });
      assert.deepEqual(result, { ok: false, error: [1, true] });
      assert.equal(
        await repo.one(from(Post).where("title", "=", "Draft")),
        null,
      );
    });

    test("in a Multi", async () => {
      const result = await repo.transact(
        Multi.new<DB>()
          .all("posts", from(Post).where("user_id", "=", ann.id).orderBy("id"))
          .one("kysely", from(Post).where("title", "=", "Kysely"))
          .all("ids", from(Post).clearSelect().select("id"))
          .all("later", (changes) =>
            from(Post).where("id", "=", changes.kysely?.id ?? 0),
          )
          .exists("any", from(Post)),
      );
      assert.ok(result.ok);
      const { posts, kysely: one, ids, later } = result.value;
      type _posts = Expect<Equal<typeof posts, Infer<typeof Post>[]>>;
      type _one = Expect<Equal<typeof one, Infer<typeof Post> | null>>;
      type _ids = Expect<Equal<typeof ids, { id: number }[]>>;
      type _later = Expect<Equal<typeof later, Infer<typeof Post>[]>>;
      assert.deepEqual(
        posts.map((p) => p.title),
        ["Ecto", "Elixir"],
      );
      assert.equal(getMeta(one ?? {})?.schema, Post);
      assert.equal(ids.length, 3);
      assert.equal(later[0]?.title, "Kysely");
      assert.equal(result.value.any, true);
    });

    describe("in the test sandbox", () => {
      const box = sandbox(repo);

      test("queries run on the sandbox's transaction", async () => {
        await box.repo.insertOrThrow(
          change(Post.new(), { title: "Sandboxed", user_id: ann.id }),
        );
        const post = await repo.oneOrThrow(
          from(Post).where("title", "=", "Sandboxed"),
        );
        assert.equal(getMeta(post)?.schema, Post);
        assert.equal(
          (await box.repo.all(from(Post).where("title", "=", "Sandboxed")))
            .length,
          1,
        );
      });

      test("and are rolled back after it", async () => {
        assert.equal(
          await repo.one(from(Post).where("title", "=", "Sandboxed")),
          null,
        );
      });
    });
  });
}

suite(
  "queries on SQLite",
  (options) =>
    createRepo<DB>({
      adapter: sqlite(),
      database: ":memory:",
      poolSize: 1,
      ...options,
    }),
  "INTEGER PRIMARY KEY AUTOINCREMENT",
);

describe("queries on Postgres", { skip: skipWithoutPg }, () => {
  if (skipWithoutPg) return;
  suite("pool", (options) => connectPg<DB>(options), "bigserial PRIMARY KEY");
});
