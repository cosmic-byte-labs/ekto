---

title: Anatomy of a migration
group: Migration Guides
---

# Anatomy of a migration

Migrations, from `ekto/migrate`, are used to do the following:

- Change the structure of the database, such as adding fields, tables, or indexes to improve
  lookups (DDL).
- Populating fields with modified data or new data (DML).

In order for us to create and run safe migrations on our database, it is helpful to understand
what is actually happening with the database. To do that, we'll dig deeper into how ekto
migrations work by looking both at the code being executed and the Postgres logs. This guide
follows ecto_sql's [Anatomy of a Migration](https://hexdocs.pm/ecto_sql/migration_anatomy.html).

To generate a migration, we'll run the `ekto` command:

```bash
pnpm ekto gen.migration create_weather_table
```

> [!TIP]
> `pnpm ekto gen.schema` generates a migration too, together with a schema, and allows you to pass
> in fields and types. See `pnpm ekto --help` for more information.

This command will generate a file in `migrations/`, or in the `migrationsFolder` of
`ekto.config.ts`.

Let's look at that file:

```ts
import { migration } from "ekto/migrate";

export default migration({
  change(m) {},
});
```

Let's make some changes; how about we create a table that tracks a city's climate?

```ts
import { migration, table } from "ekto/migrate";

export default migration({
  change(m) {
    m.create(table("weather"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("city", "string", { size: 40 });
      t.add("temp_lo", "integer");
      t.add("temp_hi", "integer");
      t.add("prcp", "float");
      t.timestamps();
    });
  },
});
```

Unlike Ecto, `table` adds no `id` column, so we declare the primary key ourselves.

Now that we have a migration, let's run it! Run `pnpm ekto migrate`:

```bash
$ pnpm ekto migrate
== Migrated 20210702012346 create_weather_table
```

## Inspect SQL

Understanding exactly what SQL commands are running is helpful to ensure safe migrations, so how
do we see the SQL that is executed? ekto does not log the SQL that migrations run, so we'll ask
Postgres to log every statement it receives, for our development database only:

```sql
ALTER DATABASE my_app_dev SET log_statement = 'all';
```

The setting applies to new connections. First, I'll roll back, and then re-migrate while tailing the
PostgreSQL server logs:

```bash
$ pnpm ekto rollback
== Rolled back 20210702012346 create_weather_table
$ pnpm ekto migrate
== Migrated 20210702012346 create_weather_table
```

```
CREATE TABLE IF NOT EXISTS "schema_migrations" ("version" bigint, "inserted_at" timestamp(0), PRIMARY KEY ("version"))
SELECT version FROM "schema_migrations"
begin
LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE
SELECT version FROM "schema_migrations"
begin
CREATE TABLE "weather" ("id" bigserial, "city" varchar(40), "temp_lo" integer, "temp_hi" integer, "prcp" float, "inserted_at" timestamp(0) NOT NULL, "updated_at" timestamp(0) NOT NULL, PRIMARY KEY ("id"))
INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2)
commit
commit
```

The migrator first creates the `schema_migrations` table, if it doesn't exist yet, and reads the
versions that already ran. Then, inside a transaction, it obtains a `SHARE UPDATE EXCLUSIVE` lock
of the `schema_migrations` table, and reads the versions again.

**Why this lock is important**: Systems at scale may have multiple instances of the application
connected to the same database, and during a deployment all of the instances rolling out may try
to migrate that database at the same time. ekto leverages this `SHARE UPDATE EXCLUSIVE` lock, as
Ecto does, as a way to ensure that only one instance is running a migration at a time and only
once.

This is what the migration actually looks like:

```sql
BEGIN;
LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE;
BEGIN;
CREATE TABLE "weather" ("id" bigserial, "city" varchar(40), "temp_lo" integer, "temp_hi" integer, "prcp" float, "inserted_at" timestamp(0) NOT NULL, "updated_at" timestamp(0) NOT NULL, PRIMARY KEY ("id"));
INSERT INTO "schema_migrations" (version, inserted_at) VALUES ('20210702012346', '2021-07-02 01:23:46');
COMMIT;
COMMIT;
```

