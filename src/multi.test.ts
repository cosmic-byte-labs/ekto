import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Changeset, change } from "./changeset.ts";
import { Multi } from "./multi.ts";
import { schema, t } from "./schema.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

const Post = schema("posts", { id: t.id(), title: t.string() });

describe("Multi", () => {
  test("is immutable data; building runs nothing", () => {
    const empty = Multi.new();
    const one = empty.put("a", 1);
    assert.notEqual(one, empty);
    assert.deepEqual(empty.toList(), []);
    assert.deepEqual(one.toList(), [["a", { kind: "put", value: 1 }]]);
    assert.ok(one.has("a"));
    assert.ok(!empty.has("a"));
    assert.ok(Object.isFrozen(one));
  });

  test("names must be unique", () => {
    assert.throws(
      () => Multi.new().put("a", 1).put("a", 2),
      /"a" is already a member of the Multi/,
    );
  });

  test("append and prepend join in order and reject shared names", () => {
    const a = Multi.new().put("a", 1);
    const b = Multi.new().put("b", 2);
    assert.deepEqual(
      a
        .append(b)
        .toList()
        .map(([name]) => name),
      ["a", "b"],
    );
    assert.deepEqual(
      a
        .prepend(b)
        .toList()
        .map(([name]) => name),
      ["b", "a"],
    );
    assert.throws(
      () => a.append(Multi.new().put("a", 3)),
      /both Multis have operations named "a"/,
    );
  });

  test("merges have no name", () => {
    const list = Multi.new()
      .merge(() => Multi.new())
      .toList();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.[0], undefined);
    assert.equal(list[0]?.[1].kind, "merge");
  });

  test("sets the action of changesets, rejecting a different one", () => {
    const changeset = change(Post.new(), { title: "Hi" });
    const [[, operation] = []] = Multi.new().insert("post", changeset).toList();
    assert.ok(operation?.kind === "changeset");
    assert.equal((operation.input as Changeset<object>).action, "insert");
    assert.equal(changeset.action, null, "the given changeset is unchanged");

    const updating = new Changeset({ ...changeset, action: "update" });
    assert.throws(
      () => Multi.new().insert("post", updating),
      /action "update" was given to Multi.insert/,
    );
  });

  test("tracks the result types by name", () => {
    const multi = Multi.new()
      .put("n", 1)
      .run("s", (_tx, { n }) => ({ ok: true, value: String(n) }))
      .insertAll("posts", Post, [{ title: "a" }]);
    type C = typeof multi extends Multi<unknown, infer C> ? C : never;
    type _n = Expect<Equal<C["n"], number>>;
    type _s = Expect<Equal<C["s"], string>>;
    type _count = Expect<Equal<C["posts"]["count"], number>>;
    assert.ok(multi.has("posts"));
  });
});
