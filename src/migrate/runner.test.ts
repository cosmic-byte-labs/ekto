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
import {
  createMigrator,
  FILE_NOT_FOUND,
  fileMigrations,
  type Migrations,
} from "./runner.ts";

const users = (suffix: string) => `mig_users_${suffix}`;
const posts = (suffix: string) => `mig_posts_${suffix}`;

const makeMigrations = (suffix: string): Migrations => ({
  "20260101000000_create_users": migration({
    change(m) {
      m.create(table(users(suffix)), (t) => {
        t.add("email", "string", { null: false });
        t.timestamps();
      });
      m.create(uniqueIndex(users(suffix), ["email"]));
    },
  }),
  "20260102000000_create_posts": migration({
    change(m) {
      m.create(table(posts(suffix)), (t) => {
        t.add("title", "string");
        t.add("user_id", references(users(suffix), { onDelete: "deleteAll" }));
      });
    },
  }),
  "20260103000000_add_age": migration({
    change(m) {
      m.alter(table(users(suffix)), (t) => t.add("age", "integer"));
      m.execute(
        async (db) => {
          await sql`UPDATE ${sql.table(users(suffix))} SET age = 1`.execute(db);
        },
        async () => {},
      );
    },
  }),
});

// biome-ignore lint/suspicious/noExplicitAny: any database
type AnyKysely = Kysely<any>;

/** Whether `table` exists with `column`; avoids introspecting other tests' tables. */
async function has(db: AnyKysely, table: string, column = "*") {
  try {
    await sql
      .raw(
        `SELECT ${column === "*" ? "*" : `"${column}"`} FROM "${table}" LIMIT 0`,
      )
      .execute(db);
    return true;
  } catch {
    return false;
  }
}

const versions = (run: readonly { version: number }[]) =>
  run.map((m) => m.version);

