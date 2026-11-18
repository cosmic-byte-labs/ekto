import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inspect } from "node:util";
import {
  type AnyChangeset,
  addError,
  applyAction,
  applyActionOrThrow,
  applyChanges,
  Changeset,
  cast,
  change,
  changed,
  checkConstraint,
  deleteChange,
  exclusionConstraint,
  fetchField,
  fieldMissing,
  forceChange,
  foreignKeyConstraint,
  getChange,
  getField,
  InvalidChangesetError,
  optimisticLock,
  pipe,
  prepareChanges,
  putChange,
  type StandardSchemaV1,
  schemaless,
  traverseErrors,
  uniqueConstraint,
  updateChange,
  validateAcceptance,
  validateChange,
  validateConfirmation,
  validateExclusion,
  validateFormat,
  validateInclusion,
  validateLength,
  validateNumber,
  validateRequired,
  validateSubset,
  validateWith,
} from "./changeset.ts";
import { getMeta, type Infer, load, schema, t } from "./schema.ts";
import * as types from "./type.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

const User = schema("users", {
  id: t.id(),
  email: t.string(),
  name: t.string({ nullable: true }),
  age: t.integer({ nullable: true }),
  score: t.decimal({ nullable: true }),
  role: t.enum(["admin", "member"], { default: "member" }),
  tags: t.array(t.string, { default: [] }),
  password: t.string({ virtual: true }),
  terms: t.boolean({ virtual: true }),
  lock_version: t.integer({ default: 1 }),
  password_hash: t.string({ redact: true }),
});

const loaded = () =>
  load(User, {
    id: 1,
    email: "a@b.c",
    name: "Ann",
    age: 30,
    password_hash: "h",
  });

function errorsOf(changeset: AnyChangeset) {
  return changeset.errors.map(({ field, message, meta }) => [
    field,
    message,
    meta,
  ]);
}

describe("cast", () => {
  test("casts permitted params and ignores the rest", () => {
    const cs = cast(User.new(), { email: "x@y.z", age: "42", role: "admin" }, [
      "email",
      "age",
    ]);
    assert.ok(cs instanceof Changeset);
    assert.deepEqual(cs.changes, { email: "x@y.z", age: 42 });
    assert.equal(cs.valid, true);
    assert.deepEqual(cs.params, { email: "x@y.z", age: "42", role: "admin" });
  });

  test("throws on unknown permitted fields and params that are not objects", () => {
    assert.throws(
      () => cast(User.new(), {}, ["nope" as never]),
      /unknown field nope/,
    );
    assert.throws(() => cast(User.new(), "x", ["email"]), types.CastError);
    assert.throws(() => cast({ a: 1 }, {}, ["a"]), /schemaless/);
  });

  test("does not record values equal to the current ones, unless forced", () => {
    assert.deepEqual(
      cast(loaded(), { age: "30", name: "Bo" }, ["age", "name"]).changes,
      {
        name: "Bo",
      },
    );
    assert.deepEqual(
      cast(loaded(), { age: "30" }, ["age"], { force: true }).changes,
      { age: 30 },
    );
  });

  test("turns empty values into the default", () => {
    const cs = cast(loaded(), { name: "  ", tags: ["a", "", "b"] }, [
      "name",
      "tags",
    ]);
    assert.deepEqual(cs.changes, { name: null, tags: ["a", "b"] });
    const admin = load(User, { id: 1, role: "admin" });
    assert.deepEqual(cast(admin, { role: "" }, ["role"]).changes, {
      role: "member",
    });
    const custom = cast(loaded(), { name: "-" }, ["name"], {
      emptyValues: ["-"],
    });
    assert.deepEqual(custom.changes, { name: null });
  });

  test("adds an error for values that cannot be cast", () => {
    const cs = cast(User.new(), { age: "x", email: 1 }, ["email", "age"]);
    assert.equal(cs.valid, false);
    assert.deepEqual(errorsOf(cs), [
      ["age", "is invalid", { validation: "cast", type: "integer" }],
      ["email", "is invalid", { validation: "cast", type: "string" }],
    ]);
    assert.deepEqual(cs.changes, {});
  });

  test("takes a custom message", () => {
    const cs = cast(User.new(), { age: "x" }, ["age"], {
      message: (field, meta) => `${field} is not a ${String(meta.type)}`,
    });
    assert.equal(cs.errors[0]?.message, "age is not a integer");
  });

  test("casting onto a changeset merges params, changes and errors", () => {
    const first = cast(User.new(), { age: "x" }, ["age"]);
    const second = cast(first, { email: "a@b.c" }, ["email"]);
    assert.deepEqual(second.params, { age: "x", email: "a@b.c" });
    assert.deepEqual(second.changes, { email: "a@b.c" });
    assert.equal(second.valid, false);
    assert.equal(second.errors.length, 1);
  });

  test("changesets are immutable", () => {
    const cs = cast(User.new(), { email: "a@b.c" }, ["email"]);
    assert.throws(() => {
      (cs.changes as Record<string, unknown>).email = "x";
    }, TypeError);
    assert.ok(Object.isFrozen(cs));
  });
});

