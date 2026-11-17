---

title: Safe migrations
group: Migration Guides
---

# Safe migrations

A guide on common migration recipes and how to avoid trouble. This guide follows ecto_sql's
[Safe Ecto Migrations](https://hexdocs.pm/ecto_sql/safe_migrations.html), for PostgreSQL. SQLite
locks the whole database while it writes, so its migrations block other writers whatever they
change.

## Quick reference

| Operation                                                                                       | Risk                                                 | Safe approach                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Adding an index](#adding-an-index)                                                             | Blocks writes                                        | Use `concurrently: true` and disable transactions                                        |
| [Dropping an index](#dropping-an-index)                                                         | Blocks reads and writes                              | Use `concurrently: true` and disable transactions                                        |
| [Adding a reference or foreign key](#adding-a-reference-or-foreign-key)                         | Blocks writes on both tables                         | Use `validate: false`, then validate separately                                          |
| [Adding a column with a default value](#adding-a-column-with-a-default-value)                   | Volatile or expression defaults rewrite the table    | Constant defaults are fast on PostgreSQL 11+; otherwise add the column, then the default |
| [Changing a column's default value](#changing-a-columns-default-value)                          | `modify` can force an unnecessary type change        | Use raw SQL to change only the default                                                   |
| [Changing the type of a column](#changing-the-type-of-a-column)                                 | Table rewrite                                        | Create a new column, migrate data, swap reads, drop the old column                       |
| [Removing a column](#removing-a-column)                                                         | Query failures                                       | Remove it from the schema first, then drop it                                            |
| [Renaming a column](#renaming-a-column)                                                         | Query failures                                       | Use a view, or rewrite the column                                                        |
| [Renaming a table](#renaming-a-table)                                                           | Query failures                                       | Prefer renaming the schema instead                                                       |
| [Adding a check constraint](#adding-a-check-constraint)                                         | Full table scan                                      | Create with `validate: false`, then validate separately                                  |
| [Setting NOT NULL on an existing column](#setting-not-null-on-an-existing-column)               | Full table scan                                      | Use a check constraint, validate it, then add `NOT NULL`                                 |
| [Adding a JSON column](#adding-a-json-column)                                                   | `SELECT DISTINCT` errors                             | Use `jsonb` (or `map`) instead of `json`                                                 |
| [Removing or replacing a PostgreSQL enum value](#removing-or-replacing-a-postgresql-enum-value) | Removing a value requires replacing the type         | Rename with `RENAME VALUE`; otherwise phase app changes, backfill, replace the type      |
| [Adding a PostgreSQL extension](#adding-a-postgresql-extension)                                 | Privilege or extension-specific install requirements | Use `IF NOT EXISTS`; disable transactions only if the extension requires it              |

## All scenarios

The biggest factor in all the scenarios below is **scale**. For 1 million records in tables, you
may lock writes to the table when creating the column for milliseconds which could be acceptable
for you. However, once your table has 100+ million records, the difference becomes seconds which
is more likely to be felt and cause timeouts. Therefore, err on the side of safety, but **always
benchmark for your own database**. Also consider the hardware the database is running: for
example, a Raspberry Pi 2B on a microSD will run much slower.

To see the SQL a migration runs, and the transactions and lock around it, see
[Anatomy of a migration](anatomy-of-a-migration.md).

## Adding an index

Creating an index will [block writes](https://www.postgresql.org/docs/current/sql-createindex.html)
to the table in PostgreSQL unless you use `CONCURRENTLY`.

### Bad

```ts
export default migration({
  change(m) {
    m.create(index("posts", ["slug"]));
    // This obtains a ShareLock on "posts" which will block writes to the table
  },
});
```

### Good

With PostgreSQL, instead create the index concurrently which does not block writes. Disable the DDL
transaction in the migration to avoid a database transaction which is not compatible with
`CONCURRENTLY` database operations:

```ts
export default migration({
  disableDdlTransaction: true,
  change(m) {
    m.create(index("posts", ["slug"], { concurrently: true }));
  },
});
```

Ecto also has you disable the migration lock, or use advisory locks, since a concurrent index build
waits for every transaction that holds a snapshot, and Ecto's lock transaction holds one. ekto's
lock transaction runs nothing but `LOCK TABLE`, which takes no snapshot, so the migration lock can
stay on and competing nodes still run the migration only once. (`migrationLock: "pgAdvisoryLock"`
in `ekto.config.ts` works too.)

The migration may still take a while to run, but reads and updates to rows will continue to work.
For example, for 100,000,000 rows it took 165 seconds to run the migration, but SELECTS and
UPDATES could occur while it was running.

**Do not have other changes in the same migration**; only create the index concurrently and
separate other changes to later migrations.

## Dropping an index

In PostgreSQL, dropping an index blocks reads and writes while acquiring an `ACCESS EXCLUSIVE` lock.

### Bad

```ts
export default migration({
  change(m) {
    m.drop(index("posts", ["slug"]));
    // Acquires ACCESS EXCLUSIVE lock, blocking all reads and writes
  },
});
```

### Good

Drop the index concurrently to avoid blocking reads and writes:

```ts
export default migration({
  disableDdlTransaction: true,
  change(m) {
    m.drop(index("posts", ["slug"], { concurrently: true }));
  },
});
```

> [!NOTE]
> Like creating indexes concurrently, dropping concurrently cannot be done inside a transaction.

## Adding a reference or foreign key

Adding a foreign key blocks writes on both tables.

### Bad

```ts
export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.add("group_id", references("groups"));
      // Obtains a ShareRowExclusiveLock which blocks writes on both tables
    });
  },
});
```

### Good

In the first migration

```ts
export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.add("group_id", references("groups", { validate: false }));
      // Obtains a ShareRowExclusiveLock which blocks writes on both tables.
    });
  },
});
```

In the second migration

```ts
export default migration({
  change(m) {
    m.execute(
      "ALTER TABLE posts VALIDATE CONSTRAINT posts_group_id_fkey",
      async () => {}, // validating has nothing to undo
    );
    // Obtains a ShareUpdateExclusiveLock which doesn't block reads or writes
  },
});
```

The constraint is named `<table>_<column>_fkey` unless `references` is given a `name`.

> [!NOTE]
> The down migration is an empty string because PostgreSQL does not have an "unvalidate"
> operation for constraints. This is safe because validation only confirms existing data meets the
> constraint; it doesn't modify data. If you need to rollback, the constraint will remain
> validated, which has no negative impact.

These migrations can be in the same deployment, but make sure they are separate migrations.

**Note on empty tables**: when the table creating the referenced column is empty, you may be able
to create the column and validate at the same time since the time difference would be
milliseconds which may not be noticeable, no matter if you have 1 million or 100 million records
in the referenced table.

**Note on populated tables**: the biggest difference depends on your scale. For 1 million records
in both tables, you may lock writes to both tables when creating the column for milliseconds (you
should benchmark for yourself) which could be acceptable for you. However, once your table has
100+ million records, the difference becomes seconds which is more likely to be felt and cause
timeouts. The differentiating metric is the time that both tables are locked from writes.
Therefore, err on the side of safety and separate constraint validation from referenced column
creation when there is any data in the table.

## Adding a column with a default value

On PostgreSQL 11+, adding a column with a constant or literal default is usually a fast metadata
change. The main remaining hazard is volatile or expression defaults.

### Caveats

Note: A constant default is generally safe in
[PostgreSQL 11+](https://www.postgresql.org/docs/release/11.0/). The volatile-expression example
below remains unsafe.

```ts
export default migration({
  change(m) {
    m.alter(table("comments"), (t) => {
      t.add("approved", "boolean", { default: false });
      // Safe on recent PostgreSQL when the database can use its fast path,
      // but older PostgreSQL versions may still rewrite.
    });
  },
});
```

```ts
export default migration({
  change(m) {
    m.alter(table("comments"), (t) => {
      t.add("some_timestamp", "utc_datetime", { default: fragment("now()") });
      // A volatile value
    });
  },
});
```

### Good

If you need a conservative approach that also works for older PostgreSQL versions, or you are
using a volatile default, add the column first and then alter it to include the default.

First migration:

```ts
export default migration({
  change(m) {
    m.alter(table("comments"), (t) => {
      t.add("approved", "boolean");
      // This took 0.27 milliseconds for 100 million rows with no fkeys,
    });
  },
});
```

Second migration:

```ts
export default migration({
  change(m) {
    m.execute(
      "ALTER TABLE comments ALTER COLUMN approved SET DEFAULT false",
      "ALTER TABLE comments ALTER COLUMN approved DROP DEFAULT",
    );
    // This took 0.28 milliseconds for 100 million rows with no fkeys,
  },
});
```

Note: we cannot use `modify` here as it will include updating the column type as well
unnecessarily, causing PostgreSQL to rewrite the table.

Schema change to read the new column:

```diff
 export const Comment = schema("comments", {
+  approved: t.boolean().default(false),
 });
```

> [!NOTE]
> The safe method will not materialize the default value on the column for existing rows because
> the default was not set when adding the column (avoiding a potential table lock so it can
> re-write it to _write_ the default). This may affect your queries where you'd expect the value
> to now be set to your default but is actually `null`. However, the next `UPDATE` operation on
> the row will materialize the default. If you want to materialize the value, then you will need
> to consider [backfilling](backfilling-data.md).

## Changing a column's default value

Changing only a column's default is typically a metadata change in PostgreSQL. The real risk is
using `modify`, which also restates the type.

### Bad

```ts
export default migration({
  change(m) {
    m.alter(table("comments"), (t) => {
      // Previously, the default was `true`
      t.modify("approved", "boolean", {
        default: false,
        from: { type: "boolean", default: true },
      });
      // This also restates the type, which can trigger unnecessary work.
    });
  },
});
```

The issue is that we cannot use `modify` as it will include updating the column type as well
unnecessarily, causing PostgreSQL to rewrite the table.

### Good

Execute raw SQL instead to alter the default:

```ts
export default migration({
  change(m) {
    m.execute(
      "ALTER TABLE comments ALTER COLUMN approved SET DEFAULT false",
      "ALTER TABLE comments ALTER COLUMN approved SET DEFAULT true",
    );
    // This took 0.28 milliseconds for 100 million rows with no fkeys,
  },
});
```

> [!NOTE]
> This will not update the values of rows previously-set by the old default. This value has been
> materialized at the time of insert/update and therefore has no distinction between whether it
> was set by the column `DEFAULT` or set by the original operation.
>
> If you want to update the default of already-written rows, you must distinguish them somehow and
> modify them with a [backfill](backfilling-data.md).

## Changing the type of a column

Changing the type of a column may cause the table to be rewritten. During this time, reads and
writes are blocked in PostgreSQL.

### Bad

Safe in PostgreSQL:

- increasing length on varchar or removing the limit
- changing varchar to text
- changing text to varchar with no length limit
- PostgreSQL 9.2+ - increasing precision (NOTE: not scale) of decimal or numeric columns. eg,
  increasing 8,2 to 10,2 is safe. Increasing 8,2 to 8,4 is not safe.
- PostgreSQL 9.2+ - changing decimal or numeric to be unconstrained
- PostgreSQL 12+ - changing timestamp to timestamptz when session TZ is UTC

```ts
export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.modify("my_column", "boolean", { from: "text" });
    });
  },
});
```

### Good

Take a phased approach:

1. Create a new column
1. In application code, write to both columns
1. Backfill data from old column to new column
1. In application code, move reads from old column to the new column
1. In application code, remove old column from ekto schemas.
1. Drop the old column.

## Removing a column

If ekto is still configured to read a column in any running instances of the application, then
queries will fail when loading data into your records. This can happen in multi-node deployments
or if you start the application before running migrations.

### Bad

```ts
// Without a code change to the ekto schema

export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.remove("no_longer_needed_column", "text");
    });
  },
});
```

### Good

Safety can be assured if the application code is first updated to remove references to the column
so it's no longer loaded or queried. Then, the column can safely be removed from the table.

1. Deploy code change to remove references to the field.
1. Deploy migration change to remove the column.

First deployment:

```diff
 // First deploy, in the ekto schema

 export const Post = schema("posts", {
-  no_longer_needed_column: t.string().nullable(),
 });
```

Second deployment:

```ts
export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.remove("no_longer_needed_column", "text");
    });
  },
});
```

## Renaming a column

Ask yourself: "Do I _really_ need to rename a column?". Probably not, but if you must, read on and
be aware it requires time and effort.

If ekto is configured to read a column in any running instances of the application, then queries
will fail when loading data into your records. This can happen in multi-node deployments or if
you start the application before running migrations.

Ecto has a shortcut: don't rename the database column, and instead rename the schema's field and
point it to the column with `source:`. An ekto schema's field names are its column names, so it
does not have this shortcut.

### Bad

```ts
// In your schema
export const Post = schema("posts", {
  summary: t.string(),
});

// In your migration
export default migration({
  change(m) {
    m.rename(table("posts"), "title", { to: "summary" });
  },
});
```

The time between your migration running and your application getting the new code may encounter
trouble.

### Good

**Strategy 1**

Take a phased approach and use a database view:

1. In the same transaction: (1) Rename the table to a temporary name, (2) Create an updatable
   database view with the table's original name, selecting all of the table's columns as well as
   the renaming column selected again as the new name.
1. In application code, change the field to the new name
1. In the same transaction: (1) Drop the database view, (2) Rename the database table back to the
   real name, (3) Rename the column to the new name

**Strategy 2**

Take a phased approach and physically rewrite the column:

1. Create a new column
1. In application code, write to both columns
1. Backfill data from old column to new column
1. In application code, move reads from old column to the new column
1. In application code, remove old column from ekto schemas.
1. Drop the old column.

## Renaming a table

Ask yourself: "Do I _really_ need to rename a table?". Probably not, but if you must, read on and
be aware it requires time and effort.

If ekto is still configured to read a table in any running instances of the application, then
queries will fail when loading data into your records. This can happen in multi-node deployments
or if you start the application before running migrations.

There is a shortcut: rename the schema only, and do not change the underlying database table name.

### Bad

```ts
export default migration({
  change(m) {
    m.rename(table("posts"), { to: table("articles") });
  },
});
```

### Good

**Strategy 1**

Rename the schema only and all calling code, and don't rename the table:

```diff
-export const Weather = schema("weather", {
+export const Forecast = schema("weather", {
   id: t.id(),
   temp_lo: t.integer().nullable(),
   temp_hi: t.integer().nullable(),
   prcp: t.float().nullable(),
   city: t.string().nullable(),
 });

 // and in calling code:
-const weather = await repo.get(Weather, id);
+const forecast = await repo.get(Forecast, id);
```

**Strategy 2**

Take a phased approach and use a database view:

For example, rename "weather" to "forecasts"

1. Create an updatable database view of the table with the new name "forecasts"
1. In application code, change the schema's table to the updatable view "forecasts"
1. In the same transaction: (1) drop the database view, (2) rename the database table to the
   intended name, eg "forecasts"

**Strategy 3**

Take a phased approach and physically rewrite the table:

1. Create the new table. This should include creating new constraints (checks and foreign keys)
   that mimic behavior of the old table.
1. In application code, write to both tables, continuing to read from the old table.
1. Backfill data from old table to new table
1. In application code, move reads from old table to the new table
1. In application code, remove the old table from ekto schemas.
1. Drop the old table.

## Adding a check constraint

Adding a check constraint blocks reads and writes to the table in PostgreSQL while every row is
checked.

### Bad

```ts
export default migration({
  change(m) {
    m.create(
      constraint("products", "price_must_be_positive", { check: "price > 0" }),
    );
    // Creating the constraint with validate: true (the default when
    // unspecified) will perform a full table scan and acquires a lock
    // preventing updates
  },
});
```

### Good

There are two operations occurring:

1. Creating a new constraint for new or updating records
1. Validating the new constraint for existing records

If these commands are happening at the same time, it obtains a lock on the table as it validates
the entire table and fully scans the table. To avoid this full table scan, we can separate the
operations.

In one migration:

```ts
export default migration({
  change(m) {
    m.create(
      constraint("products", "price_must_be_positive", {
        check: "price > 0",
        validate: false,
      }),
    );
    // Setting validate: false will prevent a full table scan, and therefore
    // commits immediately.
  },
});
```

In the next migration:

```ts
export default migration({
  change(m) {
    m.execute(
      "ALTER TABLE products VALIDATE CONSTRAINT price_must_be_positive",
      async () => {}, // validating has nothing to undo
    );
    // Acquires SHARE UPDATE EXCLUSIVE lock, which allows updates to continue
  },
});
```

These can be in the same deployment, but ensure there are 2 separate migrations.

## Setting NOT NULL on an existing column

In PostgreSQL, setting NOT NULL on an existing column requires scanning the table and can block
concurrent updates while every row is checked.

Just like the Adding a check constraint scenario, there are two operations occurring:

1. Creating a new constraint for new or updating records
1. Validating the new constraint for existing records

To avoid the full table scan, we can separate these two operations.

### Bad

```ts
export default migration({
  change(m) {
    m.alter(table("products"), (t) => {
      t.modify("active", "boolean", { null: false, from: "boolean" });
    });
  },
});
```

### Good

Add a check constraint without validating it, backfill data to satiate the constraint and then
validate it. This will be functionally equivalent.

In the first migration:

```ts
// Deployment 1
export default migration({
  change(m) {
    m.create(
      constraint("products", "active_not_null", {
        check: "active IS NOT NULL",
        validate: false,
      }),
    );
  },
});
```

This will enforce the constraint in all new rows, but not care about existing rows until that row
is updated.

You'll likely need a data migration at this point to ensure that the constraint is satisfied.

Then, in the next deployment's migration, we'll enforce the constraint on all rows:

```ts
// Deployment 2
export default migration({
  change(m) {
    m.execute(
      "ALTER TABLE products VALIDATE CONSTRAINT active_not_null",
      async () => {}, // validating has nothing to undo
    );
  },
});
```

You can then add the NOT NULL to the column after validating the constraint. From the PostgreSQL
docs:

> SET NOT NULL may only be applied to a column provided none of the records in the table contain a
> NULL value for the column. Ordinarily this is checked during the ALTER TABLE by scanning the
> entire table; however, if a valid CHECK constraint is found which proves no NULL can exist, then
> the table scan is skipped.

**However** we cannot use `modify` as it will include updating the column type as well
unnecessarily, causing PostgreSQL to rewrite the table. And as dropping a constraint cannot be
reversed in `change`, the migration has `up` and `down`:

```ts
export default migration({
  up(m) {
    m.execute("ALTER TABLE products VALIDATE CONSTRAINT active_not_null");
    m.execute("ALTER TABLE products ALTER COLUMN active SET NOT NULL");
    m.drop(
      constraint("products", "active_not_null", {
        check: "active IS NOT NULL",
      }),
    );
  },
  down(m) {
    m.create(
      constraint("products", "active_not_null", {
        check: "active IS NOT NULL",
        validate: false,
      }),
    );
    m.execute("ALTER TABLE products ALTER COLUMN active DROP NOT NULL");
  },
});
```

If your constraint fails, then you should consider backfilling data first to cover the gaps in
your desired data integrity, then revisit validating the constraint.

## Adding a JSON column

In PostgreSQL, there is no equality operator for the json column type, which can cause errors for
existing SELECT DISTINCT queries in your application.

### Bad

```ts
export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.add("extra_data", "json");
    });
  },
});
```

### Good

Use jsonb instead. Some say it's like "json" but "better." ekto's `map` type is `jsonb` on
PostgreSQL.

```ts
export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.add("extra_data", "jsonb");
    });
  },
});
```

## Removing or replacing a PostgreSQL enum value

PostgreSQL does not support removing enum values or changing their sort order directly. However,
it does support renaming an enum value with `ALTER TYPE ... RENAME VALUE`.

If you only need to rename a value, you can do that directly:

```ts
export default migration({
  up(m) {
    m.execute("ALTER TYPE status RENAME VALUE 'obsolete' TO 'draft'");
  },
});
```

For multi-node deployments, still coordinate that rename with application code changes just like
any other application-visible rename.

If you need to remove a value, or otherwise replace the enum definition, coordinate application
code changes with database changes.

### Bad

```ts
export default migration({
  change(m) {
    // These operations do not exist in PostgreSQL
    m.execute("ALTER TYPE status DROP VALUE 'obsolete'");
  },
});
```

### Good

Take a phased approach:

1. **Deploy application code** that handles both old and new enum values (stops writing the value
   to be removed, reads both old and new values)
2. **Backfill data** to migrate rows from old value to new value (see
   [backfilling guide](backfilling-data.md))
3. **Deploy migration** to replace the enum type
4. **Deploy application code** to remove handling of old value

First deployment (application code):

```diff
 // Stop writing the old value, handle both when reading
 export function changeset(post: Post, attrs: unknown) {
   return pipe(
     cast(post, attrs, ["status"]),
-    validateInclusion("status", ["draft", "obsolete", "published", "archived"]),
+    validateInclusion("status", ["draft", "published", "archived"]),
   );
 }

 // Handle old value when reading
 export function displayStatus(post: Post) {
   return post.status === "obsolete" ? "draft" : post.status;
 }
```

Second deployment (backfill existing rows):

```ts
export default migration({
  up(m) {
    m.execute("UPDATE posts SET status = 'draft' WHERE status = 'obsolete'");
  },
});
```

For large tables, batch this operation. See [backfilling data](backfilling-data.md) for safe
approaches.

Third deployment (replace the enum type):

```ts
export default migration({
  up(m) {
    m.execute(
      "CREATE TYPE status_new AS ENUM ('draft', 'published', 'archived')",
    );
    m.execute(
      "ALTER TABLE posts ALTER COLUMN status TYPE status_new USING status::text::status_new",
    );
    m.execute("DROP TYPE status");
    m.execute("ALTER TYPE status_new RENAME TO status");
  },
});
```

> [!WARNING]
> The `ALTER COLUMN ... TYPE` operation rewrites the table and blocks reads and writes. For large
> tables, consider a phased migration using a new column instead.

## Adding a PostgreSQL extension

`CREATE EXTENSION` can usually run inside a transaction. The main concerns are privileges,
extension availability, and whether the extension's installation script depends on commands that
cannot run inside a transaction block.

### Example

```ts
export default migration({
  change(m) {
    m.execute('CREATE EXTENSION "uuid-ossp"', 'DROP EXTENSION "uuid-ossp"');
  },
});
```

### Good

```ts
export default migration({
  change(m) {
    m.execute(
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
      'DROP EXTENSION IF EXISTS "uuid-ossp"',
    );
  },
});
```

> [!NOTE]
> Creating extensions typically requires superuser privileges. In managed database services (AWS
> RDS, Heroku), some extensions may not be available.
>
> If an extension complains that it cannot run inside a transaction block, then disable the DDL
> transaction for that specific migration.

## Credits

ecto_sql's guide was created and written by David Bernheisel with recipes heavily inspired from
Andrew Kane and his library [strong_migrations](https://github.com/ankane/strong_migrations).

- [PostgreSQL at Scale by James Coleman](https://medium.com/braintree-product-technology/postgresql-at-scale-database-schema-changes-without-downtime-20d3749ed680)
- [Strong Migrations by Andrew Kane](https://github.com/ankane/strong_migrations)
- [Adding a NOT NULL CONSTRAINT on PG Faster with Minimal Locking by Christophe Escobar](https://medium.com/doctolib/adding-a-not-null-constraint-on-pg-faster-with-minimal-locking-38b2c00c4d1c)
- [PostgreSQL Runtime Configuration](https://www.postgresql.org/docs/current/runtime-config-client.html)