function suite(adapter: Adapter, connect: () => AnyKysely) {
  let db: AnyKysely;
  const suffix = adapter.name;
  const migrations = makeMigrations(suffix);
  const source = `mig_schema_migrations_${suffix}`;
  const migrator = (m: Migrations = migrations) =>
    createMigrator({ db, adapter, migrations: m, migrationSource: source });

  const reset = async () => {
    for (const name of [posts(suffix), users(suffix), "mig_failed", source])
      await sql.raw(`DROP TABLE IF EXISTS "${name}"`).execute(db);
  };

  before(async () => {
    db = connect();
    await reset();
  });
  after(async () => {
    await reset();
    await db.destroy();
  });

  test("migrates, reports status and rolls back", async () => {
    const m = migrator();
    assert.deepEqual(await m.migrate({ step: 1 }), [
      { version: 20260101000000, name: "create_users" },
    ]);
    assert.deepEqual(
      versions(await m.migrate({ to: 20260102000000 })),
      [20260102000000],
    );
    assert.deepEqual(
      await m.migrate({ to: 20260101000000 }),
      [],
      "an executed target is not rolled back",
    );
    assert.deepEqual(versions(await m.migrate()), [20260103000000]);
    assert.deepEqual(await m.migrate(), []);
    assert.ok(await has(db, posts(suffix)));

    assert.deepEqual(await m.status(), [
      { status: "up", version: 20260101000000, name: "create_users" },
      { status: "up", version: 20260102000000, name: "create_posts" },
      { status: "up", version: 20260103000000, name: "add_age" },
    ]);

    const insert = `INSERT INTO "${users(suffix)}" (email, inserted_at, updated_at) VALUES ('a@b.c', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
    await sql.raw(insert).execute(db);
    await assert.rejects(sql.raw(insert).execute(db), /unique|UNIQUE/);

    assert.deepEqual(versions(await m.rollback()), [20260103000000]);
    assert.equal(await has(db, users(suffix), "age"), false);

    assert.deepEqual(
      versions(await m.rollback({ to: 20260101000000 })),
      [20260102000000, 20260101000000],
    );
    assert.equal(await has(db, users(suffix)), false);
    assert.deepEqual(await m.rollback(), []);

    await m.migrate();
    assert.deepEqual(
      versions(await m.rollback({ step: 2 })),
      [20260103000000, 20260102000000],
    );
    assert.deepEqual(
      versions(await m.rollback({ toExclusive: 20260101000000 })),
      [],
    );
    assert.deepEqual(
      versions(await m.rollback({ all: true })),
      [20260101000000],
    );
    assert.deepEqual(
      (await m.status()).map((s) => s.status),
      ["down", "down", "down"],
    );
  });

  test("runs pending migrations older than executed ones (out of order)", async () => {
    const { "20260102000000_create_posts": _, ...rest } = migrations;
    await migrator(rest).migrate({ to: 20260101000000 });
    await migrator(rest).migrate({ toExclusive: 20260104000000 });
    assert.deepEqual(versions(await migrator().migrate()), [20260102000000]);
    assert.deepEqual(
      versions(await migrator().rollback({ all: true })),
      [20260103000000, 20260102000000, 20260101000000],
    );
  });

  test("a failed migration leaves nothing behind", async () => {
    const m = migrator({
      "20260104000000_broken": migration({
        up(m) {
          m.create(table("mig_failed"));
          m.execute("SELECT * FROM no_such_table");
        },
      }),
    });
    await assert.rejects(m.migrate(), /migration 20260104000000_broken failed/);
    assert.equal(await has(db, "mig_failed"), false, "rolled back");
    assert.deepEqual(
      (await m.status()).map((s) => s.status),
      ["down"],
    );
  });

  test("disableDdlTransaction runs the migration outside a transaction", async () => {
    const m = migrator({
      "20260104000000_no_transaction": migration({
        disableDdlTransaction: true,
        disableMigrationLock: true,
        up(m) {
          m.create(table("mig_failed"));
          m.execute("SELECT * FROM no_such_table");
        },
      }),
    });
    await assert.rejects(m.migrate(), /failed/);
    assert.equal(await has(db, "mig_failed"), true, "not rolled back");
    await sql.raw(`DROP TABLE "mig_failed"`).execute(db);
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
    // Without its file, the up-only migration is skipped on rollback.
    assert.deepEqual(await migrator(irreversible).status(), [
      { status: "up", version: 20260101000000, name: "irreversible" },
      { status: "up", version: 20260102000000, name: FILE_NOT_FOUND },
    ]);
    await assert.rejects(
      migrator(irreversible).rollback(),
      /migration 20260101000000_irreversible failed: cannot reverse migration command: execute "SELECT 1"/,
    );
    await sql.raw(`DELETE FROM "${source}"`).execute(db);
  });

  test("checks migrations and options", async () => {
    await assert.rejects(
      migrator().migrate({ step: 0 }),
      /step must be a positive integer/,
    );
    await assert.rejects(
      migrator({ x: {} as never }).migrate(),
      /migration x must be named <version>_<name>/,
    );
    await assert.rejects(
      migrator({ "1_x": {} as never }).migrate(),
      /migration 1_x must be created with migration\(\)/,
    );
    const noop = migration({ change() {} });
    await assert.rejects(
      migrator({ "1_a": noop, "1_b": noop }).migrate(),
      /migration version 1 is duplicated/,
    );
    await assert.rejects(
      migrator({ "1_a": noop, "2_a": noop }).migrate(),
      /migration name a is duplicated/,
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
  if (skipWithoutPg) return;
  suite(postgres(), () => connectPg().db);

  test("concurrent migrators run each migration once", async () => {
    const db = connectPg().db;
    const source = "mig_schema_migrations_concurrent";
    let runs = 0;
    const migrations: Migrations = {
      "1_slow": migration({
        up(m) {
          m.execute(async (q) => {
            runs++;
            await sql`SELECT pg_sleep(0.05)`.execute(q);
          });
        },
      }),
    };
    const make = () =>
      createMigrator({
        db,
        adapter: postgres(),
        migrations,
        migrationSource: source,
      });
    try {
      // The lock is on the migrations table, so it must exist first.
      await make().status();
      const [a, b] = await Promise.all([make().migrate(), make().migrate()]);
      assert.equal(runs, 1);
      assert.equal(a.length + b.length, 1);
    } finally {
      await sql.raw(`DROP TABLE IF EXISTS "${source}"`).execute(db);
      await db.destroy();
    }
  });
});

describe("fileMigrations", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ekto-migrations-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads <version>_<name> files, sorted by file name", async () => {
    const dsl = pathToFileURL(join(import.meta.dirname, "dsl.ts")).href;
    const body = `import { migration } from ${JSON.stringify(dsl)};\nexport default migration({ change(m) { m.execute("SELECT 1", "SELECT 2"); } });\n`;
    await writeFile(join(dir, "002_b.ts"), body);
    await writeFile(join(dir, "001_a.mjs"), body);
    await writeFile(join(dir, "types.d.ts"), "export {};\n");
    await writeFile(join(dir, "helpers.ts"), "export {};\n");
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
