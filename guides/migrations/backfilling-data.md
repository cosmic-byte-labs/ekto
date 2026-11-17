---

title: Backfilling data
group: Migration Guides
---

# Backfilling data

Backfilling data refers to any attempt to change data in bulk. This can happen in code through
migrations, application code, UIs that allow multiple selections and updates, or in a console
connected to a running application. Since bulk changes affect a lot of data, it's always a good
idea to have the code reviewed before it runs. You also want to check that it runs efficiently and
does not overwhelm the database. Ideally, it's nice when the code is written to be safe to re-run.
For these reasons, please don't change data in bulk through a console! This guide follows
ecto_sql's [Backfilling Data](https://hexdocs.pm/ecto_sql/backfilling_data.html), for PostgreSQL.

We're going to focus on bulk changes executed through ekto migrations, but the same principles are
applicable to any case where bulk changes are being made. Typical scenarios where you might need
to run data migrations is when you need to fill in data for records that already exist (hence,
backfilling data). This usually comes up when table structures are changed in the database.

Some examples of backfilling:

- Populating data into a new column
- Changing a column to make it required. May require changing existing rows to set a value.
- Splitting one database table into several
- Fixing bad data

For simplicity, we are using ekto's migrator to run our data migrations, but it's important to not
let these migrations break developers' environments over time (more on this below). If using
migrations to change data is a normal process that happens regularly, then you may consider
exploring a migration system outside of ekto's migrator that is observable, hooks into error
reporting, metrics, and allows for dry runs. This guide is intended as a starting point, and since
ekto ships with a migration runner, we'll leverage it to also run the data migrations.

There are both bad and good ways to write these data migrations. Let's explore some:

## Bad

In the following example, a migration references the schema `Post` and the application's repo.

```ts
import { migration, table } from "ekto/migrate";
import { repo } from "../src/repo.ts";
import { Post } from "../src/schemas.ts";

export default migration({
  change(m) {
    m.alter(table("posts"), (t) => {
      t.add("new_data", "text");
    });

    m.execute(async () => {
      await repo.updateAll(Post, { set: { new_data: "some data" } }, (q) =>
        q.where("new_data", "is", null),
      );
    });
  },
});
```

The problem is the code and schema may change over time. However, migrations are using a snapshot
of your schemas at the time it's written. In the future, many assumptions may no longer be true.
For example, the `new_data` column may not be present anymore in the schema causing the query to
fail if this migration is run months later.

Additionally, in your development environment, you might have 10 records to migrate. In staging,
you might have 100. In production, you might have 1 billion to migrate. Scaling your approach
matters.

Ultimately, there are several bad practices here:

1. The ekto schema in the query may change after this migration was written.
2. If you try to backfill the data all at once, it may exhaust the database memory and/or CPU if
   it's changing a large data set.
3. Backfilling data inside a transaction for the migration locks row updates for the duration of
   the migration, even if you are updating in batches. Here it is worse still: the application's
   repo runs the update on a connection of its own, outside the migration's transaction, so the
   update waits for the lock the migration's `ALTER TABLE` holds until the migration commits,
   which it never does.
4. Disabling the transaction for the migration and only batching updates may still spike the
   database CPU to 100%, causing other concurrent reads or writes to time out.

## Good

There are four keys to backfilling safely:

1. running outside a transaction
2. batching
3. throttling
4. resiliency

To disable the migration transactions, add these options to your migration:

```ts
export default migration({
  disableDdlTransaction: true,
  disableMigrationLock: true,
  // ...
});
```

Batching our data migrations still has several challenges.

