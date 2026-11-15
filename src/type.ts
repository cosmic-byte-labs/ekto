/**
 * Types: how a field's value is cast from external input, loaded from the
 * database and dumped back to it. Modelled on `Ecto.Type`.
 *
 * - `cast` turns external data (form params, JSON) into the runtime value.
 * - `load` turns what the database adapter returns into the runtime value.
 * - `dump` turns the runtime value into what the adapter sends to the database.
 * - `equal` decides whether two runtime values are the same, so `cast` can skip
 *   changes that change nothing.
 *
 * As in Ecto, `null` (and `undefined`) is handled outside the type: casting,
 * loading or dumping `null` always gives `null`, so a type implementation never
 * sees it.
 *
 * Converting driver representations (Postgres `int8` as a string, SQLite
 * booleans as `0`/`1`) is the adapter's job, not the type's, as with Ecto's
 * adapter loaders and dumpers.
 */

/** Primitive types that adapters know about (Ecto's base types). */
export type BaseType =
  | "id"
  | "integer"
  | "float"
  | "decimal"
  | "boolean"
  | "string"
  | "binary"
  | "map"
  | "uuid"
  | "date"
  | "time"
  | "utc_datetime"
  | "utc_datetime_msec"
  | "any";

/** A base type, or an array of one (Ecto's `{:array, type}`). */
export type PrimitiveType = BaseType | readonly ["array", PrimitiveType];

/** Extra information about a failed cast, kept in the changeset error. */
export type CastErrorMeta = Readonly<Record<string, unknown>>;

export type CastResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** Replaces the default "is invalid" message, like Ecto's `{:error, message: …}`. */
      readonly message?: string;
      readonly meta?: CastErrorMeta;
    };

/**
 * A field type. Implement this for custom types; the built-in types below
 * follow the same interface.
 */
export interface Type<T, P extends PrimitiveType = PrimitiveType> {
  /** The primitive type the adapter stores this type as (Ecto's `type/0`). */
  readonly type: P;
  cast(value: unknown): CastResult<T>;
  load(value: unknown): CastResult<T>;
  dump(value: unknown): CastResult<unknown>;
  /** Defaults to structural equality when left out. */
  equal?(a: T, b: T): boolean;
  /**
   * Generates a value for fields declared with `.autogenerate()` (Ecto's
   * `autogenerate/0` callback), e.g. a new UUID.
   */
  autogenerate?(): T;
}

/** The runtime value type of a `Type`. */
export type ValueOf<TType> = TType extends Type<infer T> ? T : never;

/** A successful result. */
export function ok<T>(value: T): CastResult<T> {
  return { ok: true, value };
}

/** A failed result, optionally with a custom message and metadata. */
export function error(
  options: { message?: string; meta?: CastErrorMeta } = {},
): CastResult<never> {
  return { ok: false, ...options };
}

/** Raised by the `…OrThrow` helpers when a value cannot be cast (Ecto.CastError). */
export class CastError extends Error {
  readonly type: PrimitiveType;
  readonly value: unknown;

  constructor(type: PrimitiveType, value: unknown, message?: string) {
    super(message ?? `cannot cast ${describe(value)} to ${formatType(type)}`);
    this.name = "CastError";
    this.type = type;
    this.value = value;
  }
}

