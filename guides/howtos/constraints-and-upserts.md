---

title: Constraints and upserts
group: How-To's
---

# Constraints and upserts

In this guide we will learn how to use constraints and upserts. To showcase those features, we
will work on a practical scenario: a many to many relationship between posts and tags. It
follows Ecto's [Constraints and Upserts](https://hexdocs.pm/ecto/constraints-and-upserts.html) guide.

## Posts and tags

Imagine we are building an application that has blog posts and such posts may have many tags.
Not only that, a given tag may also belong to many posts. This is a classic scenario where we
would use {@link ekto!manyToMany | manyToMany} associations. Our migration would look like:

```ts
import { migration, references, table, uniqueIndex } from "ekto/migrate";

export default migration({
  change(m) {
    m.create(table("posts"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("title", "string");
      t.add("body", "text");
      t.timestamps();
    });

    m.create(table("tags"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("name", "string", { null: false });
      t.timestamps();
    });

    m.create(uniqueIndex("tags", ["name"]));

    m.create(table("posts_tags"), (t) => {
      t.add("post_id", references("posts"), { null: false });
      t.add("tag_id", references("tags"), { null: false });
    });
  },
});
```

Note we added a unique index to the tag name because we don't want to have duplicated tags in our
database. It is important to add an index at the database level instead of using a validation
since there is always a chance two tags with the same name would be validated and inserted
simultaneously, passing the validation and leading to duplicated entries.

The schemas are:

```ts
import { type Infer, manyToMany, schema, t } from "ekto";

export class Post extends schema("posts", {
  id: t.id(),
  title: t.string().nullable(),
  body: t.string().nullable(),
  ...t.timestamps(),
}) {
  static associations = {
    tags: manyToMany(() => Tag, {
      joinThrough: "posts_tags",
      joinKeys: { post_id: "id", tag_id: "id" },
    }),
  };
}
export const Tag = schema("tags", {
  id: t.id(),
  name: t.string(),
  ...t.timestamps(),
});
export type Tag = Infer<typeof Tag>;
```

Now let's also imagine we want the user to input such tags as a list of words split by comma,
such as: "elixir, erlang, ecto". Once this data is received in the server, we will break it apart
into multiple tags and associate them to the post, creating any tag that does not yet exist in the
database.

ekto does not write associations through the parent's changeset (Ecto's `put_assoc` and
`cast_assoc`): we insert the post, get or insert each tag, and then insert the rows of the join
table. Let's write a function that does that:

```ts
export async function createPost(params: {
  title: string;
  body: string;
  tags?: string;
}) {
  const post = await repo.insertOrThrow(
    cast(Post.new(), params, ["title", "body"]),
  );
  const tags = await parseTags(params.tags);
  if (tags.length > 0)
    await repo.exec(
      repo.kysely
        .insertInto("posts_tags")
        .values(tags.map((tag) => ({ post_id: post.id, tag_id: tag.id }))),
    );
  return post;
}

async function parseTags(tags = "") {
  const names = tags
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const result = [];
  for (const name of names) result.push(await getOrInsertTag(name));
  return result;
}

async function getOrInsertTag(name: string) {
  return (
    (await repo.getBy(Tag, { name })) ??
    (await repo.insertOrThrow(change(Tag.new(), { name })))
  );
}
```

`parseTags` checks for the parameter, breaks each tag apart with `split`, then removes any left
over whitespace with `trim`, rejects any empty string and finally checks if the tag exists in the
database or not, creating one in case none exists. `repo.exec` runs the insert into the join
table, which has no schema of its own.

However, our code is not yet ready for production. Let's see why.

## Constraints and race conditions

Remember we added a unique index to the tag `name` column when creating the tags table. We did so
to protect us from having duplicate tags in the database.

By adding the unique index and then using `repo.getBy` with a `repo.insertOrThrow` to get or
insert a tag, we introduced a potential error in our application. If two posts are submitted at
the same time with a similar tag, there is a chance we will check if the tag exists at the same
time, leading both submissions to believe there is no such tag in the database. When that
happens, only one of the submissions will succeed while the other one will fail. That's a race
condition: your code will error from time to time, only when certain conditions are met. And
those conditions are time sensitive.

Luckily ekto gives us a mechanism to handle constraint errors from the database.

## Checking for constraint errors

Since our `getOrInsertTag(name)` function fails when a tag already exists in the database, we
need to handle such scenarios accordingly. Let's rewrite it taking race conditions into account:

```ts
async function getOrInsertTag(name: string) {
  const result = await repo.insert(
    pipe(change(Tag.new(), { name }), uniqueConstraint("name")),
  );
  if (result.ok) return result.value;
  return repo.getByOrThrow(Tag, { name });
}
```