describe("change and friends", () => {
  test("change puts changes without casting and drops unchanged values", () => {
    const cs = change(loaded(), { age: 30, name: "Bo" });
    assert.deepEqual(cs.changes, { name: "Bo" });
  });

  test("putChange removes a change back to the original value", () => {
    const cs = pipe(
      change(loaded()),
      putChange("name", "Bo"),
      putChange("name", "Ann"),
    );
    assert.deepEqual(cs.changes, {});
  });

  test("forceChange, deleteChange and updateChange", () => {
    const cs = forceChange(change(loaded()), "age", 30);
    assert.deepEqual(cs.changes, { age: 30 });
    assert.deepEqual(deleteChange(cs, "age").changes, {});
    const upper = updateChange(
      change(loaded(), { name: "bo" }),
      "name",
      (v) => v?.toUpperCase() ?? null,
    );
    assert.deepEqual(upper.changes, { name: "BO" });
    assert.deepEqual(
      updateChange(change(loaded()), "name", () => "x").changes,
      {},
    );
  });

  test("getters read changes before data", () => {
    const cs = change(loaded(), { name: "Bo" });
    assert.equal(getField(cs, "name"), "Bo");
    assert.equal(getField(cs, "email"), "a@b.c");
    assert.equal(getChange(cs, "name"), "Bo");
    assert.equal(getChange(cs, "email"), undefined);
    assert.deepEqual(fetchField(cs, "name"), { from: "changes", value: "Bo" });
    assert.deepEqual(fetchField(cs, "email"), { from: "data", value: "a@b.c" });
    assert.throws(() => getField(cs, "nope" as never), /unknown field/);
  });

  test("changed checks to and from", () => {
    const cs = change(loaded(), { name: "Bo" });
    assert.ok(changed(cs, "name"));
    assert.ok(changed(cs, "name", { to: "Bo", from: "Ann" }));
    assert.ok(!changed(cs, "name", { to: "Cy" }));
    assert.ok(!changed(cs, "email"));
  });

  test("fieldMissing counts null and empty values", () => {
    const cs = change(User.new(), { name: "" });
    assert.ok(fieldMissing(cs, "email"));
    assert.ok(fieldMissing(cs, "name"));
    assert.ok(!fieldMissing(cs, "role"));
  });
});

describe("applying", () => {
  test("applyChanges keeps the record's metadata", () => {
    const user = applyChanges(change(loaded(), { name: "Bo" }));
    assert.equal(user.name, "Bo");
    assert.equal(getMeta(user)?.state, "loaded");
    assert.ok(!inspect(user).includes("'h'"));
  });

  test("applyAction returns the data when valid, else the changeset with the action", () => {
    const ok = applyAction(change(loaded(), { name: "Bo" }), "update");
    assert.ok(ok.ok && ok.value.name === "Bo");
    const bad = applyAction(
      addError(change(loaded()), "name", "bad"),
      "insert",
    );
    assert.ok(!bad.ok && bad.changeset.action === "insert");
    assert.throws(
      () =>
        applyActionOrThrow(addError(change(loaded()), "name", "bad"), "insert"),
      (err: unknown) =>
        err instanceof InvalidChangesetError &&
        err.action === "insert" &&
        err.message.includes("name: bad"),
    );
  });
});

describe("errors", () => {
  test("addError prepends and invalidates", () => {
    const cs = pipe(
      change(loaded()),
      addError("name", "a"),
      addError("email", "b", { x: 1 }),
    );
    assert.equal(cs.valid, false);
    assert.deepEqual(errorsOf(cs), [
      ["email", "b", { x: 1 }],
      ["name", "a", {}],
    ]);
  });

  test("traverseErrors groups and interpolates, newest first per field", () => {
    const cs = pipe(
      change(loaded()),
      addError("name", "first"),
      addError("name", "at least %{count}", { count: 3 }),
      addError("email", "%{missing} stays"),
    );
    assert.deepEqual(traverseErrors(cs), {
      name: ["at least 3", "first"],
      email: ["%{missing} stays"],
    });
    assert.deepEqual(
      traverseErrors(cs, (e) => e.message.length),
      { name: [17, 5], email: [16] },
    );
  });
});