We'll start with how do we paginate efficiently: `LIMIT`/`OFFSET` by itself is an expensive query
for large tables (they start fast, but slow to a crawl when in the later pages of the table), so
we must find another way to paginate. Since we cannot use a database transaction, this also
implies we cannot leverage cursors since they require a transaction. This leaves us with
[keyset pagination](https://www.citusdata.com/blog/2016/03/30/five-ways-to-paginate/).

For querying and updating the data, `m.execute` takes a function, which is given the migration's
Kysely handle (the repo's own, as the migration has no transaction). There are two ways to
"snapshot" your schema at the time of the migration. We'll use both options below in the
examples:

1. Query the table as it is at that moment, with Kysely and no table types (`Kysely<any>`), or
   raw SQL. Do not use ekto schemas. Prefer this approach when you can. Your application's ekto
   schemas will change over time, but your migration should not, therefore it's not a true
   snapshot of the data at the time.

2. Write a small interface of the table inside the migration that only uses what you need, and
   give it to Kysely. This is helpful if you prefer typed queries and decouples from your
   application's ekto schemas as it evolves separately.

For throttling, we can simply sleep (`setTimeout` from `node:timers/promises`) after each page.

For resiliency, we need to ensure that we handle errors without losing our progress. You don't want
to migrate the same data twice! Most data migrations I have run find some records in a state that
I wasn't expecting. This causes the data migration to fail. When the data migration stops, that
means I have to write a little bit more code to handle that scenario, and re-run the migration.
Every time the data migration is re-run, it should pick up where it left off without revisiting
already-migrated records.

Finally, to manage these data migrations separately, we need to:

1. Store data migrations separately from your schema migrations.
2. Run the data migrations manually.

If you have the `ekto` command available in production, you can use
`ekto migrate --migrations data_migrations`. Otherwise, run them from code, for example from a
script your deployment runs, with `createMigrator` and the data migrations' folder:

```ts
// scripts/migrate-data.ts
import { createMigrator, fileMigrations, type RunOptions } from "ekto/migrate";
import { repo } from "../src/repo.ts";

// Migrate data in the database. Defaults to migrating to the latest,
// { all: true }. Also accepts { step: 1 }, or { to: 20200118045751 }.
export async function migrateData(options: RunOptions = { all: true }) {
  const migrator = createMigrator({
    repo,
    migrations: fileMigrations("data_migrations"),
  });
  await migrator.migrate(options);
}
```

## Batching deterministic data

If the data can be queried with a condition that is removed after update then you can repeatedly
query the data and update the data until the query result is empty. For example, if a column is
currently null and will be updated to not be null, then you can query for the null records and
pick up where you left off.

Here's how we can manage the backfill:

1. Disable migration transactions.
2. Use keyset pagination: Order the data, find rows greater than the last mutated row and limit by
   batch size.
3. For each page, mutate the records.
4. Check for failed updates and handle it appropriately.
5. Use the last mutated record's ID as the starting point for the next page. This helps with
   resiliency and prevents looping on the same record over and over again.
6. Arbitrarily sleep to throttle and prevent exhausting the database.
7. Rinse and repeat until there are no more records

For example:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { migration } from "ekto/migrate";
import type { Kysely } from "kysely";

const batchSize = 1000;
const throttleMs = 100;

export default migration({
  disableDdlTransaction: true,
  disableMigrationLock: true,
  up(m) {
    m.execute((db) => throttleChangeInBatches(db, pageQuery, doChange));
  },
  down() {},
});

async function doChange(db: Kysely<any>, batchOfIds: string[]) {
  const rows = await db
    .updateTable("weather")
    .set({ approved: true })
    .where("id", "in", batchOfIds)
    .returning("id")
    .execute();
  const results = new Set(rows.map((row) => row.id));
  for (const id of batchOfIds) if (!results.has(id)) handleNonUpdate(id);
}

function pageQuery(db: Kysely<any>, lastId: string) {
  // Notice how we do not use ekto schemas here.
  return db
    .selectFrom("weather")
    .select("id")
    .where("approved", "is", null)
    .where("id", ">", lastId)
    .orderBy("id", "asc")
    .limit(batchSize);
}

// If you have integer IDs, start from "0"; with binary IDs, from
// "00000000-0000-0000-0000-000000000000". (PostgreSQL returns bigint IDs as
// strings, and they are compared in the database.)
async function throttleChangeInBatches(
  db: Kysely<any>,
  query: typeof pageQuery,
  change: typeof doChange,
  lastPos = "0",
) {
  for (;;) {
    const ids = (await query(db, lastPos).execute()).map((row) => row.id);
    if (ids.length === 0) return;
    await change(db, ids);
    lastPos = ids[ids.length - 1];
    await sleep(throttleMs);
  }
}

function handleNonUpdate(id: string): never {
  throw new Error(`${id} was not updated`);
}
```

The migration's `down` does nothing, so it can be rolled back without undoing the data.

To test it in development/test environments:

```bash
pnpm ekto gen.migration --migrations data_migrations backfill_posts
pnpm ekto migrate --migrations data_migrations
```

## Batching arbitrary data

If the data being updated does not indicate it's already been updated, then we need to take a
snapshot of the current data and store it temporarily. For example, if all rows should increment
a column's value by 10, how would you know if a record was already updated? You could load a list
of IDs into the application during the migration, but what if the process crashes? Instead we're
going to keep the data we need in the database.

To do this, it works well if we can pick a specific point in time where all records _after_ that
point in time do not need adjustment. This happens when you realize a bug was creating bad data
and after the bug was fixed and deployed, all new entries are good and should not be touched as we
clean up the bad data. For this example, we'll use `inserted_at` as our marker. Let's say that the
bug was fixed on a midnight deploy on 2021-08-22.

Here's how we'll manage the backfill:

1. Create a "temporary" table. In this example, we're creating a real table that we'll drop at the
   end of the data migration. In PostgreSQL, there are
   [actual temporary tables](https://www.postgresql.org/docs/current/sql-createtable.html) that
   are discarded after the session is over; we're not using those because we need resiliency in
   case the data migration encounters an error. The error would cause the session to be over, and
   therefore the temporary table tracking progress would be lost. Real tables don't have this
   problem. Likewise, we don't want to store IDs in application memory during the migration for
   the same reason.

2. Populate that temporary table with IDs of records that need to update. This query only requires
   a read of the current records, so there are no consequential locks occurring when populating,
   but be aware this could be a lengthy query. Populating this table can occur at creation or
   afterwards; in this example we'll populate it at table creation.

3. Ensure there's an index on the temporary table so it's fast to delete IDs from it. I use an
   index instead of a primary key because it's easier to re-run the migration in case there's an
   error. There isn't a straight-forward way to `CREATE IF NOT EXISTS` on a primary key; but you
   can do that easily with an index.

4. Use keyset pagination to pull batches of IDs from the temporary table. Do this inside a
   database transaction and lock records for updates. Each batch should read and update within
   milliseconds, so this should have little impact on concurrent reads and writes.

5. For each batch of records, determine the data changes that need to happen. This can happen for
   each record.

6. [Upsert](https://wiki.postgresql.org/wiki/UPSERT) those changes to the real table. This insert
   will include the ID of the record that already exists and a list of attributes to change for
   that record. Since these insertions will conflict with existing records, we'll instruct
   PostgreSQL to replace certain fields on conflicts.

7. Delete those IDs from the temporary table since they're updated on the real table. Close the
   database transaction for that batch.

8. Throttle so we don't overwhelm the database, and also give opportunity to other concurrent
   processes to work.

9. Rinse and repeat until the temporary table is empty.

10. Finally, drop the temporary table when empty.

Let's see how this can work:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { index, migration, table } from "ekto/migrate";
import type { Kysely } from "kysely";

// In this example, we'll describe the tables as they are at the time of the
// migration, and no more, instead of using the application's schemas.
interface MigratingDatabase {
  weather: {
    id: string;
    temp_lo: number | null;
    temp_hi: number | null;
    prcp: number | null;
    city: string | null;
    inserted_at: Date;
    updated_at: Date;
  };
  records_to_update: { id: string };
}

const tempTableName = "records_to_update";
const batchSize = 1000;
const throttleMs = 100;

export default migration({
  disableDdlTransaction: true,
  disableMigrationLock: true,
  up(m) {
    m.execute(`
      CREATE TABLE IF NOT EXISTS "${tempTableName}" AS
      SELECT id FROM weather WHERE inserted_at < '2021-08-22T00:00:00'
    `);
    m.createIfNotExists(index(tempTableName, ["id"]));
    m.execute((db) => throttleChangeInBatches(db, pageQuery, doChange));
    // You may want to check if it's empty before dropping it. Since we're
    // throwing on non-updates, we don't have to do that in this example.
    m.drop(table(tempTableName));
  },
  down() {},
});

function doChange(db: Kysely<MigratingDatabase>, batchOfIds: string[]) {
  // Wrap in a transaction to momentarily lock records during read/update
  return db.transaction().execute(async (tx) => {
    const records = await tx
      .selectFrom("weather")
      .selectAll()
      .where("id", "in", batchOfIds)
      .forUpdate()
      .execute();
    const now = new Date();
    const mutations = records.flatMap((record) => mutation(record, now));

    // Don't be fooled by the name insertInto, this is actually an upsert
    // that will update existing records when conflicting; they should all
    // conflict since the ID is included in the update.
    const results =
      mutations.length === 0
        ? []
        : await tx
            .insertInto("weather")
            .values(mutations)
            .onConflict((oc) =>
              oc.column("id").doUpdateSet((eb) => ({
                temp_lo: eb.ref("excluded.temp_lo"),
                updated_at: eb.ref("excluded.updated_at"),
              })),
            )
            .returning("id")
            .execute();
    const updated = new Set(results.map((row) => row.id));
    for (const { id } of mutations) if (!updated.has(id)) handleNonUpdate(id);

    await tx.deleteFrom(tempTableName).where("id", "in", batchOfIds).execute();
  });
}

function mutation(record: MigratingDatabase["weather"], now: Date) {
  // This logic can be whatever you need; we'll just do something simple
  // here to illustrate
  if (record.temp_hi !== null && record.temp_hi > 1) {
    // No update needed
    return [];
  }
  // Upserts don't update the timestamps, so be sure to update them
  // yourself. The inserted_at value should never be used since all these
  // records are already inserted, and we won't replace this field on
  // conflicts; we just need it to satisfy table constraints.
  return [
    {
      id: record.id,
      temp_lo: (record.temp_hi ?? 0) - 10,
      inserted_at: now,
      updated_at: now,
    },
  ];
}

function pageQuery(db: Kysely<MigratingDatabase>, lastId: string) {
  return db
    .selectFrom(tempTableName)
    .select("id")
    .where("id", ">", lastId)
    .orderBy("id", "asc")
    .limit(batchSize);
}

function handleNonUpdate(id: string): never {
  throw new Error(`${id} was not updated`);
}

// If you have integer IDs, start from "0"; with binary IDs, from
// "00000000-0000-0000-0000-000000000000".
async function throttleChangeInBatches(
  db: Kysely<MigratingDatabase>,
  query: typeof pageQuery,
  change: typeof doChange,
  lastPos = "0",
) {
  for (;;) {
    const ids = (await query(db, lastPos).execute()).map((row) => row.id);
    if (ids.length === 0) return;
    await change(db, ids);
    lastPos = ids[ids.length - 1];
    await sleep(throttleMs);
  }
}
```

The commands of a migration run in order, so the temporary table and its index exist before the
batches run, as Ecto's `flush()` would ensure.

And to test in development/test environments:

```bash
pnpm ekto gen.migration --migrations data_migrations backfill_weather
pnpm ekto migrate --migrations data_migrations
```

---

ecto_sql's guide was originally published on
[Fly.io Phoenix Files](https://fly.io/phoenix-files/backfilling-data/). See
[Automatic and Manual Ecto Migrations by Wojtek Mach](https://dashbit.co/blog/automatic-and-manual-ecto-migrations)
for more examples on running Ecto migrations.