The two transactions run on two connections: the lock's transaction holds one while the migration
runs on another. That is why the `ekto` command starts the Repo with a pool of two connections.

When a migration fails, the transaction is rolled back and no changes are kept in the database. In
most situations, these are great defaults.

Veteran database administrators may notice the database transactions (`BEGIN`/`COMMIT`) and wonder
how to turn those off in situations where transactions could cause problems, such as when adding
indexes concurrently. ekto provides some options that can help with transactions and locks. Let's
explore some of those options next.

## Migration options

A typical migration has this structure (reminder: this guide is using Postgres; SQLite will vary):

```sql
BEGIN;
  LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE;
  BEGIN;
    -- my_changes
    INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
  COMMIT;
COMMIT;
```

_`my_changes` refers to the changes you specify in each of your migrations._

### `disableMigrationLock`

By default, ekto acquires a lock on the `schema_migrations` table during the migration
transaction:

```sql
BEGIN;
  -- THIS LOCK
  LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE
  BEGIN;
    -- my_changes
    INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
  COMMIT;
COMMIT;
```

You want this lock for most migrations because running multiple migrations simultaneously without
this lock could have unpredictable results. In database transactions, any locks obtained inside
the transaction are released when the transaction is committed, which then unblocks other
transactions that touch the same records to proceed.

However, there are some scenarios where you don't want a lock. We'll explore these scenarios later
on (for example, backfilling data). Creating indexes concurrently is not one of them: the lock's
transaction runs nothing but `LOCK TABLE`, so it holds no snapshot for `CONCURRENTLY` to wait for.

You can skip this lock by setting `disableMigrationLock: true` in your migration. (`--no-lock` on
the command, or `migrationLock: false` in `ekto.config.ts`, skips it for every migration.) When
the migration lock is disabled, the migration looks like this:

```sql
BEGIN;
  -- my changes
  INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
COMMIT;
```

### `disableDdlTransaction`

By default, ekto wraps your changes in a transaction:

```sql
BEGIN;
  LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE
  -- THIS TRANSACTION
  BEGIN;
    -- my changes
    INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
  COMMIT;
  -- THIS TRANSACTION
COMMIT;
```

This ensures that when failures occur during a migration, your database is not left in an
incomplete or mangled state.

There are scenarios where you don't want a migration to run inside a transaction. Like when
performing data migrations or when running commands such as `CREATE INDEX CONCURRENTLY` that can
run in the background in the database after you issue the command and cannot be inside a
transaction.

You can disable this transaction by setting `disableDdlTransaction: true` in your migration:

```ts
export default migration({
  disableDdlTransaction: true,
  change(m) {
    // ...
  },
});
```

The migration then looks like this:

```sql
BEGIN;
  LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE
  -- my_changes
  INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
COMMIT;
```

> [!TIP]
> Ecto's guide has you also disable the migration lock for Postgres here, since that lock's
> transaction holds a snapshot that `CONCURRENTLY` waits for. ekto's lock transaction runs nothing
> but `LOCK TABLE` and holds no snapshot, so you can keep the lock, and with it the protection
> against multiple nodes running the same migration at the same exact time.

Disabling both the migration lock and the DDL transaction, your migration will be pretty simple:

```sql
-- my_changes
INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
```

### Running code in the transaction

Ecto migrations can define `after_begin` and `before_commit` callbacks, which run first and last
in the migration's transaction. ekto has no such callbacks, but it does not need them for this:
the commands of a migration run in the order they are given, inside its transaction, so a command
given first runs right after `BEGIN`:

```sql
BEGIN;
  -- the first command
  -- my_changes
  INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
COMMIT;
```

A good use case for this is setting migration lock timeouts as safeguards (see the later Safeguards
section). In `change`, mind that rolling back runs the commands in reverse order, so a command
meant to run first on rollback goes last.

> [!WARNING]
> Be aware that with `disableDdlTransaction: true` there is no transaction for these commands to
> run first in.

## Safeguards in the database

It's a good idea to add safeguards so no developer on the team accidentally locks up the database
for too long. Even if you know all about databases and locks, you might have a forgetful day and
try to add an index non-concurrently and bring down production. Safeguards are good.

