import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sql } from "kysely";
import pg from "pg";
import { connectPg, skipWithoutPg } from "../postgres.test-helper.ts";
import { postgres, utcTimestamps } from "./index.ts";

const adapter = postgres();

describe("postgres adapter", () => {
  test("loads int8 strings as numbers, keeping unsafe ones", () => {
    assert.equal(adapter.load("id", "42"), 42);
    assert.equal(adapter.load("integer", 7n), 7);
    assert.equal(
      adapter.load("id", "9007199254740993"),
      "9007199254740993",
      "left for the type to reject",
    );
  });

  test("loads dates node-postgres parsed at local midnight", () => {
    assert.equal(adapter.load("date", new Date(2026, 0, 2)), "2026-01-02");
    assert.equal(adapter.load("date", "2026-01-02"), "2026-01-02");
  });

  test("drops fractional seconds of times", () => {
    assert.equal(adapter.load("time", "07:30:00.123456"), "07:30:00");
  });

  test("loads timestamp text as UTC", () => {
    assert.deepEqual(
      adapter.load("utc_datetime", "2026-01-02 10:30:00"),
      new Date("2026-01-02T10:30:00Z"),
    );
    assert.deepEqual(
      adapter.load("utc_datetime_msec", "2026-01-02 10:30:00.123456+02"),
      new Date("2026-01-02T08:30:00.123Z"),
    );
  });

  test("loads arrays element by element", () => {
    assert.deepEqual(adapter.load(["array", "integer"], ["1", null]), [
      1,
      null,
    ]);
  });

  test("dumps datetimes as UTC text, bytes as Buffers and maps as JSON", () => {
    assert.equal(
      adapter.dump("utc_datetime", new Date("2026-01-02T10:30:00Z")),
      "2026-01-02T10:30:00.000Z",
    );
    assert.ok(Buffer.isBuffer(adapter.dump("binary", new Uint8Array([1]))));
    assert.equal(adapter.dump("map", { a: [1] }), '{"a":[1]}');
  });

  test("maps constraint violations like Ecto", () => {
    const error = (code: string, extra: object = {}) =>
      Object.assign(new Error("boom"), { code, ...extra });
    assert.deepEqual(
      adapter.toConstraints(
        error("23505", { constraint: "users_email_index" }),
      ),
      [{ type: "unique", constraint: "users_email_index" }],
    );
    assert.deepEqual(
      adapter.toConstraints(
        error("23503", { constraint: "posts_user_id_fkey" }),
      ),
      [{ type: "foreign_key", constraint: "posts_user_id_fkey" }],
    );
    assert.deepEqual(
      adapter.toConstraints(error("23514", { constraint: "positive" })),
      [{ type: "check", constraint: "positive" }],
    );
    assert.deepEqual(
      adapter.toConstraints(
        Object.assign(
          new Error('duplicate key value violates unique constraint "x_index"'),
          { code: "23505" },
        ),
      ),
      [{ type: "unique", constraint: "x_index" }],
    );
    assert.deepEqual(adapter.toConstraints(error("42P01")), []);
    assert.deepEqual(adapter.toConstraints("nope"), []);
  });
});

describe("utcTimestamps", () => {
  const types = utcTimestamps(pg.types);

  test("parses timestamp and timestamp[] text as UTC", () => {
    assert.deepEqual(
      types.getTypeParser(1114, "text")("2026-01-02 10:30:00.5"),
      new Date("2026-01-02T10:30:00.500Z"),
    );
    assert.deepEqual(
      types.getTypeParser(1115, "text")('{"2026-01-02 10:30:00",NULL}'),
      [new Date("2026-01-02T10:30:00Z"), null],
    );
  });

  test("keeps the other parsers", () => {
    assert.equal(types.getTypeParser(23, "text")("42"), 42);
    assert.equal(types.getTypeParser(1184), pg.types.getTypeParser(1184));
  });

  test("reads timestamps from the database as UTC", {
    skip: skipWithoutPg,
  }, async () => {
    const { db, pool } = connectPg();
    try {
      const { rows } = await sql<{ at: Date; ats: Date[] }>`
        SELECT '2026-01-02 10:30:00'::timestamp AS at,
          ARRAY['2026-01-02 10:30:00'::timestamp] AS ats`.execute(db);
      assert.deepEqual(rows[0], {
        at: new Date("2026-01-02T10:30:00Z"),
        ats: [new Date("2026-01-02T10:30:00Z")],
      });
    } finally {
      await pool.end();
    }
  });
});