Instead of inserting the tag directly, we now build a changeset, which allows us to use the
{@link ekto!uniqueConstraint | uniqueConstraint} annotation. Now if the `repo.insert` operation
fails because the unique index for `name` is violated, ekto won't throw, but return
`{ ok: false, changeset }`. Therefore, if `repo.insert` succeeds, it is because the tag was
saved, otherwise the tag already exists, which we then fetch with `repo.getByOrThrow`.

While the mechanism above fixes the race condition, it is a quite expensive one: we need to
perform two queries for every tag that already exists in the database: the (failed) insert and
then the repository lookup. Given that's the most common scenario, we may want to rewrite it to
the following:

```ts
async function getOrInsertTag(name: string) {
  return (await repo.getBy(Tag, { name })) ?? (await maybeInsertTag(name));
}

async function maybeInsertTag(name: string) {
  const result = await repo.insert(
    pipe(change(Tag.new(), { name }), uniqueConstraint("name")),
  );
  if (result.ok) return result.value;
  return repo.getByOrThrow(Tag, { name });
}
```

The above performs 1 query for every tag that already exists, 2 queries for every new tag and
possibly 3 queries in the case of race conditions. While the above would perform slightly better
on average, ekto has a better option in stock.

**NOTE:** On PostgreSQL, a failed insert inside a transaction aborts the transaction, so the
lookup after it fails too. Outside a transaction, as here, each query stands on its own.

## Upserts

ekto supports the so-called "upsert" command which is an abbreviation for "update or insert".
The idea is that we try to insert a record and in case it conflicts with an existing entry, for
example due to a unique index, we can choose how we want the database to act by either raising
an error (the default behaviour), ignoring the insert (no error) or by updating the conflicting
database entries.

"upsert" in ekto is done with the `onConflict` option. Let's rewrite `getOrInsertTag(name)` once
more but this time using the `onConflict` option.

Your first try in using `onConflict` may be by setting it to `"nothing"`, as below:

```ts
async function getOrInsertTag(name: string) {
  return repo.insertOrThrow(Tag.new({ name }), { onConflict: "nothing" });
}
```

While the above won't throw an error in case of conflicts, it also won't read anything back, so
it will return a tag without an id. One solution is to force an update to happen in case of
conflicts, even if the update is about setting the tag name to its current name. In such cases,
ekto also requires the `conflictTarget` option to be given, which is the column (or a list
of columns) we are expecting the conflict to happen:

```ts
async function getOrInsertTag(name: string) {
  return repo.insertOrThrow(Tag.new({ name }), {
    onConflict: { replace: ["name"] },
    conflictTarget: ["name"],
  });
}
```

And that's it! We try to insert a tag with the given name and if such tag already exists, we tell
ekto to update its name to the current value, updating the tag and fetching its id. While the
above is certainly a step up from all solutions so far, it still performs one query per tag. If 10
tags are sent, we will perform 10 queries. Can we further improve this?

## Upserts and insertAll

ekto accepts the `onConflict` option not only in `repo.insert` but also in the `repo.insertAll`
function. This means we can build one query that attempts to insert all missing tags and then
another query that fetches all of them at once. Let's see how `parseTags` will look after
those changes:

```ts
async function parseTags(tags = "") {
  const names = tags
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return insertAndGetAll(names);
}

async function insertAndGetAll(names: string[]) {
  if (names.length === 0) return [];
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await repo.insertAll(
    Tag,
    names.map((name) => ({ name, inserted_at: now, updated_at: now })),
    { onConflict: "nothing" },
  );
  return repo.all(
    Tag,
    repo.kysely.selectFrom("tags").selectAll().where("name", "in", names),
  );
}
```

Instead of getting and inserting each tag individually, the code above works on all tags at once,
first by building a list of entries which is given to `repo.insertAll`. Then we look up all tags
with the given names. Regardless of how many tags are sent, we will perform only 2 queries -
unless no tag is sent, in which case we return an empty list back promptly. This solution is only
possible thanks to the `onConflict` option, which guarantees `insertAll` won't fail in case a
unique index is violated, such as from duplicate tag names. Remember, `insertAll` won't
autogenerate values like timestamps. That's why we set `inserted_at` and `updated_at` ourselves,
to the current time truncated to seconds, as `t.timestamps()` are `utc_datetime` fields.

Finally, keep in mind that we haven't used transactions in any of the examples so far. That
decision was deliberate as we relied on the fact that getting or inserting tags is an idempotent
operation, i.e. we can repeat it many times for a given input and it will always give us the same
result back. Therefore, even if we fail to introduce the post to the database due to a validation
error, the user will be free to resubmit the form and we will just attempt to get or insert the
same tags once again. The downside of this approach is that tags will be created even if creating
the post fails, which means some tags may not have posts associated to them. In case that's not
desired, the whole operation could be wrapped in a transaction with `repo.transact` or modeled
with {@link ekto!Multi | Multi}.
