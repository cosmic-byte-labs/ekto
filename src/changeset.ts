/**
 * Changesets: filter, cast, validate and track changes to a record before it
 * is written. Modelled on `Ecto.Changeset`.
 *
 * Every function returns a new changeset; nothing is mutated. Functions that
 * transform a changeset can be called directly (`validateRequired(cs,
 * ["email"])`) or without the changeset to get a step for `pipe`:
 *
 * ```ts
 * const cs = pipe(
 *   cast(User.new(), params, ["email", "age"]),
 *   validateRequired(["email"]),
 *   validateNumber("age", { greaterThanOrEqualTo: 0 }),
 *   uniqueConstraint("email"),
 * );
 * ```
 *
 * Errors keep Ecto's shape: an un-interpolated message plus metadata
 * (`{ field: "age", message: "must be greater than or equal to %{number}",
 * meta: { validation: "number", kind: "greaterThanOrEqualTo", number: 0 } }`);
 * `traverseErrors` interpolates them. Like Ecto's keyword list, the newest
 * errors come first.
 */

import { type AnyField, Field, getMeta } from "./schema.ts";
import {
  type ArrayType,
  boolean as booleanType,
  CastError,
  castValue,
  compareDecimal,
  equalValues,
  isPlainObject,
  type PrimitiveType,
  type Type,
} from "./type.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata of an error, e.g. `{ validation: "length", kind: "min", count: 3 }`. */
export type ErrorMeta = Readonly<Record<string, unknown>>;

export interface ChangesetError {
  readonly field: string;
  /** The message, with `%{key}` placeholders for values in `meta`. */
  readonly message: string;
  readonly meta: ErrorMeta;
}

/** What Repo was asked to do with the changeset. */
export type Action =
  | "insert"
  | "update"
  | "delete"
  | "replace"
  | "ignore"
  | "validate";

export type ConstraintType = "unique" | "foreign_key" | "check" | "exclusion";

/** How a declared constraint name matches the name the database reports. */
export type ConstraintMatch = "exact" | "suffix" | "prefix";

/** A constraint declared on the changeset (Ecto's `changeset.constraints`). */
export interface Constraint {
  readonly type: ConstraintType;
  readonly constraint: string | RegExp;
  readonly match: ConstraintMatch;
  readonly field: string;
  readonly errorMessage: string;
  /** The `constraint` metadata of the error added on violation. */
  readonly errorType: string;
}

/** A validation that ran, kept for reflection (Ecto's `changeset.validations`). */
export interface Validation {
  readonly field: string;
  readonly validation: string;
  readonly options: unknown;
}

/** The fields of a changeset's data. */
export type Key<D> = keyof D & string;

type Changes<D> = { readonly [K in keyof D]?: D[K] };

type Types = Readonly<Record<string, Type<unknown>>>;

interface ChangesetFields<D extends object> {
  readonly data: D;
  readonly types: Types;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly changes: Changes<D>;
  readonly errors: readonly ChangesetError[];
  readonly valid: boolean;
  readonly required: readonly string[];
  readonly validations: readonly Validation[];
  readonly constraints: readonly Constraint[];
  readonly filters: Readonly<Record<string, unknown>>;
  readonly action: Action | null;
  readonly prepare: readonly ((changeset: Changeset<D>) => Changeset<D>)[];
  readonly emptyValues: readonly unknown[];
}

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

/**
 * A changeset over data of type `D`: a schema record, or plain data with
 * explicit types for schemaless changesets.
 */
export class Changeset<D extends object> implements ChangesetFields<D> {
  /** The original data. */
  readonly data: D;
  /** The type of every field, virtual ones included. */
  readonly types: Types;
  /** The params given to `cast`, or `null`. */
  readonly params: Readonly<Record<string, unknown>> | null;
  /** Changed fields and their new values. */
  readonly changes: Changes<D>;
  readonly errors: readonly ChangesetError[];
  /** `true` while there are no errors (Ecto's `valid?`). */
  readonly valid: boolean;
  /** Fields passed to `validateRequired`. */
  readonly required: readonly string[];
  readonly validations: readonly Validation[];
  readonly constraints: readonly Constraint[];
  /** Extra conditions Repo adds to update and delete queries. */
  readonly filters: Readonly<Record<string, unknown>>;
  readonly action: Action | null;
  /** Functions Repo runs before writing (see `prepareChanges`). */
  readonly prepare: readonly ((changeset: Changeset<D>) => Changeset<D>)[];
  readonly emptyValues: readonly unknown[];

  constructor(fields: ChangesetFields<D>) {
    this.data = fields.data;
    this.types = fields.types;
    this.params = fields.params;
    this.changes = Object.freeze({ ...fields.changes });
    this.errors = Object.freeze([...fields.errors]);
    this.valid = fields.valid;
    this.required = Object.freeze([...fields.required]);
    this.validations = Object.freeze([...fields.validations]);
    this.constraints = Object.freeze([...fields.constraints]);
    this.filters = Object.freeze({ ...fields.filters });
    this.action = fields.action;
    this.prepare = Object.freeze([...fields.prepare]);
    this.emptyValues = fields.emptyValues;
    Object.freeze(this);
  }

  /** Like Ecto's Inspect implementation: hides params and redacted changes. */
  [inspectCustom](): object {
    const redact = new Set(redactedFields(this.data));
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.changes)) {
      changes[key] = redact.has(key) ? "**redacted**" : value;
    }
    return {
      action: this.action,
      changes,
      errors: this.errors,
      data: this.data,
      valid: this.valid,
    };
  }
}

/** A changeset over any data. */
// biome-ignore lint/suspicious/noExplicitAny: any data
export type AnyChangeset = Changeset<any>;

function update<D extends object>(
  changeset: Changeset<D>,
  patch: Partial<ChangesetFields<D>>,
): Changeset<D> {
  return new Changeset<D>({ ...changeset, ...patch });
}

function redactedFields(data: object): readonly string[] {
  return getMeta(data)?.schema.redactFields ?? [];
}