We can add one or more safeguards:

1. Automatically cancel a statement if the lock is held for too long. There are two ways to do
   this:
   1. Apply to migrations. This can be done with a `lock_timeout` inside a transaction.
   2. Apply to any statements. This can be done by setting a `lock_timeout` on a Postgres role.
2. Automatically cancel statements that take too long. This is broader than #1 because it includes
   any statement, not just locks.

Let's dive into these safeguards.

### Add a `lock_timeout`

One safeguard we can add to migrations is a lock timeout. A lock timeout ensures a lock will not
last more than n seconds. This way, when an unsafe migration sneaks in, it only locks tables to
updates and writes (and possibly reads) for n seconds instead of indefinitely when the migration
finishes.

From the Postgres docs:

> Abort any statement that waits longer than the specified amount of time while attempting to
> acquire a lock on a table, index, row, or other database object. The time limit applies
> separately to each lock acquisition attempt. The limit applies both to explicit locking requests
> (such as LOCK TABLE, or SELECT FOR UPDATE without NOWAIT) and to implicitly-acquired locks. If
> this value is specified without units, it is taken as milliseconds. A value of zero (the
> default) disables the timeout.
>
> Unlike `statement_timeout`, this timeout can only occur while waiting for locks. Note that if
> `statement_timeout` is nonzero, it is rather pointless to set lock_timeout to the same or larger
> value, since the statement timeout would always trigger first. If `log_min_error_statement` is
> set to `ERROR` or lower, the statement that timed out will be logged.

There are two ways to apply this lock:

1. localized to the transaction
2. default for the user/role

Let's go through those options:

#### Transaction `lock_timeout`

In SQL:

```sql
SET LOCAL lock_timeout TO '5s';
```

Let's move that to the start of the migration's transaction. Since this `lock_timeout` will be in
a database transaction for Postgres, we will use `SET LOCAL lock_timeout` so that the
`lock_timeout` only alters this database transaction and not the session.

You can set a lock timeout in every migration, as its first command:

```ts
export default migration({
  up(m) {
    m.execute("SET LOCAL lock_timeout TO '5s'");
    // ... my changes
  },
  down(m) {
    // You might give yourself a couple extra seconds when rolling back.
    m.execute("SET LOCAL lock_timeout TO '10s'");
    // ... undo my changes
  },
});
```

But this can get tedious since you'll likely want this for every migration. Let's write a little
function to help with this boilerplate code.

Every migration default-exports `migration(...)`, from `ekto/migrate`. Let's use this same idea
with a function of our own that wraps it and takes an option to set a lock timeout, running it
before the migration's commands. Let's create it at `src/migration.ts`:

```ts
import {
  type MigrationContext,
  type MigrationDefinition,
  migration,
} from "ekto/migrate";

type LockTimeout = { up: string; down: string } | false;

export function appMigration(
  definition: MigrationDefinition,
  {
    lockTimeout = { up: "5s", down: "10s" },
  }: { lockTimeout?: LockTimeout } = {},
) {
  if (lockTimeout === false || definition.disableDdlTransaction)
    return migration(definition);
  const setLockTimeout = (m: MigrationContext) => {
    const sql = `SET LOCAL lock_timeout TO '${lockTimeout[m.direction]}'`;
    m.execute(sql, sql);
  };
  if ("change" in definition) {
    const { change } = definition;
    return migration({
      ...definition,
      change(m) {
        // Rolling back runs the commands of change reversed, so the timeout
        // is recorded last to run first.
        if (m.direction === "up") setLockTimeout(m);
        change(m);
        if (m.direction === "down") setLockTimeout(m);
      },
    });
  }
  const { up, down } = definition;
  return migration({
    ...definition,
    up(m) {
      setLockTimeout(m);
      up(m);
    },
    down:
      down &&
      ((m) => {
        setLockTimeout(m);
        down(m);
      }),
  });
}
```

And adjust our migration:

```diff
-import { migration, table } from "ekto/migrate";
+import { table } from "ekto/migrate";
+import { appMigration } from "../src/migration.ts";

-export default migration({
+export default appMigration({
   change(m) {
     // my changes
   },
 });
```