function describe(value: unknown): string {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Formats a primitive type for messages: `integer`, `{array, integer}`. */
export function formatType(type: PrimitiveType): string {
  return typeof type === "string" ? type : `{array, ${formatType(type[1])}}`;
}

// ---------------------------------------------------------------------------
// Operations (Ecto.Type.cast/load/dump/equal?)
// ---------------------------------------------------------------------------

function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Casts external input to the runtime value. `null` casts to `null`. */
export function castValue<T>(
  type: Type<T>,
  value: unknown,
): CastResult<T | null> {
  return isNil(value) ? ok(null) : type.cast(value);
}

/** Like `castValue`, but throws `CastError` instead of returning an error. */
export function castValueOrThrow<T>(type: Type<T>, value: unknown): T | null {
  const result = castValue(type, value);
  if (!result.ok) throw new CastError(type.type, value, result.message);
  return result.value;
}

/** Loads a value returned by the adapter. `null` loads as `null`. */
export function loadValue<T>(
  type: Type<T>,
  value: unknown,
): CastResult<T | null> {
  return isNil(value) ? ok(null) : type.load(value);
}

/** Dumps a runtime value for the adapter. `null` dumps as `null`. */
export function dumpValue<T>(
  type: Type<T>,
  value: unknown,
): CastResult<unknown> {
  return isNil(value) ? ok(null) : type.dump(value);
}

/** Whether two runtime values are equal for the type. */
export function equalValues<T>(
  type: Type<T>,
  a: T | null,
  b: T | null,
): boolean {
  if (isNil(a) || isNil(b)) return isNil(a) && isNil(b);
  return type.equal ? type.equal(a, b) : deepEqual(a, b);
}

/**
 * Structural equality for runtime values: primitives, `Date`, `Uint8Array`,
 * arrays and plain objects.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b)
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Plain objects only: `{}` literals and `Object.create(null)`. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// Built-in types
// ---------------------------------------------------------------------------

const INTEGER = /^[+-]?\d+$/;
const FLOAT = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function castInteger(value: unknown): CastResult<number> {
  // Like Ecto, refuse long strings before parsing; past 2^53 a JS number
  // cannot represent the integer exactly, so refuse those as well.
  if (typeof value === "string") {
    if (value.length >= 32 || !INTEGER.test(value)) return error();
    return sameInteger(Number(value));
  }
  return sameInteger(value);
}

function sameInteger(value: unknown): CastResult<number> {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? ok(value)
    : error();
}

/** Integer primary keys (Ecto's `:id`). */
export const id: Type<number, "id"> = {
  type: "id",
  cast: castInteger,
  load: sameInteger,
  dump: sameInteger,
  equal: Object.is,
};

export const integer: Type<number, "integer"> = {
  type: "integer",
  cast: castInteger,
  load: sameInteger,
  dump: sameInteger,
  equal: Object.is,
};

function sameFloat(value: unknown): CastResult<number> {
  return typeof value === "number" && Number.isFinite(value)
    ? ok(value)
    : error();
}

export const float: Type<number, "float"> = {
  type: "float",
  cast: (value) => {
    if (typeof value === "string")
      return FLOAT.test(value) ? sameFloat(Number(value)) : error();
    return sameFloat(value);
  },
  load: sameFloat,
  dump: sameFloat,
  equal: Object.is,
};

/**
 * Arbitrary-precision decimals, kept as strings so no precision is lost and no
 * decimal library is required. Numbers are accepted and converted.
 */
export const decimal: Type<string, "decimal"> = {
  type: "decimal",
  cast: sameDecimal,
  load: sameDecimal,
  dump: sameDecimal,
  equal: (a, b) => compareDecimal(a, b) === 0,
};

function sameDecimal(value: unknown): CastResult<string> {
  if (typeof value === "string")
    return DECIMAL.test(value) ? ok(value) : error();
  if (typeof value === "number")
    return Number.isFinite(value) ? ok(String(value)) : error();
  if (typeof value === "bigint") return ok(value.toString());
  return error();
}

interface ParsedDecimal {
  readonly negative: boolean;
  /** Significant digits without leading or trailing zeros; "" for zero. */
  readonly digits: string;
  /** Power of ten the digits are multiplied by. */
  readonly exponent: number;
}

function parseDecimal(value: string): ParsedDecimal {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || !DECIMAL.test(value)) {
    throw new TypeError(`invalid decimal: ${JSON.stringify(value)}`);
  }
  const [, sign = "", int = "", frac = "", exp = "0"] = match;
  const all = (int + frac).replace(/^0+/, "");
  const trimmed = all.replace(/0+$/, "");
  return {
    negative: sign === "-" && trimmed !== "",
    digits: trimmed,
    exponent: Number(exp) - frac.length + (all.length - trimmed.length),
  };
}

/**
 * Compares two decimal strings exactly: -1, 0 or 1 (Ecto's
 * `Decimal.compare/2`). `"1.50"`, `"1.5"` and `"15e-1"` are equal.
 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  const sign = x.negative ? -1 : 1;
  if (x.digits === "" || y.digits === "") {
    if (x.digits === y.digits) return 0;
    return x.digits === "" ? (-sign as -1 | 1) : (sign as -1 | 1);
  }
  // Compare the position of the leading digit, then the digits themselves.
  const xMagnitude = x.digits.length + x.exponent;
  const yMagnitude = y.digits.length + y.exponent;
  if (xMagnitude !== yMagnitude)
    return (xMagnitude > yMagnitude ? sign : -sign) as -1 | 1;
  const width = Math.max(x.digits.length, y.digits.length);
  const xs = x.digits.padEnd(width, "0");
  const ys = y.digits.padEnd(width, "0");
  if (xs === ys) return 0;
  return (xs > ys ? sign : -sign) as -1 | 1;
}

function sameBoolean(value: unknown): CastResult<boolean> {
  return typeof value === "boolean" ? ok(value) : error();
}

export const boolean: Type<boolean, "boolean"> = {
  type: "boolean",
  cast: (value) => {
    if (value === "true" || value === "1") return ok(true);
    if (value === "false" || value === "0") return ok(false);
    return sameBoolean(value);
  },
  load: sameBoolean,
  dump: sameBoolean,
  equal: Object.is,
};

function sameString(value: unknown): CastResult<string> {
  return typeof value === "string" ? ok(value) : error();
}

export const string: Type<string, "string"> = {
  type: "string",
  cast: sameString,
  load: sameString,
  dump: sameString,
  equal: Object.is,
};

function sameBinary(value: unknown): CastResult<Uint8Array> {
  return value instanceof Uint8Array ? ok(value) : error();
}

/** Raw bytes (`bytea` / `BLOB`). */
export const binary: Type<Uint8Array, "binary"> = {
  type: "binary",
  cast: sameBinary,
  load: sameBinary,
  dump: sameBinary,
  equal: bytesEqual,
};

