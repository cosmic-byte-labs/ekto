import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Command,
  constraint,
  fragment,
  index,
  isMigration,
  type MigrationContext,
  MigrationError,
  migration,
  record,
  references,
  reverse,
  table,
  uniqueIndex,
} from "./dsl.ts";

const commands = (fn: (m: MigrationContext) => void) => record("up", fn);

describe("migration objects", () => {
  test("create adds no implicit id: the primary key is a column", () => {
    assert.deepEqual(table("users"), {
      kind: "table",
      name: "users",
      options: undefined,
    });
    const [command] = commands((m) =>
      m.create(table("users"), (t) => t.add("email", "string")),
    );
    assert.ok(command?.command === "create" && "columns" in command);
    assert.deepEqual(
      command.columns.map((c) => c.name),
      ["email"],
    );
  });

  test("index names follow Ecto", () => {
    assert.equal(index("users", ["email"]).name, "users_email_index");
    assert.equal(index("users", ["a", "b"]).name, "users_a_b_index");
    assert.equal(
      index("users", ["lower(email)"]).name,
      "users_lower_email_index",
    );
    assert.equal(index("users", "email", { name: "x" }).name, "x");
    assert.equal(uniqueIndex("users", "email").unique, true);
  });

  test("references defaults", () => {
    const ref = references("users");
    assert.equal(ref.column, "id");
    assert.equal(ref.type, "bigserial");
    assert.equal(ref.onDelete, "nothing");
    assert.throws(
      () => references("users", { onDelete: "cascade" as never }),
      /unknown onDelete value: "cascade"/,
    );
  });

  test("constraint takes check or exclude", () => {
    assert.equal(constraint("u", "c", { check: "a > 0" }).check, "a > 0");
    assert.throws(
      () => constraint("u", "c", {}),
      /expects exactly one of the check or exclude options/,
    );
  });
});

describe("recording", () => {
  test("create adds the primary key, columns and timestamps", () => {
    const [create] = commands((m) =>
      m.create(table("users"), (t) => {
        t.add("id", "bigserial", { primaryKey: true });
        t.add("email", "string", { null: false });
        t.add("org_id", references("orgs"));
        t.timestamps();
      }),
    );
    assert.ok(create?.command === "create" && "columns" in create);
    assert.deepEqual(
      create.columns.map((c) => [c.name, c.op]),
      [
        ["id", "add"],
        ["email", "add"],
        ["org_id", "add"],
        ["inserted_at", "add"],
        ["updated_at", "add"],
      ],
    );
    assert.deepEqual(create.columns[3], {
      op: "add",
      name: "inserted_at",
      type: "utc_datetime",
      options: { null: false },
    });
  });

  test("timestamps options", () => {
    const [create] = commands((m) =>
      m.create(table("t"), (t) =>
        t.timestamps({
          type: "utc_datetime_msec",
          insertedAt: "created_at",
          updatedAt: false,
          default: fragment("CURRENT_TIMESTAMP"),
        }),
      ),
    );
    assert.ok(create && "columns" in create);
    assert.deepEqual(create.columns, [
      {
        op: "add",
        name: "created_at",
        type: "utc_datetime_msec",
        options: { null: false, default: fragment("CURRENT_TIMESTAMP") },
      },
    ]);
  });

  test("only add can be used in create", () => {
    assert.throws(
      () => commands((m) => m.create(table("t"), (t) => t.remove("a"))),
      /remove can only be used in alter, not create/,
    );
  });

  test("rename forms", () => {
    const recorded = commands((m) => {
      m.rename(table("a"), { to: table("b") });
      m.rename(table("a"), "x", { to: "y" });
      m.rename(index("a", "x"), { to: "a_y_index" });
    });
    assert.deepEqual(
      recorded.map((c) => c.command),
      ["renameTable", "renameColumn", "renameIndex"],
    );
  });

  test("execute with a down is reversible", () => {
    const recorded = commands((m) => {
      m.execute("SELECT 1");
      m.execute("CREATE EXTENSION x", "DROP EXTENSION x");
    });
    assert.deepEqual(recorded, [
      { command: "execute", sql: "SELECT 1" },
      {
        command: "executeReversible",
        up: "CREATE EXTENSION x",
        down: "DROP EXTENSION x",
      },
    ]);
  });

  test("the context knows the direction", () => {
    let direction: string | undefined;
    record("down", (m) => {
      direction = m.direction;
    });
    assert.equal(direction, "down");
  });
});

