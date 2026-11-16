---

title: Getting Started
group: Introduction
---

# Getting Started

This guide is an introduction to ekto, a data layer for TypeScript inspired by Elixir's
[Ecto](https://hexdocs.pm/ecto). In this guide, we're going to learn some basics about ekto,
such as creating, reading, updating and deleting records from a PostgreSQL database. It follows
Ecto's own [Getting Started](https://hexdocs.pm/ecto/getting-started.html) guide step by step.

**This guide will require you to have set up PostgreSQL beforehand.** Everything in it also
works on SQLite; [Using SQLite](#using-sqlite) at the end lists what changes.

## Adding ekto to an application

To start off with, we'll create a new Node project called `friends`:

```bash
mkdir friends && cd friends
pnpm init
pnpm pkg set type=module
```

ekto runs TypeScript files directly with Node 22.19 or later, so there is nothing to compile
for this guide. To add ekto, we install it together with [Kysely](https://kysely.dev), which
ekto builds its queries with, and `pg` (node-postgres), the driver that talks to PostgreSQL:

```bash
pnpm add ekto kysely pg
```

ekto provides the common API, but it needs the driver installed too, as that is what ekto uses
to speak in terms a PostgreSQL database can understand. ekto talks to its PostgreSQL adapter,
`postgres()` from `ekto/postgres`, which then in turn talks to `pg`.

Next we need a _repo_. The repo is the only part of our code that talks to the database. Let's
define it in `src/repo.ts`:

```ts
import { createRepo } from "ekto";
import { postgres } from "ekto/postgres";

export const repo = createRepo({
  adapter: postgres(),
  url: process.env.DATABASE_URL,
});
```

This configures how ekto will connect to our database, called `friends`, with the URL we will
give it in the `DATABASE_URL` environment variable:

```bash
export DATABASE_URL=postgres://user:pass@localhost/friends
```

**NOTE:** Your PostgreSQL database may be set up to

- not require a username and password. If the URL above doesn't work, try removing them
  (`postgres://localhost/friends`), or setting them both to `postgres`.
- be running on a non-standard port. The default port is `5432`. You can give yours in the URL:
  `postgres://localhost:15432/friends`.

Instead of a URL, the repo also takes `hostname`, `port`, `database`, `username` and
`password`. More information about the options is in the documentation of
{@link ekto!RepoConfig | RepoConfig}.

The repo opens connections as they are needed, and keeps them in a pool. There is no process to
start: as soon as `createRepo` returns, we can query the database. When our program is done,
`repo.stop()` closes the connections.

There's one final bit of configuration. The `ekto` command, which runs migrations, reads its
configuration from `ekto.config.ts`. Let's create it at the root of the project:

```ts
import { postgres } from "ekto/postgres";

export default {
  repo: { adapter: postgres(), url: process.env.DATABASE_URL },
  migrationsFolder: "migrations",
};
```

We've now configured our application so that it's able to make queries to our database. Let's
now create our database, add a table to it, and then perform some queries.

## Setting up the database

To be able to query a database, it first needs to exist. ekto does not create databases, so we
create it with PostgreSQL's `createdb` command:

```bash
createdb friends
```

**NOTE:** If you get an error, you may need to give `createdb` your username (`-U postgres`) or
host (`-h localhost`), as it may be an authentication error.

A database by itself isn't very queryable, so we will need to create a table within that
database. To do that, we'll use what's referred to as a _migration_. If you've come from Ecto or
Active Record, you will have seen these before. A migration is a single step in the process of
constructing your database.

Let's create a migration now with this command:

```bash
pnpm ekto gen.migration create_people
```

This command will generate a brand new migration file in `migrations`, which is empty by
default:

```ts
// migrations/20260115103000_create_people.ts
import { migration } from "ekto/migrate";

export default migration({
  change(m) {},
});
```

Let's add some code to this migration to create a new table called `people`, with a few columns
in it:

```ts
import { migration, table } from "ekto/migrate";

export default migration({
  change(m) {
    m.create(table("people"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("first_name", "string");
      t.add("last_name", "string");
      t.add("age", "integer");
    });
  },
});
```

This new code will tell ekto to create a new table called `people`, with an `id` primary key and
three new fields: `first_name`, `last_name` and `age`. The types of these fields are `string`
and `integer`. Unlike Ecto, ekto does not add the `id` column for us: we declare the primary key
like any other column.

**NOTE:** The naming convention for tables is to use a pluralized name.

To run this migration and create the `people` table in our database, we will run this command:

```bash
pnpm ekto migrate
```

```
== Migrated 20260115103000 create_people
```

If we found out that we made a mistake in this migration, we could run `pnpm ekto rollback` to
undo the changes in the migration. We could then fix the changes in the migration and run
`pnpm ekto migrate` again. If we ran `pnpm ekto rollback` now, it would delete the table that we
just created. `pnpm ekto status` lists the migrations and whether they ran.

We now have a table created in our database. The next step that we'll need to do is to create
the schema.

## Creating the schema

The schema is a TypeScript representation of data from our database. Schemas are commonly
associated with a database table, however they can be associated with a database view as well.

Let's create the schema within our application at `src/person.ts`:

```ts
import { type Infer, schema, t } from "ekto";

export const Person = schema("people", {
  id: t.id(),
  first_name: t.string().nullable(),
  last_name: t.string().nullable(),
  age: t.integer().nullable(),
});
export type Person = Infer<typeof Person>;
```

This defines the schema from the database that this schema maps to. In this case, we're telling
ekto that the `Person` schema maps to the `people` table in the database, and the `id`,
`first_name`, `last_name` and `age` fields in that table. The field types (`t.id()`,
`t.string()`, `t.integer()`) tell ekto how we want the information from the database to be
represented in our records. The columns of our table may be `NULL`, so the fields are
`.nullable()`. `Infer` gives us the TypeScript type of a person.

We've called this schema `Person` because the naming convention for schemas is a singularized
name.

Now that we have a schema, we can let the repo know about our tables, so that its queries are
typed. Let's change `src/repo.ts` to:

```ts
import { createRepo } from "ekto";
import { type KyselyDB, postgres } from "ekto/postgres";
import { Person } from "./person.ts";

export type DB = KyselyDB<[typeof Person]>;

export const repo = createRepo<DB>({
  adapter: postgres(),
  url: process.env.DATABASE_URL,
});
```

We can play around with this schema in a script. Records are plain objects; `Person.new()`
builds one, with `null` (or the field's default) for all the fields:

```ts
let person = Person.new();
// { id: null, first_name: null, last_name: null, age: null }
```

We can set values on these fields when building it:

```ts
person = Person.new({ age: 28 });
```

Or with syntax like this:

```ts
person = { ...person, age: 28 };
```

We can retrieve values using this syntax:

```ts
person.age; // => 28
```

Let's take a look at how we can insert data into the database.

## Inserting data

We can insert a new record into our `people` table with this code:

```ts
import { Person } from "./person.ts";
import { repo } from "./repo.ts";

const result = await repo.insert(Person.new());
```

To insert the data into our database, we call `insert` on `repo`, which is the object that uses
ekto to talk to our database. This tells ekto that we want to insert a new `Person` record into
the database. The record here represents the data that we want to insert into the database.

A successful insertion will return a result like so:

```ts
result;
// {
//   ok: true,
//   value: { id: 1, first_name: null, last_name: null, age: null }
// }
```

`ok` can be checked to ensure that the insertion succeeded. A situation where the insertion may
not succeed is if you have a constraint on the database itself. For instance, if the database
had a unique constraint on a field called `email` so that an email can only be used for one
person record, then the insertion would fail.

You may wish to check the result in order to refer to the record inserted into the database:

```ts
if (result.ok) {
  const person = result.value;
}
```

## Validating changes

In ekto, you may wish to validate changes before they go to the database. For instance, you may
wish that a person has both a first name and a last name before a record can be entered into the
database. For this, ekto has _changesets_.

Let's add a changeset to our `src/person.ts` now:

```ts
import {
  type Changeset,
  cast,
  type Infer,
  type New,
  pipe,
  schema,
  t,
  validateRequired,
} from "ekto";

// The schema is the same

export function changeset<D extends Person | New<typeof Person>>(
  person: D | Changeset<D>,
  params: unknown = {},
): Changeset<D> {
  return pipe(
    cast(person, params, ["first_name", "last_name", "age"]),
    validateRequired(["first_name", "last_name"]),
  );
}
```

This changeset takes a `person` and a set of params, which are to be the changes to apply to this
person. The `changeset` function first casts the `first_name`, `last_name` and `age` keys from
the parameters passed in to the changeset. Casting tells the changeset what parameters are
allowed to be passed through in this changeset, and anything not in the list will be ignored.
`pipe` passes the changeset through each step in turn.

On the next line, we call `validateRequired` which says that, for this changeset, we expect
`first_name` and `last_name` to have values specified. Let's use this changeset to attempt to
create a new record without a `first_name` and `last_name`:

```ts
import { changeset, Person } from "./person.ts";

const person = Person.new();
const cs = changeset(person, {});
const result = await repo.insert(cs);
```

On the first line here, we build a new person record. We know what that does, because we saw it
not too long ago. On the second line we do something brand new: we define a changeset. This
changeset says that on the specified `person` record, we're looking to make some changes. In this
case, we're not looking to change anything at all.

On the final line, rather than inserting the `person`, we insert the changeset. The changeset
knows about the `person`, the changes and the validation rules that must be met before the data
can be entered into the database. When this line runs, we'll get this result:

```ts
result;
// {
//   ok: false,
//   changeset: {
//     action: "insert",
//     changes: {},
//     errors: [
//       { field: "first_name", message: "can't be blank", meta: { validation: "required" } },
//       { field: "last_name", message: "can't be blank", meta: { validation: "required" } }
//     ],
//     data: { id: null, first_name: null, last_name: null, age: null },
//     valid: false
//   }
// }
```

Just like the last time we did an insertion, this returns a result. This time however, `ok` is
`false`, which indicates something bad happened. The specifics of what happened are included in
the changeset which is returned. We can get to the errors with `result.changeset.errors`:

```ts
if (!result.ok) result.changeset.errors;
// [
//   { field: "first_name", message: "can't be blank", meta: { validation: "required" } },
//   { field: "last_name", message: "can't be blank", meta: { validation: "required" } }
// ]
```

And we can ask the changeset itself if it is valid, even before doing an insertion:

```ts
cs.valid; // => false
```

Since this changeset has errors, no new record was inserted into the `people` table.

Let's try now with some valid data.

```ts
const cs = changeset(Person.new(), { first_name: "Ryan", last_name: "Bigg" });
```

We start out here with a new person record. We then create a changeset for that person which has
a `first_name` and a `last_name` parameter specified. At this point, we can ask the changeset if
it has errors:

```ts
cs.errors; // => []
```

And we can ask if it's valid or not:

```ts
cs.valid; // => true
```

The changeset does not have errors, and is valid. Therefore if we try to insert this changeset
it will work:

```ts
await repo.insert(cs);
// { ok: true, value: { id: 2, first_name: "Ryan", last_name: "Bigg", age: null } }
```

Since `repo.insert` returns a result, we can check `ok` to take different code paths depending on
what happens:

```ts
const result = await repo.insert(cs);
if (result.ok) {
  // do something with result.value
} else {
  // do something with result.changeset
}
```

**NOTE:** `cs.valid` will not check constraints (such as `uniqueConstraint`). For that, you will
need to attempt to do an insertion and check for errors from the database. It's for this reason
it's best practice to try inserting data and check the returned result from `repo.insert` to get
the correct errors, as prior to insertion the changeset will only contain validation errors from
the application itself.

If the insertion of the changeset succeeds, then you can do whatever you wish with the person
returned in that result. If it fails, then you have access to the changeset and its errors. In
the failure case, you may wish to present these errors to the end user. Each error has the
field, the validation message and the metadata for the message. Imagine that we had a field
called `bio` that we were validating, and that field has to be longer than 15 characters. This is
what would be returned:

```ts
[
  {
    field: "bio",
    message: "should be at least %{count} character(s)",
    meta: { count: 15, validation: "length", kind: "min", type: "string" },
  },
  {
    field: "first_name",
    message: "can't be blank",
    meta: { validation: "required" },
  },
  {
    field: "last_name",
    message: "can't be blank",
    meta: { validation: "required" },
  },
];
```

To display these error messages in a human friendly way, we can use
{@link ekto!traverseErrors | traverseErrors}, which fills the metadata into the messages:

```ts
import { traverseErrors } from "ekto";

traverseErrors(cs);
// {
//   last_name: ["can't be blank"],
//   first_name: ["can't be blank"],
//   bio: ["should be at least 15 character(s)"]
// }
```

One more final thing to mention here: you can trigger an exception to be thrown by using
`repo.insertOrThrow`. If a changeset is invalid, you will see an `InvalidChangesetError`. Here's
a quick example of that:

```ts
await repo.insertOrThrow(changeset(Person.new(), { first_name: "Ryan" }));
```

```
InvalidChangesetError: could not perform insert because changeset is invalid: last_name: can't be blank
```

The error's `changeset` holds the changes and the errors. This can be useful if you want to
insert a bunch of data and then have an exception thrown if that data is not inserted correctly
at all.

Now that we've covered inserting data into the database, let's look at how we can pull that data
back out.

## Our first queries

Querying a database requires two steps in ekto. First, we must construct the query and then we
must execute that query against the database by passing the query to the repo. Before we do
this, let's re-create the database for our app and set up some test data. To re-create the
database, we'll run these commands:

```bash
dropdb friends
createdb friends
pnpm ekto migrate
```

Then to create the test data, we'll run this in a script:

```ts
const people = [
  Person.new({ first_name: "Ryan", last_name: "Bigg", age: 28 }),
  Person.new({ first_name: "John", last_name: "Smith", age: 27 }),
  Person.new({ first_name: "Jane", last_name: "Smith", age: 26 }),
];

for (const person of people) await repo.insert(person);
```

This code will create three new people in our database, Ryan, John and Jane. Note here that we
could've used a changeset to validate the data going into the database, but the choice was made
not to use one.

We'll be querying for these people in this section. Let's jump in!

### Fetching a single record

ekto has no query language of its own: queries are [Kysely](https://kysely.dev) query builders,
which `repo.kysely` starts, typed with our `DB`. Let's start off with fetching just one record
from our `people` table:

```ts
const query = repo.kysely
  .selectFrom("people")
  .selectAll()
  .orderBy("id")
  .limit(1);
```

To execute the query that we've just constructed, we can call `repo.one`, with the schema to
load the rows as:

```ts
await repo.one(Person, query);
// { id: 1, first_name: "Ryan", last_name: "Bigg", age: 28 }
```

The `one` function retrieves just one record from our database and returns it as a `Person`.

Similarly, ordering the other way gives us the last person:

```ts
await repo.one(
  Person,
  repo.kysely.selectFrom("people").selectAll().orderBy("id", "desc").limit(1),
);
// { id: 3, first_name: "Jane", last_name: "Smith", age: 26 }
```

`repo.one` will only return a record if there is one row in the result from the database. If
there is more than one row returned, a `MultipleResultsError` is thrown. Some code that would
cause that issue to happen is:

```ts
await repo.one(Person);
```

We've left out the query here, and so there is no `limit` or `order by` clause applied to the
executed query. We'll see this error:

```
MultipleResultsError: expected at most one result but got 3 in query:

SELECT "id", "first_name", "last_name", "age" FROM "people"
```

This happens because ekto doesn't know what one record out of all the records returned that we
want. ekto will only return a result if we are explicit in our querying about which result we
want.

If there is no record which matches the query, `one` will return `null`.

### Fetching all records

To fetch all records from the schema, ekto provides the `all` function:

```ts
await repo.all(Person);
```

This will return a `Person` representation of all the records that currently exist within our
`people` table:

```ts
[
  { id: 1, first_name: "Ryan", last_name: "Bigg", age: 28 },
  { id: 2, first_name: "John", last_name: "Smith", age: 27 },
  { id: 3, first_name: "Jane", last_name: "Smith", age: 26 },
];
```

### Fetch a single record based on ID

To fetch a record based on its ID, you use the `get` function:

```ts
await repo.get(Person, 1);
// { id: 1, first_name: "Ryan", last_name: "Bigg", age: 28 }
```

### Fetch a single record based on a specific attribute

If we want to get a record based on something other than the `id` attribute, we can use `getBy`:

```ts
await repo.getBy(Person, { first_name: "Ryan" });
// { id: 1, first_name: "Ryan", last_name: "Bigg", age: 28 }
```

### Filtering results

If we want to get multiple records matching a specific attribute, we can use `where`:

```ts
await repo.all(
  Person,
  repo.kysely.selectFrom("people").selectAll().where("last_name", "=", "Smith"),
);
```

```ts
[
  { id: 2, first_name: "John", last_name: "Smith", age: 27 },
  { id: 3, first_name: "Jane", last_name: "Smith", age: 26 },
];
```

If we compile the query instead of running it, we will see the SQL that is generated:

```ts
repo.kysely
  .selectFrom("people")
  .selectAll()
  .where("last_name", "=", "Smith")
  .compile().sql;
// select * from "people" where "last_name" = $1
```

The values given to `where` are always sent as parameters (`$1`), never written into the SQL,
which protects against SQL injection. That's also why we can use variables freely:

```ts
const lastName = "Smith";
await repo.all(
  Person,
  repo.kysely
    .selectFrom("people")
    .selectAll()
    .where("last_name", "=", lastName),
);
```

### Composing queries

Queries don't have to be built in one spot. They can be built up by calling Kysely's functions on
existing queries. For instance, if we want to find all people with the last name "Smith", we can
do:

```ts
let query = repo.kysely
  .selectFrom("people")
  .selectAll()
  .where("last_name", "=", "Smith");
```

If we want to scope this down further to only people with the first name of "Jane", we can do
this:

```ts
query = query.where("first_name", "=", "Jane");
```

Our query will now have two `where` clauses in it:

```sql
select * from "people" where "last_name" = $1 and "first_name" = $2
```

This can be useful if you want to do something with the first query, and then build off that
query later on. The [Dynamic queries](../howtos/dynamic-queries.md) guide shows more.

## Updating records

Updating records in ekto requires us to first fetch a record from the database. We then create a
changeset from that record and the changes we want to make to that record, and then call the
`repo.update` function.

Let's fetch the first person from our database and change their age. First, we'll fetch the
person:

```ts
const person = await repo.oneOrThrow(
  Person,
  repo.kysely.selectFrom("people").selectAll().orderBy("id").limit(1),
);
```

Next, we'll build a changeset. We need to build a changeset because if we just create a new
person record with the new age, ekto wouldn't be able to know that the age has changed without
inspecting the database. Let's build that changeset:

```ts
const cs = changeset(person, { age: 29 });
```

This changeset will inform the database that we want to update the record to have the `age` set
to 29. To tell the database about the change we want to make, we run this command:

```ts
await repo.update(cs);
```

Just like `repo.insert`, `repo.update` will return a result:

```ts
// { ok: true, value: { id: 1, first_name: "Ryan", last_name: "Bigg", age: 29 } }
```

If the changeset fails for any reason, the result of `repo.update` will be
`{ ok: false, changeset }`. We can see this in action by passing through a blank `first_name` in
our changeset's parameters:

```ts
await repo.update(changeset(person, { first_name: "" }));
// {
//   ok: false,
//   changeset: {
//     action: "update",
//     changes: {},
//     errors: [{ field: "first_name", message: "can't be blank", meta: { validation: "required" } }],
//     data: { id: 1, first_name: "Ryan", last_name: "Bigg", age: 28 },
//     valid: false
//   }
// }
```

This means that you can also check `ok` to do different things depending on the outcome of the
`update` function:

```ts
const result = await repo.update(cs);
if (result.ok) {
  // do something with result.value
} else {
  // do something with result.changeset
}
```

Similar to `insertOrThrow`, there is also `updateOrThrow` which will throw an
`InvalidChangesetError` if the changeset is invalid:

```ts
await repo.updateOrThrow(changeset(person, { first_name: "" }));
```

```
InvalidChangesetError: could not perform update because changeset is invalid: first_name: can't be blank
```

## Deleting records

We've now covered creating (`insert`), reading (`get`, `getBy`, `where`) and updating records.
The last thing that we'll cover in this guide is how to delete a record using ekto.

Similar to updating, we must first fetch a record from the database and then call `repo.delete`
to delete that record:

```ts
const person = await repo.getOrThrow(Person, 1);
await repo.delete(person);
// { ok: true, value: { id: 1, first_name: "Ryan", last_name: "Bigg", age: 29 } }
```

Similar to `insert` and `update`, `delete` returns a result. If the deletion succeeds, then `ok`
will be `true`, but if it fails then it will be `false`.

## Using SQLite

To follow this guide with SQLite instead of PostgreSQL, install `sqlite3` instead of `pg`:

```bash
pnpm add ekto kysely sqlite3
```

and use the SQLite adapter, with the path of the database file, in `src/repo.ts` and
`ekto.config.ts`:

```ts
import { createRepo } from "ekto";
import { type KyselyDB, sqlite } from "ekto/sqlite";
import { Person } from "./person.ts";

export type DB = KyselyDB<[typeof Person]>;

export const repo = createRepo<DB>({
  adapter: sqlite(),
  database: "friends.db",
});
```

SQLite creates the database file when it first connects, so there is no `createdb`; to re-create
the database, delete the file. The migration and the rest of the code stay the same. Only the SQL
that Kysely generates differs, using `?` for parameters instead of `$1`.