function sameMap(value: unknown): CastResult<Record<string, unknown>> {
  return isPlainObject(value) ? ok(value) : error();
}

/** A JSON object (Ecto's `:map`). */
export const map: Type<Record<string, unknown>, "map"> = {
  type: "map",
  cast: sameMap,
  load: sameMap,
  dump: sameMap,
};

/** Any value, passed through unchanged (Ecto's `:any`). */
export const any: Type<unknown, "any"> = {
  type: "any",
  cast: ok,
  load: ok,
  dump: ok,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: unknown): CastResult<string> {
  if (typeof value === "string")
    return UUID.test(value) ? ok(value.toLowerCase()) : error();
  if (value instanceof Uint8Array && value.length === 16)
    return ok(encodeUuid(value));
  return error();
}

function encodeUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUIDs as lowercase hyphenated strings (Ecto.UUID). */
export const uuid: Type<string, "uuid"> = {
  type: "uuid",
  cast: castUuid,
  load: castUuid,
  dump: (value) =>
    typeof value === "string" && UUID.test(value) ? ok(value) : error(),
  equal: Object.is,
  autogenerate: generateUuid,
};

/** Generates a random (version 4) UUID, as Ecto.UUID.generate/0. */
export function generateUuid(): string {
  return globalThis.crypto.randomUUID();
}

// Dates and times --------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (days[month - 1] ?? 0);
}

function validTime(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 59;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function formatDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function castDate(value: unknown): CastResult<string> {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return error();
    return ok(
      formatDate(
        value.getUTCFullYear(),
        value.getUTCMonth() + 1,
        value.getUTCDate(),
      ),
    );
  }
  if (typeof value !== "string") return error();
  const date = DATE.exec(value);
  if (date) {
    const [year, month, day] = date.slice(1, 4).map(Number) as [
      number,
      number,
      number,
    ];
    return validDate(year, month, day) ? ok(value) : error();
  }
  // Like Ecto, a date-time without an offset casts to its date.
  const parsed = parseDatetime(value);
  if (parsed === null || parsed.offset !== undefined) return error();
  return ok(value.slice(0, 10));
}

function sameDate(value: unknown): CastResult<string> {
  if (typeof value !== "string") return error();
  const date = DATE.exec(value);
  if (!date) return error();
  const [year, month, day] = date.slice(1, 4).map(Number) as [
    number,
    number,
    number,
  ];
  return validDate(year, month, day) ? ok(value) : error();
}

/** Calendar dates as `"YYYY-MM-DD"` strings (Ecto's `:date`). */
export const date: Type<string, "date"> = {
  type: "date",
  cast: castDate,
  load: sameDate,
  dump: sameDate,
  equal: Object.is,
};

function castTime(value: unknown): CastResult<string> {
  if (typeof value !== "string") return error();
  const time = TIME.exec(value);
  if (!time) return error();
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = Number(time[3] ?? 0);
  if (!validTime(hour, minute, second)) return error();
  // Ecto's :time drops fractional seconds.
  return ok(`${pad(hour)}:${pad(minute)}:${pad(second)}`);
}

function sameTime(value: unknown): CastResult<string> {
  return typeof value === "string" && /^\d{2}:\d{2}:\d{2}$/.test(value)
    ? castTime(value)
    : error();
}

/** Times of day as `"HH:MM:SS"` strings, without fractional seconds (Ecto's `:time`). */
export const time: Type<string, "time"> = {
  type: "time",
  cast: castTime,
  load: sameTime,
  dump: sameTime,
  equal: Object.is,
};

interface ParsedDatetime {
  /** Milliseconds since the epoch, reading the wall time as UTC. */
  readonly wallMs: number;
  /** The offset, if the string had one. */
  readonly offset: string | undefined;
}