export function isChangeset(value: unknown): value is AnyChangeset {
  return value instanceof Changeset;
}

/** Ecto's default `empty_values`: `""` (after trimming leading whitespace). */
const defaultEmptyValues: readonly unknown[] = Object.freeze([""]);

function typesOf(data: object): Types {
  const meta = getMeta(data);
  if (!meta) {
    throw new TypeError(
      "expected a record created by a schema or a changeset; " +
        "use schemaless(types, data) for plain data",
    );
  }
  const types: Record<string, Type<unknown>> = {};
  for (const [name, field] of Object.entries(meta.schema.fields)) {
    types[name] = (field as AnyField).type;
  }
  return types;
}

function emptyChangeset<D extends object>(data: D, types: Types): Changeset<D> {
  return new Changeset<D>({
    data,
    types,
    params: null,
    changes: {},
    errors: [],
    valid: true,
    required: [],
    validations: [],
    constraints: [],
    filters: {},
    action: null,
    prepare: [],
    emptyValues: defaultEmptyValues,
  });
}

function ensureField(changeset: AnyChangeset, field: string): Type<unknown> {
  const type = changeset.types[field];
  if (!type) {
    throw new TypeError(
      `unknown field ${field}; the known fields are: ${Object.keys(changeset.types).join(", ")}`,
    );
  }
  return type;
}

/**
 * Lets a function be called with the changeset first, or without it to get a
 * step for `pipe`.
 */
function dual(
  args: readonly unknown[],
  // biome-ignore lint/suspicious/noExplicitAny: the implementations check their own arguments
  impl: (changeset: AnyChangeset, ...rest: any[]) => AnyChangeset,
): AnyChangeset | ((changeset: AnyChangeset) => AnyChangeset) {
  if (isChangeset(args[0])) return impl(args[0], ...args.slice(1));
  return (changeset: AnyChangeset) => impl(changeset, ...args);
}

// ---------------------------------------------------------------------------
// Schemaless changesets
// ---------------------------------------------------------------------------

/** The data type of a schemaless changeset over the given types. */
export type SchemalessData<
  T extends Readonly<Record<string, Type<unknown> | AnyField>>,
> = {
  -readonly [K in keyof T]: (
    T[K] extends AnyField
      ? T[K]["type"]
      : T[K]
  ) extends Type<infer V>
    ? V | null
    : never;
};

/**
 * An empty changeset over plain data with explicit types (Ecto's
 * `{data, types}`), for validating input that is not a schema record, such
 * as a search form. Types may be `Type`s or `t.*` fields.
 */
export function schemaless<
  const T extends Readonly<Record<string, Type<unknown> | AnyField>>,
>(
  types: T,
  data: Partial<SchemalessData<T>> = {},
): Changeset<SchemalessData<T>> {
  const resolved: Record<string, Type<unknown>> = {};
  const full: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(types)) {
    resolved[name] =
      type instanceof Field ? type.type : (type as Type<unknown>);
    full[name] = (data as Record<string, unknown>)[name] ?? null;
  }
  return emptyChangeset(full as SchemalessData<T>, Object.freeze(resolved));
}

// ---------------------------------------------------------------------------
// cast and change
// ---------------------------------------------------------------------------

export interface CastOptions {
  /** Values treated as empty, so the field gets its default (default `[""]`). */
  readonly emptyValues?: readonly unknown[];
  /** Record changes even when the value equals the current one. */
  readonly force?: boolean;
  /** Replaces the "is invalid" message: return a message, or `undefined` for the default. */
  readonly message?: (field: string, meta: ErrorMeta) => string | undefined;
}

/**
 * Applies `params` to `data` as changes, keeping only the `permitted` fields
 * and casting each value to the field's type (Ecto's `cast/4`).
 *
 * - Params missing a field leave it unchanged; values equal to the current
 *   one are not recorded as changes.
 * - Empty values (`""`, after trimming leading whitespace) become the field's
 *   default, usually `null`.
 * - Values that cannot be cast add an `"is invalid"` error with
 *   `{ validation: "cast", type }`.
 *
 * `data` is a schema record or an existing changeset, whose changes are kept.
 */
export function cast<D extends object>(
  data: D | Changeset<D>,
  params: unknown,
  permitted: readonly Key<D>[],
  options: CastOptions = {},
): Changeset<D> {
  if (!isPlainObject(params)) {
    throw new CastError("map", params, "expected params to be a plain object");
  }
  const base = isChangeset(data) ? data : emptyChangeset(data, typesOf(data));
  const emptyValues = options.emptyValues ?? base.emptyValues;
  const defaults = defaultsOf(base.data);
  const changes: Record<string, unknown> = { ...base.changes };
  const errors: ChangesetError[] = [];

  for (const field of permitted) {
    const type = ensureField(base, field);
    if (!Object.hasOwn(params, field)) continue;
    const current = Object.hasOwn(changes, field)
      ? changes[field]
      : (base.data as Record<string, unknown>)[field];
    const value = filterEmpty(
      type.type,
      params[field],
      emptyValues,
      defaults[field] ?? null,
    );
    const result = castValue(type, value);
    if (result.ok) {
      if (options.force || !equalValues(type, current, result.value)) {
        changes[field] = result.value;
      }
    } else {
      const meta: ErrorMeta = {
        validation: "cast",
        ...result.meta,
        type: type.type,
      };
      const message =
        options.message?.(field, meta) ?? result.message ?? "is invalid";
      errors.unshift({ field, message, meta });
    }
  }

  return update(base, {
    params: { ...base.params, ...params },
    changes: changes as Changes<D>,
    errors: [...errors, ...base.errors],
    valid: base.valid && errors.length === 0,
    emptyValues,
  });
}

function defaultsOf(data: object): Readonly<Record<string, unknown>> {
  const schema = getMeta(data)?.schema;
  return schema ? schema.new() : {};
}

