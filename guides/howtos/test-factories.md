---

title: Test factories
group: How-To's
---

# Test factories

Many projects depend on external libraries to build their test data. Some of those libraries are
called factories because they provide convenience functions for producing different groups of
data. However, given records are plain objects and the repo inserts them, we can implement such
functionality without relying on third-party projects. This guide follows Ecto's
[Test factories](https://hexdocs.pm/ecto/test-factories.html).

To get started, let's create a file at `test/support/factory.ts` with the following contents:

```ts
import { buildAssoc } from "ekto";
import { Comment, Post, User } from "../../src/schemas.ts";
import { repo } from "../../src/repo.ts";

let unique = 0;

// Factories

const factories = {
  post: () => Post.new({ title: "hello world" }),
  comment: () => Comment.new({ body: "good post" }),
  user: () => {
    unique++;
    return User.new({
      email: `hello${unique}`,
      username: `hello${unique}`,
    });
  },
};

type Factories = typeof factories;
type Built<K extends keyof Factories> = ReturnType<Factories[K]>;

// Convenience API

export function build<K extends keyof Factories>(
  name: K,
  attributes: Partial<Built<K>> = {},
): Built<K> {
  return Object.assign(factories[name](), attributes) as Built<K>;
}

export function insert<K extends keyof Factories>(
  name: K,
  attributes: Partial<Built<K>> = {},
) {
  return repo.insertOrThrow(build(name, attributes));
}

export async function insertPostWithComments() {
  const post = await insert("post", { title: "hello with comments" });
  const comments = [
    await repo.insertOrThrow(
      buildAssoc(post, "comments", { body: "first" }),
    ),
    await repo.insertOrThrow(
      buildAssoc(post, "comments", { body: "second" }),
    ),
  ];
  return { ...post, comments };
}
```

Our factory module defines three "factories" as functions building records: `post`, `comment` and
`user`. Each defines records with the fields that are required by the database. In certain cases,
the generated record also needs to generate unique fields, such as the user's email and username.
We did so with a counter; you could use `crypto.randomUUID()` instead if tests run in several
processes against the same database.

At the end, we defined three functions: `build` and `insert`, which are conveniences for building
records with specific attributes and for inserting data directly in the repository respectively
(`build` assigns the attributes onto the record the factory built, as a spread would lose the
schema the record belongs to),
and `insertPostWithComments`. ekto does not insert associations together with their parent, so it
inserts the post first and then its comments, with
{@link ekto!buildAssoc | buildAssoc} setting their `post_id`.

That's literally all that is necessary for building our factories. We are now ready to use them in
our tests. In any of the tests that need to generate data, we can import the factory module and use
its functions:

```ts
import { build, insert } from "./support/factory.ts";

build("post");
// { id: null, title: "hello world", ... }

build("post", { title: "custom title" });
// { id: null, title: "custom title", ... }

await insert("post", { title: "custom title" });
// { id: ..., title: "custom title", ... }
```

With the [test sandbox](../testing/testing-with-ekto.md), what the factories insert is rolled back
at the end of each test.

By building the functionality we need on top of ekto's capabilities, we are able to extend and
improve our factories in whatever way we desire, without being constrained to third-party
limitations.
