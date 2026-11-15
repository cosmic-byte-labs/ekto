---

title: Squashing migrations
group: Migration Guides
---

# Squashing migrations

If you have a long list of migrations, sometimes it can take a while to migrate each of those files
every time the project is reset or spun up by a new developer. Ecto comes with mix tasks to `dump`
and `load` a database structure which will represent the state of the database up to a certain
point in time, not including content. ekto has no such commands, but the database's own tools do
the same. This guide follows ecto_sql's
[Squashing Migrations](https://hexdocs.pm/ecto_sql/squashing_migrations.html).

On Postgres, Ecto's `mix ecto.dump` runs `pg_dump`, and `mix ecto.load` runs `psql`; so can we.

For example:

```
20210101000000 - First Migration
20210201000000 - Second Migration
20210701000000 - Third Migration <-- we are here now. dump the structure
```

We can "squash" the migrations up to the current day which will effectively fast-forward
migrations to that structure. The migrator will detect that the database is already migrated to
the third migration, and so it begins there and migrates forward.

Let's add a new migration:

```
20210101000000 - First Migration
20210201000000 - Second Migration
20210701000000 - Third Migration <-- `structure.sql` represents up to here
20210801000000 - New Migration <-- This is where migrations will begin
```

The new migration will still run, but the first-through-third migrations will not need to be run
since the structure already represents the changes applied by those migrations. At this point, you
can safely delete the first, second, and third migration files or keep them for historical
auditing.

Let's make this work:

1. Dump the current structure into `structure.sql`, together with the versions in
   `schema_migrations`, which tell the migrator which migrations it represents:

   ```bash
   pg_dump --schema-only --no-acl --no-owner --file structure.sql "$DATABASE_URL"
   pg_dump --data-only --inserts --table schema_migrations "$DATABASE_URL" >> structure.sql
   ```

2. During project setup with an empty database, load `structure.sql`:

   ```bash
   psql --quiet --set ON_ERROR_STOP=1 --file structure.sql "$DATABASE_URL"
   ```

3. Run `pnpm ekto migrate` to run any additional migrations created after the structure was
   dumped.

To simplify these actions into one command, we can leverage `package.json` scripts:

```json
{
  "scripts": {
    "db:dump": "pg_dump --schema-only --no-acl --no-owner --file structure.sql \"$DATABASE_URL\" && pg_dump --data-only --inserts --table schema_migrations \"$DATABASE_URL\" >> structure.sql",
    "db:load": "psql --quiet --set ON_ERROR_STOP=1 --file structure.sql \"$DATABASE_URL\"",
    "db:setup": "pnpm db:load && ekto migrate"
  }
}
```

Now you can run `pnpm db:setup` and it will load the database structure and run remaining
migrations. Of course, you can continue running `pnpm ekto migrate` as you create them.

With SQLite, the `sqlite3` command does the same:

```bash
sqlite3 my_app.db ".schema --nosys" > structure.sql
sqlite3 my_app.db ".dump schema_migrations" >> structure.sql
sqlite3 my_app_new.db < structure.sql
```