describe("reverse (Ecto.Migration.Runner)", () => {
  const one = (fn: (m: MigrationContext) => void): Command => {
    const [command] = commands(fn);
    assert.ok(command);
    return command;
  };

  test("create and drop", () => {
    const users = table("users");
    assert.deepEqual(reverse(one((m) => m.create(users))), {
      command: "drop",
      object: users,
      mode: "restrict",
    });
    const idx = index("users", "email");
    assert.deepEqual(reverse(one((m) => m.createIfNotExists(idx))), {
      command: "dropIfExists",
      object: idx,
      mode: "restrict",
    });
    assert.deepEqual(reverse(one((m) => m.drop(idx))), {
      command: "create",
      object: idx,
    });
    assert.equal(reverse(one((m) => m.drop(users))), undefined);
    const check = constraint("users", "c", { check: "true" });
    assert.deepEqual(reverse(one((m) => m.create(check))), {
      command: "drop",
      object: check,
      mode: "restrict",
    });
    assert.equal(reverse(one((m) => m.drop(check))), undefined);
  });

  test("renames swap", () => {
    assert.deepEqual(
      reverse(one((m) => m.rename(table("a"), { to: table("b") }))),
      { command: "renameTable", object: table("b"), to: table("a") },
    );
    assert.deepEqual(
      reverse(one((m) => m.rename(table("a"), "x", { to: "y" }))),
      { command: "renameColumn", object: table("a"), from: "y", to: "x" },
    );
    const renamed = reverse(
      one((m) => m.rename(index("a", "x"), { to: "a_y" })),
    );
    assert.ok(renamed?.command === "renameIndex");
    assert.equal(renamed.object.name, "a_y");
    assert.equal(renamed.to, "a_x_index");
  });

  test("alter reverses each change in reverse order", () => {
    const reversed = reverse(
      one((m) =>
        m.alter(table("users"), (t) => {
          t.add("a", "string");
          t.remove("b", "integer", { null: false });
          t.modify("c", "text", { null: true, from: "string" });
          t.modify("d", "integer", {
            null: false,
            from: { type: "string", null: true },
          });
        }),
      ),
    );
    assert.ok(reversed?.command === "alter");
    assert.deepEqual(reversed.changes, [
      {
        op: "modify",
        name: "d",
        type: "string",
        options: { null: true, from: { type: "integer", null: false } },
      },
      {
        op: "modify",
        name: "c",
        type: "string",
        options: { null: true, from: { type: "text", null: true } },
      },
      { op: "add", name: "b", type: "integer", options: { null: false } },
      { op: "remove", name: "a", type: "string", options: {} },
    ]);
  });

  test("irreversible changes", () => {
    for (const fn of [
      (m: MigrationContext) => m.alter(table("u"), (t) => t.remove("a")),
      (m: MigrationContext) =>
        m.alter(table("u"), (t) => t.modify("a", "text")),
      (m: MigrationContext) =>
        m.alter(table("u"), (t) => t.removeIfExists("a", "text")),
      (m: MigrationContext) => m.execute("SELECT 1"),
      (m: MigrationContext) => m.execute(async () => {}),
    ])
      assert.equal(reverse(one(fn)), undefined);
  });
});

describe("migration", () => {
  test("change runs reversed commands in reverse order on down", () => {
    const m = migration({
      change(m) {
        m.create(table("users"), (t) => t.add("email", "string"));
        m.create(uniqueIndex("users", "email"));
      },
    });
    assert.ok(isMigration(m));
    assert.deepEqual(
      m.down?.().map((c) => c.command),
      ["drop", "drop"],
    );
    const [first] = m.down?.() ?? [];
    assert.ok(first && "object" in first);
    assert.equal(first.object.kind, "index");
  });

  test("change fails on down when a command is irreversible", () => {
    const m = migration({
      change(m) {
        m.execute("UPDATE users SET a = 1");
      },
    });
    assert.throws(
      () => m.down?.(),
      (error: unknown) =>
        error instanceof MigrationError &&
        /cannot reverse migration command: execute "UPDATE users SET a = 1". You will need to explicitly define up and down/.test(
          error.message,
        ),
    );
  });

  test("up and down", () => {
    const m = migration({
      up(m) {
        m.execute("SELECT 1");
      },
    });
    assert.equal(m.down, undefined);
    assert.equal(isMigration({}), false);
  });
});