describe("validateChange", () => {
  test("runs only on non-null changes", () => {
    let calls = 0;
    const validator = (field: string, value: unknown) => {
      calls++;
      return value === "bad" ? [[field, "is bad", { why: 1 }] as const] : [];
    };
    validateChange(change(loaded()), "name", validator);
    validateChange(change(loaded(), { name: null }), "name", validator);
    assert.equal(calls, 0);
    const cs = validateChange(
      change(loaded(), { name: "bad" }),
      "name",
      validator,
    );
    assert.deepEqual(errorsOf(cs), [["name", "is bad", { why: 1 }]]);
  });
});

describe("validateRequired", () => {
  test("adds errors in field order and drops the failed changes", () => {
    const cs = validateRequired(change(User.new(), { name: "" }), [
      "email",
      "name",
      "role",
    ]);
    assert.deepEqual(errorsOf(cs), [
      ["email", "can't be blank", { validation: "required" }],
      ["name", "can't be blank", { validation: "required" }],
    ]);
    assert.deepEqual(cs.changes, {});
    assert.deepEqual(cs.required, ["email", "name", "role"]);
  });

  test("skips fields that already have errors and takes a message", () => {
    const cs = pipe(
      cast(User.new(), { age: "x" }, ["age"]),
      validateRequired(["age", "email"], { message: "required!" }),
    );
    assert.deepEqual(
      cs.errors.map((e) => [e.field, e.message]),
      [
        ["email", "required!"],
        ["age", "is invalid"],
      ],
    );
  });

  test("passes for values in the data", () => {
    assert.ok(validateRequired(change(loaded()), "email").valid);
  });
});

describe("validateFormat", () => {
  test("matches strings, global regexps included", () => {
    const re = /@/g;
    const cs = change(User.new(), { email: "a@b" });
    assert.ok(validateFormat(cs, "email", re).valid);
    assert.ok(validateFormat(cs, "email", re).valid);
    assert.deepEqual(
      errorsOf(
        validateFormat(change(User.new(), { email: "ab" }), "email", re),
      ),
      [["email", "has invalid format", { validation: "format" }]],
    );
  });

  test("throws for non-strings", () => {
    assert.throws(
      () => validateFormat(change(User.new(), { age: 1 }), "age", /1/),
      TypeError,
    );
  });
});

describe("inclusion, exclusion and subset", () => {
  test("validateInclusion", () => {
    const cs = validateInclusion(change(User.new(), { age: 5 }), "age", [1, 2]);
    assert.deepEqual(errorsOf(cs), [
      ["age", "is invalid", { validation: "inclusion", enum: [1, 2] }],
    ]);
    assert.ok(
      validateInclusion(change(User.new(), { score: "1.0" }), "score", ["1"])
        .valid,
    );
  });

  test("validateExclusion", () => {
    const cs = validateExclusion(
      change(User.new(), { name: "admin" }),
      "name",
      ["admin"],
    );
    assert.deepEqual(errorsOf(cs), [
      ["name", "is reserved", { validation: "exclusion", enum: ["admin"] }],
    ]);
  });

  test("validateSubset", () => {
    const cs = change(User.new(), { tags: ["a", "c"] });
    assert.ok(validateSubset(cs, "tags", ["a", "b", "c"]).valid);
    assert.deepEqual(errorsOf(validateSubset(cs, "tags", ["a"])), [
      ["tags", "has an invalid entry", { validation: "subset", enum: ["a"] }],
    ]);
    assert.throws(
      () => validateSubset(cs, "name", ["a"] as never),
      /array field/,
    );
  });
});

describe("validateLength", () => {
  const withName = (name: string) => change(User.new(), { name });

  test("counts code points by default", () => {
    assert.ok(validateLength(withName("😀😀"), "name", { is: 2 }).valid);
    assert.deepEqual(
      errorsOf(validateLength(withName("ab"), "name", { min: 3 })),
      [
        [
          "name",
          "should be at least %{count} character(s)",
          { count: 3, validation: "length", kind: "min", type: "string" },
        ],
      ],
    );
  });

  test("reports only the first failing check", () => {
    const cs = validateLength(withName("abcd"), "name", { is: 2, max: 3 });
    assert.equal(cs.errors.length, 1);
    assert.equal(cs.errors[0]?.meta.kind, "is");
  });

  test("counts graphemes or bytes when asked", () => {
    const family = "👨‍👩‍👧";
    assert.ok(
      validateLength(withName(family), "name", { is: 1, count: "graphemes" })
        .valid,
    );
    const bytes = validateLength(withName("é"), "name", {
      max: 1,
      count: "bytes",
    });
    assert.deepEqual(
      errorsOf(bytes)[0]?.[1],
      "should be at most %{count} byte(s)",
    );
  });

  test("counts items in arrays", () => {
    const cs = validateLength(change(User.new(), { tags: ["a"] }), "tags", {
      min: 2,
    });
    assert.equal(
      cs.errors[0]?.message,
      "should have at least %{count} item(s)",
    );
    assert.equal(cs.errors[0]?.meta.type, "list");
  });
});

