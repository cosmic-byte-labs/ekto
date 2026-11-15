import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inspect } from "node:util";
import {
  getMeta,
  type Infer,
  isSchema,
  load,
  type New,
  putMeta,
  schema,
  t,
} from "./schema.ts";
import { ok, type Type } from "./type.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

const User = schema("users", {
  id: t.id(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  tags: t.array(t.string().type).default([]),
  password: t.string().virtual(),
  remember: t.boolean().virtual().default(false),
  password_hash: t.string().redact(),
  ...t.timestamps(),
});

describe("schema types", () => {
  test("Infer gives loaded records, New gives built ones", () => {
    type User = Infer<typeof User>;
    type _loaded = Expect<
      Equal<
        User,
        {
          id: number;
          email: string;
          name: string | null;
          age: number | null;
          role: "admin" | "member";
          tags: string[];
          password: string | null;
          remember: boolean;
          password_hash: string;
          inserted_at: Date;
          updated_at: Date;
        }
      >
    >;
    type _new = Expect<
      Equal<
        New<typeof User>,
        {
          id: number | null;
          email: string | null;
          name: string | null;
          age: number | null;
          role: "admin" | "member";
          tags: string[];
          password: string | null;
          remember: boolean;
          password_hash: string | null;
          inserted_at: Date | null;
          updated_at: Date | null;
        }
      >
    >;
    assert.ok(true);
  });
});

describe("schema reflection", () => {
  test("isSchema recognises schemas only", () => {
    assert.ok(isSchema(User));
    assert.ok(!isSchema({ ...User }));
    assert.ok(!isSchema(User.new()));
    assert.ok(!isSchema(null));
  });

  test("splits persisted and virtual fields", () => {
    assert.equal(User.source, "users");
    assert.deepEqual(User.persistedFields, [
      "id",
      "email",
      "name",
      "age",
      "role",
      "tags",
      "password_hash",
      "inserted_at",
      "updated_at",
    ]);
    assert.deepEqual(User.virtualFields, ["password", "remember"]);
  });

  test("reports keys and generated fields", () => {
    assert.deepEqual(User.primaryKey, ["id"]);
    assert.equal(User.autogenerateId, "id");
    assert.deepEqual(User.autogenerateFields, ["inserted_at", "updated_at"]);
    assert.deepEqual(User.autoupdateFields, ["updated_at"]);
    assert.deepEqual(User.redactFields, ["password_hash"]);
    assert.equal(User.type("email").type, "string");
  });

  test("uuid keys generate in the app", () => {
    const Token = schema("tokens", {
      id: t.uuid().primaryKey().autogenerate(),
    });
    assert.equal(Token.autogenerateId, undefined);
    assert.deepEqual(Token.autogenerateFields, ["id"]);
    const generate = Token.fields.id.options.autogenerate;
    assert.equal(typeof generate, "function");
    assert.match((generate as () => string)(), /^[0-9a-f-]{36}$/);
  });

  test("schemas without a primary key are allowed", () => {
    assert.deepEqual(schema("events", { name: t.string() }).primaryKey, []);
  });
});

describe("schema validation", () => {
  test("rejects defaults that do not fit the type", () => {
    assert.throws(
      () => t.integer().default("x" as unknown as number),
      TypeError,
    );
  });

  test("rejects autogenerate for types that cannot generate", () => {
    assert.throws(() => t.integer().autogenerate(), /cannot autogenerate/);
    assert.equal(
      typeof t.integer().autogenerate(() => 1).options.autogenerate,
      "function",
    );
  });

  test("rejects virtual keys and several database-generated fields", () => {
    assert.throws(
      () => schema("x", { id: t.integer().virtual().primaryKey() }),
      TypeError,
    );
    assert.throws(
      () => schema("x", { a: t.id(), b: t.id() }),
      /only one field/,
    );
  });

  test("rejects invalid sources", () => {
    assert.throws(() => schema("users; drop table x", {}), TypeError);
    assert.throws(() => schema("app.users", {}), TypeError);
  });
});

describe("new", () => {
  test("applies defaults and marks the record as built", () => {
    const user = User.new();
    assert.equal(user.email, null);
    assert.equal(user.role, "member");
    assert.equal(user.remember, false);
    assert.equal(getMeta(user)?.state, "built");
    assert.equal(getMeta(user)?.schema, User);
  });

  test("takes attributes without casting them", () => {
    const user = User.new({ email: "a@b.c" });
    assert.equal(user.email, "a@b.c");
    assert.throws(() => User.new({ nope: 1 } as never), /unknown field nope/);
  });

  test("does not share mutable defaults between records", () => {
    const a = User.new();
    a.tags.push("x");
    assert.deepEqual(User.new().tags, []);
  });

  test("keeps metadata out of spreads and JSON", () => {
    const user = User.new();
    assert.equal(getMeta({ ...user }), undefined);
    assert.equal(JSON.stringify(user).includes("ekto"), false);
  });

  test("redacts fields on inspection", () => {
    const user = User.new({ password_hash: "secret" });
    const shown = inspect(user);
    assert.ok(!shown.includes("secret"), shown);
    assert.ok(shown.includes("**redacted**"), shown);
  });
});

describe("putMeta", () => {
  test("returns a copy with the new state", () => {
    const user = User.new();
    const deleted = putMeta(user, { state: "deleted" });
    assert.equal(getMeta(deleted)?.state, "deleted");
    assert.equal(getMeta(user)?.state, "built");
    assert.throws(() => putMeta({}, { state: "loaded" }), TypeError);
  });
});

describe("load", () => {
  const row = {
    id: 1,
    email: "a@b.c",
    name: null,
    role: "admin",
    tags: ["x"],
    password_hash: "h",
    inserted_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    unknown_column: 1,
  };

  test("loads known columns and marks the record as loaded", () => {
    const user = load(User, row);
    assert.equal(user.id, 1);
    assert.equal(user.role, "admin");
    assert.equal(getMeta(user)?.state, "loaded");
    assert.equal("unknown_column" in user, false);
  });

  test("keeps defaults for missing columns and never loads virtual fields", () => {
    const user = load(User, { id: 1, password: "nope" });
    assert.equal(user.role, "member");
    assert.equal(user.password, null);
  });

  test("throws when a value cannot be loaded", () => {
    assert.throws(
      () => load(User, { id: "1" }),
      /cannot load 1 as type id for field id/,
    );
  });

  test("runs the adapter loader first", () => {
    const user = load(User, { id: "7" }, (type, value) =>
      type.type === "id" && typeof value === "string" ? Number(value) : value,
    );
    assert.equal(user.id, 7);
  });
});

describe("custom types", () => {
  test("work like built-in ones", () => {
    const upper: Type<string> = {
      type: "string",
      cast: (v) =>
        typeof v === "string" ? ok(v.toUpperCase()) : { ok: false },
      load: (v) => ok(String(v)),
      dump: (v) => ok(v),
    };
    const Code = schema("codes", { code: t.custom(upper) });
    type _code = Expect<Equal<Infer<typeof Code>, { code: string }>>;
    assert.equal(load(Code, { code: "ab" }).code, "ab");
  });
});
