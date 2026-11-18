import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DummyDriver,
  type Insertable,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Selectable,
  type Updateable,
} from "kysely";
import type { KyselyDB as PostgresDB } from "./postgres/index.ts";
import { schema, t } from "./schema.ts";
import type { KyselyDB as SqliteDB } from "./sqlite/index.ts";
import { integer } from "./type.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

const User = schema("users", {
  id: t.id(),
  email: t.string(),
  name: t.string({ nullable: true }),
  active: t.boolean({ default: true }),
  score: t.decimal({ nullable: true }),
  tags: t.array(integer),
  born_on: t.date({ nullable: true }),
  password: t.string({ virtual: true }),
  version: t.integer({ readAfterWrites: true }),
  ...t.timestamps(),
});

const Post = schema("posts", {
  id: t.uuid({ primaryKey: true, autogenerate: true }),
  title: t.string(),
  author_id: t.integer(),
});

/** Flattens Kysely's intersections so `Equal` compares plain object types. */
type Plain<T> = { [K in keyof T]: T[K] };

type PG = PostgresDB<[typeof User, typeof Post]>;
type Lite = SqliteDB<[typeof User, typeof Post]>;

describe("KyselyDB", () => {
  test("maps schemas to tables by source, without virtual fields", () => {
    type _tables = Expect<Equal<keyof PG, "users" | "posts">>;
    type _columns = Expect<
      Equal<
        keyof PG["users"],
        | "id"
        | "email"
        | "name"
        | "active"
        | "score"
        | "tags"
        | "born_on"
        | "version"
        | "inserted_at"
        | "updated_at"
      >
    >;
    assert.ok(true);
  });

  test("Postgres columns use what node-postgres returns", () => {
    type _select = Expect<
      Equal<
        Selectable<PG["users"]>,
        {
          id: string;
          email: string;
          name: string | null;
          active: boolean;
          score: string | null;
          tags: number[];
          born_on: Date | null;
          version: number;
          inserted_at: Date;
          updated_at: Date;
        }
      >
    >;
    assert.ok(true);
  });

  test("database-generated and nullable columns are optional on insert", () => {
    type _insert = Expect<
      Equal<
        Plain<Insertable<PG["users"]>>,
        {
          id?: string | number | bigint | undefined;
          email: string;
          name?: string | null | undefined;
          active: boolean;
          score?: string | number | null | undefined;
          tags: number[];
          born_on?: Date | string | null | undefined;
          version?: number | undefined;
          inserted_at: Date | string;
          updated_at: Date | string;
        }
      >
    >;
    // App-generated keys (uuid) are ekto's job, so raw inserts must give them.
    type _post = Expect<
      Equal<
        Plain<Insertable<PG["posts"]>>,
        { id: string; title: string; author_id: number }
      >
    >;
    type _update = Expect<
      Equal<Updateable<PG["posts"]>["id"], string | undefined>
    >;
    assert.ok(true);
  });

  test("SQLite columns use what node-sqlite3 returns", () => {
    type _select = Expect<
      Equal<
        Selectable<Lite["users"]>,
        {
          id: number;
          email: string;
          name: string | null;
          active: number;
          score: number | string | null;
          tags: string;
          born_on: string | null;
          version: number;
          inserted_at: string;
          updated_at: string;
        }
      >
    >;
    assert.ok(true);
  });

  test("works as a Kysely database type", () => {
    const db = new Kysely<PG>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const query = db
      .selectFrom("posts")
      .innerJoin("users", "users.id", "posts.author_id")
      .where("users.active", "=", true)
      .select(["posts.title", "users.name as author"]);
    type _row = Expect<
      Equal<
        Awaited<ReturnType<typeof query.executeTakeFirstOrThrow>>,
        { title: string; author: string | null }
      >
    >;
    assert.equal(
      query.compile().sql,
      'select "posts"."title", "users"."name" as "author" from "posts" inner join "users" on "users"."id" = "posts"."author_id" where "users"."active" = $1',
    );
    // @ts-expect-error: virtual fields are not columns
    db.selectFrom("users").select("password");
  });
});
