---

title: Dynamic queries
group: How-To's
---

# Dynamic queries

ekto has no query language of its own: queries are [Kysely](https://kysely.dev) query builders,
typed with the tables your schemas describe. This guide follows Ecto's
[Dynamic queries](https://hexdocs.pm/ecto/dynamic-queries.html) and shows how its ideas map to
Kysely. The examples use PostgreSQL: on SQLite, `utc_datetime` columns are typed as ISO 8601
strings, so you compare them with strings rather than `Date`s. The examples start their queries
with `from`, defined beside the repo:

```ts
// src/repo.ts
export const { from, kysely } = queries<DB>();
```

`from(Post)` selects the columns of the `Post` schema from its table, and we chain calls on it:

```ts
from(Post)
  .where("author", "=", "José")
  .where("category", "=", "Elixir")
  .where("published_at", ">", minimumDate)
  .orderBy("published_at", "desc");
```

Queries are composable. For example, imagine you want to abstract the `published_at` filtering
and sorting into a function. A function taking a query and returning it refined can be applied
with Kysely's `$call`:

```ts
import type { SelectQueryBuilder } from "kysely";
import { type DB, from, repo } from "./repo.ts";

function mostRecentFrom<O>(minimumDate: Date) {
  return (query: SelectQueryBuilder<DB, "posts", O>) =>
    query
      .where("published_at", ">", minimumDate)
      .orderBy("published_at", "desc");
}

await repo.all(from(Post).$call(mostRecentFrom(minimumDate)));
```

The examples above show you can build and compose queries at a high-level: by composing each call
to `where`, `orderBy`, and so on. However, sometimes you want the contents of the `where` or the
`orderBy` themselves to be defined dynamically. For example, a web application that provides
search functionality on top of existing posts. The user should be able to specify multiple
criteria, such as the author name, the post category, publishing interval, etc.

## Focusing on data structures

Each call returns a new query, so a query can be refined conditionally, as ordinary code:

```ts
let query = from(Post)
  .where("author", "=", "José")
  .where("category", "=", "Elixir")
  .orderBy("published_at", "desc");

if (params.published_at !== undefined)
  query = query.where("published_at", "<", params.published_at);
```

Kysely's `$if` does the same inside the chain:

```ts
from(Post).$if(params.published_at !== undefined, (q) =>
  q.where("published_at", "<", params.published_at!),
);
```

## Dynamic expressions

For cases where we want to build the condition itself dynamically, Kysely's expression builder
(`eb`) plays the role of Ecto's `dynamic`. `where` accepts a function receiving `eb`, and the
function can return any expression: `eb(column, operator, value)` is one comparison, and
`eb.and([...])` and `eb.or([...])` combine a list of them. `eb.and([])` is true (`1 = 1`) and `eb.or([])`
is false (`1 = 0`).

For example, imagine that in the example above you may optionally filter posts by a date of
publication:

```ts
from(Post)
  .where((eb) =>
    params.published_at !== undefined
      ? eb("published_at", "<", params.published_at)
      : eb.and([]),
  )
  .orderBy("published_at", "desc");
```

The expressions are built when the query is, from plain data, so we can decouple the processing of
parameters from the query generation. Let's see a more complex example.

## Building dynamic queries

Let's go back to the original problem. We want to build a search functionality where the user can
configure how to traverse all posts in many different ways. For example, the user may choose how
to order the data, filter by author and category, as well as select posts published after a
certain date.

To tackle this, we can break our problem into a bunch of small functions, that build either data
structures or expressions, and then we apply them to the query:

```ts
import type { ExpressionBuilder, SelectQueryBuilder } from "kysely";

type Params = Record<string, string | undefined>;

export function filter(params: Params) {
  return from(Post)
    .where((eb) => filterWhere(eb, params))
    .$call(filterOrderBy(params.order_by));
}

function filterOrderBy(orderBy: string | undefined) {
  return <O>(q: SelectQueryBuilder<DB, "posts", O>) => {
    switch (orderBy) {
      case "published_at_desc":
        return q.orderBy("published_at", "desc");
      case "published_at":
        return q.orderBy("published_at", "asc");
      default:
        return q;
    }
  };
}

function filterWhere(
  eb: ExpressionBuilder<DB, "posts">,
  params: Params,
) {
  const conditions = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    switch (key) {
      case "author":
        conditions.push(eb("author", "=", value));
        break;
      case "category":
        conditions.push(eb("category", "=", value));
        break;
      case "published_at":
        conditions.push(eb("published_at", ">", new Date(value)));
        break;
      // Not a where parameter
    }
  }
  return eb.and(conditions);
}
```

Because we were able to break our problem into smaller functions that receive regular data
structures, we can use all the tools available in TypeScript to work with data. For handling the
`order_by` parameter, it may be best to simply switch on it. For building the `where` clause, we
collect a list of conditions as we traverse the parameters, and `eb.and` of an empty list is true.

Testing also becomes simpler, as each function can be tested on its own, and the query is data
until a Repo runs it: `repo.toSql` gives its SQL and parameters without running it.

```ts
test("filter published at based on the given date", () => {
  assert.match(repo.toSql(filter({})).sql, / where 1 = 1$/);
  assert.deepEqual(repo.toSql(filter({ published_at: "2010-04-17" })), {
    sql: 'select "posts"."id", "posts"."author", "posts"."author_id", "posts"."category", "posts"."published_at" from "posts" where "published_at" > $1',
    params: [new Date("2010-04-17")],
  });
});
```

## Dynamic and joins

Even query joins can be tackled dynamically. For example, let's do two modifications to the
example above. Let's say we can also sort by author name (`author_name` and `author_name_desc`)
and at the same time let's say that authors are in a separate table, which means our author filter
in `filterWhere` now needs to go through the join.

Our final solution would look like this:

```ts
export function filter(params: Params) {
  return (
    from(Post)
      // 1. Join the authors, with a name to refer to them by
      .innerJoin("authors", "authors.id", "posts.author_id")
      .where((eb) => filterWhere(eb, params))
      .$call(filterOrderBy(params.order_by))
  );
}

// 2. Order by a column of the join
function filterOrderBy(orderBy: string | undefined) {
  return <O>(q: SelectQueryBuilder<DB, "posts" | "authors", O>) => {
    switch (orderBy) {
      case "published_at_desc":
        return q.orderBy("posts.published_at", "desc");
      case "published_at":
        return q.orderBy("posts.published_at", "asc");
      case "author_name_desc":
        return q.orderBy("authors.name", "desc");
      case "author_name":
        return q.orderBy("authors.name", "asc");
      default:
        return q;
    }
  };
}

// 3. Change the author condition to the joined table
function filterWhere(
  eb: ExpressionBuilder<DB, "posts" | "authors">,
  params: Params,
) {
  const conditions = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    switch (key) {
      case "author":
        conditions.push(eb("authors.name", "=", value));
        break;
      case "category":
        conditions.push(eb("posts.category", "=", value));
        break;
      case "published_at":
        conditions.push(eb("posts.published_at", ">", new Date(value)));
        break;
      // Not a where parameter
    }
  }
  return eb.and(conditions);
}
```

Since `from(Post)` selects the columns of `posts` qualified with the table (`"posts"."id"`, and
so on), the join adds no columns and they do not clash with those of `authors`:
`repo.all(filter(params))` still loads its rows as posts. Adding more filters in the future is
simply a matter of adding more cases to the `switch` in `filterWhere`.
