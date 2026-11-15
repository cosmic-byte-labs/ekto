import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  association,
  associations,
  belongsTo,
  buildAssoc,
  hasMany,
  hasOne,
  isLoaded,
  manyToMany,
  type Preloaded,
  type PreloadSpec,
} from "./association.ts";
import { type Infer, load, schema, t } from "./schema.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

class User extends schema("users", {
  id: t.id(),
  email: t.string(),
}) {
  static associations = {
    posts: hasMany(() => Post, { foreignKey: "author_id" }),
    profile: hasOne(() => Profile, { foreignKey: "user_id" }),
  };
}

class Post extends schema("posts", {
  id: t.id(),
  title: t.string(),
  author_id: t.integer().nullable(),
}) {
  static associations = {
    author: belongsTo(() => User),
    comments: hasMany(() => Comment, { foreignKey: "post_id" }),
    tags: manyToMany(() => Tag, {
      joinThrough: "posts_tags",
      joinKeys: { post_id: "id", tag_id: "id" },
    }),
  };
}

class Comment extends schema("comments", {
  id: t.id(),
  body: t.string(),
  post_id: t.integer(),
}) {
  static associations = {
    post: belongsTo(() => Post, { foreignKey: "post_id" }),
  };
}

const Profile = schema("profiles", { id: t.id(), user_id: t.integer() });
const Tag = schema("tags", { id: t.id(), name: t.string() });

describe("association reflection", () => {
  test("resolves keys as Ecto does", () => {
    const author = association(Post, "author");
    assert.equal(author.kind, "belongsTo");
    assert.equal(author.cardinality, "one");
    assert.equal(author.owner, Post);
    assert.equal(author.related, User);
    assert.equal(author.ownerKey, "author_id", "defaults to <name>_id");
    assert.equal(author.relatedKey, "id");

    const posts = association(User, "posts");
    assert.equal(posts.cardinality, "many");
    assert.equal(posts.ownerKey, "id", "defaults to the primary key");
    assert.equal(posts.relatedKey, "author_id");

    const tags = association(Post, "tags");
    assert.equal(tags.ownerKey, "id");
    assert.equal(tags.relatedKey, "id");
    assert.deepEqual(tags.join, {
      source: "posts_tags",
      ownerKey: "post_id",
      relatedKey: "tag_id",
    });

    assert.deepEqual(
      [...associations(Post).keys()],
      ["author", "comments", "tags"],
    );
    assert.equal(associations(Tag).size, 0);
  });

  test("throws for an unknown association", () => {
    assert.throws(
      () => association(Post, "nope"),
      /schema posts does not have association "nope"/,
    );
  });

  test("takes the join table from a schema", () => {
    const PostTag = schema("posts_tags", {
      post_id: t.integer(),
      tag_id: t.integer(),
    });
    class P extends schema("posts", { id: t.id() }) {
      static associations = {
        tags: manyToMany(() => Tag, {
          joinThrough: PostTag,
          joinKeys: { post_id: "id", tag_id: "id" },
        }),
      };
    }
    assert.equal(association(P, "tags").join?.source, "posts_tags");
  });

  test("checks associations when first used", () => {
    const cases: [() => unknown, RegExp][] = [
      [
        () =>
          class extends schema("a", { id: t.id() }) {
            static associations = { user: belongsTo(() => User) };
          },
        /schema a does not have the field user_id used by association user/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id(), user_id: t.integer() }) {
            static associations = {
              user: belongsTo(() => User, { references: "nope" }),
            };
          },
        /associated schema users does not have field nope/,
      ],
      [
        () =>
          class extends schema("a", { name: t.string() }) {
            static associations = {
              posts: hasMany(() => Post, { foreignKey: "author_id" }),
            };
          },
        /need to set the references option for association posts when schema a has no single primary key/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id() }) {
            static associations = {
              posts: hasMany(() => Post, {
                foreignKey: "author_id",
                references: "nope",
              }),
            };
          },
        /schema a does not have the field nope used by association posts, please set the references option/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id() }) {
            static associations = {
              posts: hasMany(() => Post, { foreignKey: "a_id" }),
            };
          },
        /associated schema posts does not have field a_id/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id() }) {
            static associations = {
              tags: manyToMany(() => Tag, {
                joinThrough: "a_tags",
                joinKeys: { a_id: "id" },
              }),
            };
          },
        /manyToMany tags expects joinKeys to be an object with two entries/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id() }) {
            static associations = {
              tags: manyToMany(() => Tag, {
                joinThrough: "a_tags",
                joinKeys: { a_id: "uuid", tag_id: "id" },
              }),
            };
          },
        /schema a does not have the field uuid used by association tags, please set the joinKeys option/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id(), user: t.integer() }) {
            static associations = {
              user: belongsTo(() => User, { foreignKey: "user" }),
            };
          },
        /field\/association user already exists on schema a/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id(), user_id: t.integer() }) {
            static associations = { user: belongsTo(() => "users") };
          },
        /association user of schema a: the related value is not a schema/,
      ],
      [
        () =>
          class extends schema("a", { id: t.id() }) {
            static associations = {
              user: { kind: "belongsTo", related: () => User },
            };
          },
        /association user of schema a must be created with belongsTo, hasMany, hasOne or manyToMany/,
      ],
      [
        () =>
          class extends schema("a", {
            id: t.id(),
            password: t.string().virtual(),
          }) {
            static associations = {
              posts: hasMany(() => Post, {
                foreignKey: "author_id",
                references: "password",
              }),
            };
          },
        /schema a does not have the field password/,
      ],
    ];
    for (const [define, error] of cases) {
      const Schema = define();
      assert.throws(
        // biome-ignore lint/suspicious/noExplicitAny: any schema
        () => associations(Schema as any),
        error,
      );
    }
  });
});