function isEmpty(
  type: PrimitiveType,
  value: unknown,
  emptyValues: readonly unknown[],
): boolean {
  // Ecto.Type.trim/2: strings are compared without leading whitespace.
  const trimmed =
    typeof value === "string" && type !== "binary" ? value.trimStart() : value;
  return emptyValues.some((empty) => Object.is(empty, trimmed));
}

function filterEmpty(
  type: PrimitiveType,
  value: unknown,
  emptyValues: readonly unknown[],
  fallback: unknown,
): unknown {
  if (typeof type !== "string" && Array.isArray(value)) {
    // Like Ecto, empty elements are dropped from arrays.
    const filtered = value.filter(
      (item) => !isEmpty(type[1], item, emptyValues),
    );
    return isEmpty(type, filtered, emptyValues) ? fallback : filtered;
  }
  return isEmpty(type, value, emptyValues) ? fallback : value;
}

/**
 * A changeset with the given changes, without casting or validating them
 * (Ecto's `change/2`). Use it for internal data; use `cast` for external
 * input.
 */
export function change<D extends object>(
  data: D | Changeset<D>,
  changes: Partial<D> = {},
): Changeset<D> {
  let changeset: AnyChangeset = isChangeset(data)
    ? data
    : emptyChangeset(data, typesOf(data));
  for (const [field, value] of Object.entries(changes)) {
    changeset = putChangeImpl(changeset, field, value);
  }
  return changeset as Changeset<D>;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The change for `field` if there is one, else its value in the data (Ecto's `get_field`). */
export function getField<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
): D[K] {
  ensureField(changeset, field);
  return Object.hasOwn(changeset.changes, field)
    ? (changeset.changes[field] as D[K])
    : changeset.data[field];
}

/** The change for `field`, or `undefined` if it is unchanged (Ecto's `get_change`). */
export function getChange<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
): D[K] | undefined {
  ensureField(changeset, field);
  return changeset.changes[field];
}

/**
 * Where `field`'s value comes from and what it is (Ecto's `fetch_field`):
 * the changes, or the data.
 */
export function fetchField<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
): { readonly from: "changes" | "data"; readonly value: D[K] } {
  ensureField(changeset, field);
  return Object.hasOwn(changeset.changes, field)
    ? { from: "changes", value: changeset.changes[field] as D[K] }
    : { from: "data", value: changeset.data[field] };
}

/**
 * Whether `field` changed (Ecto's `changed?`), optionally to or from a given
 * value.
 */
export function changed<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  options: { readonly to?: D[K]; readonly from?: D[K] } = {},
): boolean {
  const type = ensureField(changeset, field);
  if (!Object.hasOwn(changeset.changes, field)) return false;
  if (
    "to" in options &&
    !equalValues(type, changeset.changes[field], options.to)
  )
    return false;
  if (
    "from" in options &&
    !equalValues(type, changeset.data[field], options.from)
  )
    return false;
  return true;
}

/** Whether `field` is `null` or empty, counting changes (Ecto's `field_missing?`). */
export function fieldMissing<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
): boolean {
  const value = getField(changeset, field);
  return (
    value === null ||
    value === undefined ||
    changeset.emptyValues.includes(value)
  );
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

function putChangeImpl(
  changeset: AnyChangeset,
  field: string,
  value: unknown,
): AnyChangeset {
  const type = ensureField(changeset, field);
  const changes = { ...changeset.changes };
  // As in Ecto, a value equal to the data's removes the change.
  if (equalValues(type, changeset.data[field], value)) delete changes[field];
  else changes[field] = value;
  return update(changeset, { changes });
}

/**
 * Puts a change without casting it (Ecto's `put_change`). A value equal to
 * the one in the data removes the change instead.
 */
export function putChange<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  value: D[K],
): Changeset<D>;
export function putChange<const K extends string, V>(
  field: K,
  value: V,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function putChange(...args: unknown[]): unknown {
  return dual(args, putChangeImpl);
}

/** Puts a change even when it equals the data (Ecto's `force_change`). */
export function forceChange<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  value: D[K],
): Changeset<D>;
export function forceChange<const K extends string, V>(
  field: K,
  value: V,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function forceChange(...args: unknown[]): unknown {
  return dual(args, (changeset, field: string, value: unknown) => {
    ensureField(changeset, field);
    return update(changeset, {
      changes: { ...changeset.changes, [field]: value },
    });
  });
}

/** Removes the change for `field` (Ecto's `delete_change`). */
export function deleteChange<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
): Changeset<D>;
export function deleteChange<const K extends string>(
  field: K,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function deleteChange(...args: unknown[]): unknown {
  return dual(args, (changeset, field: string) => {
    ensureField(changeset, field);
    const changes = { ...changeset.changes };
    delete changes[field];
    return update(changeset, { changes });
  });
}

/** Replaces the change for `field` with `fn(change)`, if there is one (Ecto's `update_change`). */
export function updateChange<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  fn: (value: D[K]) => D[K],
): Changeset<D>;
export function updateChange<const K extends string, V>(
  field: K,
  fn: (value: V) => V,
): <D extends Record<K, V>>(changeset: Changeset<D>) => Changeset<D>;
export function updateChange(...args: unknown[]): unknown {
  return dual(
    args,
    (changeset, field: string, fn: (value: unknown) => unknown) => {
      ensureField(changeset, field);
      if (!Object.hasOwn(changeset.changes, field)) return changeset;
      return putChangeImpl(changeset, field, fn(changeset.changes[field]));
    },
  );
}

/** The data with the changes applied, whether valid or not (Ecto's `apply_changes`). */
export function applyChanges<D extends object>(changeset: Changeset<D>): D {
  const applied = { ...changeset.data, ...changeset.changes } as D;
  // Keep the record's metadata (and its redacting inspect), which spreading drops.
  for (const key of Object.getOwnPropertySymbols(changeset.data)) {
    const descriptor = Object.getOwnPropertyDescriptor(changeset.data, key);
    if (descriptor && !descriptor.enumerable)
      Object.defineProperty(applied, key, descriptor);
  }
  return applied;
}

