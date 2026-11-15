import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { type Kysely, Kysely as KyselyClass, SqliteDialect, sql } from "kysely";
import type { Adapter } from "../adapter.ts";
import { postgres } from "../postgres/index.ts";
import { connectPg, skipWithoutPg } from "../postgres.test-helper.ts";
import { sqlite } from "../sqlite/index.ts";
import {
  MigrationError,
  migration,
  references,
  table,
  uniqueIndex,
} from "./dsl.ts";
import { createMigrator, fileMigrations, type Migrations } from "./runner.ts";

const migrations: Migrations = {
  "20260101000000_create_users": migration({
    change(m) {
      m.create(table("users"), (t) => {
        t.add("email", "string", { null: false });
        t.timestamps();
      });
      m.create(uniqueIndex("users", ["email"]));
    },
  }),
  "20260102000000_create_posts": migration({
    change(m) {
      m.create(table("posts"), (t) => {
        t.add("title", "string");
        t.add("user_id", references("users", { onDelete: "deleteAll" }));
      });
    },
  }),
  "20260103000000_add_age": migration({
    change(m) {
      m.alter(table("users"), (t) => t.add("age", "integer"));
      m.execute(
        async (db) => {
          await sql`UPDATE users SET age = 1`.execute(db);
        },
        async () => {},
      );
    },
  }),
};

// biome-ignore lint/suspicious/noExplicitAny: any database
async function tables(db: Kysely<any>): Promise<string[]> {
  const metadata = await db.introspection.getTables();
  return metadata
    .map((t) => t.name)
    .filter((name) => name === "users" || name === "posts")
    .sort();
}