describe("validateNumber", () => {
  test("checks bounds and reports the first failure", () => {
    const cs = validateNumber(change(User.new(), { age: 5 }), "age", {
      greaterThan: 1,
      lessThan: 3,
      equalTo: 4,
    });
    assert.deepEqual(errorsOf(cs), [
      [
        "age",
        "must be less than %{number}",
        { validation: "number", kind: "lessThan", number: 3 },
      ],
    ]);
    assert.ok(
      validateNumber(change(User.new(), { age: 5 }), "age", { notEqualTo: 4 })
        .valid,
    );
  });

  test("compares decimals exactly", () => {
    const cs = change(User.new(), { score: "0.30000000000000000001" });
    assert.ok(validateNumber(cs, "score", { greaterThan: "0.3" }).valid);
    assert.ok(!validateNumber(cs, "score", { lessThanOrEqualTo: 0.3 }).valid);
  });

  test("throws on unknown options and non-numbers", () => {
    assert.throws(
      () =>
        validateNumber(change(User.new(), { age: 5 }), "age", {
          less_than: 1,
        } as never),
      /unknown option less_than/,
    );
    assert.throws(
      () =>
        validateNumber(change(User.new(), { name: "x" }), "name", {
          lessThan: 1,
        }),
      TypeError,
    );
  });
});

describe("validateConfirmation and validateAcceptance", () => {
  test("confirmation errors go on the confirmation field", () => {
    const params = { password: "secret1", password_confirmation: "secret2" };
    const cs = validateConfirmation(
      cast(User.new(), params, ["password"]),
      "password",
    );
    assert.deepEqual(errorsOf(cs), [
      [
        "password_confirmation",
        "does not match confirmation",
        { validation: "confirmation" },
      ],
    ]);
    const missing = validateConfirmation(
      cast(User.new(), { password: "x" }, ["password"]),
      "password",
      {
        required: true,
      },
    );
    assert.deepEqual(errorsOf(missing), [
      ["password_confirmation", "can't be blank", { validation: "required" }],
    ]);
    assert.ok(validateConfirmation(change(User.new()), "password").valid);
  });

  test("acceptance casts the param to true", () => {
    const accept = (terms: unknown) =>
      validateAcceptance(cast(User.new(), { terms }, ["terms"]), "terms");
    assert.ok(accept("true").valid);
    assert.deepEqual(errorsOf(accept("false")), [
      ["terms", "must be accepted", { validation: "acceptance" }],
    ]);
    assert.ok(!validateAcceptance(cast(User.new(), {}, []), "terms").valid);
    assert.ok(validateAcceptance(change(User.new()), "terms").valid);
  });
});

describe("validateWith", () => {
  const minLength = (n: number): StandardSchemaV1<string> => ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        typeof value === "string" && value.length >= n
          ? { value }
          : { issues: [{ message: `too short`, path: [{ key: "x" }, 0] }] },
    },
  });

  test("turns issues into errors", () => {
    const cs = validateWith(
      change(User.new(), { name: "a" }),
      "name",
      minLength(2),
    );
    assert.deepEqual(errorsOf(cs), [
      [
        "name",
        "too short",
        { validation: "schema", vendor: "test", path: ["x", 0] },
      ],
    ]);
    assert.ok(
      validateWith(change(User.new(), { name: "ab" }), "name", minLength(2))
        .valid,
    );
  });

  test("rejects asynchronous validators", () => {
    const asyncSchema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) => ({ value }),
      },
    };
    assert.throws(
      () =>
        validateWith(change(User.new(), { name: "a" }), "name", asyncSchema),
      /synchronous/,
    );
  });
});

