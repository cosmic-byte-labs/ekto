import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import type { Adapter } from "../adapter.ts";
import { postgres } from "../postgres/index.ts";
import { connectPg, skipWithoutPg } from "../postgres.test-helper.ts";
import { createRepo, type Repo } from "../repo.ts";
import { sqlite } from "../sqlite/index.ts";
import { main } from "./cli.ts";
import {
  generateSchema,
  generateSchemas,
  kyselyMigrationSource,
  migrationSource,
  parseAttrs,
  type SchemaSpec,
  schemaFile,
  schemaName,
  schemaSource,
} from "./gen.ts";
import { createMigrator } from "./runner.ts";

describe("parseAttrs (mix phx.gen.schema attributes)", () => {
  test("types, unique, references, arrays and enums", () => {
    const attrs = parseAttrs([
      "title",
      "email:string:unique",
      "slug:unique",
      "body:text",
      "tags:array:string",
      "status:enum:draft:published",
      "user_id:references:users",
    ]);
    assert.deepEqual(
      attrs.map((a) => [a.name, a.field, a.columnSource, a.unique]),
      [
        ["title", "t.string()", '"string"', false],
        ["email", "t.string()", '"string"', true],
        ["slug", "t.string()", '"string"', true],
        ["body", "t.string()", '"text"', false],
        ["tags", "t.array(t.string)", '["array", "string"]', false],
        ["status", 't.enum(["draft", "published"])', '"string"', false],
        ["user_id", "t.integer()", 'references("users")', false],
      ],
    );
    const [ref] = parseAttrs(["org_id:references:orgs"], { binaryId: true });
    assert.equal(ref?.field, "t.uuid()");
    assert.equal(ref?.columnSource, 'references("orgs", { type: "uuid" })');
  });

  test("errors", () => {
    assert.throws(() => parseAttrs(["x:nope"]), /unknown type nope for x/);
    assert.throws(() => parseAttrs(["x:references"]), /x:references:<table>/);
    assert.throws(() => parseAttrs(["x:array:nope"]), /x:array:<type>/);
    assert.throws(() => parseAttrs(["x:enum"]), /x:enum:<value>/);
    assert.throws(() => parseAttrs(["x", "x:integer"]), /duplicate field x/);
    assert.throws(() => parseAttrs(["id:integer"]), /id is added/);
    assert.throws(() => parseAttrs(["1x"]), /invalid field name/);
    assert.throws(
      () => schemaSource({ name: "post", table: "posts", attrs: [] }),
      /expected a schema name/,
    );
    assert.equal(schemaFile("Blog.PostComment"), "blog/post_comment.ts");
    assert.equal(schemaFile("Blog.Post", "js"), "blog/post.js");
  });

  test("the generated sources", () => {
    const spec: SchemaSpec = {
      name: "Blog.Post",
      table: "posts",
      attrs: parseAttrs(["title", "user_id:references:users"]),
    };
    const schema = schemaSource(spec);
    assert.match(schema, /export const Post = schema\("posts", \{/);
    assert.match(schema, /cast\(post, attrs, \["title"\]\)/, "no references");
    const migration = migrationSource(spec);
    assert.match(
      migration,
      /m\.create\(table\("posts"\), \(t\) => \{\n\s+t\.add\("id", "bigserial", \{ primaryKey: true \}\);/,
      "the id is explicit",
    );
    assert.match(
      migrationSource({ ...spec, binaryId: true }),
      /t\.add\("id", "uuid", \{ primaryKey: true \}\);/,
    );
    assert.match(migration, /t\.add\("user_id", references\("users"\)\);/);
    assert.match(migration, /m\.create\(index\("posts", \["user_id"\]\)\);/);
    const kysely = kyselyMigrationSource(spec, postgres());
    assert.match(
      kysely,
      /\.addColumn\("id", "bigserial", \(col\) => col\.primaryKey\(\)\)/,
    );
    assert.match(kysely, /\.addColumn\("title", "varchar\(255\)"\)/);
    assert.match(
      kysely,
      /\.addColumn\("user_id", "bigint", \(col\) => col\.references\("users\.id"\)\)/,
    );
    assert.match(kysely, /\.createIndex\("posts_user_id_index"\)/);
    assert.throws(
      () => kyselyMigrationSource(spec, { name: "x" } as Adapter),
      /cannot generate Kysely migrations/,
    );
  });

  test("JavaScript sources have no types", () => {
    const spec: SchemaSpec = {
      name: "Post",
      table: "posts",
      attrs: parseAttrs(["title:unique"]),
    };
    const schema = schemaSource(spec, "js");
    assert.match(schema, /export function changeset\(post, attrs\) \{/);
    assert.doesNotMatch(schema, /\btype\b|Infer|New|Changeset/);
    const kysely = kyselyMigrationSource(spec, postgres(), "js");
    assert.match(kysely, /^export async function up\(db\) \{/);
    assert.match(kysely, /export async function down\(db\) \{/);
    assert.doesNotMatch(kysely, /Kysely|Promise|biome/);
  });
});

const ROOT = new URL("../", import.meta.url);

/** Points the generated imports at this checkout. */
async function link(file: string) {
  const source = (await readFile(file, "utf8"))
    .replace(
      'from "ekto/migrate"',
      `from ${JSON.stringify(new URL("migrate/index.ts", ROOT).href)}`,
    )
    .replace(
      'from "ekto"',
      `from ${JSON.stringify(new URL("index.ts", ROOT).href)}`,
    )
    .replace(
      'from "kysely"',
      `from ${JSON.stringify(import.meta.resolve("kysely"))}`,
    );
  await writeFile(file, source);
  return import(pathToFileURL(file).href);
}

function roundTrip(name: string, connect: () => Repo) {
  describe(name, () => {
    let dir: string;
    const repo = connect();
    const { adapter } = repo;
    const db = repo.kysely;
    const tables = [
      `gen_comments_${adapter.name}`,
      `gen_kposts_${adapter.name}`,
      `gen_authors_${adapter.name}`,
      `gen_jposts_${adapter.name}`,
      `gen_jkposts_${adapter.name}`,
      `gen_schema_migrations_${adapter.name}`,
    ];
    const drop = async () => {
      for (const table of tables)
        await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
    };

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "ekto-gen-schema-"));
      await drop();
    });
    after(async () => {
      await drop();
      await repo.stop();
      await rm(dir, { recursive: true, force: true });
    });

    test("an ekto migration and its schema work", async () => {
      const authors = `gen_authors_${adapter.name}`;
      const comments = `gen_comments_${adapter.name}`;
      const folders = {
        schemasFolder: join(dir, "ekto", "schemas"),
        migrationsFolder: join(dir, "ekto", "migrations"),
      };
      const [authorFile, authorMigration] = await generateSchema(
        {
          name: "Author",
          table: authors,
          attrs: parseAttrs(["email:unique", "age:integer"]),
        },
        { ...folders, migration: "ekto", now: new Date("2026-01-01") },
      );
      const [commentFile, commentMigration] = await generateSchema(
        {
          name: "Blog.Comment",
          table: comments,
          attrs: parseAttrs([
            "body:text",
            "tags:array:string",
            `author_id:references:${authors}`,
          ]),
        },
        { ...folders, migration: "ekto", now: new Date("2026-01-02") },
      );
      assert.ok(
        authorFile && authorMigration && commentFile && commentMigration,
      );
      assert.equal(commentFile, join(folders.schemasFolder, "blog/comment.ts"));

      const migrator = createMigrator({
        repo,
        migrationSource: `gen_schema_migrations_${adapter.name}`,
        migrations: {
          [`20260101000000_create_${authors}`]: (await link(authorMigration))
            .default,
          [`20260102000000_create_${comments}`]: (await link(commentMigration))
            .default,
        },
      });
      assert.equal((await migrator.migrate()).length, 2);

      const { Author, changeset } = await link(authorFile);
      const ann = await repo.insertOrThrow(
        changeset(Author.new(), { email: "ann@x", age: "41" }),
      );
      assert.equal(ann.age, 41);
      assert.ok(ann.inserted_at instanceof Date);
      const missing = changeset(Author.new(), { email: "" });
      assert.deepEqual(
        missing.errors.map((e: { field: string }) => e.field),
        ["email", "age"],
      );
      const taken = await repo.insert(
        changeset(Author.new(), { email: "ann@x", age: 1 }),
      );
      assert.equal(taken.ok, false, "the unique index and constraint");

      if (adapter.name === "postgres") {
        const comment = await link(commentFile);
        const saved = await repo.insertOrThrow(
          comment.changeset(comment.Comment.new({ author_id: ann.id }), {
            body: "hi",
            tags: ["a"],
          }),
        );
        assert.deepEqual(saved.tags, ["a"]);
      }
      assert.equal((await migrator.rollback({ all: true })).length, 2);
    });

    test("a Kysely migration creates the same table", async () => {
      const posts = `gen_kposts_${adapter.name}`;
      const [schemaPath, migrationPath] = await generateSchema(
        {
          name: "KPost",
          table: posts,
          attrs: parseAttrs(["title:unique", "score:float", "meta:map"]),
        },
        {
          schemasFolder: join(dir, "kysely", "schemas"),
          migrationsFolder: join(dir, "kysely", "migrations"),
          migration: "kysely",
          adapter,
        },
      );
      assert.ok(schemaPath && migrationPath);
      const migration = await link(migrationPath);
      await migration.up(db);
      const { KPost, changeset } = await link(schemaPath);
      const post = await repo.insertOrThrow(
        changeset(KPost.new(), { title: "a", score: 1.5, meta: { a: 1 } }),
      );
      assert.deepEqual(
        { score: post.score, meta: post.meta },
        { score: 1.5, meta: { a: 1 } },
      );
      assert.equal(
        (
          await repo.insert(
            changeset(KPost.new(), { title: "a", score: 1, meta: {} }),
          )
        ).ok,
        false,
      );
      await migration.down(db);
    });

    test("JavaScript schemas and migrations work", async () => {
      const posts = `gen_jposts_${adapter.name}`;
      const kposts = `gen_jkposts_${adapter.name}`;
      const attrs = parseAttrs(["title:unique", "score:float"]);
      const [schemaPath, migrationPath] = await generateSchema(
        { name: "JPost", table: posts, attrs },
        {
          schemasFolder: join(dir, "js", "schemas"),
          migrationsFolder: join(dir, "js", "migrations"),
          migration: "ekto",
          language: "js",
        },
      );
      const [kschemaPath, kmigrationPath] = await generateSchema(
        { name: "JKPost", table: kposts, attrs },
        {
          schemasFolder: join(dir, "js", "schemas"),
          migrationsFolder: join(dir, "js", "migrations"),
          migration: "kysely",
          adapter,
          language: "js",
        },
      );
      assert.ok(schemaPath && migrationPath && kschemaPath && kmigrationPath);
      assert.match(schemaPath, /jpost\.js$/);
      assert.match(migrationPath, /_create_gen_jposts_\w+\.js$/);

      const migrator = createMigrator({
        repo,
        migrationSource: `gen_schema_migrations_${adapter.name}`,
        migrations: {
          [`20260103000000_create_${posts}`]: (await link(migrationPath))
            .default,
        },
      });
      await migrator.migrate();
      const kmigration = await link(kmigrationPath);
      await kmigration.up(db);
      for (const path of [schemaPath, kschemaPath]) {
        const module = await link(path);
        const Schema = module.JPost ?? module.JKPost;
        const post = await repo.insertOrThrow(
          module.changeset(Schema.new(), { title: "a", score: "1.5" }),
        );
        assert.equal(post.score, 1.5);
        const taken = await repo.insert(
          module.changeset(Schema.new(), { title: "a", score: 1 }),
        );
        assert.equal(taken.ok, false);
      }
      await kmigration.down(db);
      await migrator.rollback({ all: true });
    });
  });
}

roundTrip("gen.schema on SQLite", () =>
  createRepo({ adapter: sqlite(), database: ":memory:", poolSize: 1 }),
);

describe("gen.schema on Postgres", { skip: skipWithoutPg }, () => {
  if (skipWithoutPg) return;
  roundTrip("pool", () => connectPg());
});

describe("ekto gen.schema", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ekto-gen-cli-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the schema and migration", async () => {
    const lines: string[] = [];
    const args = [
      "gen.schema",
      "Accounts.User",
      "users",
      "email:string:unique",
      "--schemas",
      join(dir, "schemas"),
      "--migrations",
      join(dir, "migrations"),
      "--config",
      join(dir, "none.ts"),
    ];
    await assert.rejects(
      main(args, () => {}),
      /none.ts not found/,
    );
    args.splice(-2);
    assert.equal(await main(args, (l) => lines.push(l)), 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /schemas\/accounts\/user\.ts$/);
    assert.match(lines[1] ?? "", /migrations\/\d{14}_create_users\.ts$/);
    await assert.rejects(
      main(args, () => {}),
      /user\.ts already exists/,
    );
    await assert.rejects(
      main([...args, "--js"], () => {}),
      /user\.ts already exists/,
      "a schema in either language",
    );
    await assert.rejects(
      main(["gen.schema", "User"], () => {}),
      /usage: ekto gen.schema/,
    );
    lines.length = 0;
    await main(
      ["gen.schema", "Person", "people", "--no-migration", "--schemas", dir],
      (l) => lines.push(l),
    );
    assert.deepEqual(lines, [`* creating ${join(dir, "person.ts")}`]);
    lines.length = 0;
    await main(
      [
        "gen.schema",
        "Robot",
        "robots",
        "--js",
        "--schemas",
        dir,
        "--migrations",
        dir,
      ],
      (l) => lines.push(l),
    );
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `* creating ${join(dir, "robot.js")}`);
    assert.match(lines[1] ?? "", /_create_robots\.js$/);
    await assert.rejects(
      main([...args, "--migration", "kysely"], () => {}),
      /Kysely migrations need the adapter/,
    );
  });

  test("binaryId in the configuration sets the primary key type", async () => {
    const folder = join(dir, "binary");
    const config = join(folder, "ekto.config.ts");
    await mkdir(folder);
    const sqliteUrl = JSON.stringify(
      pathToFileURL(join(import.meta.dirname, "../sqlite/index.ts")).href,
    );
    await writeFile(
      config,
      `import { sqlite } from ${sqliteUrl};
export default {
  repo: { adapter: sqlite(), database: ":memory:", poolSize: 1 },
  schemasFolder: ${JSON.stringify(join(folder, "schemas"))},
  migrationsFolder: ${JSON.stringify(join(folder, "migrations"))},
  binaryId: true,
};
`,
    );
    const gen = async (...args: string[]) => {
      const lines: string[] = [];
      await main(["gen.schema", ...args, "--config", config], (l) =>
        lines.push(l),
      );
      const migration = lines.find((l) => l.includes("migrations"));
      assert.ok(migration);
      return readFile(migration.replace("* creating ", ""), "utf8");
    };
    const uuid = /t\.add\("id", "uuid", \{ primaryKey: true \}\);/;
    const source = await gen("Org", "orgs", "owner_id:references:users");
    assert.match(source, uuid);
    assert.match(source, /references\("users", \{ type: "uuid" \}\)/);
    const bigserial = await gen("Tag", "tags", "--no-binary-id");
    assert.match(
      bigserial,
      /t\.add\("id", "bigserial", \{ primaryKey: true \}\);/,
    );
  });

  test("language in the configuration sets the files' language", async () => {
    const folder = join(dir, "language");
    let config = join(folder, "ekto.config.js");
    await mkdir(folder);
    const sqliteUrl = JSON.stringify(
      pathToFileURL(join(import.meta.dirname, "../sqlite/index.ts")).href,
    );
    const write = (language: string) =>
      writeFile(
        config,
        `import { sqlite } from ${sqliteUrl};
export default {
  repo: { adapter: sqlite(), database: ":memory:", poolSize: 1 },
  schemasFolder: ${JSON.stringify(join(folder, "schemas"))},
  migrationsFolder: ${JSON.stringify(join(folder, "migrations"))},
  language: ${JSON.stringify(language)},
};
`,
      );
    await write("js");
    const gen = async (...args: string[]) => {
      const lines: string[] = [];
      await main([...args, "--config", config], (l) => lines.push(l));
      return lines.map((l) => l.replace(/^.*\//, ""));
    };
    const [schema, migration] = await gen("gen.schema", "Org", "orgs");
    assert.equal(schema, "org.js");
    assert.match(migration ?? "", /_create_orgs\.js$/);
    assert.match((await gen("gen.migration", "a"))[0] ?? "", /_a\.js$/);
    assert.match((await gen("gen.migration", "b", "--ts"))[0] ?? "", /_b\.ts$/);
    await assert.rejects(
      gen("gen.migration", "c", "--js", "--ts"),
      /--js or --ts, not both/,
    );
    config = join(folder, "invalid.config.js");
    await write("javascript");
    await assert.rejects(
      gen("gen.migration", "d"),
      /expected the language "ts" or "js" in the configuration, got "javascript"/,
    );
  });
});

function fromDatabase(
  name: string,
  connect: () => Repo,
  ddl: (orgs: string, members: string) => string[],
) {
  describe(name, () => {
    let dir: string;
    const repo = connect();
    const { adapter } = repo;
    const db = repo.kysely;
    const orgs = `gen_db_orgs_${adapter.name}`;
    const members = `gen_db_members_${adapter.name}`;
    const drop = async () => {
      for (const table of [members, orgs])
        await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
    };
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "ekto-gen-db-"));
      await drop();
      for (const statement of ddl(orgs, members))
        await sql.raw(statement).execute(db);
    });
    after(async () => {
      await drop();
      await repo.stop();
      await rm(dir, { recursive: true, force: true });
    });

    test("describes tables", async () => {
      const tables = await adapter.describeTables?.(db);
      const table = tables?.find((t) => t.name === members);
      assert.ok(table);
      assert.deepEqual(
        table.columns.map((c) => [c.name, c.primaryKey, c.nullable]),
        [
          ["id", true, false],
          ["email", false, false],
          ["nickname", false, true],
          ["role", false, false],
          ["org_id", false, true],
          ["inserted_at", false, false],
          ["updated_at", false, false],
        ],
      );
      assert.equal(table.columns[0]?.generated, true);
      assert.deepEqual(table.foreignKeys, [
        { column: "org_id", table: orgs, references: "id" },
      ]);
      assert.deepEqual(table.uniqueIndexes, [
        { column: "email", name: `${members}_email_index` },
      ]);
    });

    test("schemas for the tables work", async () => {
      const folder = join(dir, "schemas");
      const result = await generateSchemas(db, adapter, {
        schemasFolder: folder,
        tables: new Map([
          [orgs, "Org"],
          [members, undefined],
        ]),
      });
      const memberName = schemaName(members);
      assert.deepEqual(result.written, [
        join(folder, "org.ts"),
        join(folder, schemaFile(memberName)),
      ]);
      const source = await readFile(
        join(folder, schemaFile(memberName)),
        "utf8",
      );
      assert.match(source, /id: t\.id\(\),/);
      assert.match(source, /nickname: t\.string\(\{ nullable: true \}\),/);
      assert.match(source, /role: t\.string\(\{ readAfterWrites: true \}\),/);
      assert.match(source, /\.\.\.t\.timestamps\(\),/);
      assert.match(
        source,
        /cast\(\w+, attrs, \["email", "nickname", "role"\]\)/,
      );
      assert.match(source, /validateRequired\(\["email"\]\)/);
      assert.match(source, /uniqueConstraint\("email"\)/);

      const Org = (await link(join(folder, "org.ts"))).Org;
      const Member = await link(join(folder, schemaFile(memberName)));
      const org = await repo.insertOrThrow(Org.new({ name: "acme" }));
      const member = await repo.insertOrThrow(
        Member.changeset(Member[memberName].new({ org_id: org.id }), {
          email: "ann@x",
        }),
      );
      assert.equal(member.role, "member", "read back after insert");
      assert.equal(member.nickname, null);
      const taken = await repo.insert(
        Member.changeset(Member[memberName].new(), { email: "ann@x" }),
      );
      assert.equal(taken.ok, false);

      const again = await generateSchemas(db, adapter, {
        schemasFolder: folder,
        tables: new Map([[orgs, "Org"]]),
      });
      assert.deepEqual(again, {
        written: [],
        skipped: [join(folder, "org.ts")],
      });
      await assert.rejects(
        generateSchemas(db, adapter, {
          schemasFolder: folder,
          tables: new Map([["nope", undefined]]),
        }),
        /no table nope/,
      );
    });
  });
}

