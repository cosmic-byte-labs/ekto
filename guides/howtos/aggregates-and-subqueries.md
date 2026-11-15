---

title: Aggregates and subqueries
group: How-To's
---

# Aggregates and subqueries

Now it's time to discuss aggregates and subqueries. As we will learn, one builds directly on the
other. This guide follows Ecto's
[Aggregates and subqueries](https://hexdocs.pm/ecto/aggregates-and-subqueries.html).

## Aggregates

ekto includes a convenience function in repositories to calculate aggregates.

For example, if we assume every post has an integer column named `visits`, we can find the
average number of visits across all posts with:

```ts
await repo.aggregate(Post, "avg", "visits");
// => 1743
```

Behind the scenes, the query above translates to:

```ts
await repo.one(
  repo.kysely
    .selectFrom("posts")
    .select((eb) => eb.fn.avg("visits").as("value")),
);
```

`repo.aggregate` supports `count`, `avg`, `sum`, `min` and `max`. On a schema, the result is
loaded with the field's type, and `avg` of an integer field is a number.

At first, it looks like the implementation of `aggregate` is quite straight-forward. You could
even start to wonder why it was added to ekto in the first place. However, complexities start to
arise on queries that rely on `limit`, `offset` or `distinct` clauses.

Imagine that instead of calculating the average of all posts, you want the average of only the
top 10. Your first try may be:

```ts
await repo.one(
  repo.kysely
    .selectFrom("posts")
    .select((eb) => eb.fn.avg("visits").as("value"))
    .orderBy("visits", "desc")
    .limit(10),
);
```

Oops. The query above does not even run on PostgreSQL, as `visits` would have to be grouped to be
ordered by, and on SQLite it returns the same value as the queries before. The `limit(10)` has no
effect here since it is limiting the aggregated result and queries with aggregates return only a
single row anyway. In order to retrieve the correct result, we would need to first find the top
10 posts and only then aggregate. That's exactly what `aggregate` does when given a query:

```ts
const query = repo.kysely
  .selectFrom("posts")
  .selectAll()
  .orderBy("visits", "desc")
  .limit(10);

await repo.aggregate(query, "avg", "visits");
// => "4682.0000000000000000" on PostgreSQL
```

Given a query, `aggregate` wraps it in a subquery. Therefore the query executed by `aggregate`
above is rather equivalent to:

```ts
const innerQuery = repo.kysely
  .selectFrom("posts")
  .selectAll()
  .orderBy("visits", "desc")
  .limit(10);

await repo.one(
  repo.kysely
    .selectFrom(innerQuery.as("q"))
    .select((eb) => eb.fn.avg("q.visits").as("value")),
);
```

As a query has no schema to load its result with, `avg`, `sum`, `min` and `max` over a query are
returned as the driver gives them: PostgreSQL's `avg` is a `numeric`, which node-postgres returns
as a string. `count` is always a number.

Let's take a closer look at subqueries.

## Subqueries

In the previous section we have already learned some queries that would be hard to express
without support for subqueries.

In ekto, queries are [Kysely](https://kysely.dev) query builders, and a query becomes a subquery
by giving it a name with `.as(name)`. A subquery can be used where a table can: in `selectFrom`
and in joins. All columns selected in a subquery can be accessed from the parent query, and
Kysely keeps their types: if you write `q.column_that_does_not_exist`, your query won't type
check. Let's revisit the aggregate query we saw in the previous section:

```ts
const innerQuery = repo.kysely
  .selectFrom("posts")
  .selectAll()
  .orderBy("visits", "desc")
  .limit(10);

await repo.one(
  repo.kysely
    .selectFrom(innerQuery.as("q"))
    .select((eb) => eb.fn.avg("q.visits").as("value")),
);
```

Because the inner query selects all columns of `posts`, all of them are available on the parent
query, such as `q.visits`.

If you need to reference the parent in the subquery, you can do so with the parent's table name
(or its alias) inside the subquery, as Kysely's correlated subqueries do. Here is an example that
counts the comments of each post:

```ts
await repo.all(
  repo.kysely.selectFrom("posts").select((eb) => [
    "posts.id",
    eb
      .selectFrom("comments")
      .whereRef("comments.post_id", "=", "posts.id")
      .select((eb) => eb.fn.countAll().as("count"))
      .as("comments"),
  ]),
);
```

Let's see one last example. Imagine you manage a library (as in an actual library in the real
world) and there is a table that logs every time the library lends a book. The `lendings` table
uses an auto-incrementing primary key and can be backed by the following schema:

```ts
import { belongsTo, schema, t } from "ekto";

export class Lending extends schema("lendings", {
  id: t.id(),
  book_id: t.integer(),
  visitor_id: t.integer(),
}) {
  static associations = {
    book: belongsTo(() => Book),
    visitor: belongsTo(() => Visitor),
  };
}
```

Now consider we want to retrieve the name of every book alongside the name of the last person the
library has lent it to. To do so, we need to find the last lending ID of every book, and then join
on the book and visitor tables. With subqueries, that's straight-forward:

```ts
const lastLendings = repo.kysely
  .selectFrom("lendings")
  .groupBy("book_id")
  .select((eb) => ["book_id", eb.fn.max("id").as("last_lending_id")]);

await repo.all(
  repo.kysely
    .selectFrom("lendings as l")
    .innerJoin(lastLendings.as("last"), "last.last_lending_id", "l.id")
    .innerJoin("books as b", "b.id", "l.book_id")
    .innerJoin("visitors as v", "v.id", "l.visitor_id")
    .select(["b.name as book", "v.name as visitor"]),
);
// [{ book: "Dune", visitor: "Ann" }, ...]
```

Without a schema, `repo.all` returns the rows as the driver gives them.
