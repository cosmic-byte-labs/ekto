/**
 * Schemas: map a database source (table) to records with typed fields.
 * Modelled on `Ecto.Schema`.
 *
 * ```ts
 * const User = schema("users", {
 *   id: t.id(),
 *   email: t.string(),
 *   name: t.string().nullable(),
 *   password: t.string().virtual(),
 *   ...t.timestamps(),
 * });
 * type User = Infer<typeof User>;
 * ```
 *
 * Field names are the column names (no renaming, no casing conversion).
 * Records are plain objects; like Ecto's `__meta__`, each one carries hidden
 * metadata (its schema and whether it was built or loaded) under a symbol key
 * that is non-enumerable, so it does not show up in spreads or JSON.
 */

import * as types from "./type.ts";
import { castValue, loadValue, type Type } from "./type.ts";

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Runtime options of a field (Ecto's `field/3` options). */
export interface FieldOptions<T> {
  /** May be `null` in the database. */
  readonly nullable: boolean;
  /** Not persisted (Ecto's `virtual: true`). */
  readonly virtual: boolean;
  /** Hidden when the record is inspected (Ecto's `redact: true`). */
  readonly redact: boolean;
  /** Part of the primary key. */
  readonly primaryKey: boolean;
  /** Value of new records; `undefined` when there is none. */
  readonly default: T | undefined;
  readonly hasDefault: boolean;
  /**
   * Generated on insert: `"database"` for keys the database generates
   * (Ecto's `autogenerate_id`, e.g. serial ids), or a function ekto calls.
   */
  readonly autogenerate: "database" | (() => T) | undefined;
  /** Generated again on every update (`updated_at`). */
  readonly autoupdate: (() => T) | undefined;
  /** Read back from the database after every write (Ecto's `read_after_writes`). */
  readonly readAfterWrites: boolean;
}

const defaultOptions: FieldOptions<never> = {
  nullable: false,
  virtual: false,
  redact: false,
  primaryKey: false,
  default: undefined,
  hasDefault: false,
  autogenerate: undefined,
  autoupdate: undefined,
  readAfterWrites: false,
};

/**
 * A field definition. The type parameters only track what TypeScript needs
 * to derive record types: the value type, and whether the field is nullable,
 * has a default (or is generated), or is virtual.
 */
export class Field<
  T,
  TNullable extends boolean = false,
  TDefault extends boolean = false,
  TVirtual extends boolean = false,
> {
  readonly type: Type<T>;
  readonly options: FieldOptions<T>;
  declare readonly __flags?: {
    nullable: TNullable;
    default: TDefault;
    virtual: TVirtual;
  };

  constructor(type: Type<T>, options: Partial<FieldOptions<T>> = {}) {
    this.type = type;
    this.options = Object.freeze({ ...defaultOptions, ...options });
  }

  #with<N extends boolean, D extends boolean, V extends boolean>(
    options: Partial<FieldOptions<T>>,
  ): Field<T, N, D, V> {
    return new Field<T, N, D, V>(this.type, { ...this.options, ...options });
  }

  /** The column may hold `null`, so loaded records may have `null` here. */
  nullable(): Field<T, true, TDefault, TVirtual> {
    return this.#with({ nullable: true });
  }

  /** The value new records start with (Ecto's `default:`). */
  default(value: T): Field<T, TNullable, true, TVirtual> {
    const cast = castValue(this.type, value);
    if (!cast.ok) {
      throw new TypeError(
        `default value ${String(value)} is invalid for type ${types.formatType(this.type.type)}`,
      );
    }
    return this.#with({ default: value, hasDefault: true });
  }

  /** Not persisted; only lives in records and changesets (Ecto's `virtual: true`). */
  virtual(): Field<T, TNullable, TDefault, true> {
    return this.#with({ virtual: true });
  }

  /** Hidden when the record or a changeset is inspected (Ecto's `redact: true`). */
  redact(): Field<T, TNullable, TDefault, TVirtual> {
    return this.#with({ redact: true });
  }

  /** Part of the primary key. */
  primaryKey(): Field<T, TNullable, TDefault, TVirtual> {
    return this.#with({ primaryKey: true });
  }

  /**
   * Generated on insert when no value is given: by `generate`, or by the
   * type's own `autogenerate` (e.g. a random UUID).
   */
  autogenerate(generate?: () => T): Field<T, TNullable, TDefault, TVirtual> {
    const fn = generate ?? this.type.autogenerate?.bind(this.type);
    if (!fn) {
      throw new TypeError(
        `type ${types.formatType(this.type.type)} cannot autogenerate values; pass a function`,
      );
    }
    return this.#with({ autogenerate: fn });
  }

  /** Read back from the database after every write (Ecto's `read_after_writes: true`). */
  readAfterWrites(): Field<T, TNullable, TDefault, TVirtual> {
    return this.#with({ readAfterWrites: true });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: a field of any configuration
export type AnyField = Field<any, boolean, boolean, boolean>;
export type Fields = Readonly<Record<string, AnyField>>;

function truncatedNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/**
 * Field builders, one per built-in type. `t.custom(type)` wraps a custom
 * `Type`.
 */
export const t = {
  /** Integer primary key generated by the database (Ecto's default `:id` key). */
  id: () => new Field(types.id, { primaryKey: true, autogenerate: "database" }),
  integer: () => new Field(types.integer),
  float: () => new Field(types.float),
  decimal: () => new Field(types.decimal),
  boolean: () => new Field(types.boolean),
  string: () => new Field(types.string),
  binary: () => new Field(types.binary),
  map: () => new Field(types.map),
  uuid: () => new Field(types.uuid),
  date: () => new Field(types.date),
  time: () => new Field(types.time),
  utcDatetime: () => new Field(types.utcDatetime),
  utcDatetimeMsec: () => new Field(types.utcDatetimeMsec),
  any: () => new Field(types.any),
  array: <T>(of: Type<T>) => new Field(types.array(of)),
  enum: <const V extends string>(values: readonly V[]) =>
    new Field(types.enumOf(values)),
  custom: <T>(type: Type<T>) => new Field(type),

  /**
   * `inserted_at` and `updated_at`, set on insert and `updated_at` again on
   * every update (Ecto's `timestamps/1`). The default type is `utcDatetime`
   * (whole seconds); pass `{ type: "utcDatetimeMsec" }` for milliseconds.
   */
  timestamps: (options: { type?: "utcDatetime" | "utcDatetimeMsec" } = {}) => {
    const msec = options.type === "utcDatetimeMsec";
    const type = msec ? types.utcDatetimeMsec : types.utcDatetime;
    const now = msec ? () => new Date() : truncatedNow;
    return {
      inserted_at: new Field(type, { autogenerate: now }),
      updated_at: new Field(type, { autogenerate: now, autoupdate: now }),
    };
  },
} as const;

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

type FieldValue<F> =
  F extends Field<infer T, boolean, boolean, boolean> ? T : never;

/** The value type of a field in a loaded record. */
type LoadedValue<F> =
  F extends Field<infer T, infer N, infer D, infer V>
    ? true extends N
      ? T | null
      : true extends V
        ? true extends D
          ? T
          : T | null
        : T
    : never;

/** The value type of a field in a new record: `null` unless it has a default. */
type NewValue<F> =
  F extends Field<infer T, infer N, infer D, boolean>
    ? true extends N
      ? T | null
      : true extends D
        ? T
        : T | null
    : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A record of the schema as loaded from the database. */
export type Infer<S extends AnySchema> = Simplify<{
  -readonly [K in keyof S["fields"]]: LoadedValue<S["fields"][K]>;
}>;

/** A record of the schema as built by `Schema.new()`, before it is inserted. */
export type New<S extends AnySchema> = Simplify<{
  -readonly [K in keyof S["fields"]]: NewValue<S["fields"][K]>;
}>;

/** The field names of a schema. */
export type FieldName<S extends AnySchema> = keyof S["fields"] & string;

/** The runtime value type of one field. */
export type ValueOfField<
  S extends AnySchema,
  K extends FieldName<S>,
> = FieldValue<S["fields"][K]>;

// ---------------------------------------------------------------------------
// Record metadata (Ecto's __meta__)
// ---------------------------------------------------------------------------

/** Where a record is in its life: built in memory, loaded, or deleted. */
export type RecordState = "built" | "loaded" | "deleted";

export interface Meta {
  readonly schema: AnySchema;
  readonly state: RecordState;
  readonly source: string;
}

/** The symbol key under which records keep their `Meta`. */
export const meta: unique symbol = Symbol("ekto.meta");

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

/** Reads a record's metadata, or `undefined` if the value is not a record. */
export function getMeta(record: object): Meta | undefined {
  return (record as { [meta]?: Meta })[meta];
}

/** Returns a copy of the record with its metadata changed (Ecto.put_meta/2). */
export function putMeta<R extends object>(
  record: R,
  changes: Partial<Pick<Meta, "state" | "source">>,
): R {
  const current = getMeta(record);
  if (!current)
    throw new TypeError("putMeta expects a record created by a schema");
  return attachMeta({ ...record }, { ...current, ...changes });
}

function attachMeta<R extends object>(record: R, value: Meta): R {
  Object.defineProperty(record, meta, {
    value: Object.freeze(value),
    enumerable: false,
  });
  const redacted = value.schema.redactFields;
  if (redacted.length > 0) {
    // Like Ecto's Inspect implementation, hide redacted fields from
    // `console.log` / `util.inspect`.
    Object.defineProperty(record, inspectCustom, {
      enumerable: false,
      value(this: Record<string, unknown>) {
        const shown: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(this)) {
          shown[key] = redacted.includes(key) ? "**redacted**" : v;
        }
        return shown;
      },
    });
  }
  return record;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A schema; see `schema()`. */
export interface Schema<F extends Fields = Fields> {
  /** The table (Ecto's `__schema__(:source)`). */
  readonly source: string;
  readonly fields: F;
  /** Names of persisted fields, in definition order (`__schema__(:fields)`). */
  readonly persistedFields: readonly (keyof F & string)[];
  /** Names of virtual fields (`__schema__(:virtual_fields)`). */
  readonly virtualFields: readonly (keyof F & string)[];
  /** Names of the primary key fields; empty if there is none. */
  readonly primaryKey: readonly (keyof F & string)[];
  /** The primary key field generated by the database, if any (`__schema__(:autogenerate_id)`). */
  readonly autogenerateId: (keyof F & string) | undefined;
  /** Fields generated by ekto on insert (`__schema__(:autogenerate_fields)`). */
  readonly autogenerateFields: readonly (keyof F & string)[];
  /** Fields regenerated on update (`__schema__(:autoupdate)`). */
  readonly autoupdateFields: readonly (keyof F & string)[];
  /** Fields read back after every write (`__schema__(:read_after_writes)`). */
  readonly readAfterWrites: readonly (keyof F & string)[];
  /** Fields hidden on inspection (`__schema__(:redact_fields)`). */
  readonly redactFields: readonly (keyof F & string)[];
  /** The type of a field (`__schema__(:type, field)`). */
  type<K extends keyof F & string>(field: K): F[K]["type"];
  /**
   * A new record with defaults applied, like `%User{}` (or
   * `struct(User, attrs)` when given attributes). Attributes are not cast or
   * validated; use a changeset for external input.
   */
  readonly new: (attrs?: Partial<New<Schema<F>>>) => New<Schema<F>>;
}

// biome-ignore lint/suspicious/noExplicitAny: a schema with any fields
export type AnySchema = Schema<any>;

const SOURCE = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

/**
 * Defines a schema for a table (Ecto's `schema/2`).
 *
 * @param source the table name, optionally `schema.table`
 * @param fields field definitions built with `t`
 */
export function schema<const F extends Fields>(
  source: string,
  fields: F,
): Schema<F> {
  if (!SOURCE.test(source))
    throw new TypeError(`invalid schema source: ${JSON.stringify(source)}`);

  const names = Object.keys(fields) as (keyof F & string)[];
  const pick = (predicate: (options: FieldOptions<unknown>) => boolean) =>
    Object.freeze(
      names.filter((name) => predicate((fields[name] as AnyField).options)),
    );

  for (const name of names) {
    const { options } = fields[name] as AnyField;
    if (
      options.virtual &&
      (options.primaryKey || options.autogenerate || options.readAfterWrites)
    ) {
      throw new TypeError(
        `virtual field ${name} cannot be a primary key, generated or read back`,
      );
    }
  }

  const databaseGenerated = pick((o) => o.autogenerate === "database");
  if (databaseGenerated.length > 1) {
    // Ecto allows only one database-generated id per schema.
    throw new TypeError(
      `only one field can be generated by the database, got ${databaseGenerated}`,
    );
  }
  const autogenerateId = databaseGenerated[0];
  if (
    autogenerateId !== undefined &&
    !(fields[autogenerateId] as AnyField).options.primaryKey
  ) {
    throw new TypeError(
      `database-generated field ${autogenerateId} must be a primary key`,
    );
  }

  const defaults: Record<string, unknown> = {};
  for (const name of names) {
    const { options } = fields[name] as AnyField;
    defaults[name] = options.hasDefault ? options.default : null;
  }

  const self: Schema<F> = {
    source,
    fields: Object.freeze({ ...fields }),
    persistedFields: pick((o) => !o.virtual),
    virtualFields: pick((o) => o.virtual),
    primaryKey: pick((o) => o.primaryKey),
    autogenerateId,
    autogenerateFields: pick((o) => typeof o.autogenerate === "function"),
    autoupdateFields: pick((o) => o.autoupdate !== undefined),
    readAfterWrites: pick((o) => o.readAfterWrites),
    redactFields: pick((o) => o.redact),
    type: (field) => {
      const definition = fields[field];
      if (!definition)
        throw new TypeError(`unknown field ${field} in schema ${source}`);
      return definition.type;
    },
    new: (attrs = {}) => {
      for (const key of Object.keys(attrs)) {
        if (!Object.hasOwn(fields, key)) {
          throw new TypeError(`unknown field ${key} in schema ${source}`);
        }
      }
      const record = { ...cloneDefaults(defaults), ...attrs } as New<Schema<F>>;
      return attachMeta(record, { schema: self, state: "built", source });
    },
  };
  return Object.freeze(self);
}

/** Copies mutable defaults (arrays, objects) so records never share them. */
function cloneDefaults(
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    out[key] =
      typeof value === "object" && value !== null
        ? structuredClone(value)
        : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Converts a raw driver value before the type loads it (an adapter loader). */
export type Loader = (type: Type<unknown>, value: unknown) => unknown;

/**
 * Builds a loaded record from a database row (Ecto's `Repo.load/2`).
 *
 * Only persisted fields present in the row are loaded; other fields keep
 * their defaults, and columns the schema does not know are ignored. Throws
 * when a value cannot be loaded, as Ecto raises.
 */
export function load<S extends AnySchema>(
  schema: S,
  row: Readonly<Record<string, unknown>>,
  loader?: Loader,
): Infer<S> {
  const record = schema.new() as Record<string, unknown>;
  for (const name of schema.persistedFields) {
    if (!Object.hasOwn(row, name)) continue;
    const { type } = schema.fields[name] as AnyField;
    const raw = row[name];
    const result = loadValue(
      type,
      loader && raw !== null ? loader(type, raw) : raw,
    );
    if (!result.ok) {
      throw new TypeError(
        `cannot load ${String(raw)} as type ${types.formatType(type.type)} ` +
          `for field ${name} in schema ${schema.source}`,
      );
    }
    record[name] = result.value;
  }
  return putMeta(record, { state: "loaded" }) as Infer<S>;
}
