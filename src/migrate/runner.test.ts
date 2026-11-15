import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { type Kysely, sql } from "kysely";
import type { Adapter, MigrationLockOptions } from "../adapter.ts";
import { connectPg, skipWithoutPg } from "../postgres.test-helper.ts";
import { createRepo, type Repo } from "../repo.ts";
import { sqlite } from "../sqlite/index.ts";
import {
  index,
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
        t.add("id", "bigserial", { primaryKey: true });
        t.add("email", "string", { null: false });
        t.timestamps();
      });
      m.create(uniqueIndex(users(suffix), ["email"]));
    },
  }),
  "20260102000000_create_posts": migration({
    change(m) {
      m.create(table(posts(suffix)), (t) => {
        t.add("id", "bigserial", { primaryKey: true });
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
        // Qualified, as SQLite reads an unknown "column" as a string.
        `SELECT ${column === "*" ? "*" : `"${table}"."${column}"`} FROM "${table}" LIMIT 0`,
      )
      .execute(db);
    return true;
  } catch {
    return false;
  }
}

const versions = (run: readonly { version: number }[]) =>
  run.map((m) => m.version);

function suite(connect: () => Repo) {
  const repo = connect();
  const db = repo.kysely;
  const suffix = repo.adapter.name;
  const migrations = makeMigrations(suffix);
  const source = `mig_schema_migrations_${suffix}`;
  const migrator = (m: Migrations = migrations) =>
    createMigrator({ repo, migrations: m, migrationSource: source });

  const reset = async () => {
    for (const name of [posts(suffix), users(suffix), "mig_failed", source])
      await sql.raw(`DROP TABLE IF EXISTS "${name}"`).execute(db);
  };

  before(reset);
  after(async () => {
    await reset();
    await repo.stop();
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
          m.create(table("mig_failed"), (t) => t.add("id", "integer"));
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
          m.create(table("mig_failed"), (t) => t.add("id", "integer"));
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

  test("steps and versions stop at the available migrations", async () => {
    const m = migrator();
    assert.deepEqual(
      versions(await m.migrate({ step: 10 })),
      [20260101000000, 20260102000000, 20260103000000],
    );
    assert.deepEqual(
      versions(await m.rollback({ step: 10 })),
      [20260103000000, 20260102000000, 20260101000000],
    );
    assert.deepEqual(
      versions(await m.migrate({ to: 20990101000000 })),
      [20260101000000, 20260102000000, 20260103000000],
    );
    assert.deepEqual(
      versions(await m.rollback({ to: 1 })),
      [20260103000000, 20260102000000, 20260101000000],
    );
    assert.deepEqual(
      versions(await m.migrate({ toExclusive: 20260102000000 })),
      [20260101000000],
    );
    assert.deepEqual(
      versions(await m.rollback({ all: true })),
      [20260101000000],
    );
  });

  test("a failure midway keeps the migrations before it and skips the rest", async () => {
    const ran: string[] = [];
    const step = (name: string, fail = false) =>
      migration({
        up(m) {
          m.execute(async () => {
            ran.push(name);
            if (fail) throw new Error("boom");
          });
        },
        down(m) {
          m.execute(async () => {});
        },
      });
    const m = migrator({
      "1_first": step("first"),
      "2_second": step("second", true),
      "3_third": step("third"),
    });
    await assert.rejects(m.migrate(), /migration 2_second failed: boom/);
    assert.deepEqual(ran, ["first", "second"]);
    assert.deepEqual(
      (await m.status()).map((s) => s.status),
      ["up", "down", "down"],
    );
    assert.deepEqual(versions(await m.rollback({ all: true })), [1]);
  });

  test("loads migrations from a function", async () => {
    const m = createMigrator({
      repo,
      migrations: async () => ({
        "1_loaded": migration({
          change(m) {
            m.execute("SELECT 1", "SELECT 1");
          },
        }),
      }),
      migrationSource: source,
    });
    assert.deepEqual(await m.migrate(), [{ version: 1, name: "loaded" }]);
    assert.deepEqual(await m.rollback(), [{ version: 1, name: "loaded" }]);
  });

  test("checks migrations and options", async () => {
    await assert.rejects(
      migrator().migrate({ step: 0 }),
      /step must be a positive integer/,
    );
    await assert.rejects(
      migrator().migrate({ to: "20260101000000" as never }),
      /to must be an integer version, got 20260101000000/,
    );
    await assert.rejects(
      migrator().rollback({ toExclusive: 1.5 }),
      /toExclusive must be an integer version/,
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
  suite(() =>
    createRepo({ adapter: sqlite(), database: ":memory:", poolSize: 1 }),
  );
});

describe("lock for migrations", () => {
  const locks: string[] = [];
  const lockOptions: MigrationLockOptions[] = [];
  const adapter: Adapter = {
    ...sqlite(),
    async lockForMigrations(_meta, source, fn, options) {
      locks.push(source);
      lockOptions.push(options);
      return fn();
    },
  };
  const repo = createRepo({ adapter, database: ":memory:", poolSize: 1 });
  const noop = (options: { disableMigrationLock?: boolean } = {}) =>
    migration({
      ...options,
      change(m) {
        m.execute("SELECT 1", "SELECT 1");
      },
    });
  after(() => repo.stop());

  test("is taken for each migration going up and down", async () => {
    locks.length = 0;
    const m = createMigrator({
      repo,
      migrations: { "1_a": noop(), "2_b": noop() },
    });
    await m.migrate();
    assert.deepEqual(locks, ["schema_migrations", "schema_migrations"]);
    await m.rollback({ all: true });
    assert.equal(locks.length, 4);
  });

  test("is not taken with disableMigrationLock or migrationLock: false", async () => {
    locks.length = 0;
    const m = createMigrator({
      repo,
      migrations: { "1_a": noop({ disableMigrationLock: true }) },
    });
    await m.migrate();
    await m.rollback();
    const unlocked = createMigrator({
      repo,
      migrations: { "1_a": noop() },
      migrationLock: false,
    });
    await unlocked.migrate();
    await unlocked.rollback();
    assert.deepEqual(locks, []);
  });

  test("passes the strategy and the advisory lock's retries to the adapter", async () => {
    lockOptions.length = 0;
    const migrations = { "1_a": noop() };
    const m = createMigrator({ repo, migrations });
    await m.migrate();
    await m.rollback();
    const advisory = createMigrator({
      repo,
      migrations,
      migrationLock: "pgAdvisoryLock",
      migrationAdvisoryLockRetryIntervalMs: 10,
      migrationAdvisoryLockMaxTries: 3,
    });
    await advisory.migrate();
    await advisory.rollback();
    assert.deepEqual(lockOptions, [
      ...Array(2).fill({
        strategy: "tableLock",
        advisoryLockRetryIntervalMs: 5000,
        advisoryLockMaxTries: Infinity,
      }),
      ...Array(2).fill({
        strategy: "pgAdvisoryLock",
        advisoryLockRetryIntervalMs: 10,
        advisoryLockMaxTries: 3,
      }),
    ]);
  });
});

describe("concurrent index warnings (Ecto's runner warnings)", () => {
  // Indexes run nothing, so only the warnings are checked.
  const fake = (name: string): Adapter => {
    const adapter = sqlite();
    return {
      ...adapter,
      name,
      ddl: (command) =>
        "object" in command && command.object.kind === "index"
          ? []
          : (adapter.ddl?.(command) ?? []),
    };
  };
  const warnings = async (
    t: TestContext,
    name: string,
    options: {
      disableDdlTransaction?: boolean;
      disableMigrationLock?: boolean;
    },
    migrationLock?: "pgAdvisoryLock",
  ) => {
    const emit = t.mock.method(process, "emitWarning", () => {});
    const repo = createRepo({
      adapter: fake(name),
      database: ":memory:",
      poolSize: 1,
    });
    try {
      const m = createMigrator({
        repo,
        migrations: {
          "1_index": migration({
            ...options,
            change(m) {
              m.create(index("posts", ["slug"], { concurrently: true }));
              m.create(index("posts", ["title"]));
            },
          }),
        },
        ...(migrationLock !== undefined && { migrationLock }),
      });
      await m.migrate();
      await m.rollback();
    } finally {
      await repo.stop();
    }
    return emit.mock.calls.map((call) => String(call.arguments[0]));
  };

  test("warn going up and down without disabling the DDL transaction and the lock", async (t) => {
    const messages = await warnings(t, "postgres", {});
    assert.equal(messages.length, 4);
    assert.equal(
      messages[0],
      "Migration 1_index has set index `posts_slug_index` on table `posts` to concurrently but did not disable ddl transaction. Please set:\n\n    migration({ disableDdlTransaction: true, ... })\n",
    );
    assert.match(messages[1] ?? "", /did not disable migration lock/);
    assert.match(messages[1] ?? "", /migrationLock: "pgAdvisoryLock"/);
  });

  test("only Postgres suggests the advisory lock", async (t) => {
    const messages = await warnings(t, "sqlite", {
      disableDdlTransaction: true,
    });
    assert.equal(messages.length, 2);
    assert.match(messages[0] ?? "", /did not disable migration lock/);
    assert.doesNotMatch(messages[0] ?? "", /pgAdvisoryLock/);
  });

  test("do not warn when disabled, or with the advisory lock on Postgres", async (t) => {
    assert.deepEqual(
      await warnings(t, "postgres", {
        disableDdlTransaction: true,
        disableMigrationLock: true,
      }),
      [],
    );
    assert.deepEqual(
      await warnings(
        t,
        "postgres",
        { disableDdlTransaction: true },
        "pgAdvisoryLock",
      ),
      [],
    );
  });
});

describe("migrator on Postgres", { skip: skipWithoutPg }, () => {
  if (skipWithoutPg) return;
  suite(() => connectPg());

  test("concurrent migrators run each migration once", async () => {
    const repo = connectPg();
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
      createMigrator({ repo, migrations, migrationSource: source });
    try {
      // The lock is on the migrations table, so it must exist first.
      await make().status();
      const [a, b] = await Promise.all([make().migrate(), make().migrate()]);
      assert.equal(runs, 1);
      assert.equal(a.length + b.length, 1);
    } finally {
      await sql.raw(`DROP TABLE IF EXISTS "${source}"`).execute(repo.kysely);
      await repo.stop();
    }
  });
});

describe("migrator with the Postgres advisory lock", {
  skip: skipWithoutPg,
}, () => {
  if (skipWithoutPg) return;
  const repo = connectPg();
  const source = "mig_schema_migrations_advisory";
  const posts = "mig_posts_advisory";
  after(async () => {
    await sql
      .raw(`DROP TABLE IF EXISTS "${source}", "${source}_2", "${posts}"`)
      .execute(repo.kysely);
    await repo.stop();
  });

  test("concurrent migrators run each migration once", async () => {
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
        repo,
        migrations,
        migrationSource: `${source}_2`,
        migrationLock: "pgAdvisoryLock",
        migrationAdvisoryLockRetryIntervalMs: 10,
      });
    // The migrations table must exist first.
    await make().status();
    const [a, b] = await Promise.all([make().migrate(), make().migrate()]);
    assert.equal(runs, 1);
    assert.equal(a.length + b.length, 1);
  });

  test("lets a migration create an index concurrently, and fails after its retries", async (t) => {
    t.mock.method(process, "emitWarning", () => {});
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const migrations: Migrations = {
      "1_posts": migration({
        change(m) {
          m.create(table(posts), (t) => t.add("slug", "string"));
        },
      }),
      "2_index": migration({
        disableDdlTransaction: true,
        up(m) {
          m.create(index(posts, ["slug"], { concurrently: true }));
          m.execute(async () => {
            started();
            await held;
          });
        },
        down(m) {
          m.drop(index(posts, ["slug"], { concurrently: true }));
        },
      }),
    };
    const make = (maxTries?: number) =>
      createMigrator({
        repo,
        migrations,
        migrationSource: source,
        migrationLock: "pgAdvisoryLock",
        migrationAdvisoryLockRetryIntervalMs: 10,
        ...(maxTries !== undefined && {
          migrationAdvisoryLockMaxTries: maxTries,
        }),
      });
    await make().migrate({ step: 1 });
    const first = make().migrate();
    await running;
    await assert.rejects(make(2).migrate(), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.match(
        error.message,
        /failed to obtain advisory lock\. Tried 2 times waiting 10ms between tries/,
      );
      return true;
    });
    release();
    assert.equal((await first).length, 1);
    const { rows } = await sql<{
      indexname: string;
    }>`SELECT indexname FROM pg_indexes WHERE tablename = ${posts}`.execute(
      repo.kysely,
    );
    assert.deepEqual(
      rows.map((row) => row.indexname),
      [`${posts}_slug_index`],
    );
    await make().rollback({ all: true });
  });
});

describe("migrator on a Postgres pool of one connection", {
  skip: skipWithoutPg,
}, () => {
  if (skipWithoutPg) return;
  const source = "mig_schema_migrations_pool";
  const migrations: Migrations = {
    "1_noop": migration({
      change(m) {
        m.execute("SELECT 1", "SELECT 1");
      },
    }),
  };
  const repo = connectPg({ poolSize: 1 });
  after(async () => {
    await sql.raw(`DROP TABLE IF EXISTS "${source}"`).execute(repo.kysely);
    await repo.stop();
  });

  test("raises when the pool is too small for the lock (Ecto's pool_size check)", async () => {
    const m = createMigrator({ repo, migrations, migrationSource: source });
    await assert.rejects(m.migrate(), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.match(
        error.message,
        /Migrations failed to run because the connection pool size is less than 2/,
      );
      return true;
    });
    assert.deepEqual(
      (await m.status()).map((s) => s.status),
      ["down"],
      "nothing ran, and the pool still works",
    );
  });

  test("does not raise without the lock", async () => {
    const m = createMigrator({
      repo,
      migrations,
      migrationSource: source,
      migrationLock: false,
    });
    assert.deepEqual(versions(await m.migrate()), [1]);
    assert.deepEqual(versions(await m.rollback()), [1]);
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

  test("picks up subfolders and several folders, in version order", async () => {
    const dsl = pathToFileURL(join(import.meta.dirname, "dsl.ts")).href;
    const body = `import { migration } from ${JSON.stringify(dsl)};\nexport default migration({ change(m) { m.execute("SELECT 1", "SELECT 2"); } });\n`;
    const a = join(dir, "paths", "a");
    const b = join(dir, "paths", "b");
    await mkdir(join(a, "nested"), { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "10_ten.ts"), body);
    await writeFile(join(a, "nested", "12_twelve.ts"), body);
    await writeFile(join(b, "11_eleven.ts"), body);
    const repo = createRepo({
      adapter: sqlite(),
      database: ":memory:",
      poolSize: 1,
    });
    try {
      const m = createMigrator({
        repo,
        migrations: fileMigrations([a, b]),
      });
      assert.deepEqual(versions(await m.migrate()), [10, 11, 12]);
      // Without b, its executed migration shows as missing (Ecto's status).
      assert.deepEqual(
        await createMigrator({
          repo,
          migrations: fileMigrations(a),
        }).status(),
        [
          { status: "up", version: 10, name: "ten" },
          { status: "up", version: 11, name: FILE_NOT_FOUND },
          { status: "up", version: 12, name: "twelve" },
        ],
      );
    } finally {
      await repo.stop();
    }

    await writeFile(join(b, "10_ten.ts"), body);
    await assert.rejects(
      fileMigrations([a, b])(),
      /migration 10_ten is duplicated/,
    );
    await assert.rejects(
      fileMigrations(join(dir, "missing"))(),
      /could not find migrations directory .*missing/,
    );
  });
});