export type ApplyResult<D> =
  | { readonly ok: true; readonly value: D }
  | { readonly ok: false; readonly changeset: Changeset<D & object> };

/**
 * Applies the changes if the changeset is valid, else returns it with the
 * action set (Ecto's `apply_action`). Useful for changesets that are never
 * written, such as search forms.
 */
export function applyAction<D extends object>(
  changeset: Changeset<D>,
  action: Action,
): ApplyResult<D> {
  if (changeset.valid) return { ok: true, value: applyChanges(changeset) };
  return { ok: false, changeset: update(changeset, { action }) };
}

/** Raised by `applyActionOrThrow` and Repo's `…OrThrow` functions (Ecto.InvalidChangesetError). */
export class InvalidChangesetError extends Error {
  readonly action: Action;
  readonly changeset: AnyChangeset;

  constructor(action: Action, changeset: AnyChangeset) {
    const errors = changeset.errors
      .map((e) => `${e.field}: ${e.message}`)
      .join(", ");
    super(
      `could not perform ${action} because changeset is invalid: ${errors}`,
    );
    this.name = "InvalidChangesetError";
    this.action = action;
    this.changeset = changeset;
  }
}

/** Like `applyAction`, but throws `InvalidChangesetError` when invalid (Ecto's `apply_action!`). */
export function applyActionOrThrow<D extends object>(
  changeset: Changeset<D>,
  action: Action,
): D {
  const result = applyAction(changeset, action);
  if (!result.ok) throw new InvalidChangesetError(action, result.changeset);
  return result.value;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function addErrorImpl(
  changeset: AnyChangeset,
  field: string,
  message: string,
  meta: ErrorMeta = {},
): AnyChangeset {
  return update(changeset, {
    errors: [{ field, message, meta }, ...changeset.errors],
    valid: false,
  });
}

/** Adds an error and marks the changeset invalid (Ecto's `add_error`). */
export function addError<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  message: string,
  meta?: ErrorMeta,
): Changeset<D>;
export function addError<const K extends string>(
  field: K,
  message: string,
  meta?: ErrorMeta,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function addError(...args: unknown[]): unknown {
  return dual(args, addErrorImpl);
}

/** Replaces `%{key}` placeholders in a message with values from its metadata. */
export function interpolate(
  error: Pick<ChangesetError, "message" | "meta">,
): string {
  return error.message.replace(/%\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(error.meta, key) ? String(error.meta[key]) : placeholder,
  );
}

/**
 * Groups errors by field, turning each into a message (Ecto's
 * `traverse_errors`). By default, messages are interpolated with their
 * metadata.
 *
 * ```ts
 * traverseErrors(cs); // { password: ["should be at least 12 character(s)"] }
 * ```
 */
export function traverseErrors<D extends object, R = string>(
  changeset: Changeset<D>,
  fn: (
    error: ChangesetError,
    changeset: Changeset<D>,
  ) => R = interpolate as never,
): Partial<Record<Key<D>, R[]>> & Record<string, R[]> {
  const out: Record<string, R[]> = {};
  // Like Ecto, walk from the oldest error and prepend, so each field lists
  // its newest error first.
  for (const error of [...changeset.errors].reverse()) {
    const messages = out[error.field] ?? [];
    messages.unshift(fn(error, changeset));
    out[error.field] = messages;
  }
  return out as Partial<Record<Key<D>, R[]>> & Record<string, R[]>;
}

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

export interface MessageOptions {
  /** Replaces the default error message. */
  readonly message?: string;
}

/** An error returned by a `validateChange` validator: `[field, message]` or `[field, message, meta]`. */
export type ValidatorError = readonly [
  field: string,
  message: string,
  meta?: ErrorMeta,
];

function validateChangeImpl(
  changeset: AnyChangeset,
  field: string,
  validation: Validation | null,
  validator: (field: string, value: unknown) => readonly ValidatorError[],
): AnyChangeset {
  ensureField(changeset, field);
  const validations = validation
    ? [validation, ...changeset.validations]
    : changeset.validations;
  const value = changeset.changes[field];
  // As in Ecto, validators only run on changes, and never on null.
  const found =
    value === null || value === undefined ? [] : validator(field, value);
  if (found.length === 0) return update(changeset, { validations });
  return update(changeset, {
    validations,
    errors: [
      ...found.map(([errorField, message, meta = {}]) => ({
        field: errorField,
        message,
        meta,
      })),
      ...changeset.errors,
    ],
    valid: false,
  });
}

/**
 * Runs `validator` on the change for `field`, if there is one and it is not
 * `null` (Ecto's `validate_change`). The validator returns the errors to add.
 *
 * ```ts
 * validateChange("email", (field, value) =>
 *   value.endsWith("@example.com") ? [[field, "is not allowed"]] : []);
 * ```
 */
export function validateChange<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  validator: (field: K, value: NonNullable<D[K]>) => readonly ValidatorError[],
): Changeset<D>;
export function validateChange<const K extends string, V = unknown>(
  field: K,
  validator: (field: K, value: NonNullable<V>) => readonly ValidatorError[],
): <D extends Record<K, V>>(changeset: Changeset<D>) => Changeset<D>;
export function validateChange(...args: unknown[]): unknown {
  return dual(args, (changeset, field: string, validator) =>
    validateChangeImpl(changeset, field, null, validator),
  );
}

function errorFor(
  field: string,
  options: MessageOptions,
  message: string,
  meta: ErrorMeta,
): ValidatorError {
  return [field, options.message ?? message, meta];
}

/**
 * Checks that the fields are present: not `null` and not an empty value,
 * counting changes and data (Ecto's `validate_required`). Missing fields get
 * `"can't be blank"` with `{ validation: "required" }`, unless they already
 * have an error, and their changes are dropped.
 */
