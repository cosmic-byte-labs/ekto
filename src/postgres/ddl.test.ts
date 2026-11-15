import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  constraint,
  fragment,
  index,
  type MigrationContext,
  record,
  references,
  table,
  uniqueIndex,
} from "../migrate/dsl.ts";
import { postgresDdl } from "./ddl.ts";

const ddl = (fn: (m: MigrationContext) => void) =>
  record("up", fn).flatMap((command) => {
    assert.notEqual(command.command, "executeReversible");
    return postgresDdl(command as Parameters<typeof postgresDdl>[0]);
  });

// Expected strings follow ecto_sql's test/ecto/adapters/postgres_test.exs.
describe("PostgreSQL DDL", () => {
  test("create table", () => {
    assert.deepEqual(
      ddl((m) =>
        m.create(table("posts"), (t) => {
          t.add("id", "bigserial", { primaryKey: true });
          t.add("name", "string", { default: "Hello", null: false });
          t.add("token", "binary", { size: 20, null: false });
          t.add("price", "numeric", {
            precision: 8,
            scale: 2,
            default: fragment("expr"),
          });
          t.add("on_hand", "integer", { default: 0, null: true });
          t.add("published_at", "utc_datetime", { null: true });
          t.add("is_active", "boolean", { default: true });
          t.add("tags", ["array", "string"], { default: ["foo", "bar"] });
          t.add("meta", "map", { default: { a: 1 } });
          t.add("nothing", "text", { default: null });
        }),
      ),
      [
        'CREATE TABLE "posts" ("id" bigserial, "name" varchar(255) DEFAULT \'Hello\' NOT NULL, ' +
          '"token" bytea(20) NOT NULL, "price" numeric(8,2) DEFAULT expr, ' +
          '"on_hand" integer DEFAULT 0 NULL, "published_at" timestamp(0) NULL, ' +
          '"is_active" boolean DEFAULT true, ' +
          "\"tags\" varchar(255)[] DEFAULT ARRAY['foo','bar']::varchar[], " +
          '"meta" jsonb DEFAULT \'{"a":1}\', "nothing" text DEFAULT NULL, ' +
          'PRIMARY KEY ("id"))',
      ],
    );
  });

  test("create table with references, options and composite keys", () => {
    assert.deepEqual(
      ddl((m) => {
        m.createIfNotExists(
          table("posts", { options: "WITH FOO=BAR" }),
          (t) => {
            t.add("a", "integer", { primaryKey: true });
            t.add("b", "integer", { primaryKey: true });
            t.add("category_0", references("categories"));
            t.add(
              "category_1",
              references("categories", {
                name: "foo_bar",
                onDelete: "deleteAll",
                onUpdate: "updateAll",
              }),
            );
            t.add(
              "category_2",
              references("categories", {
                type: "uuid",
                column: "uuid",
                onDelete: "nilifyAll",
                validate: false,
              }),
            );
          },
        );
      }),
      [
        'CREATE TABLE IF NOT EXISTS "posts" ("a" integer, "b" integer, ' +
          '"category_0" bigint, CONSTRAINT "posts_category_0_fkey" FOREIGN KEY ("category_0") REFERENCES "categories"("id"), ' +
          '"category_1" bigint, CONSTRAINT "foo_bar" FOREIGN KEY ("category_1") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE, ' +
          '"category_2" uuid, CONSTRAINT "posts_category_2_fkey" FOREIGN KEY ("category_2") REFERENCES "categories"("uuid") ON DELETE SET NULL NOT VALID, ' +
          'PRIMARY KEY ("a","b")) WITH FOO=BAR',
      ],
    );
  });

  test("defaults Postgres cannot take", () => {
    assert.throws(
      () =>
        ddl((m) =>
          m.create(table("t"), (t) =>
            t.add("a", "string", { default: "a\0b" }),
          ),
        ),
      /cannot contain null bytes/,
    );
    assert.throws(
      () =>
        ddl((m) =>
          m.create(table("t"), (t) =>
            t.add("a", "string", { default: { a: 1 } }),
          ),
        ),
      /unknown default/,
    );
  });

  test("drop", () => {
    assert.deepEqual(
      ddl((m) => {
        m.drop(table("posts"));
        m.dropIfExists(table("posts"), { mode: "cascade" });
        m.drop(index("posts", ["a"]));
        m.dropIfExists(index("posts", ["a"]), { mode: "cascade" });
        m.drop(
          constraint("products", "price_must_be_positive", {
            check: "price > 0",
          }),
        );
        m.dropIfExists(constraint("products", "c", { check: "x" }));
      }),
      [
        'DROP TABLE "posts"',
        'DROP TABLE IF EXISTS "posts" CASCADE',
        'DROP INDEX "posts_a_index"',
        'DROP INDEX IF EXISTS "posts_a_index" CASCADE',
        'ALTER TABLE "products" DROP CONSTRAINT "price_must_be_positive"',
        'ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "c"',
      ],
    );
  });

  test("alter table", () => {
    assert.deepEqual(
      ddl((m) =>
        m.alter(table("posts"), (t) => {
          t.add("title", "string", {
            default: "Untitled",
            size: 100,
            null: false,
          });
          t.add("author_id", references("author"));
          t.addIfNotExists("subtitle", "string");
          t.modify("price", "numeric", { precision: 8, scale: 2, null: true });
          t.modify("cost", "integer", { null: false, default: null });
          t.modify("permalink_id", references("permalinks"), { null: false });
          t.modify("status", "string", { from: references("statuses") });
          t.remove("summary");
          t.remove("body", "text");
          t.remove("space_id", references("author"));
          t.removeIfExists("extra", references("author"));
          t.removeIfExists("other");
        }),
      ),
      [
        'ALTER TABLE "posts" ADD COLUMN "title" varchar(100) DEFAULT \'Untitled\' NOT NULL, ' +
          'ADD COLUMN "author_id" bigint, ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "author"("id"), ' +
          'ADD COLUMN IF NOT EXISTS "subtitle" varchar(255), ' +
          'ALTER COLUMN "price" TYPE numeric(8,2), ALTER COLUMN "price" DROP NOT NULL, ' +
          'ALTER COLUMN "cost" TYPE integer, ALTER COLUMN "cost" SET NOT NULL, ALTER COLUMN "cost" SET DEFAULT NULL, ' +
          'ALTER COLUMN "permalink_id" TYPE bigint, ADD CONSTRAINT "posts_permalink_id_fkey" FOREIGN KEY ("permalink_id") REFERENCES "permalinks"("id"), ALTER COLUMN "permalink_id" SET NOT NULL, ' +
          'DROP CONSTRAINT "posts_status_fkey", ALTER COLUMN "status" TYPE varchar(255), ' +
          'DROP COLUMN "summary", DROP COLUMN "body", ' +
          'DROP CONSTRAINT "posts_space_id_fkey", DROP COLUMN "space_id", ' +
          'DROP CONSTRAINT IF EXISTS "posts_extra_fkey", DROP COLUMN IF EXISTS "extra", ' +
          'DROP COLUMN IF EXISTS "other"',
      ],
    );
  });

  test("alter table adding a primary key", () => {
    assert.deepEqual(
      ddl((m) =>
        m.alter(table("posts"), (t) =>
          t.add("my_pk", "serial", { primaryKey: true }),
        ),
      ),
      [
        'ALTER TABLE "posts" ADD COLUMN "my_pk" serial, ADD PRIMARY KEY ("my_pk")',
      ],
    );
  });

  test("indexes", () => {
    assert.deepEqual(
      ddl((m) => {
        m.create(index("posts", ["category_id", "permalink"]));
        m.create(
          uniqueIndex("posts", ["lower(permalink)"], { name: "posts$main" }),
        );
        m.createIfNotExists(
          index("posts", ["permalink"], { where: "public IS TRUE" }),
        );
        m.create(
          index("posts", ["data"], {
            using: "gin",
            include: ["id"],
            nullsDistinct: false,
          }),
        );
        m.createIfNotExists(
          uniqueIndex("posts", ["slug"], { concurrently: true }),
        );
        m.drop(index("posts", ["slug"], { concurrently: true }));
        m.dropIfExists(index("posts", ["slug"], { concurrently: true }));
      }),
      [
        'CREATE INDEX "posts_category_id_permalink_index" ON "posts" ("category_id", "permalink")',
        'CREATE UNIQUE INDEX "posts$main" ON "posts" (lower(permalink))',
        'CREATE INDEX IF NOT EXISTS "posts_permalink_index" ON "posts" ("permalink") WHERE public IS TRUE',
        'CREATE INDEX "posts_data_index" ON "posts" USING gin ("data") INCLUDE ("id") NULLS NOT DISTINCT',
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "posts_slug_index" ON "posts" ("slug")',
        'DROP INDEX CONCURRENTLY "posts_slug_index"',
        'DROP INDEX CONCURRENTLY IF EXISTS "posts_slug_index"',
      ],
    );
  });

  test("constraints", () => {
    assert.deepEqual(
      ddl((m) => {
        m.create(
          constraint("products", "price_must_be_positive", {
            check: "price > 0",
          }),
        );
        m.create(
          constraint("products", "no_overlap", {
            exclude: 'gist (int4range("from", "to") WITH &&)',
            validate: false,
          }),
        );
      }),
      [
        'ALTER TABLE "products" ADD CONSTRAINT "price_must_be_positive" CHECK (price > 0)',
        'ALTER TABLE "products" ADD CONSTRAINT "no_overlap" EXCLUDE USING gist (int4range("from", "to") WITH &&) NOT VALID',
      ],
    );
  });

  test("renames and execute", () => {
    assert.deepEqual(
      ddl((m) => {
        m.rename(table("posts"), { to: table("new_posts") });
        m.rename(table("posts"), "given_name", { to: "first_name" });
        m.rename(index("people", ["name"], { name: "persons_name_index" }), {
          to: "people_name_index",
        });
        m.execute("SELECT 1");
      }),
      [
        'ALTER TABLE "posts" RENAME TO "new_posts"',
        'ALTER TABLE "posts" RENAME "given_name" TO "first_name"',
        'ALTER INDEX "persons_name_index" RENAME TO "people_name_index"',
        "SELECT 1",
      ],
    );
  });

  test("types", () => {
    assert.deepEqual(
      ddl((m) =>
        m.create(table("t"), (t) => {
          t.add("a", "uuid");
          t.add("b", "utc_datetime_msec");
          t.add("c", "utc_datetime_msec", { precision: 3 });
          t.add("d", "time");
          t.add("e", "decimal");
          t.add("f", "id");
        }),
      ),
      [
        'CREATE TABLE "t" ("a" uuid, "b" timestamp, "c" timestamp(3), "d" time(0), "e" decimal, "f" integer)',
      ],
    );
  });
});
