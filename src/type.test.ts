import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  array,
  binary,
  boolean,
  CastError,
  castValue,
  castValueOrThrow,
  compareDecimal,
  date,
  decimal,
  deepEqual,
  dumpValue,
  enumOf,
  equalValues,
  float,
  id,
  integer,
  loadValue,
  map,
  string,
  type Type,
  time,
  utcDatetime,
  utcDatetimeMsec,
  uuid,
} from "./type.ts";

function castOk<T>(type: Type<T>, value: unknown): T | null {
  const result = castValue(type, value);
  assert.ok(result.ok, `expected ${String(value)} to cast`);
  return result.value;
}

function castFails(type: Type<unknown>, value: unknown): void {
  assert.equal(
    castValue(type, value).ok,
    false,
    `expected ${String(value)} not to cast`,
  );
}

describe("null handling", () => {
  test("null and undefined cast, load and dump to null for every type", () => {
    for (const type of [
      integer,
      string,
      boolean,
      utcDatetime,
      array(integer),
    ] as Type<unknown>[]) {
      assert.deepEqual(castValue(type, null), { ok: true, value: null });
      assert.deepEqual(castValue(type, undefined), { ok: true, value: null });
      assert.deepEqual(loadValue(type, null), { ok: true, value: null });
      assert.deepEqual(dumpValue(type, null), { ok: true, value: null });
    }
  });
});

describe("integer and id", () => {
  test("casts integers and integer strings", () => {
    for (const type of [integer, id]) {
      assert.equal(castOk(type, 1), 1);
      assert.equal(castOk(type, "10"), 10);
      assert.equal(castOk(type, "-3"), -3);
      assert.equal(castOk(type, "+3"), 3);
    }
  });

  test("rejects floats, junk and integers JS cannot represent", () => {
    castFails(integer, 1.5);
    castFails(integer, "1.0");
    castFails(integer, "1a");
    castFails(integer, "");
    castFails(integer, "9".repeat(32));
    castFails(integer, "9007199254740993");
    castFails(integer, true);
  });

  test("load does not parse strings (that is the adapter's job)", () => {
    assert.equal(loadValue(integer, "10").ok, false);
    assert.deepEqual(loadValue(integer, 10), { ok: true, value: 10 });
  });
});

describe("float", () => {
  test("casts numbers and numeric strings", () => {
    assert.equal(castOk(float, 1), 1);
    assert.equal(castOk(float, "1.5"), 1.5);
    assert.equal(castOk(float, "1e3"), 1000);
  });

  test("rejects non-finite and junk", () => {
    castFails(float, Number.NaN);
    castFails(float, Number.POSITIVE_INFINITY);
    castFails(float, "1.5x");
    castFails(float, ".5");
  });
});

describe("decimal", () => {
  test("keeps strings as given and converts numbers", () => {
    assert.equal(castOk(decimal, "1.50"), "1.50");
    assert.equal(castOk(decimal, ".5"), ".5");
    assert.equal(castOk(decimal, 2.25), "2.25");
    assert.equal(castOk(decimal, 10n), "10");
  });

  test("rejects junk, NaN and infinity", () => {
    castFails(decimal, "1.2.3");
    castFails(decimal, "NaN");
    castFails(decimal, Number.NaN);
    castFails(decimal, " 1");
  });

  test("compares numerically", () => {
    assert.ok(equalValues(decimal, "1.50", "1.5"));
    assert.ok(equalValues(decimal, "15e-1", "1.5"));
    assert.ok(equalValues(decimal, "0.0", "0"));
    assert.ok(equalValues(decimal, "100", "1e2"));
    assert.ok(!equalValues(decimal, "1.5", "-1.5"));
    assert.ok(!equalValues(decimal, "1.5", "1.51"));
  });
});

describe("boolean", () => {
  test("casts booleans and Ecto's string forms", () => {
    assert.equal(castOk(boolean, true), true);
    assert.equal(castOk(boolean, "true"), true);
    assert.equal(castOk(boolean, "1"), true);
    assert.equal(castOk(boolean, "false"), false);
    assert.equal(castOk(boolean, "0"), false);
  });

  test("rejects other values", () => {
    castFails(boolean, "yes");
    castFails(boolean, 1);
    castFails(boolean, "");
  });
});