describe("association records", () => {
  test("buildAssoc sets the key for has associations (build_assoc)", () => {
    const user = load(User, { id: 7, email: "a@b.c" });
    const post = buildAssoc(user, "posts", { title: "Hi" });
    assert.deepEqual({ ...post }, { id: null, title: "Hi", author_id: 7 });
    type _post = Expect<Equal<typeof post.author_id, number | null>>;

    const profile = buildAssoc(user, "profile");
    assert.equal(profile.user_id, 7);

    const loaded = load(Post, { id: 1, title: "x", author_id: 7 });
    const author = buildAssoc(loaded, "author", { email: "c@d.e" });
    assert.equal(author.id, null, "belongsTo sets no key");
    assert.equal(author.email, "c@d.e");
    const tag = buildAssoc(loaded, "tags");
    assert.equal(tag.name, null);

    assert.throws(
      () => buildAssoc({} as never, "posts" as never),
      /buildAssoc expects a record created by a schema/,
    );
  });

  test("isLoaded tells whether an association is set (assoc_loaded?)", () => {
    const post = load(Post, { id: 1, title: "x", author_id: null });
    assert.equal(isLoaded(post, "author"), false);
    assert.equal(isLoaded({ ...post, author: null }, "author"), true);
  });
});

describe("association types", () => {
  test("Preloaded adds the loaded associations", () => {
    type P = Preloaded<typeof Post, { author: true; comments: "post" }>;
    type _author = Expect<Equal<P["author"], Preloaded<typeof User> | null>>;
    type _comments = Expect<
      Equal<P["comments"], Preloaded<typeof Comment, "post">[]>
    >;
    type _post = Expect<
      Equal<P["comments"][number]["post"], Infer<typeof Post> | null>
    >;
    type _notLoaded = Expect<
      Equal<"tags" extends keyof P ? true : false, false>
    >;

    type L = Preloaded<typeof Post, ["author", { tags: true }]>;
    type _list = Expect<Equal<L["tags"], Infer<typeof Tag>[]>>;
    type _listAuthor = Expect<Equal<L["author"], Infer<typeof User> | null>>;

    type F = Preloaded<
      typeof User,
      { posts: [(q: never) => never, "comments"] }
    >;
    type _refined = Expect<
      Equal<F["posts"][number]["comments"], Infer<typeof Comment>[]>
    >;
    assert.ok(true);
  });

  test("PreloadSpec accepts only association names", () => {
    const ok: PreloadSpec<typeof Post>[] = [
      "author",
      ["author", "tags"],
      { author: true, comments: { post: "author" } },
      { comments: (q) => q.orderBy("id") },
      { comments: [(q) => q, ["post"]] },
    ];
    // @ts-expect-error not an association
    const bad: PreloadSpec<typeof Post> = "title";
    // @ts-expect-error not an association of comments
    const nested: PreloadSpec<typeof Post> = { comments: "tags" };
    assert.ok(ok && bad && nested);
  });
});