fromDatabase(
  "gen.schemas on SQLite",
  () => createRepo({ adapter: sqlite(), database: ":memory:", poolSize: 1 }),
  (orgs, members) => [
    `CREATE TABLE ${orgs} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
    `CREATE TABLE ${members} (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, nickname TEXT, role TEXT NOT NULL DEFAULT 'member', org_id INTEGER REFERENCES ${orgs}(id), inserted_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX ${members}_email_index ON ${members} (email)`,
  ],
);

describe("gen.schemas on Postgres", { skip: skipWithoutPg }, () => {
  if (skipWithoutPg) return;
  fromDatabase(
    "pool",
    () => connectPg(),
    (orgs, members) => [
      `CREATE TABLE ${orgs} (id bigserial PRIMARY KEY, name varchar(255) NOT NULL)`,
      `CREATE TABLE ${members} (id bigserial PRIMARY KEY, email varchar(255) NOT NULL, nickname text, role text NOT NULL DEFAULT 'member', org_id bigint REFERENCES ${orgs}(id), inserted_at timestamp(0) NOT NULL, updated_at timestamp(0) NOT NULL)`,
      `CREATE UNIQUE INDEX ${members}_email_index ON ${members} (email)`,
    ],
  );
});

test("schemaName", () => {
  assert.equal(schemaName("users"), "User");
  assert.equal(schemaName("blog_posts"), "BlogPost");
  assert.equal(schemaName("categories"), "Category");
  assert.equal(schemaName("addresses"), "Address");
  assert.equal(schemaName("boxes"), "Box");
  assert.equal(schemaName("status"), "Status");
});
