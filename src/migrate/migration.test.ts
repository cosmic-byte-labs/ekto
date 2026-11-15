/**
 * Migrations run against real databases, after ecto_sql's
 * `integration_test/sql/migration.exs`: each test migrates up, checks the
 * database (rows, constraints, `describeTables`), rolls back and checks
 * that the change is gone. The suite runs on SQLite and, with
 * `EKTO_PG_URL`, on Postgres; what SQLite cannot do runs on Postgres only.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql } from "kysely";
import type { ColumnDescription } from "../adapter.ts";
import { connectPg, skipWithoutPg } from "../postgres.test-helper.ts";
import { createRepo, type Repo } from "../repo.ts";
import { sqlite } from "../sqlite/index.ts";
import {
  constraint,
  fragment,
  index,
  type MigrationContext,
  type MigrationDefinition,
  migration,
  references,
  table,
  uniqueIndex,
} from "./dsl.ts";
import { createMigrator } from "./runner.ts";

// Tables of this file start with mi_, as test files run concurrently on
// one Postgres database.
const PREFIX = "mi_";
const SOURCE = "mi_schema_migrations";

const VIOLATION = /violates|constraint failed/i;

function suite(connect: () => Repo) {
  const repo = connect();
  const { adapter } = repo;
  const db = repo.kysely;
  const pg = adapter.name === "postgres";
  let version = 0;

  /** A migration with its own version, to run up and roll back. */
  const define = (definition: MigrationDefinition) => {
    version++;
    const migrator = createMigrator({
      repo,
      migrations: { [`${version}_test_${version}`]: migration(definition) },
      migrationSource: SOURCE,
    });
    return {
      up: async () => assert.equal((await migrator.migrate()).length, 1),
      down: async () =>
        assert.equal((await migrator.rollback({ all: true })).length, 1),
    };
  };

  const rows = async (text: string) =>
    (await sql.raw(text).execute(db)).rows as Record<string, unknown>[];
  const run = async (text: string) => {
    await sql.raw(text).execute(db);
  };

  const describeTable = async (name: string) =>
    (await adapter.describeTables?.(db))?.find((t) => t.name === name);
  const exists = async (name: string) =>
    (await describeTable(name)) !== undefined;
  const columns = async (name: string) => {
    const described = await describeTable(name);
    assert.ok(described, `table ${name} exists`);
    return new Map<string, ColumnDescription>(
      described.columns.map((c) => [c.name, c]),
    );
  };

  const dropAll = async () => {
    for (const t of (await adapter.describeTables?.(db)) ?? [])
      if (t.name.startsWith(PREFIX))
        await run(`DROP TABLE IF EXISTS "${t.name}"${pg ? " CASCADE" : ""}`);
  };

  before(dropAll);
  after(async () => {
    await dropAll();
    await repo.stop();
  });

  test("create and drop table and indexes", async () => {
    const m = define({
      change(m) {
        m.create(table("mi_posts"), (t) => {
          t.add("id", "bigserial", { primaryKey: true });
          t.add("title", "string", { null: false });
          t.add("slug", "string");
        });
        m.create(index("mi_posts", ["title"]));
        m.create(uniqueIndex("mi_posts", ["slug"]));
      },
    });
    await m.up();
    const cols = await columns("mi_posts");
    assert.deepEqual([...cols.keys()], ["id", "title", "slug"]);
    assert.equal(cols.get("id")?.primaryKey, true);
    assert.equal(cols.get("id")?.generated, true);
    assert.equal(cols.get("title")?.nullable, false);
    assert.deepEqual((await describeTable("mi_posts"))?.uniqueIndexes, [
      { column: "slug", name: "mi_posts_slug_index" },
    ]);
    await run(`INSERT INTO mi_posts (title, slug) VALUES ('a', 'a')`);
    await assert.rejects(
      run(`INSERT INTO mi_posts (title, slug) VALUES ('b', 'a')`),
      /unique/i,
    );
    await assert.rejects(run(`INSERT INTO mi_posts (slug) VALUES ('c')`));
    await m.down();
    assert.equal(await exists("mi_posts"), false);
  });

  test("rolls back an index created in change by dropping it", async () => {
    await run(`CREATE TABLE mi_idx (id INTEGER PRIMARY KEY, code TEXT)`);
    const m = define({
      change(m) {
        m.create(uniqueIndex("mi_idx", ["code"], { name: "mi_idx_code" }));
      },
    });
    await m.up();
    assert.deepEqual((await describeTable("mi_idx"))?.uniqueIndexes, [
      { column: "code", name: "mi_idx_code" },
    ]);
    await m.down();
    assert.deepEqual((await describeTable("mi_idx"))?.uniqueIndexes, []);
    await run(`DROP TABLE mi_idx`);
  });

  test("references: on delete", async () => {
    const m = define({
      change(m) {
        m.create(table("mi_parents"), (t) =>
          t.add("id", "bigserial", { primaryKey: true }),
        );
        m.create(table("mi_children"), (t) => {
          t.add("id", "bigserial", { primaryKey: true });
          t.add(
            "cascade_id",
            references("mi_parents", { onDelete: "deleteAll" }),
          );
          t.add(
            "nilify_id",
            references("mi_parents", { onDelete: "nilifyAll" }),
          );
          t.add(
            "default_id",
            references("mi_parents", { onDelete: "defaultAll" }),
            {
              default: 2,
            },
          );
        });
        m.create(table("mi_restricted"), (t) => {
          t.add("id", "bigserial", { primaryKey: true });
          t.add(
            "parent_id",
            references("mi_parents", { onDelete: "restrict" }),
          );
        });
      },
    });
    await m.up();
    assert.deepEqual(
      (await describeTable("mi_children"))?.foreignKeys
        .map((f) => f.column)
        .sort(),
      ["cascade_id", "default_id", "nilify_id"],
    );
    await run(`INSERT INTO mi_parents (id) VALUES (1), (2), (3), (4)`);
    await run(
      `INSERT INTO mi_children (cascade_id, nilify_id, default_id) VALUES (1, NULL, NULL), (NULL, 1, NULL), (NULL, NULL, 3)`,
    );
    await run(`DELETE FROM mi_parents WHERE id = 1`);
    assert.deepEqual(
      (
        await rows(`SELECT cascade_id, nilify_id FROM mi_children ORDER BY id`)
      ).map((r) => [r.cascade_id, r.nilify_id]),
      [
        [null, null],
        [null, null],
      ],
      "the cascading child is deleted, the nilified one kept with null",
    );
    await run(`DELETE FROM mi_parents WHERE id = 3`);
    assert.deepEqual(
      (
        await rows(
          `SELECT default_id FROM mi_children WHERE default_id IS NOT NULL`,
        )
      ).map((r) => Number(r.default_id)),
      [2],
      "set to the column default",
    );
    await run(`INSERT INTO mi_restricted (parent_id) VALUES (4)`);
    await assert.rejects(run(`DELETE FROM mi_parents WHERE id = 4`), VIOLATION);
    await assert.rejects(
      run(`INSERT INTO mi_restricted (parent_id) VALUES (99)`),
      VIOLATION,
    );
    await m.down();
    assert.equal(await exists("mi_children"), false);
    assert.equal(await exists("mi_parents"), false);
  });

  test("create if not exists and drop if exists do not fail", async () => {
    const create = (m: MigrationContext) => {
      m.createIfNotExists(table("mi_maybe"), (t) => t.add("name", "string"));
      m.createIfNotExists(index("mi_maybe", ["name"]));
    };
    const m = define({
      up(m) {
        create(m);
        create(m);
      },
      down(m) {
        m.dropIfExists(index("mi_maybe", ["name"]));
        m.dropIfExists(index("mi_maybe", ["name"]));
        m.dropIfExists(table("mi_maybe"));
        m.dropIfExists(table("mi_maybe"));
      },
    });
    await m.up();
    assert.ok(await exists("mi_maybe"));
    await m.down();
    assert.equal(await exists("mi_maybe"), false);
  });

  test("add columns: defaults fill existing and new rows", async () => {
    await run(`CREATE TABLE mi_defaults (id INTEGER PRIMARY KEY)`);
    await run(`INSERT INTO mi_defaults (id) VALUES (1)`);
    const m = define({
      change(m) {
        m.alter(table("mi_defaults"), (t) => {
          t.add("name", "string", { default: "it's", null: false });
          t.add("count", "integer", { default: 7 });
          t.add("ratio", "float", { default: 1.5 });
          t.add("active", "boolean", { default: true, null: false });
          t.add("data", "map", { default: { a: [1] } });
          t.add("tags", ["array", "string"], { default: [] });
          // SQLite cannot add a column with a non-constant default.
          if (pg) t.add("at", "utc_datetime", { default: fragment("now()") });
        });
      },
    });
    await m.up();
    await run(`INSERT INTO mi_defaults (id) VALUES (2)`);
    const loaded = await rows(`SELECT * FROM mi_defaults ORDER BY id`);
    for (const row of loaded) {
      assert.equal(row.name, "it's");
      assert.equal(Number(row.count), 7);
      assert.equal(Number(row.ratio), 1.5);
      assert.equal(adapter.load("boolean", row.active), true);
      assert.deepEqual(adapter.load("map", row.data), { a: [1] });
      assert.deepEqual(adapter.load(["array", "string"], row.tags), []);
      if (pg) assert.ok(row.at !== null);
    }
    const cols = await columns("mi_defaults");
    assert.equal(cols.get("name")?.nullable, false);
    assert.equal(cols.get("count")?.nullable, true);
    await m.down();
    assert.deepEqual([...(await columns("mi_defaults")).keys()], ["id"]);
    await run(`DROP TABLE mi_defaults`);
  });

  test("remove a column and get it back on rollback", async () => {
    const m0 = define({
      change(m) {
        m.create(table("mi_remove"), (t) => {
          t.add("id", "bigserial", { primaryKey: true });
          t.add("keep", "string");
          t.add("gone", "string", { size: 40 });
        });
      },
    });
    await m0.up();
    const m = define({
      change(m) {
        m.alter(table("mi_remove"), (t) =>
          t.remove("gone", "string", { size: 40 }),
        );
      },
    });
    await m.up();
    assert.deepEqual([...(await columns("mi_remove")).keys()], ["id", "keep"]);
    await m.down();
    assert.deepEqual(
      [...(await columns("mi_remove")).keys()],
      ["id", "keep", "gone"],
    );
    await m0.down();
  });

  test("rename a column and a table, keeping the data", async () => {
    await run(`CREATE TABLE mi_old (id INTEGER PRIMARY KEY, before TEXT)`);
    await run(`INSERT INTO mi_old (id, before) VALUES (1, 'x')`);
    const m = define({
      change(m) {
        m.rename(table("mi_old"), "before", { to: "after" });
        m.rename(table("mi_old"), { to: table("mi_new") });
      },
    });
    await m.up();
    assert.equal(await exists("mi_old"), false);
    assert.deepEqual(await rows(`SELECT after FROM mi_new`), [{ after: "x" }]);
    await m.down();
    assert.equal(await exists("mi_new"), false);
    assert.deepEqual(await rows(`SELECT before FROM mi_old`), [
      { before: "x" },
    ]);
    await run(`DROP TABLE mi_old`);
  });

  test("rename an index", async () => {
    await run(`CREATE TABLE mi_ri (id INTEGER PRIMARY KEY, code TEXT)`);
    await run(`CREATE UNIQUE INDEX mi_ri_a ON mi_ri (code)`);
    const m = define({
      change(m) {
        // SQLite has no ALTER INDEX: as ecto_sqlite3, the index is dropped
        // and created again, so it must be described in full.
        m.rename(uniqueIndex("mi_ri", ["code"], { name: "mi_ri_a" }), {
          to: "mi_ri_b",
        });
      },
    });
    await m.up();
    assert.deepEqual((await describeTable("mi_ri"))?.uniqueIndexes, [
      { column: "code", name: "mi_ri_b" },
    ]);
    await m.down();
    assert.deepEqual((await describeTable("mi_ri"))?.uniqueIndexes, [
      { column: "code", name: "mi_ri_a" },
    ]);
    await run(`DROP TABLE mi_ri`);
  });

  test("timestamps and composite primary keys", async () => {
    const m = define({
      change(m) {
        m.create(table("mi_pairs"), (t) => {
          t.add("a", "integer", { primaryKey: true });
          t.add("b", "integer", { primaryKey: true });
          t.timestamps();
        });
      },
    });
    await m.up();
    const cols = await columns("mi_pairs");
    assert.deepEqual(
      [...cols.values()].filter((c) => c.primaryKey).map((c) => c.name),
      ["a", "b"],
    );
    assert.equal(cols.get("inserted_at")?.nullable, false);
    // SQLite stores datetimes as TEXT, as ecto_sqlite3.
    assert.equal(cols.get("inserted_at")?.type, pg ? "utc_datetime" : "string");
    const insert = `INSERT INTO mi_pairs (a, b, inserted_at, updated_at) VALUES (1, 2, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`;
    await run(insert);
    await assert.rejects(run(insert), VIOLATION);
    await assert.rejects(run(`INSERT INTO mi_pairs (a, b) VALUES (3, 4)`));
    await m.down();
  });

  test("execute runs SQL and functions, reversibly", async () => {
    await run(`CREATE TABLE mi_exec (id INTEGER PRIMARY KEY, n INTEGER)`);
    const m = define({
      change(m) {
        m.execute(
          "INSERT INTO mi_exec (id, n) VALUES (1, 1)",
          "DELETE FROM mi_exec WHERE id = 1",
        );
        m.execute(
          async (q) => {
            await sql`UPDATE mi_exec SET n = n + ${10}`.execute(q);
          },
          async (q) => {
            await sql`UPDATE mi_exec SET n = n - ${10}`.execute(q);
          },
        );
      },
    });
    await m.up();
    assert.deepEqual(
      (await rows(`SELECT n FROM mi_exec`)).map((r) => Number(r.n)),
      [11],
    );
    await m.down();
    assert.deepEqual(await rows(`SELECT n FROM mi_exec`), []);
    await run(`DROP TABLE mi_exec`);
  });

  test("the context knows the direction", async () => {
    await run(`CREATE TABLE mi_dir (direction TEXT)`);
    const m = define({
      change(m) {
        const insert = `INSERT INTO mi_dir VALUES ('${m.direction}')`;
        m.execute(insert, insert);
      },
    });
    await m.up();
    await m.down();
    assert.deepEqual(
      (await rows(`SELECT direction FROM mi_dir`)).map((r) => r.direction),
      ["up", "down"],
    );
    await run(`DROP TABLE mi_dir`);
  });

  test("check constraints: created, enforced and dropped", async () => {
    await run(`CREATE TABLE mi_checks (id INTEGER PRIMARY KEY, n INTEGER)`);
    await run(`INSERT INTO mi_checks (id, n) VALUES (1, -1)`);
    // Existing rows are checked (SQLite ≥ 3.53 adds CHECK constraints with
    // ALTER TABLE, as ecto_sqlite3 emits).
    await assert.rejects(
      define({
        change(m) {
          m.create(constraint("mi_checks", "n_positive", { check: "n > 0" }));
        },
      }).up(),
      /violated|constraint failed/i,
    );
    await run(`DELETE FROM mi_checks`);
    const m = define({
      change(m) {
        m.create(constraint("mi_checks", "n_positive", { check: "n > 0" }));
      },
    });
    await m.up();
    await assert.rejects(
      run(`INSERT INTO mi_checks (id, n) VALUES (2, 0)`),
      VIOLATION,
    );
    await m.down();
    await run(`INSERT INTO mi_checks (id, n) VALUES (2, 0)`);
    await run(`DROP TABLE mi_checks`);
  });

  if (!pg) {
    test("SQLite rejects what it cannot do, leaving nothing behind", async () => {
      await run(`CREATE TABLE mi_lite (id INTEGER PRIMARY KEY, n INTEGER)`);
      for (const [change, error] of [
        [
          (m: MigrationContext) =>
            m.alter(table("mi_lite"), (t) => {
              t.add("x", "integer");
              t.modify("n", "bigint");
            }),
          /ALTER COLUMN not supported by SQLite3/,
        ],
        [
          (m: MigrationContext) =>
            m.create(
              constraint("mi_lite", "n_positive", {
                check: "n > 0",
                validate: false,
              }),
            ),
          /does not support validate: false/,
        ],
        [
          (m: MigrationContext) =>
            m.create(
              constraint("mi_lite", "no_overlap", {
                exclude: "gist (n WITH =)",
              }),
            ),
          /does not support exclusion constraints/,
        ],
      ] as const) {
        await assert.rejects(define({ up: change }).up(), error);
        assert.deepEqual([...(await columns("mi_lite")).keys()], ["id", "n"]);
      }
      await run(`DROP TABLE mi_lite`);
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Postgres only
  // ---------------------------------------------------------------------------

  test("modify a column's type and nullability, reversed with from", async () => {
    await run(`CREATE TABLE mi_modify (id serial PRIMARY KEY, n integer)`);
    await run(`INSERT INTO mi_modify (n) VALUES (1)`);
    const m = define({
      change(m) {
        m.alter(table("mi_modify"), (t) =>
          t.modify("n", "bigint", {
            null: false,
            default: 0,
            from: { type: "integer", null: true },
          }),
        );
      },
    });
    await m.up();
    let n = (await columns("mi_modify")).get("n");
    assert.equal(n?.dbType, "int8");
    assert.equal(n?.nullable, false);
    await run(`INSERT INTO mi_modify DEFAULT VALUES`);
    await m.down();
    n = (await columns("mi_modify")).get("n");
    assert.equal(n?.dbType, "int4");
    assert.equal(n?.nullable, true);
    await run(`DROP TABLE mi_modify`);
  });

  test("modify without from cannot be rolled back", async () => {
    await run(`CREATE TABLE mi_modify2 (id serial PRIMARY KEY, n integer)`);
    const m = define({
      change(m) {
        m.alter(table("mi_modify2"), (t) => t.modify("n", "bigint"));
      },
    });
    await m.up();
    await assert.rejects(m.down(), /cannot reverse migration command/);
    await run(`DROP TABLE mi_modify2`);
    await run(`DELETE FROM ${SOURCE}`);
  });

  test("modify a foreign key's on delete, reversed with from", async () => {
    await run(`CREATE TABLE mi_owners (id bigserial PRIMARY KEY)`);
    await run(
      `CREATE TABLE mi_owned (id bigserial PRIMARY KEY, owner_id bigint CONSTRAINT mi_owned_owner_id_fkey REFERENCES mi_owners (id))`,
    );
    const m = define({
      change(m) {
        m.alter(table("mi_owned"), (t) =>
          t.modify(
            "owner_id",
            references("mi_owners", { onDelete: "deleteAll" }),
            {
              from: references("mi_owners"),
            },
          ),
        );
      },
    });
    await m.up();
    await run(`INSERT INTO mi_owners (id) VALUES (1)`);
    await run(`INSERT INTO mi_owned (owner_id) VALUES (1)`);
    await run(`DELETE FROM mi_owners`);
    assert.deepEqual(await rows(`SELECT * FROM mi_owned`), [], "cascaded");
    await m.down();
    await run(`INSERT INTO mi_owners (id) VALUES (2)`);
    await run(`INSERT INTO mi_owned (owner_id) VALUES (2)`);
    await assert.rejects(run(`DELETE FROM mi_owners`), VIOLATION);
    await run(`DROP TABLE mi_owned, mi_owners`);
  });

  test("a reference added in change is removed on rollback", async () => {
    await run(`CREATE TABLE mi_refd (id bigserial PRIMARY KEY)`);
    await run(`CREATE TABLE mi_refs (id bigserial PRIMARY KEY)`);
    const m = define({
      change(m) {
        m.alter(table("mi_refs"), (t) =>
          t.add("refd_id", references("mi_refd")),
        );
      },
    });
    await m.up();
    assert.deepEqual((await describeTable("mi_refs"))?.foreignKeys, [
      { column: "refd_id", table: "mi_refd", references: "id" },
    ]);
    await m.down();
    assert.deepEqual([...(await columns("mi_refs")).keys()], ["id"]);
    // The constraint went with the column: the table can be dropped alone.
    await run(`DROP TABLE mi_refd`);
    await run(`DROP TABLE mi_refs`);
  });

  test("add if not exists and remove if exists do not fail", async () => {
    await run(`CREATE TABLE mi_ifx (id serial PRIMARY KEY, n integer)`);
    const m = define({
      up(m) {
        m.alter(table("mi_ifx"), (t) => {
          t.addIfNotExists("n", "integer");
          t.addIfNotExists("o", "integer");
        });
      },
      down(m) {
        m.alter(table("mi_ifx"), (t) => {
          t.removeIfExists("o", "integer");
          t.removeIfExists("p", "integer");
        });
      },
    });
    await m.up();
    assert.deepEqual([...(await columns("mi_ifx")).keys()], ["id", "n", "o"]);
    await m.down();
    assert.deepEqual([...(await columns("mi_ifx")).keys()], ["id", "n"]);
    await run(`DROP TABLE mi_ifx`);
  });

  test("check constraints, validated or not", async () => {
    await run(`CREATE TABLE mi_checked (id serial PRIMARY KEY, n integer)`);
    await run(`INSERT INTO mi_checked (n) VALUES (-1)`);
    await assert.rejects(
      define({
        change(m) {
          m.create(constraint("mi_checked", "n_positive", { check: "n > 0" }));
        },
      }).up(),
      /violated by some row/,
    );
    const m = define({
      change(m) {
        m.create(
          constraint("mi_checked", "n_positive", {
            check: "n > 0",
            validate: false,
          }),
        );
      },
    });
    await m.up();
    await assert.rejects(
      run(`INSERT INTO mi_checked (n) VALUES (0)`),
      /n_positive/,
    );
    await m.down();
    await run(`INSERT INTO mi_checked (n) VALUES (0)`);
    await run(`DROP TABLE mi_checked`);
  });

  test("drop table with cascade", async () => {
    await run(`CREATE TABLE mi_base (id serial PRIMARY KEY)`);
    await run(
      `CREATE TABLE mi_dependent (id serial PRIMARY KEY, base_id integer REFERENCES mi_base (id))`,
    );
    await assert.rejects(
      define({ up: (m) => m.drop(table("mi_base")) }).up(),
      /depend/,
    );
    await define({
      up: (m) => m.drop(table("mi_base"), { mode: "cascade" }),
    }).up();
    assert.equal(await exists("mi_base"), false);
    assert.equal(
      (await describeTable("mi_dependent"))?.foreignKeys.length,
      0,
      "the foreign key was dropped",
    );
    await run(`DROP TABLE mi_dependent`);
  });
}

describe("migrations on SQLite", () => {
  suite(() => createRepo({ adapter: sqlite(), database: ":memory:" }));
});

describe("migrations on Postgres", { skip: skipWithoutPg }, () => {
  if (skipWithoutPg) return;
  suite(() => connectPg());
});