function parseDatetime(value: string): ParsedDatetime | null {
  const match = DATETIME.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = Number(match[6] ?? 0);
  const fraction = match[7] ?? "";
  const offset = match[8];
  // Like Ecto, seconds may only be left out when there is no offset
  // (HTML `datetime-local` inputs send "2026-01-02T10:30").
  if (match[6] === undefined && offset !== undefined) return null;
  if (!validDate(year, month, day) || !validTime(hour, minute, second))
    return null;
  const ms = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return { wallMs, offset };
}

function offsetMs(offset: string): number {
  if (offset.toUpperCase() === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  return (
    sign *
    (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) *
    60_000
  );
}

function castUtcDatetime(value: unknown, truncate: boolean): CastResult<Date> {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime();
    if (Number.isNaN(ms)) return error();
  } else if (typeof value === "string") {
    const parsed = parseDatetime(value);
    if (parsed === null) return error();
    // Without an offset, the time is taken as UTC.
    ms =
      parsed.wallMs -
      (parsed.offset === undefined ? 0 : offsetMs(parsed.offset));
  } else {
    return error();
  }
  return ok(new Date(truncate ? ms - (((ms % 1000) + 1000) % 1000) : ms));
}

function sameDatetime(value: unknown): CastResult<Date> {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? ok(value)
    : error();
}

function dumpUtcDatetime(value: unknown): CastResult<unknown> {
  const result = sameDatetime(value);
  // Ecto raises when a :utc_datetime has microseconds: cast and autogenerate
  // always truncate, so a value with them was built by hand and would silently
  // lose precision.
  if (result.ok && result.value.getTime() % 1000 !== 0) {
    throw new TypeError(
      ":utc_datetime expects the milliseconds to be 0, got " +
        `${result.value.toISOString()}; use the utc_datetime_msec type to keep them`,
    );
  }
  return result;
}

/** Points in time as `Date`s, truncated to whole seconds (Ecto's `:utc_datetime`). */
export const utcDatetime: Type<Date, "utc_datetime"> = {
  type: "utc_datetime",
  cast: (value) => castUtcDatetime(value, true),
  load: (value) => {
    const result = sameDatetime(value);
    return result.ok ? castUtcDatetime(result.value, true) : result;
  },
  dump: dumpUtcDatetime,
};

/**
 * Points in time as `Date`s with millisecond precision, the most a JS `Date`
 * holds (Ecto's `:utc_datetime_usec` has microseconds).
 */
export const utcDatetimeMsec: Type<Date, "utc_datetime_msec"> = {
  type: "utc_datetime_msec",
  cast: (value) => castUtcDatetime(value, false),
  load: sameDatetime,
  dump: sameDatetime,
};

// Parameterized types ------------------------------------------------------------

/** The type returned by `array`; `of` is the element type. */
export interface ArrayType<T, P extends PrimitiveType = PrimitiveType>
  extends Type<T[], readonly ["array", P]> {
  readonly of: Type<T, P>;
}

/** A list of values of one type (Ecto's `{:array, type}`). */
export function array<T, P extends PrimitiveType>(
  of: Type<T, P>,
): ArrayType<T, P> {
  const each =
    (fn: (value: unknown) => CastResult<unknown>) =>
    (value: unknown): CastResult<T[]> => {
      if (!Array.isArray(value)) return error();
      const out: unknown[] = [];
      for (const item of value) {
        // As in Ecto, `null` elements are passed to the inner type, which
        // rejects them unless it accepts them.
        const result = fn(item);
        if (!result.ok) return result;
        out.push(result.value);
      }
      return ok(out as T[]);
    };
  return {
    type: ["array", of.type] as const,
    of,
    cast: each((v) => of.cast(v)),
    load: each((v) => of.load(v)),
    dump: each((v) => of.dump(v)),
    equal: (a, b) =>
      a.length === b.length &&
      a.every((item, i) => equalValues(of, item, b[i] as T)),
  };
}

/** A string limited to the given values, stored as a string (Ecto.Enum). */
export interface EnumType<V extends string> extends Type<V, "string"> {
  readonly values: readonly V[];
}

export function enumOf<const V extends string>(
  values: readonly V[],
): EnumType<V> {
  if (values.length === 0) throw new TypeError("enum needs at least one value");
  const allowed = new Set<string>(values);
  const same = (value: unknown): CastResult<V> =>
    typeof value === "string" && allowed.has(value) ? ok(value as V) : error();
  return {
    type: "string",
    values: Object.freeze([...values]),
    cast: same,
    load: same,
    dump: same,
    equal: Object.is,
  };
}
