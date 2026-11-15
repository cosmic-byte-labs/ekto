import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
    await writeFile(
      join(dir, "ekto.config.ts"),
      `import { sqlite } from ${url("../sqlite/index.ts")};

export default () => ({
  repo: { adapter: sqlite(), database: ${JSON.stringify(database)} },
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
    m.create(table("users"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("email", "string");
    });
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

  test("--to-exclusive, a deleted file and a custom folder (mix ecto.migrate, ecto.migrations)", async () => {
    const folder = join(dir, "migrations");
    const [file] = await readdir(folder);
    assert.ok(file);
    const version = file.slice(0, 14);
    await run("migrate", "--to-exclusive", version);
    assert.deepEqual(lines, ["Migrations already up"]);
    await run("migrate", "--to-exclusive", String(Number(version) + 1));
    assert.match(lines.join("\n"), /== Migrated/);

    const moved = join(dir, "moved");
    await rename(folder, moved);
    await mkdir(folder);
    try {
      await run("status");
      assert.match(lines.join("\n"), /up\s+\d{14}\s+\*\* FILE NOT FOUND \*\*/);
      await assert.rejects(
        run("migrate", "--migrations", join(dir, "nowhere")),
        /could not find migrations directory .*nowhere/,
      );
      assert.equal(await run("rollback", "--migrations", moved), 0);
      assert.match(lines.join("\n"), /== Rolled back/);
    } finally {
      await rm(folder, { recursive: true });
      await rename(moved, folder);
    }
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