describe("string, binary, map", () => {
  test("string accepts only strings", () => {
    assert.equal(castOk(string, "a"), "a");
    castFails(string, 1);
  });

  test("binary accepts only bytes and compares them", () => {
    const bytes = new Uint8Array([1, 2]);
    assert.equal(castOk(binary, bytes), bytes);
    castFails(binary, "ab");
    assert.ok(
      equalValues(binary, new Uint8Array([1, 2]), new Uint8Array([1, 2])),
    );
    assert.ok(
      !equalValues(binary, new Uint8Array([1, 2]), new Uint8Array([1, 3])),
    );
  });

  test("map accepts plain objects only", () => {
    assert.deepEqual(castOk(map, { a: 1 }), { a: 1 });
    castFails(map, [1]);
    castFails(map, new Date());
    castFails(map, "{}");
    assert.ok(equalValues(map, { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  });
});

describe("uuid", () => {
  test("casts hyphenated strings in any case to lowercase", () => {
    assert.equal(
      castOk(uuid, "601D74E4-A8D3-4B6E-8365-EDDB4C893327"),
      "601d74e4-a8d3-4b6e-8365-eddb4c893327",
    );
  });

  test("casts 16 raw bytes", () => {
    const bytes = new Uint8Array([
      0x60, 0x1d, 0x74, 0xe4, 0xa8, 0xd3, 0x4b, 0x6e, 0x83, 0x65, 0xed, 0xdb,
      0x4c, 0x89, 0x33, 0x27,
    ]);
    assert.equal(castOk(uuid, bytes), "601d74e4-a8d3-4b6e-8365-eddb4c893327");
  });

  test("rejects malformed values", () => {
    castFails(uuid, "601d74e4a8d34b6e8365eddb4c893327");
    castFails(uuid, "not-a-uuid");
    castFails(uuid, new Uint8Array(15));
  });
});

describe("date and time", () => {
  test("date casts ISO dates, naive date-times and Dates", () => {
    assert.equal(castOk(date, "2024-02-29"), "2024-02-29");
    assert.equal(castOk(date, "2024-02-29T10:00:00"), "2024-02-29");
    assert.equal(
      castOk(date, new Date(Date.UTC(2024, 0, 5, 23))),
      "2024-01-05",
    );
  });

  test("date rejects impossible dates and offsets", () => {
    castFails(date, "2023-02-29");
    castFails(date, "2024-13-01");
    castFails(date, "2024-02-29T10:00:00Z");
    castFails(date, "24-1-1");
  });

  test("time casts with or without seconds and drops fractions", () => {
    assert.equal(castOk(time, "10:30"), "10:30:00");
    assert.equal(castOk(time, "10:30:15.123"), "10:30:15");
    castFails(time, "24:00:00");
    castFails(time, "10:60");
  });
});

describe("utc_datetime", () => {
  test("casts ISO 8601 with offsets to UTC", () => {
    assert.deepEqual(
      castOk(utcDatetime, "2026-01-02T10:30:00+02:00"),
      new Date("2026-01-02T08:30:00Z"),
    );
    assert.deepEqual(
      castOk(utcDatetime, "2026-01-02 10:30:00Z"),
      new Date("2026-01-02T10:30:00Z"),
    );
  });

  test("takes date-times without an offset as UTC, seconds optional", () => {
    assert.deepEqual(
      castOk(utcDatetime, "2026-01-02T10:30"),
      new Date("2026-01-02T10:30:00Z"),
    );
    castFails(utcDatetime, "2026-01-02T10:30Z");
  });

  test("truncates to seconds, the msec variant keeps milliseconds", () => {
    const value = new Date("2026-01-02T10:30:00.789Z");
    assert.deepEqual(
      castOk(utcDatetime, value),
      new Date("2026-01-02T10:30:00Z"),
    );
    assert.deepEqual(castOk(utcDatetimeMsec, value), value);
    assert.deepEqual(
      castOk(utcDatetimeMsec, "2026-01-02T10:30:00.123456Z"),
      new Date("2026-01-02T10:30:00.123Z"),
    );
  });

  test("rejects invalid values", () => {
    castFails(utcDatetime, "2026-02-30T00:00:00Z");
    castFails(utcDatetime, new Date(Number.NaN));
    castFails(utcDatetime, 0);
  });

  test("dumping a utc_datetime with milliseconds throws, as Ecto raises", () => {
    assert.throws(
      () => dumpValue(utcDatetime, new Date("2026-01-02T10:30:00.5Z")),
      TypeError,
    );
    assert.ok(
      dumpValue(utcDatetimeMsec, new Date("2026-01-02T10:30:00.5Z")).ok,
    );
  });

  test("compares by time", () => {
    assert.ok(equalValues(utcDatetime, new Date(1000), new Date(1000)));
  });
});

describe("array", () => {
  test("casts every element", () => {
    assert.deepEqual(castOk(array(integer), ["1", 2]), [1, 2]);
    castFails(array(integer), ["1", "x"]);
    castFails(array(integer), [null]);
    castFails(array(integer), "1");
  });

  test("reports the primitive type as Ecto's {:array, type}", () => {
    assert.deepEqual(array(array(string)).type, ["array", ["array", "string"]]);
  });

  test("compares element-wise with the inner type", () => {
    assert.ok(equalValues(array(decimal), ["1.0"], ["1"]));
    assert.ok(!equalValues(array(decimal), ["1.0"], ["1", "2"]));
  });
});

describe("enumOf", () => {
  test("accepts only the listed values", () => {
    const role = enumOf(["admin", "member"]);
    assert.equal(castOk(role, "admin"), "admin");
    castFails(role, "owner");
    assert.deepEqual(role.values, ["admin", "member"]);
    assert.equal(role.type, "string");
  });

  test("needs at least one value", () => {
    assert.throws(() => enumOf([]), TypeError);
  });
});

describe("castValueOrThrow", () => {
  test("returns the value or throws CastError", () => {
    assert.equal(castValueOrThrow(integer, "1"), 1);
    assert.throws(
      () => castValueOrThrow(integer, 1.5),
      (err: unknown) =>
        err instanceof CastError &&
        err.message === "cannot cast 1.5 to integer",
    );
  });
});

describe("deepEqual", () => {
  test("handles nested structures", () => {
    assert.ok(deepEqual({ a: [1, new Date(5)] }, { a: [1, new Date(5)] }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!deepEqual([1], { 0: 1 }));
  });
});

describe("compareDecimal", () => {
  test("compares exactly, whatever the notation", () => {
    assert.equal(compareDecimal("1.50", "1.5"), 0);
    assert.equal(compareDecimal("0.00", "-0"), 0);
    assert.equal(compareDecimal("2", "10"), -1);
    assert.equal(compareDecimal("-2", "-10"), 1);
    assert.equal(compareDecimal("0.1", "0"), 1);
    assert.equal(compareDecimal("-0.1", "0"), -1);
    assert.equal(compareDecimal("1e3", "999.9999"), 1);
    assert.equal(
      compareDecimal("12345678901234567890.1", "12345678901234567890.01"),
      1,
    );
  });

  test("throws on invalid decimals", () => {
    assert.throws(() => compareDecimal("x", "1"), TypeError);
  });
});