export function validateRequired<D extends object>(
  changeset: Changeset<D>,
  fields: Key<D> | readonly Key<D>[],
  options?: MessageOptions,
): Changeset<D>;
export function validateRequired<const K extends string>(
  fields: K | readonly K[],
  options?: MessageOptions,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function validateRequired(...args: unknown[]): unknown {
  return dual(
    args,
    (
      changeset,
      fieldOrFields: string | readonly string[],
      options: MessageOptions = {},
    ) => {
      const fields =
        typeof fieldOrFields === "string"
          ? [fieldOrFields]
          : [...fieldOrFields];
      const missing = fields.filter((field) => {
        ensureField(changeset, field);
        return (
          fieldMissing(changeset, field) &&
          !changeset.errors.some((error) => error.field === field)
        );
      });
      const required = [...fields, ...changeset.required];
      if (missing.length === 0) return update(changeset, { required });
      const changes = { ...changeset.changes };
      for (const field of missing) delete changes[field];
      return update(changeset, {
        changes,
        required,
        errors: [
          ...missing.map((field) => ({
            field,
            message: options.message ?? "can't be blank",
            meta: { validation: "required" },
          })),
          ...changeset.errors,
        ],
        valid: false,
      });
    },
  );
}

/** Checks the change matches `format` (Ecto's `validate_format`): "has invalid format". */
export function validateFormat<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  format: RegExp,
  options?: MessageOptions,
): Changeset<D>;
export function validateFormat<const K extends string>(
  field: K,
  format: RegExp,
  options?: MessageOptions,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function validateFormat(...args: unknown[]): unknown {
  return dual(
    args,
    (changeset, field: string, format: RegExp, options: MessageOptions = {}) =>
      validateChangeImpl(
        changeset,
        field,
        { field, validation: "format", options: format },
        (_, value) => {
          if (typeof value !== "string") {
            throw new TypeError(
              `validateFormat expects changes to be strings, received: ${String(value)} for field ${field}`,
            );
          }
          // `search` ignores `lastIndex`, so global and sticky regexps are safe.
          return value.search(format) !== -1
            ? []
            : [
                errorFor(field, options, "has invalid format", {
                  validation: "format",
                }),
              ];
        },
      ),
  );
}

function includes(
  type: Type<unknown>,
  values: readonly unknown[],
  value: unknown,
): boolean {
  return values.some((candidate) => equalValues(type, candidate, value));
}

/** Checks the change is one of `values` (Ecto's `validate_inclusion`): "is invalid". */
export function validateInclusion<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  values: readonly NonNullable<D[K]>[],
  options?: MessageOptions,
): Changeset<D>;
export function validateInclusion<const K extends string, V>(
  field: K,
  values: readonly V[],
  options?: MessageOptions,
): <D extends Record<K, V | null>>(changeset: Changeset<D>) => Changeset<D>;
export function validateInclusion(...args: unknown[]): unknown {
  return dual(
    args,
    (
      changeset,
      field: string,
      values: readonly unknown[],
      options: MessageOptions = {},
    ) =>
      validateChangeImpl(
        changeset,
        field,
        { field, validation: "inclusion", options: values },
        (_, value) =>
          includes(ensureField(changeset, field), values, value)
            ? []
            : [
                errorFor(field, options, "is invalid", {
                  validation: "inclusion",
                  enum: values,
                }),
              ],
      ),
  );
}

/** Checks the change is none of `values` (Ecto's `validate_exclusion`): "is reserved". */
export function validateExclusion<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  values: readonly NonNullable<D[K]>[],
  options?: MessageOptions,
): Changeset<D>;
export function validateExclusion<const K extends string, V>(
  field: K,
  values: readonly V[],
  options?: MessageOptions,
): <D extends Record<K, V | null>>(changeset: Changeset<D>) => Changeset<D>;
export function validateExclusion(...args: unknown[]): unknown {
  return dual(
    args,
    (
      changeset,
      field: string,
      values: readonly unknown[],
      options: MessageOptions = {},
    ) =>
      validateChangeImpl(
        changeset,
        field,
        { field, validation: "exclusion", options: values },
        (_, value) =>
          includes(ensureField(changeset, field), values, value)
            ? [
                errorFor(field, options, "is reserved", {
                  validation: "exclusion",
                  enum: values,
                }),
              ]
            : [],
      ),
  );
}

/**
 * Checks every element of an array change is one of `values` (Ecto's
 * `validate_subset`): "has an invalid entry".
 */
export function validateSubset<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  values: readonly (NonNullable<D[K]> extends readonly (infer E)[]
    ? E
    : never)[],
  options?: MessageOptions,
): Changeset<D>;
export function validateSubset<const K extends string, V>(
  field: K,
  values: readonly V[],
  options?: MessageOptions,
): <D extends Record<K, readonly V[] | null>>(
  changeset: Changeset<D>,
) => Changeset<D>;
export function validateSubset(...args: unknown[]): unknown {
  return dual(
    args,
    (
      changeset,
      field: string,
      values: readonly unknown[],
      options: MessageOptions = {},
    ) => {
      const type = ensureField(changeset, field);
      const element = (type as Partial<ArrayType<unknown>>).of;
      if (!element)
        throw new TypeError(
          `validateSubset expects ${field} to be an array field`,
        );
      return validateChangeImpl(
        changeset,
        field,
        { field, validation: "subset", options: values },
        (_, value) =>
          (value as readonly unknown[]).every((item) =>
            includes(element, values, item),
          )
            ? []
            : [
                errorFor(field, options, "has an invalid entry", {
                  validation: "subset",
                  enum: values,
                }),
              ],
      );
    },
  );
}

export interface LengthOptions extends MessageOptions {
  readonly is?: number;
  readonly min?: number;
  readonly max?: number;
  /**
   * How strings are counted: Unicode code points (default), grapheme clusters,
   * or UTF-8 bytes.
   */
  readonly count?: "codepoints" | "graphemes" | "bytes";
}

type LengthKind = "string" | "binary" | "list" | "map";

const LENGTH_MESSAGES: Record<
  LengthKind,
  Record<"is" | "min" | "max", string>
