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
import { sqliteDdl } from "./ddl.ts";

const ddl = (fn: (m: MigrationContext) => void) =>
  record("up", fn).flatMap((command) => {
    assert.notEqual(command.command, "executeReversible");
    return sqliteDdl(command as Parameters<typeof sqliteDdl>[0]);
  });

// Expected strings follow ecto_sqlite3's test/ecto/adapters/sqlite3/connection/*_test.exs.
describe("SQLite DDL", () => {
  test("create table", () => {
    assert.deepEqual(
      ddl((m) =>
        m.create(table("posts"), (t) => {
          t.add("id", "bigserial", { primaryKey: true });
          t.add("name", "string", { default: "Hello", null: false });
          t.add("price", "decimal", { precision: 8, scale: 2 });
          t.add("on_hand", "integer", { default: 0, null: true });
          t.add("is_active", "boolean", { default: true });
          t.add("tags", ["array", "string"], { default: ["a"] });
          t.add("meta", "map", { default: { a: "it's" } });
          t.add("at", "utc_datetime", {
            default: fragment("CURRENT_TIMESTAMP"),
          });
          t.add(
            "category_id",
            references("categories", { onDelete: "deleteAll" }),
          );
          t.add("blob", "binary");
          t.add("score", "float");
          t.add("custom", "citext");
        }),
      ),
      [
        'CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, ' +
          '"name" TEXT DEFAULT \'Hello\' NOT NULL, "price" DECIMAL(8,2), ' +
          '"on_hand" INTEGER DEFAULT 0 NULL, "is_active" INTEGER DEFAULT true, ' +
          '"tags" TEXT DEFAULT (\'["a"]\'), "meta" TEXT DEFAULT (\'{"a":"it\'\'s"}\'), ' +
          '"at" TEXT DEFAULT CURRENT_TIMESTAMP, ' +
          '"category_id" INTEGER CONSTRAINT "posts_category_id_fkey" REFERENCES "categories"("id") ON DELETE CASCADE, ' +
          '"blob" BLOB, "score" NUMERIC, "custom" CITEXT)',
      ],
    );
  });

  test("composite primary keys and options", () => {
    assert.deepEqual(
      ddl((m) =>
        m.createIfNotExists(table("t", { options: "STRICT" }), (t) => {
          t.add("a", "integer", { primaryKey: true });
          t.add("b", "integer", { primaryKey: true });
        }),
      ),
      [
        'CREATE TABLE IF NOT EXISTS "t" ("a" INTEGER, "b" INTEGER, PRIMARY KEY ("a","b")) STRICT',
      ],
    );
    assert.deepEqual(
      ddl((m) =>
        m.create(table("t"), (t) =>
          t.add("uuid", "uuid", { primaryKey: true }),
        ),
      ),
      ['CREATE TABLE "t" ("uuid" TEXT PRIMARY KEY)'],
    );
  });

  test("alter table runs one statement per change", () => {
    assert.deepEqual(
      ddl((m) =>
        m.alter(table("posts"), (t) => {
          t.add("title", "string", { default: "Untitled", null: false });
          t.add("author_id", references("author"));
          t.add("published_at", "utc_datetime", { null: false });
          t.remove("summary");
          t.remove("body", "text");
        }),
      ),
      [
        'ALTER TABLE "posts" ADD COLUMN "title" TEXT DEFAULT \'Untitled\' NOT NULL',
        'ALTER TABLE "posts" ADD COLUMN "author_id" INTEGER CONSTRAINT "posts_author_id_fkey" REFERENCES "author"("id")',
        'ALTER TABLE "posts" ADD COLUMN "published_at" TEXT',
        'ALTER TABLE "posts" DROP COLUMN "summary"',
        'ALTER TABLE "posts" DROP COLUMN "body"',
      ],
    );
  });

  test("what SQLite cannot do", () => {
    const cases: [(m: MigrationContext) => void, RegExp][] = [
      [
        (m) => m.alter(table("t"), (t) => t.modify("a", "text")),
        /ALTER COLUMN not supported by SQLite3/,
      ],
      [
        (m) => m.alter(table("t"), (t) => t.removeIfExists("a")),
        /removeIfExists is not supported by SQLite3/,
      ],
      [
        (m) => m.drop(table("t"), { mode: "cascade" }),
        /does not support CASCADE/,
      ],
      [
        (m) => m.create(index("t", "a", { using: "gin" })),
        /using is not supported/,
      ],
      [
        (m) => m.create(index("t", "a", { include: ["b"] })),
        /include is not supported/,
      ],
      [
        (m) => m.create(index("t", "a", { concurrently: true })),
        /concurrently is not supported/,
      ],
      [
        (m) => m.drop(index("t", "a", { concurrently: true })),
        /concurrently is not supported/,
      ],
      [
        (m) => m.create(constraint("t", "c", { exclude: "x" })),
        /exclusion constraints/,
      ],
      [
        (m) => m.dropIfExists(constraint("t", "c", { check: "x" })),
        /dropIfExists for constraints/,
      ],
    ];
    for (const [fn, error] of cases) assert.throws(() => ddl(fn), error);
  });

  test("indexes, renames and constraints", () => {
    assert.deepEqual(
      ddl((m) => {
        m.create(
          uniqueIndex("posts", ["lower(permalink)"], { where: "public = 1" }),
        );
        m.dropIfExists(index("posts", "a"));
        m.rename(index("posts", "a"), { to: "posts_b" });
        m.rename(table("posts"), { to: table("new_posts") });
        m.rename(table("posts"), "a", { to: "b" });
        m.create(constraint("products", "positive", { check: "price > 0" }));
      }),
      [
        'CREATE UNIQUE INDEX "posts_lower_permalink_index" ON "posts" (lower(permalink)) WHERE public = 1',
        'DROP INDEX IF EXISTS "posts_a_index"',
        'DROP INDEX "posts_a_index"',
        'CREATE INDEX "posts_b" ON "posts" ("a")',
        'ALTER TABLE "posts" RENAME TO "new_posts"',
        'ALTER TABLE "posts" RENAME COLUMN "a" TO "b"',
        'ALTER TABLE "products" ADD CONSTRAINT "positive" CHECK (price > 0)',
      ],
    );
  });
});
