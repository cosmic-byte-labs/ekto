/**
 * Kysely table types derived from schemas. Pure type mapping: nothing here
 * exists at runtime.
 *
 * Column types describe what the database driver returns and accepts (the
 * driver representation), not ekto's loaded values: raw Kysely results are
 * not loaded through the schema, so they are typed as the driver gives them.
 * Each dialect module supplies its driver representation and exports a
 * ready-made `KyselyDB` type (`ekto/postgres`, `ekto/sqlite`).
 */

import type { ColumnType } from "kysely";
import type { AnySchema, Field, FieldFlags } from "./schema.ts";
import type { BaseType, PrimitiveType } from "./type.ts";

/** A driver representation: the type a driver returns, and the type it accepts. */
export type DriverValue<Select = unknown, Insert = Select> = {
  readonly select: Select;
  readonly insert: Insert;
};

/**
 * How a driver represents each primitive type. `array` is the
 * representation of every array, or `"elements"` for drivers that return
 * arrays of their elements' representation (PostgreSQL).
 */
export type DriverTypes = { readonly [K in BaseType]: DriverValue } & {
  readonly array: DriverValue | "elements";
};

/** The driver representation of a primitive type. */
export type DriverValueOf<P, D extends DriverTypes> = P extends BaseType
  ? D[P]
  : P extends readonly ["array", infer E]
    ? D["array"] extends DriverValue
      ? D["array"]
      : DriverValueOf<E, D> extends DriverValue<infer S, infer I>
        ? DriverValue<S[], I[]>
        : never
    : never;

type Nullable<V, N> = N extends true ? V | null : V;

/**
 * The Kysely column type of a field. Nullable fields allow `null`; fields
 * the database generates (`t.id()`, `readAfterWrites`) may be left out of
 * inserts, like Kysely's `Generated`.
 */
export type KyselyColumn<F, D extends DriverTypes> =
  F extends Field<unknown, infer P, infer G extends FieldFlags>
    ? DriverValueOf<P, D> extends DriverValue<infer S, infer I>
      ? ColumnType<
          Nullable<S, G["nullable"]>,
          | Nullable<I, G["nullable"]>
          | (G["generated"] extends true ? undefined : never),
          Nullable<I, G["nullable"]>
        >
      : never
    : never;

/** The Kysely table type of a schema: its persisted fields. */
export type KyselyTable<S extends AnySchema, D extends DriverTypes> = {
  -readonly [K in keyof S["fields"] as S["fields"][K] extends Field<
    unknown,
    PrimitiveType,
    { readonly virtual: true } & FieldFlags
  >
    ? never
    : K]: KyselyColumn<S["fields"][K], D>;
};

/** The Kysely database type of the given schemas, keyed by source (table). */
export type KyselyTables<
  Schemas extends readonly AnySchema[],
  D extends DriverTypes,
> = {
  -readonly [S in Schemas[number] as S["source"]]: KyselyTable<S, D>;
};
