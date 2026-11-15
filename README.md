# ekto

An Ecto-inspired data layer for TypeScript. Inspired by Elixir's [Ecto](https://hexdocs.pm/ecto);
not affiliated with it.

ekto is split into four pieces, as Ecto is:

- **Repo**: the only part of your code that touches the database. Inserts, updates, deletes,
  reads, transactions and preloads all go through it.
- **Schema**: maps a table to plain records with typed fields.
- **Changeset**: filters, casts and validates input before it is written, and turns database
  constraint violations into field errors.
- **Query**: queries are [Kysely](https://kysely.dev) query builders (or ekto's `sql` tag),
  composed as ordinary functions and run by the Repo, which loads the rows into records.

Around them: associations and preloads, `Multi` for operations that run together in one
transaction, migrations with an `ekto` command, and a test sandbox that rolls back every test.

**Status:** early development. The API may still change, and the package is not on npm yet.

## Guides

Guides that follow Ecto's own, in `guides/` and in the API docs (`pnpm docs:build`):

- [Getting Started](guides/introduction/getting-started.md)
- How-To's: [Aggregates and subqueries](guides/howtos/aggregates-and-subqueries.md),
  [Constraints and upserts](guides/howtos/constraints-and-upserts.md),
  [Data mapping and validation](guides/howtos/data-mapping-and-validation.md),
  [Dynamic queries](guides/howtos/dynamic-queries.md),
  [Self-referencing many to many](guides/howtos/self-referencing-many-to-many.md),
  [Test factories](guides/howtos/test-factories.md)
- [Testing with ekto](guides/testing/testing-with-ekto.md)
- Migration Guides (after ecto_sql's):
  [Anatomy of a migration](guides/migrations/anatomy-of-a-migration.md),
  [Safe migrations](guides/migrations/safe-migrations.md),
  [Backfilling data](guides/migrations/backfilling-data.md),
  [Squashing migrations](guides/migrations/squashing-migrations.md)

## Features

- Schemas as plain objects with typed fields, defaults, virtual and redacted fields, timestamps
  and generated keys; record types are inferred (`Infer<typeof User>`).
- Kysely table types derived from schemas (`KyselyDB<[typeof User, typeof Post]>`).
- Changesets: `cast`, `validateRequired`, `validateLength`, `validateNumber`, `validateFormat`,
  `validateInclusion` and the rest of Ecto's validations, plus `validateWith` for Standard Schema
  validators (Zod, Valibot, ArkType). Schemaless changesets for forms that are not tables.
- Unique, foreign key, check and exclusion constraints reported as changeset errors.
- Writes return `{ ok: true, value }` or `{ ok: false, changeset }`; each has an `…OrThrow`
  variant.
- Optimistic locking, upserts (`onConflict`), `insertAll`, `updateAll`, `deleteAll`, aggregates.
- `belongsTo`, `hasMany`, `hasOne` and `manyToMany` associations, preloaded with one query per
  association; no lazy loading.
- Transactions with `Repo.transact`, and `Multi` for named steps that see each other's results.
- Migrations with a reversible `change`, a `schema_migrations` table and a migration lock; the
  `ekto` command migrates, rolls back, reports status and generates migrations and schemas.
- A test sandbox (`ekto/testing`) that runs each test in a transaction that is rolled back.
- PostgreSQL (node-postgres) and SQLite (node-sqlite3), with a connection pool owned by the
  Repo.

## Install

ekto runs on Node 22.19 or later, and needs `kysely` and the driver of your database.

```bash
# PostgreSQL
pnpm add ekto kysely pg

# SQLite
pnpm add ekto kysely sqlite3
```

`pg` and `sqlite3` are optional peer dependencies: install the one you use. `sqlite3` builds a
native addon; pnpm asks you to approve its build (`pnpm approve-builds`). SQLite can also use
Node's built-in `node:sqlite`, which needs no package (see [SQLite](#sqlite)).

## Quickstart

Define a schema and a changeset function:

```ts
// src/schemas/user.ts
import {
  type Changeset,
  cast,
  type Infer,
  type New,
  pipe,
  schema,
  t,
  uniqueConstraint,
  validateFormat,
  validateRequired,
} from "ekto";

export const User = schema("users", {
  id: t.id(),
  email: t.string(),
  name: t.string().nullable(),
  ...t.timestamps(),
});
export type User = Infer<typeof User>;

export function changeset<D extends User | New<typeof User>>(
  user: D | Changeset<D>,
  attrs: unknown,
): Changeset<D> {
  return pipe(
    cast(user, attrs, ["email", "name"]),
    validateRequired(["email"]),
    validateFormat("email", /@/),
    uniqueConstraint("email"),
  );
}
```

Create a Repo:

```ts
// src/repo.ts
import { createRepo } from "ekto";
import { type KyselyDB, postgres } from "ekto/postgres";
import { User } from "./schemas/user.ts";

export type DB = KyselyDB<[typeof User]>;

export const repo = createRepo<DB>({
  adapter: postgres(),
  url: process.env.DATABASE_URL,
  poolSize: 10,
});
```

Insert a record and read it back:

```ts
import { traverseErrors } from "ekto";
import { repo } from "./repo.ts";
import { changeset, User } from "./schemas/user.ts";

const result = await repo.insert(
  changeset(User.new(), { email: "ann@example.com", name: "Ann" }),
);

if (result.ok) {
  console.log(result.value.id); // the generated id
} else {
  console.log(traverseErrors(result.changeset)); // { email: ["has already been taken"] }
}

const ann = await repo.getBy(User, { email: "ann@example.com" });
const all = await repo.all(User);

await repo.stop();
```

The `users` table comes from a migration; see [Migrations](#migrations).

## Repo

A Repo is created with `createRepo<DB>(config)` and owns its connection pool. Connections open as
they are needed; `repo.stop()` closes them.

```ts
const user = await repo.get(User, 1); // or null
const same = await repo.getOrThrow(User, 1); // throws NoResultsError
const byEmail = await repo.getBy(User, { email: "ann@example.com" });
const users = await repo.all(User);
const hasUsers = await repo.exists(User);
const count = await repo.aggregate(User, "count");
```

Writes take a changeset (or a record) and return a result instead of throwing on invalid input:

```ts
const updated = await repo.update(changeset(user, { name: "Ann B." }));
if (!updated.ok) console.log(updated.changeset.errors);

const deleted = await repo.delete(user);

// The …OrThrow variants throw InvalidChangesetError instead.
const created = await repo.insertOrThrow(changeset(User.new(), params));
```

Unexpected failures, such as a stale entry, a constraint the changeset did not declare
(`ConstraintError`) or a lost connection, are thrown.

Bulk writes skip changesets: values are dumped through the field types, but not validated, and
nothing is generated (no timestamps).

```ts
const now = new Date();
await repo.insertAll(
  User,
  [
    { email: "a@example.com", inserted_at: now, updated_at: now },
    { email: "b@example.com", inserted_at: now, updated_at: now },
  ],
  { onConflict: "nothing" },
);
await repo.updateAll(User, { set: { name: null } }, (q) =>
  q.where("id", ">", 100),
);
await repo.deleteAll(User, (q) => q.where("email", "like", "%@spam.example"));
```

Upserts use `onConflict` (`"raise"`, `"nothing"`, `"replaceAll"`, `{ replace: [...] }` or
`{ replaceAllExcept: [...] }`) with `conflictTarget`, on `insert` and `insertAll`.

## Schemas

`schema(table, fields)` defines a schema. Field names are the column names; there is no renaming
or case conversion. Records are plain objects: `User.new()` builds one, and the Repo loads them.

```ts
import { schema, t, type Infer } from "ekto";

export const Post = schema("posts", {
  id: t.id(), // integer primary key generated by the database
  title: t.string(),
  body: t.string().nullable(),
  status: t.enum(["draft", "published"]).default("draft"),
  tags: t.array(t.string().type).default([]),
  views: t.integer().readAfterWrites(), // a database default, read back after writes
  author_id: t.integer(),
  ...t.timestamps(), // inserted_at and updated_at
});
export type Post = Infer<typeof Post>;
```

The field builders are `t.id`, `integer`, `float`, `decimal`, `boolean`, `string`, `binary`,
`map`, `uuid`, `date`, `time`, `utcDatetime`, `utcDatetimeMsec`, `any`, `array`, `enum`,
`custom` and `timestamps`. Each field can be made `.nullable()`, `.default(value)`, `.virtual()`,
`.redact()`, `.primaryKey()`, `.autogenerate()` or `.readAfterWrites()`. A UUID primary key is
`t.uuid().primaryKey().autogenerate()`.

`KyselyDB` from `ekto/postgres` or `ekto/sqlite` derives the Kysely database type from schemas,
typed with what the driver returns:

```ts
type DB = KyselyDB<[typeof User, typeof Post]>;
```

### Associations

A schema with associations is a class extending `schema(...)`, so that schemas can refer to each
other:

```ts
import { belongsTo, hasMany, schema, t } from "ekto";

export class User extends schema("users", { id: t.id(), email: t.string() }) {
  static associations = {
    posts: hasMany(() => Post, { foreignKey: "author_id" }),
  };
}

export class Post extends schema("posts", {
  id: t.id(),
  title: t.string(),
  author_id: t.integer(),
}) {
  static associations = {
    author: belongsTo(() => User), // foreign key author_id
  };
}
```

Unlike Ecto, `belongsTo` does not define the foreign key field: declare it with the other fields.
`manyToMany(() => Tag, { joinThrough: "posts_tags", joinKeys: { post_id: "id", tag_id: "id" } })`
goes through a join table. `buildAssoc(user, "posts", { title: "Hi" })` builds a post with
`author_id` set.

## Changesets

A changeset holds the changes to a record, the errors found so far and the constraints to check
when it is written. Every function returns a new changeset. Called with a changeset first, a
function applies directly; called without, it returns a step for `pipe`:

```ts
import {
  cast,
  pipe,
  validateInclusion,
  validateLength,
  validateNumber,
  validateRequired,
} from "ekto";

const cs = pipe(
  cast(Post.new(), params, ["title", "body", "status", "author_id"]),
  validateRequired(["title", "author_id"]),
  validateLength("title", { min: 3, max: 120 }),
  validateInclusion("status", ["draft", "published"]),
);

cs.valid; // false when there are errors
cs.changes; // { title: "Hello", ... }
cs.errors; // [{ field, message, meta }], newest first

const same = validateNumber(cs, "author_id", { greaterThan: 0 });
```

`cast` keeps only the permitted fields and casts each value to the field's type; a value that
cannot be cast gets an `"is invalid"` error. `change(record, changes)` builds a changeset from
trusted data without casting.

Errors keep Ecto's shape: an uninterpolated message and its metadata. `traverseErrors` turns
them into messages per field:

```ts
traverseErrors(cs);
// { title: ["should be at least 3 character(s)"], author_id: ["can't be blank"] }
```

Other validations: `validateFormat`, `validateExclusion`, `validateSubset`,
`validateConfirmation`, `validateAcceptance`, `validateChange` (a custom validator) and
`validateWith` (any synchronous Standard Schema validator). `schemaless(types, data)` makes a
changeset over plain data, such as a search form.

### Constraints

Validations run in memory. Constraints are checked by the database, and the changeset says how
to report them:

```ts
const cs = pipe(
  cast(Post.new(), params, ["title", "author_id"]),
  uniqueConstraint("title"), // index posts_title_index
  foreignKeyConstraint("author_id"), // constraint posts_author_id_fkey
  checkConstraint("views", { name: "views_must_be_positive" }),
);

const result = await repo.insert(cs);
if (!result.ok) traverseErrors(result.changeset); // { author_id: ["does not exist"] }
```

Unique and foreign key constraint names follow Ecto's conventions; pass `name` when yours differ.
Check constraints always need a `name`. SQLite reports unique violations by column, which ekto
maps to the conventional index name, and foreign key violations without a name, so on SQLite
those are always thrown. A violation the
changeset does not declare is thrown as `ConstraintError`.

`optimisticLock(user, "lock_version")` makes updates and deletes match only while the version is
unchanged, and throws `StaleEntryError` otherwise. `prepareChanges(cs, fn)` runs `fn` inside the
write's transaction, with `changeset.repo` set.

## Queries

ekto has no query language of its own. Queries are Kysely builders on `repo.kysely`, which is
typed with your `DB`. Pass one to the Repo with a schema and the rows are loaded as records:

```ts
const query = repo.kysely
  .selectFrom("posts")
  .selectAll()
  .where("status", "=", "published")
  .orderBy("inserted_at", "desc")
  .limit(10);

const posts = await repo.all(Post, query); // Post[]
const first = await repo.one(Post, query.limit(1)); // Post | null
```

A schema query must select every persisted column of the schema (a type error, and
`SchemaMismatchError` at runtime). Without a schema, rows are returned as the driver gives them.

Queries compose as functions, which Kysely's `$call` applies:

```ts
import type { SelectQueryBuilder } from "kysely";

const published = <O>(q: SelectQueryBuilder<DB, "posts", O>) =>
  q.where("status", "=", "published");
const byAuthor =
  (authorId: number) =>
  <O>(q: SelectQueryBuilder<DB, "posts", O>) =>
    q.where("author_id", "=", authorId);

const mine = await repo.all(
  Post,
  repo.kysely
    .selectFrom("posts")
    .selectAll()
    .$call(published)
    .$call(byAuthor(user.id)),
);
```

ekto's `sql` tag binds every interpolated value as a parameter and works on both databases:

```ts
import { sql } from "ekto";

const rows = await repo.all(
  sql`SELECT * FROM users WHERE lower(email) = ${email}`,
);
const users = await repo.all(
  User,
  sql`SELECT * FROM users WHERE lower(email) = ${email}`,
);
```

`repo.query(q)` returns rows and a row count, and `repo.exec(q)` runs a write such as a Kysely
`deleteFrom`, bypassing changesets. `repo.all` and `repo.query` reject writes.

## Preloads

Associations are loaded explicitly with `repo.preload`, one query per association:

```ts
const user = await repo.preload(await repo.getOrThrow(User, 1), "posts");
user.posts; // Post[]

const posts = await repo.preload(await repo.all(Post), { author: true });
posts[0]?.author; // User

const users = await repo.preload(await repo.all(User), {
  posts: [(q) => q.orderBy("id", "desc"), "author"], // refined, then nested
});
```

A preload spec is an association name, an array of specs, or an object whose values are `true`,
a nested spec, a function refining the query, or `[refine, nested]`. Associations already loaded
are kept unless `{ force: true }` is passed. `repo.assoc(user, "posts")` returns the query of
the associated records, to refine and run with `repo.all(Post, ...)`.

## Transactions and Multi

`repo.transact(fn)` runs `fn` with `tx`, a Repo bound to the transaction. Return
`{ ok: true, ... }` to commit and `{ ok: false, ... }` to roll back; either is returned. A thrown
error rolls back and is rethrown. Nested calls use savepoints.

```ts
const result = await repo.transact(async (tx) => {
  const user = await tx.insert(changeset(User.new(), params));
  if (!user.ok) return user;
  const post = await tx.insert(
    buildAssoc(user.value, "posts", { title: "Hello" }),
  );
  return post.ok
    ? { ok: true, value: { user: user.value, post: post.value } }
    : post;
});
```

A `Multi` describes named operations as data; nothing runs until `repo.transact(multi)`. Later
steps receive the results of earlier ones, and the first failure rolls everything back:

```ts
import { Multi } from "ekto";

const multi = Multi.new<DB>()
  .insert("user", changeset(User.new(), params))
  .insert("post", ({ user }) => buildAssoc(user, "posts", { title: "Hello" }))
  .run("welcome", async (tx, { user }) => {
    await sendWelcome(user);
    return { ok: true, value: null };
  });

const result = await repo.transact(multi);
if (result.ok) {
  result.value.user;
} else {
  result.step; // "user", "post" or "welcome"
  result.error; // the invalid changeset, or what run returned
  result.changesSoFar; // results of the earlier steps, rolled back
}
```

A Multi also has `update`, `delete`, `insertOrUpdate`, `insertAll`, `updateAll`, `deleteAll`,
`all`, `one`, `exists`, `put`, `error`, `merge`, `append` and `prepend`.

## Migrations

Migrations live in `migrations/`, named `<version>_<name>.ts`, and default-export a
`migration()` from `ekto/migrate`:

```ts
// migrations/20260115103000_create_users.ts
import { migration, references, table, uniqueIndex } from "ekto/migrate";

export default migration({
  change(m) {
    m.create(table("users"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("email", "string", { null: false });
      t.add("name", "string");
      t.timestamps();
    });
    m.create(uniqueIndex("users", ["email"]));

    m.create(table("posts"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("title", "string", { null: false });
      t.add("author_id", references("users", { onDelete: "deleteAll" }), {
        null: false,
      });
      t.timestamps();
    });
  },
});
```

Unlike Ecto, `create(table(...))` adds no `id` column: declare the primary key like any other
column, as schemas do. Commands in `change` are reversed on rollback; write `up` and `down` for
those that cannot be. `m.alter`, `m.drop`, `m.rename`, `index`, `constraint`, `fragment` and
`m.execute` (SQL, or a function given the transaction's Kysely) cover the rest. Each migration
runs in a transaction unless it sets `disableDdlTransaction: true`. The
[migration guides](guides/migrations/anatomy-of-a-migration.md) cover what runs and how to change
a busy database safely.

### The `ekto` command

The command reads `ekto.config.ts` (or `.js`) in the working directory:

```ts
// ekto.config.ts
import { postgres } from "ekto/postgres";

export default {
  repo: { adapter: postgres(), url: process.env.DATABASE_URL },
  migrationsFolder: "migrations",
};
```

```bash
ekto migrate                  # run pending migrations (--step N, --to VERSION, --all)
ekto rollback                 # roll back the last migration (--step N, --to VERSION, --all)
ekto status                   # list migrations and whether they ran
ekto gen.migration add_posts  # create migrations/<timestamp>_add_posts.ts
ekto gen.schema Post posts title body:text author_id:references:users
                              # create a schema with a changeset, and its migration
ekto gen.schemas              # write schemas for the tables of an existing database
```

`migrate`, `rollback` and `status` start the Repo with a pool of 2 (`--pool-size N`). On
PostgreSQL the migration lock holds one connection while another runs the migration, so a pool of
one fails, as in Ecto. Other options: `--config`, `--migrations`, `--no-lock`, and for
`gen.schema` `--binary-id` (UUID keys, or `binaryId: true` in the config) and
`--migration ekto|kysely|none`. `ekto --help` lists them all.

Migrations can also run from code:

```ts
import { createMigrator, fileMigrations } from "ekto/migrate";

const migrator = createMigrator({
  repo,
  migrations: fileMigrations("migrations"),
});
await migrator.migrate();
await migrator.rollback({ step: 1 });
```

## Testing

`ekto/testing` runs each test in a transaction that is rolled back when the test ends, like
Ecto's SQL sandbox. While the sandbox is active, your application's Repo runs on it, so the code
under test needs no changes.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sandbox } from "ekto/testing";
import { repo } from "../src/repo.ts";

sandbox(repo); // every test in this file gets its own rolled-back transaction

test("creates a user", async () => {
  await createUser({ email: "ann@example.com" }); // uses repo
  assert.equal((await repo.all(User)).length, 1);
});
```

`sandbox` registers `node:test`'s `beforeEach` and `afterEach`; pass `{ beforeEach, afterEach }`
to use another runner. Tests in such a file must run one at a time. For concurrent tests, wrap
each in `withSandbox(repo, async () => { ... })`, which gives the sandbox only to that test's
async context. `checkout(repo)` returns a sandboxed Repo and `checkin()` for manual control.

## Configuration

### PostgreSQL

```ts
import { postgres } from "ekto/postgres";

const repo = createRepo<DB>({
  adapter: postgres(),
  url: "postgres://user:pass@localhost/app_dev",
  // or hostname, port, database, username, password, socketDir, ssl
  poolSize: 10,
});
```

### SQLite

```ts
import { sqlite } from "ekto/sqlite";

const repo = createRepo<DB>({
  adapter: sqlite(),
  database: "app.db", // or ":memory:", with poolSize: 1
  journalMode: "wal", // the default
  busyTimeout: 2000, // ms, the default
  foreignKeys: true, // the default
});
```

The SQLite pool has five connections by default, as ecto_sqlite3's. node-sqlite3 runs queries on
libuv's thread pool, so a connection waiting up to `busyTimeout` for another's write lock does
not block the event loop. A `":memory:"` database must use a pool of one, as each connection
would open its own.

Adding and dropping check constraints in a migration needs SQLite 3.53, as ecto_sqlite3 says;
`sqlite3` 6.0.1 bundles 3.52, which adds them but cannot drop them.

`sqlite({ driver: "node:sqlite" })` connects with Node's built-in `node:sqlite` instead, so
nothing needs installing or building (Node prints that it is experimental). It runs each query on
the event loop's thread: a long query, or a wait of up to `busyTimeout` for a write lock another
process holds, stops everything else in the process meanwhile. Its pool has one connection by
default, as with more, a connection waiting for another's lock would hold the thread the other
needs to commit.

```ts
const repo = createRepo<DB>({
  adapter: sqlite({ driver: "node:sqlite" }),
  database: "app.db",
});
```

### Pool and other options

| Option          | Default                     | Meaning                                                                |
| --------------- | --------------------------- | ---------------------------------------------------------------------- |
| `poolSize`      | 10 (PostgreSQL), 5 (SQLite) | Connections the Repo keeps.                                            |
| `queueTarget`   | 50                          | How long a query should wait for a connection, in ms.                  |
| `queueInterval` | 2000                        | The window `queueTarget` is checked in, in ms.                         |
| `idleInterval`  | 1000                        | How often idle connections are pinged, in ms.                          |
| `idleLimit`     | `poolSize`                  | How many idle connections are pinged per interval.                     |
| `maxLifetime`   | none                        | `[min, max]` ms after which a connection is closed and replaced.       |
| `plugins`       |                             | Kysely plugins for `repo.kysely`.                                      |
| `onQuery`       |                             | Called after every query with its SQL, params, duration and any error. |

As in Ecto's DBConnection, when every checkout in a `queueInterval` waits longer than
`queueTarget`, requests waiting more than twice `queueTarget` fail with a `ConnectionError`
instead of queueing on. `repo.config` returns the configuration with its defaults.

## Coming from Ecto

Most names map directly (`Repo.insert` is `repo.insert`, `{:ok, user}` is `{ ok: true, value }`,
`insert!` is `insertOrThrow`). Where ekto differs:

- Queries are Kysely builders, not `Ecto.Query`.
- Migrations declare the primary key explicitly; `create(table(...))` adds no `id`.
- `belongsTo` does not define the foreign key field.
- Field names are column names; there is no `:source` renaming and no schema prefixes yet.
- The sandbox is tied to a test or an async context instead of a process.

## Development

Needs Node 26 (22.19+ works) and pnpm 12. Notes for coding agents are in [AGENTS.md](AGENTS.md).

```bash
pnpm install
pnpm check                          # lint, typecheck, tests, build, API docs
pnpm test                           # node --test over src/**/*.test.ts
EKTO_PG_URL=postgres://… pnpm test  # also run the Repo tests against Postgres
pnpm format                         # Biome: fix formatting and lint
pnpm docs:build                     # API docs and guides with TypeDoc, in docs/api
```