// biome-ignore lint/suspicious/noExplicitAny: any database
function suite(adapter: Adapter, connect: () => Kysely<any>) {
  // biome-ignore lint/suspicious/noExplicitAny: any database
  let db: Kysely<any>;
  const tableName = `ekto_migrations_test_${adapter.name}`;
  const migrator = (m: Migrations = migrations) =>
    createMigrator({
      db,
      adapter,
      migrations: m,
      migrationTableName: tableName,
      migrationLockTableName: `${tableName}_lock`,
    });

  before(async () => {
    db = connect();
    await sql`DROP TABLE IF EXISTS posts`.execute(db);
    await sql`DROP TABLE IF EXISTS users`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS ${tableName}`).execute(db);
  });
  after(async () => {
    await sql`DROP TABLE IF EXISTS posts`.execute(db);
    await sql`DROP TABLE IF EXISTS users`.execute(db);
    await db.destroy();
  });

  test("migrates, reports status and rolls back", async () => {
    const m = migrator();
    assert.deepEqual(await m.migrate({ step: 1 }), [
      "20260101000000_create_users",
    ]);
    assert.deepEqual(await m.migrate({ to: "20260102000000_create_posts" }), [
      "20260102000000_create_posts",
    ]);
    assert.deepEqual(
      await m.migrate({ to: "20260101000000_create_users" }),
      [],
      "an executed target is not rolled back",
    );
    assert.deepEqual(await m.migrate(), ["20260103000000_add_age"]);
    assert.deepEqual(await m.migrate(), []);
    assert.deepEqual(await tables(db), ["posts", "users"]);

    const status = await m.status();
    assert.deepEqual(
      status.map((s) => s.status),
      ["up", "up", "up"],
    );
    assert.ok(status[0]?.executedAt instanceof Date);

    await sql`INSERT INTO users (email, inserted_at, updated_at, age) VALUES ('a@b.c', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 3)`.execute(
      db,
    );
    await assert.rejects(
      sql`INSERT INTO users (email, inserted_at, updated_at) VALUES ('a@b.c', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`.execute(
        db,
      ),
      /unique|UNIQUE/,
    );

    assert.deepEqual(await m.rollback(), ["20260103000000_add_age"]);
    const columns = (await db.introspection.getTables())
      .find((t) => t.name === "users")
      ?.columns.map((c) => c.name);
    assert.ok(columns && !columns.includes("age"));

    assert.deepEqual(await m.rollback({ to: "20260101000000_create_users" }), [
      "20260102000000_create_posts",
      "20260101000000_create_users",
    ]);
    assert.deepEqual(await tables(db), []);
    assert.deepEqual(await m.rollback(), []);

    await m.migrate();
    assert.deepEqual(await m.rollback({ step: 2 }), [
      "20260103000000_add_age",
      "20260102000000_create_posts",
    ]);
    assert.deepEqual(await m.rollback({ all: true }), [
      "20260101000000_create_users",
    ]);
    assert.deepEqual(
      (await m.status()).map((s) => s.status),
      ["down", "down", "down"],
    );
  });

  test("fails with the migration's name", async () => {
    const m = migrator({
      ...migrations,
      "20260104000000_broken": migration({
        up(m) {
          m.execute("SELECT * FROM no_such_table");
        },
      }),
    });
    await assert.rejects(m.migrate(), /migration 20260104000000_broken failed/);
    await m.rollback({ all: true });
  });

  test("refuses to roll back what cannot be", async () => {
    const irreversible = {
      "20260101000000_irreversible": migration({
        change(m) {
          m.execute("SELECT 1");
        },
      }),
    };
    const m = migrator({
      ...irreversible,
      "20260102000000_up_only": migration({
        up(m) {
          m.execute("SELECT 1");
        },
      }),
    });
    await m.migrate();
    await assert.rejects(m.rollback(), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.equal(
        error.message,
        "migration 20260102000000_up_only failed: it defines up but no down, so it cannot be rolled back",
      );
      return true;
    });
    assert.deepEqual(
      (await m.status()).map((s) => s.status),
      ["up", "up"],
    );
    // The last migration's record goes, so the irreversible one is next.
    await sql
      .raw(`DELETE FROM ${tableName} WHERE name = '20260102000000_up_only'`)
      .execute(db);
    await assert.rejects(
      migrator(irreversible).rollback(),
      /migration 20260101000000_irreversible failed: cannot reverse migration command: execute "SELECT 1"/,
    );
    await sql.raw(`DELETE FROM ${tableName}`).execute(db);
  });

  test("checks options", async () => {
    await assert.rejects(
      migrator().migrate({ step: 0 }),
      /step must be a positive integer/,
    );
    await assert.rejects(
      migrator().migrate({ to: "nope" }),
      /unknown migration nope/,
    );
    await assert.rejects(
      migrator({ x: {} as never }).migrate(),
      /migration x must be created with migration\(\)/,
    );
  });
}

describe("migrator on SQLite", () => {
  suite(sqlite(), () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    return new KyselyClass({ dialect: new SqliteDialect({ database }) });
  });
});

describe("migrator on Postgres", { skip: skipWithoutPg }, () => {
  suite(postgres(), () => connectPg().db);
});

describe("fileMigrations", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ekto-migrations-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads the default exports, sorted by file name", async () => {
    const dsl = pathToFileURL(join(import.meta.dirname, "dsl.ts")).href;
    const body = `import { migration } from ${JSON.stringify(dsl)};\nexport default migration({ change(m) { m.execute("SELECT 1", "SELECT 2"); } });\n`;
    await writeFile(join(dir, "002_b.ts"), body);
    await writeFile(join(dir, "001_a.mjs"), body);
    await writeFile(join(dir, "types.d.ts"), "export {};\n");
    await writeFile(join(dir, "README.md"), "");
    const loaded = await fileMigrations(dir)();
    assert.deepEqual(Object.keys(loaded), ["001_a", "002_b"]);

    await writeFile(join(dir, "003_c.ts"), "export default 1;\n");
    await assert.rejects(
      fileMigrations(dir)(),
      /003_c.ts must export a migration\(\) as its default export/,
    );
  });
});