describe("constraints", () => {
  test("use Ecto's default names", () => {
    const cs = pipe(
      change(User.new()),
      uniqueConstraint(["email", "name"]),
      foreignKeyConstraint("id"),
      exclusionConstraint("age"),
      checkConstraint("age", { name: "age_positive" }),
    );
    assert.deepEqual(
      cs.constraints.map((c) => [
        c.type,
        c.constraint,
        c.field,
        c.errorMessage,
        c.errorType,
      ]),
      [
        ["check", "age_positive", "age", "is invalid", "check"],
        [
          "exclusion",
          "users_age_exclusion",
          "age",
          "violates an exclusion constraint",
          "exclusion",
        ],
        ["foreign_key", "users_id_fkey", "id", "does not exist", "foreign"],
        [
          "unique",
          "users_email_name_index",
          "email",
          "has already been taken",
          "unique",
        ],
      ],
    );
  });

  test("take names, matches, error keys and messages", () => {
    const cs = uniqueConstraint(change(User.new()), "email", {
      name: "email_idx",
      match: "suffix",
      errorKey: "name",
      message: "taken",
    });
    assert.deepEqual(cs.constraints[0], {
      type: "unique",
      constraint: "email_idx",
      match: "suffix",
      field: "name",
      errorMessage: "taken",
      errorType: "unique",
    });
  });

  test("reject RegExp names with non-exact matches, and need a source", () => {
    assert.throws(
      () =>
        uniqueConstraint(change(User.new()), "email", {
          name: /x/,
          match: "prefix",
        }),
      /RegExp/,
    );
    assert.throws(
      () => checkConstraint(change(User.new()), "age", {} as never),
      /name/,
    );
    assert.throws(
      () => uniqueConstraint(schemaless({ a: types.string }), "a"),
      /source/,
    );
  });
});

describe("optimisticLock and prepareChanges", () => {
  // What Repo does before writing.
  const runPrepare = async (cs: AnyChangeset) => {
    let acc = cs;
    for (const fn of cs.prepare) acc = await fn(acc);
    return acc;
  };

  test("filters on the current version and increments it when prepared", async () => {
    const cs = optimisticLock(loaded(), "lock_version");
    assert.deepEqual(cs.filters, { lock_version: 1 });
    assert.deepEqual(cs.changes, {});
    const prepared = await runPrepare(cs);
    assert.deepEqual(prepared.changes, { lock_version: 2 });
  });

  test("rolls over at the 32-bit limit and takes an incrementer", async () => {
    const at = (v: number) => change(loaded(), { lock_version: v });
    const run = async (cs: AnyChangeset) => (await runPrepare(cs)).changes;
    assert.deepEqual(
      await run(optimisticLock(at(2_147_483_647), "lock_version")),
      {
        lock_version: 1,
      },
    );
    assert.deepEqual(
      await run(
        pipe(
          at(5),
          optimisticLock("lock_version", (v) => v + 10),
        ),
      ),
      {
        lock_version: 15,
      },
    );
  });

  test("prepareChanges runs functions in order, awaiting async ones", async () => {
    const cs = pipe(
      change(loaded()),
      prepareChanges(async (c) => putChange(c, "name", "one")),
      prepareChanges((c) => putChange(c, "name", `${c.changes.name}-two`)),
    );
    assert.deepEqual((await runPrepare(cs)).changes, {
      name: "one-two",
    });
  });
});

describe("schemaless", () => {
  test("casts and validates plain data", () => {
    const search = schemaless(
      { q: types.string, page: t.integer() },
      { page: 1 },
    );
    type _data = Expect<
      Equal<(typeof search)["data"], { q: string | null; page: number | null }>
    >;
    const cs = pipe(
      cast(search, { q: "", page: "3" }, ["q", "page"]),
      validateRequired("q"),
    );
    assert.deepEqual(cs.changes, { page: 3 });
    assert.deepEqual(traverseErrors(cs), { q: ["can't be blank"] });
  });
});

describe("typing", () => {
  test("pipe steps are checked against the data", () => {
    type U = Infer<typeof User>;
    const cs = pipe(
      change(loaded()),
      validateRequired(["email"]),
      validateLength("name", { min: 1 }),
    );
    type _cs = Expect<Equal<typeof cs, Changeset<U>>>;
    const _unchecked = () => {
      // @ts-expect-error: not a field of User
      pipe(change(loaded()), validateRequired(["nope"]));
      // @ts-expect-error: not a field of User
      validateRequired(change(loaded()), ["nope"]);
    };
    assert.ok(true);
  });
});

describe("inspect", () => {
  test("redacts changes to redacted fields", () => {
    const shown = inspect(change(loaded(), { password_hash: "secret" }));
    assert.ok(!shown.includes("secret"), shown);
    assert.ok(shown.includes("**redacted**"), shown);
  });
});