> = {
  string: {
    is: "should be %{count} character(s)",
    min: "should be at least %{count} character(s)",
    max: "should be at most %{count} character(s)",
  },
  binary: {
    is: "should be %{count} byte(s)",
    min: "should be at least %{count} byte(s)",
    max: "should be at most %{count} byte(s)",
  },
  list: {
    is: "should have %{count} item(s)",
    min: "should have at least %{count} item(s)",
    max: "should have at most %{count} item(s)",
  },
  map: {
    is: "should have %{count} item(s)",
    min: "should have at least %{count} item(s)",
    max: "should have at most %{count} item(s)",
  },
};

function measure(
  value: unknown,
  count: LengthOptions["count"],
): [LengthKind, number] {
  if (typeof value === "string") {
    if (count === "bytes")
      return ["binary", new TextEncoder().encode(value).length];
    if (count === "graphemes") {
      return ["string", [...new Intl.Segmenter().segment(value)].length];
    }
    return ["string", [...value].length];
  }
  if (value instanceof Uint8Array) return ["binary", value.length];
  if (Array.isArray(value)) return ["list", value.length];
  if (isPlainObject(value)) return ["map", Object.keys(value).length];
  throw new TypeError(`validateLength cannot measure ${String(value)}`);
}

/**
 * Checks the length of a string, byte array, array or map change (Ecto's
 * `validate_length`). Errors carry `{ validation: "length", kind, count, type }`.
 */