Now the migrations will only be allowed to acquire locks up to 5 seconds when migrating up and 10
seconds when rolling back:

```sql
BEGIN;
  LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE
  BEGIN;
    SET LOCAL lock_timeout TO '5s';
    -- my_changes
    INSERT INTO "schema_migrations" (version, inserted_at) VALUES ($1, $2);
  COMMIT;
COMMIT;
```

Remember, there is no transaction to set it in when `disableDdlTransaction: true` is set, so
`appMigration` leaves those migrations as they are.

You can override the lock timeout if needed by passing in options:

```ts
// disable the lock_timeout
export default appMigration({ change(m) {} }, { lockTimeout: false });

// or change the timeouts
export default appMigration(
  { change(m) {} },
  { lockTimeout: { up: "10s", down: "20s" } },
);
```

Ecto can be configured to generate migrations that use such a module; `ekto gen.migration` always
writes `migration(...)`, so change the import of the migrations you generate.

#### Role-level `lock_timeout`

Alternatively, you can set a lock timeout for the user in all commands:

```sql
ALTER ROLE myuser SET lock_timeout = '10s';
```

If you have a different user that runs migrations, this could be a good option for that
migration-specific Postgres user. The trade-off is that developers won't see this timeout as they
write migrations and explore the call stack since database role settings are in the database
which developers don't usually monitor.

### Statement timeout

Another way to ensure safety is to configure your Postgres database with statement timeouts. These
timeouts apply to all statements, including migrations and the locks they obtain.

From Postgres docs:

> Abort any statement that takes more than the specified amount of time. If
> `log_min_error_statement` is set to `ERROR` or lower, the statement that timed out will also be
> logged. If this value is specified without units, it is taken as milliseconds. A value of zero
> (the default) disables the timeout.
>
> The timeout is measured from the time a command arrives at the server until it is completed by
> the server. If multiple SQL statements appear in a single simple-Query message, the timeout is
> applied to each statement separately. (PostgreSQL versions before 13 usually treated the timeout
> as applying to the whole query string.) In extended query protocol, the timeout starts running
> when any query-related message (Parse, Bind, Execute, Describe) arrives, and it is canceled by
> completion of an Execute or Sync message.

You can specify this configuration for the Postgres user. For example:

```sql
ALTER ROLE myuser SET statement_timeout = '10m';
```

Now any statement automatically times out if it runs for more than 10 minutes; opposed to running
indefinitely. This can help if you accidentally run a query that runs the database CPU hot,
slowing everything else down; now the unoptimized query will be limited to 10 minutes or else it
will fail and be canceled.

Setting this `statement_timeout` requires discipline from the team; if there are runaway queries
that fail (for example) at 10 minutes, an exception will likely occur somewhere. You will want to
equip your application with sufficient logging, tracing, and reporting so you can replicate the
query and the parameters it took to hit the timeout, and ultimately optimize the query. Without
this discipline, you risk creating a culture that ignores exceptions.

### Handling failed concurrent operations

When `CREATE INDEX CONCURRENTLY` fails (due to timeout, deadlock, or other errors), PostgreSQL
leaves behind an **invalid index**. This index:

- Takes up disk space
- Slows down writes (PostgreSQL still updates it)
- Does not speed up queries (the planner ignores it)

You can find invalid indexes with:

```sql
SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
FROM pg_index WHERE NOT indisvalid;
```

To clean up, drop the invalid index and retry:

```ts
import { index, migration } from "ekto/migrate";

export default migration({
  disableDdlTransaction: true,
  change(m) {
    // Drop any invalid index from a previous failed attempt
    m.execute('DROP INDEX CONCURRENTLY IF EXISTS "posts_slug_index"', "");
    m.create(index("posts", ["slug"], { concurrently: true }));
  },
});
```

> [!WARNING]
> Always check for invalid indexes after a failed concurrent migration. They won't go away on
> their own and can silently degrade write performance.

---

ecto_sql's guide was originally published on
[Fly.io Phoenix Files](https://fly.io/phoenix-files/anatomy-of-an-ecto-migration/).
