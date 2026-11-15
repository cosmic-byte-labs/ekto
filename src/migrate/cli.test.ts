import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { generate, main } from "./cli.ts";

const url = (path: string) =>
  JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);

describe("ekto gen", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ekto-gen-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes a timestamped migration (mix ecto.gen.migration)", async () => {
    const folder = join(dir, "migrations");
    const file = await generate(
      folder,
      "AddUsersTable",
      new Date("2026-01-15T10:30:05.123Z"),
    );
    assert.equal(file, join(folder, "20260115103005_add_users_table.ts"));
    assert.match(await readFile(file, "utf8"), /export default migration\(\{/);
    await assert.rejects(
      generate(folder, "add users table"),
      /migration name add_users_table is already used by 20260115103005_add_users_table.ts/,
    );
    await assert.rejects(generate(folder, "--"), /expected a migration name/);
  });
});

describe("ekto migrate, rollback and status", () => {
  let dir: string;
  const lines: string[] = [];
  const run = (...args: string[]) => {
    lines.length = 0;
    return main(["--config", join(dir, "ekto.config.ts"), ...args], (line) =>
      lines.push(line),
    );
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ekto-cli-"));
    const database = join(dir, "test.db");
    const kysely = JSON.stringify(import.meta.resolve("kysely"));
    const betterSqlite = JSON.stringify(import.meta.resolve("better-sqlite3"));
    await writeFile(
      join(dir, "ekto.config.ts"),
      `import Database from ${betterSqlite};
import { Kysely, SqliteDialect } from ${kysely};
import { sqlite } from ${url("../sqlite/index.ts")};

export default () => ({
  db: new Kysely({ dialect: new SqliteDialect({ database: new Database(${JSON.stringify(database)}) }) }),
  adapter: sqlite(),
  migrationsFolder: ${JSON.stringify(join(dir, "migrations"))},
});
`,
    );
    await main(
      [
        "--config",
        join(dir, "ekto.config.ts"),
        "gen.migration",
        "create_users",
      ],
      () => {},
    );
    const [file] = await readdir(join(dir, "migrations"));
    assert.ok(file);
    await writeFile(
      join(dir, "migrations", file),
      `import { migration, table } from ${url("dsl.ts")};
export default migration({
  change(m) {
    m.create(table("users"), (t) => t.add("email", "string"));
  },
});
`,
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("runs the commands", async () => {
    assert.equal(await run("status"), 0);
    assert.match(lines.join("\n"), /down\s+\d{14}\s+create_users/);

    assert.equal(await run("migrate"), 0);
    assert.match(lines.join("\n"), /== Migrated \d{14} create_users/);
    await run("migrate");
    assert.deepEqual(lines, ["Migrations already up"]);

    await run("status");
    assert.match(lines.join("\n"), /up\s+\d{14}\s+create_users/);

    assert.equal(
      await run("gen.schemas", "--schemas", join(dir, "schemas")),
      0,
      "every table but schema_migrations",
    );
    assert.deepEqual(lines, [`* creating ${join(dir, "schemas", "user.ts")}`]);
    await run(
      "gen.schemas",
      "users:Account",
      "--schemas",
      join(dir, "schemas"),
    );
    assert.deepEqual(lines, [
      `* creating ${join(dir, "schemas", "account.ts")}`,
    ]);

    assert.equal(await run("rollback", "--step", "1"), 0);
    assert.match(lines.join("\n"), /== Rolled back \d{14} create_users/);
    await run("rollback", "--all");
    assert.deepEqual(lines, ["Migrations already down"]);

    await run("migrate", "--to", "1");
    assert.deepEqual(
      lines,
      ["Migrations already up"],
      "nothing up to version 1",
    );
    await assert.rejects(
      run("migrate", "--step", "x"),
      /--step expects a number/,
    );
    assert.equal(await run("migrate", "--no-lock", "--all"), 0);
    assert.match(lines.join("\n"), /== Migrated/);
    await run("rollback");
    assert.match(lines.join("\n"), /== Rolled back/);
  });

  test("usage and errors", async () => {
    assert.equal(await main([], () => {}), 1);
    assert.equal(await main(["--help"], () => {}), 0);
    await assert.rejects(run("nope"), /unknown command nope/);
    await assert.rejects(
      main(["--config", join(dir, "missing.ts"), "migrate"], () => {}),
      /configuration file .*missing.ts not found/,
    );
  });
});