export function validateLength<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  options: LengthOptions,
): Changeset<D>;
export function validateLength<const K extends string>(
  field: K,
  options: LengthOptions,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function validateLength(...args: unknown[]): unknown {
  return dual(args, (changeset, field: string, options: LengthOptions) =>
    validateChangeImpl(
      changeset,
      field,
      { field, validation: "length", options },
      (_, value) => {
        const [type, length] = measure(value, options.count);
        const checks = [
          ["is", options.is, (n: number) => length === n],
          ["min", options.min, (n: number) => length >= n],
          ["max", options.max, (n: number) => length <= n],
        ] as const;
        // Like Ecto, only the first failing check is reported.
        for (const [kind, expected, passes] of checks) {
          if (expected !== undefined && !passes(expected)) {
            return [
              errorFor(field, options, LENGTH_MESSAGES[type][kind], {
                count: expected,
                validation: "length",
                kind,
                type,
              }),
            ];
          }
        }
        return [];
      },
    ),
  );
}

export interface NumberOptions extends MessageOptions {
  readonly lessThan?: number | string;
  readonly greaterThan?: number | string;
  readonly lessThanOrEqualTo?: number | string;
  readonly greaterThanOrEqualTo?: number | string;
  readonly equalTo?: number | string;
  readonly notEqualTo?: number | string;
}

const NUMBER_VALIDATORS = {
  lessThan: [(c: number) => c < 0, "must be less than %{number}"],
  greaterThan: [(c: number) => c > 0, "must be greater than %{number}"],
  lessThanOrEqualTo: [
    (c: number) => c <= 0,
    "must be less than or equal to %{number}",
  ],
  greaterThanOrEqualTo: [
    (c: number) => c >= 0,
    "must be greater than or equal to %{number}",
  ],
  equalTo: [(c: number) => c === 0, "must be equal to %{number}"],
  notEqualTo: [(c: number) => c !== 0, "must be not equal to %{number}"],
} as const satisfies Record<
  string,
  readonly [(comparison: number) => boolean, string]
>;

function compareNumbers(
  value: number | string,
  target: number | string,
): number {
  if (typeof value === "number" && typeof target === "number") {
    return value < target ? -1 : value > target ? 1 : 0;
  }
  // Decimals are strings; compare them exactly.
  return compareDecimal(String(value), String(target));
}

/**
 * Checks a number (or decimal string) change against bounds (Ecto's
 * `validate_number`). Only the first failing bound is reported, with
 * `{ validation: "number", kind, number }`.
 */
export function validateNumber<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  options: NumberOptions,
): Changeset<D>;
export function validateNumber<const K extends string>(
  field: K,
  options: NumberOptions,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function validateNumber(...args: unknown[]): unknown {
  return dual(args, (changeset, field: string, options: NumberOptions) => {
    for (const key of Object.keys(options)) {
      if (key !== "message" && !Object.hasOwn(NUMBER_VALIDATORS, key)) {
        throw new TypeError(
          `unknown option ${key} given to validateNumber; the supported options are: ${Object.keys(NUMBER_VALIDATORS).join(", ")}`,
        );
      }
    }
    return validateChangeImpl(
      changeset,
      field,
      { field, validation: "number", options },
      (_, value) => {
        if (typeof value !== "number" && typeof value !== "string") {
          throw new TypeError(
            `expected field ${field} to be a number or decimal, got: ${String(value)}`,
          );
        }
        for (const [kind, target] of Object.entries(options)) {
          if (kind === "message" || target === undefined) continue;
          const [passes, message] =
            NUMBER_VALIDATORS[kind as keyof typeof NUMBER_VALIDATORS];
          if (!passes(compareNumbers(value, target as number | string))) {
            return [
              errorFor(field, options, message, {
                validation: "number",
                kind,
                number: target,
              }),
            ];
          }
        }
        return [];
      },
    );
  });
}

/**
 * Checks that `params[field + "_confirmation"]` equals `params[field]`
 * (Ecto's `validate_confirmation`). The error goes on the confirmation field:
 * "does not match confirmation". With `required: true`, a missing
 * confirmation is "can't be blank".
 */
export function validateConfirmation<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  options?: MessageOptions & { readonly required?: boolean },
): Changeset<D>;
export function validateConfirmation<const K extends string>(
  field: K,
  options?: MessageOptions & { readonly required?: boolean },
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function validateConfirmation(...args: unknown[]): unknown {
  return dual(
    args,
    (
      changeset,
      field: string,
      options: MessageOptions & { required?: boolean } = {},
    ) => {
      const { params } = changeset;
      if (params === null) return changeset;
      const confirmation = `${field}_confirmation`;
      let errors: ChangesetError[] = [];
      if (Object.hasOwn(params, confirmation)) {
        if (params[confirmation] !== params[field]) {
          errors = [
            {
              field: confirmation,
              message: options.message ?? "does not match confirmation",
              meta: { validation: "confirmation" },
            },
          ];
        }
      } else if (options.required) {
        errors = [
          {
            field: confirmation,
            message: options.message ?? "can't be blank",
            meta: { validation: "required" },
          },
        ];
      }
      return update(changeset, {
        validations: [
          { field, validation: "confirmation", options },
          ...changeset.validations,
        ],
        errors: [...errors, ...changeset.errors],
        valid: changeset.valid && errors.length === 0,
      });
    },
  );
}

/**
 * Checks that `params[field]` casts to `true`, e.g. a terms-of-service box
 * (Ecto's `validate_acceptance`): "must be accepted". The field is usually
 * virtual.
 */
export function validateAcceptance<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  options?: MessageOptions,
): Changeset<D>;
export function validateAcceptance<const K extends string>(
  field: K,
  options?: MessageOptions,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function validateAcceptance(...args: unknown[]): unknown {
  return dual(
    args,
    (changeset, field: string, options: MessageOptions = {}) => {
      const { params } = changeset;
      // Like Ecto, nothing to check without params.
      const cast =
        params === null ? null : castValue(booleanType, params[field]);
      const accepted = cast === null || (cast.ok && cast.value === true);
      const errors: ChangesetError[] = accepted
        ? []
        : [
            {
              field,
              message: options.message ?? "must be accepted",
              meta: { validation: "acceptance" },
            },
          ];
      return update(changeset, {
        validations: [
          { field, validation: "acceptance", options },
          ...changeset.validations,
        ],
        errors: [...errors, ...changeset.errors],
        valid: changeset.valid && errors.length === 0,
      });
    },
  );
}

// Standard Schema (https://standardschema.dev): the interface is copied here,
// as the spec recommends, so no dependency is needed.

/** A validator implementing Standard Schema v1, such as a Zod, Valibot or ArkType schema. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
}

/** The result of a Standard Schema validation. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

/** A Standard Schema validation issue. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
}

/**
 * Validates the change for `field` with a Standard Schema validator (Zod,
 * Valibot, ArkType…). Each issue becomes an error with
 * `{ validation: "schema", vendor, path }`. Only synchronous validators are
 * supported, since changesets are synchronous.
 */
export function validateWith<D extends object, K extends Key<D>>(
  changeset: Changeset<D>,
  field: K,
  validator: StandardSchemaV1,
): Changeset<D>;
export function validateWith<const K extends string>(
  field: K,
  validator: StandardSchemaV1,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function validateWith(...args: unknown[]): unknown {
  return dual(args, (changeset, field: string, validator: StandardSchemaV1) => {
    const standard = validator["~standard"];
    return validateChangeImpl(
      changeset,
      field,
      { field, validation: "schema", options: validator },
      (_, value) => {
        const result = standard.validate(value);
        if (result instanceof Promise) {
          throw new TypeError(
            `validateWith needs a synchronous validator; the ${standard.vendor} schema for ${field} is asynchronous`,
          );
        }
        return (result.issues ?? []).map((issue) => [
          field,
          issue.message,
          {
            validation: "schema",
            vendor: standard.vendor,
            path: (issue.path ?? []).map((segment) =>
              typeof segment === "object" ? segment.key : segment,
            ),
          },
        ]);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

export interface ConstraintOptions extends MessageOptions {
  /** The constraint name, when it differs from the conventional one. */
  readonly name?: string | RegExp;
  /** How `name` is matched against the database's constraint name (default `"exact"`). */
  readonly match?: ConstraintMatch;
}

function sourceOf(changeset: AnyChangeset): string {
  const source = getMeta(changeset.data)?.source;
  if (!source) {
    throw new TypeError(
      "cannot add a constraint to a changeset whose data has no schema source",
    );
  }
  return source;
}

function addConstraint(
  changeset: AnyChangeset,
  type: ConstraintType,
  name: string | RegExp,
  match: ConstraintMatch,
  field: string,
  errorMessage: string,
  errorType: string,
): AnyChangeset {
  if (name instanceof RegExp && match !== "exact") {
    throw new TypeError(
      `a RegExp constraint only allows match "exact", got: ${match}`,
    );
  }
  return update(changeset, {
    constraints: [
      { type, constraint: name, match, field, errorMessage, errorType },
      ...changeset.constraints,
    ],
  });
}

/**
 * Turns a unique constraint violation into an error on the first field
 * (Ecto's `unique_constraint`): "has already been taken". The default name is
 * `<table>_<fields>_index`, as Ecto's migrations name unique indexes.
 */
export function uniqueConstraint<D extends object>(
  changeset: Changeset<D>,
  fields: Key<D> | readonly Key<D>[],
  options?: ConstraintOptions & { readonly errorKey?: Key<D> },
): Changeset<D>;
export function uniqueConstraint<const K extends string>(
  fields: K | readonly K[],
  options?: ConstraintOptions & { readonly errorKey?: string },
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function uniqueConstraint(...args: unknown[]): unknown {
  return dual(
    args,
    (
      changeset,
      fieldOrFields: string | readonly string[],
      options: ConstraintOptions & { errorKey?: string } = {},
    ) => {
      const fields =
        typeof fieldOrFields === "string"
          ? [fieldOrFields]
          : [...fieldOrFields];
      const [first] = fields;
      if (first === undefined)
        throw new TypeError("uniqueConstraint needs at least one field");
      const name =
        options.name ?? [sourceOf(changeset), ...fields, "index"].join("_");
      return addConstraint(
        changeset,
        "unique",
        name,
        options.match ?? "exact",
        options.errorKey ?? first,
        options.message ?? "has already been taken",
        "unique",
      );
    },
  );
}

/**
 * Turns a foreign key violation into an error (Ecto's
 * `foreign_key_constraint`): "does not exist". The default name is
 * `<table>_<field>_fkey`, as Postgres names them.
 */
export function foreignKeyConstraint<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  options?: ConstraintOptions,
): Changeset<D>;
export function foreignKeyConstraint<const K extends string>(
  field: K,
  options?: ConstraintOptions,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function foreignKeyConstraint(...args: unknown[]): unknown {
  return dual(
    args,
    (changeset, field: string, options: ConstraintOptions = {}) =>
      addConstraint(
        changeset,
        "foreign_key",
        options.name ?? `${sourceOf(changeset)}_${field}_fkey`,
        options.match ?? "exact",
        field,
        options.message ?? "does not exist",
        "foreign",
      ),
  );
}

/**
 * Turns a check constraint violation into an error (Ecto's
 * `check_constraint`): "is invalid". The name is required.
 */
export function checkConstraint<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  options: ConstraintOptions & { readonly name: string | RegExp },
): Changeset<D>;
export function checkConstraint<const K extends string>(
  field: K,
  options: ConstraintOptions & { readonly name: string | RegExp },
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function checkConstraint(...args: unknown[]): unknown {
  return dual(
    args,
    (changeset, field: string, options: ConstraintOptions = {}) => {
      if (options.name === undefined)
        throw new TypeError("checkConstraint needs the constraint name");
      return addConstraint(
        changeset,
        "check",
        options.name,
        options.match ?? "exact",
        field,
        options.message ?? "is invalid",
        "check",
      );
    },
  );
}

/**
 * Turns an exclusion constraint violation into an error (Ecto's
 * `exclusion_constraint`, Postgres only): "violates an exclusion constraint".
 * The default name is `<table>_<field>_exclusion`.
 */
export function exclusionConstraint<D extends object>(
  changeset: Changeset<D>,
  field: Key<D>,
  options?: ConstraintOptions,
): Changeset<D>;
export function exclusionConstraint<const K extends string>(
  field: K,
  options?: ConstraintOptions,
): <D extends Record<K, unknown>>(changeset: Changeset<D>) => Changeset<D>;
export function exclusionConstraint(...args: unknown[]): unknown {
  return dual(
    args,
    (changeset, field: string, options: ConstraintOptions = {}) =>
      addConstraint(
        changeset,
        "exclusion",
        options.name ?? `${sourceOf(changeset)}_${field}_exclusion`,
        options.match ?? "exact",
        field,
        options.message ?? "violates an exclusion constraint",
        "exclusion",
      ),
  );
}

// ---------------------------------------------------------------------------
// Repo hooks
// ---------------------------------------------------------------------------

/**
 * Registers a function Repo runs on the changeset just before writing, inside
 * the transaction (Ecto's `prepare_changes`); for example to update a counter
 * cache. Functions run in the order they were added.
 */
export function prepareChanges<D extends object>(
  changeset: Changeset<D>,
  fn: (changeset: Changeset<D>) => Changeset<D>,
): Changeset<D>;
export function prepareChanges<D extends object>(
  fn: (changeset: Changeset<D>) => Changeset<D>,
): (changeset: Changeset<D>) => Changeset<D>;
export function prepareChanges(...args: unknown[]): unknown {
  return dual(
    args,
    (changeset, fn: (changeset: AnyChangeset) => AnyChangeset) =>
      update(changeset, { prepare: [...changeset.prepare, fn] }),
  );
}

/** Ecto's default lock incrementer: wraps to 1 past the largest 32-bit signed integer. */
function incrementWithRollover(value: number): number {
  return value >= 2_147_483_647 ? 1 : value + 1;
}

function optimisticLockImpl(
  changeset: AnyChangeset,
  field: string,
  incrementer: (value: number) => number = incrementWithRollover,
): AnyChangeset {
  const current = getField(changeset, field);
  // Apply the increment only inside Repo, so the lock change is not tracked
  // permanently.
  const prepared = update(changeset, {
    prepare: [
      ...changeset.prepare,
      (cs: AnyChangeset) =>
        update(cs, {
          changes: { ...cs.changes, [field]: incrementer(current) },
        }),
    ],
  });
  if (current === null || current === undefined) return prepared;
  return update(prepared, {
    filters: { ...prepared.filters, [field]: current },
  });
}

/**
 * Optimistic locking on a version field (Ecto's `optimistic_lock`): Repo
 * updates and deletes only match the row if `field` still has the value it
 * had when loaded, and updates increment it. A stale record makes Repo throw
 * `StaleEntryError`.
 */
export function optimisticLock<D extends object>(
  dataOrChangeset: D | Changeset<D>,
  field: Key<D>,
  incrementer?: (value: number) => number,
): Changeset<D>;
export function optimisticLock<const K extends string>(
  field: K,
  incrementer?: (value: number) => number,
): <D extends Record<K, number | null>>(
  changeset: Changeset<D>,
) => Changeset<D>;
export function optimisticLock(...args: unknown[]): unknown {
  const [first, ...rest] = args;
  if (typeof first === "object" && first !== null && !isChangeset(first)) {
    return optimisticLockImpl(change(first), ...(rest as [string]));
  }
  return dual(args, optimisticLockImpl);
}

// ---------------------------------------------------------------------------
// pipe
// ---------------------------------------------------------------------------

/**
 * Passes a value through functions left to right: `pipe(x, f, g)` is
 * `g(f(x))`. Use it to chain changeset steps, like Elixir's `|>`.
 */
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
): D;
export function pipe<A, B, C, D, E>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
): E;
export function pipe<A, B, C, D, E, F>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
): F;
export function pipe<A, B, C, D, E, F, G>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
): G;
export function pipe<A, B, C, D, E, F, G, H>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
): H;
export function pipe<A, B, C, D, E, F, G, H, I>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
): I;
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
): J;
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
): K;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
  fg: (f: F) => G,
  gh: (g: G) => H,
  hi: (h: H) => I,
  ij: (i: I) => J,
  jk: (j: J) => K,
  kl: (k: K) => L,
): L;
export function pipe(
  value: unknown,
  ...fns: ((value: unknown) => unknown)[]
): unknown {
  return fns.reduce((acc, fn) => fn(acc), value);
}
