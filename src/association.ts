/**
 * Associations between schemas (Ecto.Association): `belongsTo`, `hasMany`,
 * `hasOne` and `manyToMany`, declared as a static `associations` object on
 * a class extending the schema.
 *
 * ```ts
 * class User extends schema("users", { id: t.id(), email: t.string() }) {
 *   static associations = {
 *     posts: hasMany(() => Post, { foreignKey: "author_id" }),
 *   };
 * }
 * class Post extends schema("posts", {
 *   id: t.id(),
 *   title: t.string(),
 *   author_id: t.integer().nullable(),
 * }) {
 *   static associations = {
 *     author: belongsTo(() => User),
 *     tags: manyToMany(() => Tag, {
 *       joinThrough: "posts_tags",
 *       joinKeys: { post_id: "id", tag_id: "id" },
 *     }),
 *   };
 * }
 * ```
 *
 * The related schema is given as a function so that schemas can refer to
 * each other. As in Ecto, there is no lazy loading: an association is a
 * property of the record only once preloaded (`Repo.preload`), and its type
 * says so (`Preloaded<typeof Post, "author">`).
 *
 * Associations are checked the first time they are used (Ecto checks them
 * at compile time), since the related schema is only known then.
 */

import type { Selectable, SelectQueryBuilder } from "kysely";
import {
  type AnyField,
  type AnySchema,
  getMeta,
  type Infer,
  isSchema,
  type New,
  type SchemaOf,
} from "./schema.ts";

/** Whether an association holds one record or a list. */
export type Cardinality = "one" | "many";

interface AssociationBase<C extends Cardinality, R> {
  readonly cardinality: C;
  /** A function returning the related schema. */
  readonly related: () => R;
}

/** See `belongsTo()`. */
export interface BelongsTo<R = AnySchema> extends AssociationBase<"one", R> {
  readonly kind: "belongsTo";
  readonly foreignKey: string | undefined;
  readonly references: string;
}

/** See `hasMany()`. */
export interface HasMany<R = AnySchema> extends AssociationBase<"many", R> {
  readonly kind: "hasMany";
  readonly foreignKey: string;
  readonly references: string | undefined;
}

/** See `hasOne()`. */
export interface HasOne<R = AnySchema> extends AssociationBase<"one", R> {
  readonly kind: "hasOne";
  readonly foreignKey: string;
  readonly references: string | undefined;
}

/** See `manyToMany()`. */
export interface ManyToMany<R = AnySchema> extends AssociationBase<"many", R> {
  readonly kind: "manyToMany";
  readonly joinThrough: string;
  readonly joinKeys: Readonly<Record<string, string>>;
}

/** An association definition, as declared in a schema's `associations`. */
export type Association<R = AnySchema> =
  | BelongsTo<R>
  | HasMany<R>
  | HasOne<R>
  | ManyToMany<R>;

const definitions = new WeakSet<object>();

function define<A extends Association<unknown>>(association: A): A {
  definitions.add(association);
  return Object.freeze(association);
}

/**
 * The record holds the foreign key of one related record (Ecto's
 * `belongs_to/3`). Unlike Ecto, the foreign key field is not defined by the
 * association: declare it in the schema's fields.
 *
 * @param options.foreignKey the field holding the key; defaults to the
 *   association name followed by `_id`
 * @param options.references the related schema's field it refers to;
 *   defaults to `id`
 */
export function belongsTo<R>(
  related: () => R,
  options: { readonly foreignKey?: string; readonly references?: string } = {},
): BelongsTo<R> {
  return define({
    kind: "belongsTo",
    cardinality: "one",
    related,
    foreignKey: options.foreignKey,
    references: options.references ?? "id",
  });
}

/**
 * Related records hold this record's key (Ecto's `has_many/3`).
 *
 * @param options.foreignKey the related schema's field holding the key.
 *   Required: Ecto derives it from the module name, which ekto does not have.
 * @param options.references the field of this schema it refers to; defaults
 *   to the primary key
 */
export function hasMany<R>(
  related: () => R,
  options: { readonly foreignKey: string; readonly references?: string },
): HasMany<R> {
  return define({
    kind: "hasMany",
    cardinality: "many",
    related,
    foreignKey: options.foreignKey,
    references: options.references,
  });
}

/** Like `hasMany`, for at most one related record (Ecto's `has_one/3`). */
export function hasOne<R>(
  related: () => R,
  options: { readonly foreignKey: string; readonly references?: string },
): HasOne<R> {
  return define({
    kind: "hasOne",
    cardinality: "one",
    related,
    foreignKey: options.foreignKey,
    references: options.references,
  });
}

/**
 * Records related through a join table (Ecto's `many_to_many/3`).
 *
 * @param options.joinThrough the join table, or a schema for it
 * @param options.joinKeys two entries: the join table's column referring to
 *   this schema and the field it refers to, then the column referring to the
 *   related schema and its field, e.g. `{ post_id: "id", tag_id: "id" }`.
 *   Required, as Ecto derives them from module names.
 */
export function manyToMany<R>(
  related: () => R,
  options: {
    readonly joinThrough: string | AnySchema;
    readonly joinKeys: Readonly<Record<string, string>>;
  },
): ManyToMany<R> {
  const { joinThrough } = options;
  return define({
    kind: "manyToMany",
    cardinality: "many",
    related,
    joinThrough:
      typeof joinThrough === "string" ? joinThrough : joinThrough.source,
    joinKeys: Object.freeze({ ...options.joinKeys }),
  });
}

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

/**
 * A checked association with its keys resolved (Ecto's association
 * struct). `ownerKey` is the field of the owner, `relatedKey` the field of
 * the related schema it is compared with; for `manyToMany` they are compared
 * through the join table's columns.
 */
export interface Reflection {
  readonly name: string;
  readonly kind: Association["kind"];
  readonly cardinality: Cardinality;
  readonly owner: AnySchema;
  readonly related: AnySchema;
  readonly ownerKey: string;
  readonly relatedKey: string;
  readonly join:
    | {
        readonly source: string;
        /** The join table's column holding the owner key. */
        readonly ownerKey: string;
        /** The join table's column holding the related key. */
        readonly relatedKey: string;
      }
    | undefined;
}

const reflections = new WeakMap<object, ReadonlyMap<string, Reflection>>();

/** The associations of a schema, checked (Ecto's `__schema__(:associations)`). */
export function associations(
  schema: AnySchema,
): ReadonlyMap<string, Reflection> {
  let cached = reflections.get(schema);
  if (cached === undefined) {
    cached = reflect(schema);
    reflections.set(schema, cached);
  }
  return cached;
}

/**
 * One association of a schema (Ecto's `association_from_schema!`); throws
 * when the schema does not have it.
 */
export function association(schema: AnySchema, name: string): Reflection {
  const reflection = associations(schema).get(name);
  if (reflection === undefined) {
    throw new TypeError(
      `schema ${schema.source} does not have association ${JSON.stringify(name)}`,
    );
  }
  return reflection;
}

function reflect(owner: AnySchema): ReadonlyMap<string, Reflection> {
  const declared: unknown = (owner as { associations?: unknown }).associations;
  const result = new Map<string, Reflection>();
  if (declared === undefined) return result;
  if (typeof declared !== "object" || declared === null) {
    throw new TypeError(
      `the associations of schema ${owner.source} must be an object`,
    );
  }
  for (const [name, definition] of Object.entries(declared)) {
    if (!definitions.has(definition as object)) {
      throw new TypeError(
        `association ${name} of schema ${owner.source} must be created with ` +
          "belongsTo, hasMany, hasOne or manyToMany",
      );
    }
    if (Object.hasOwn(owner.fields, name)) {
      throw new TypeError(
        `field/association ${name} already exists on schema ${owner.source}`,
      );
    }
    result.set(name, reflectOne(owner, name, definition as Association));
  }
  return result;
}

function reflectOne(
  owner: AnySchema,
  name: string,
  definition: Association,
): Reflection {
  const related = definition.related();
  if (!isSchema(related)) {
    throw new TypeError(
      `association ${name} of schema ${owner.source}: the related value is not a schema`,
    );
  }
  const base = {
    name,
    kind: definition.kind,
    cardinality: definition.cardinality,
    owner,
    related,
  };
  switch (definition.kind) {
    case "belongsTo": {
      const ownerKey = definition.foreignKey ?? `${name}_id`;
      requireField(
        owner,
        ownerKey,
        `schema ${owner.source} does not have the field ${ownerKey} used by ` +
          `association ${name}; declare it, or set the foreignKey option accordingly`,
      );
      return {
        ...base,
        ownerKey,
        relatedKey: relatedKey(related, definition.references),
        join: undefined,
      };
    }
    case "hasMany":
    case "hasOne": {
      let ownerKey = definition.references;
      if (ownerKey === undefined) {
        const [key, ...rest] = owner.primaryKey;
        if (key === undefined || rest.length > 0) {
          throw new TypeError(
            `need to set the references option for association ${name} ` +
              `when schema ${owner.source} has no single primary key`,
          );
        }
        ownerKey = key;
      }
      requireField(
        owner,
        ownerKey,
        `schema ${owner.source} does not have the field ${ownerKey} used by ` +
          `association ${name}, please set the references option accordingly`,
      );
      return {
        ...base,
        ownerKey,
        relatedKey: relatedKey(related, definition.foreignKey),
        join: undefined,
      };
    }
    case "manyToMany": {
      const entries = Object.entries(definition.joinKeys);
      const [owning, relating] = entries;
      if (
        entries.length !== 2 ||
        owning === undefined ||
        relating === undefined
      ) {
        throw new TypeError(
          `manyToMany ${name} expects joinKeys to be an object with two entries, ` +
            "the first being how the join table reaches the current schema and " +
            "the second how it reaches the associated schema, " +
            `for example: { ${owner.source}_id: "id", ${related.source}_id: "id" }`,
        );
      }
      requireField(
        owner,
        owning[1],
        `schema ${owner.source} does not have the field ${owning[1]} used by ` +
          `association ${name}, please set the joinKeys option accordingly`,
      );
      return {
        ...base,
        ownerKey: owning[1],
        relatedKey: relatedKey(related, relating[1]),
        join: {
          source: definition.joinThrough,
          ownerKey: owning[0],
          relatedKey: relating[0],
        },
      };
    }
  }
}

function relatedKey(related: AnySchema, key: string): string {
  requireField(
    related,
    key,
    `associated schema ${related.source} does not have field ${key}`,
  );
  return key;
}

function requireField(schema: AnySchema, field: string, message: string): void {
  const definition = schema.fields[field] as AnyField | undefined;
  if (definition === undefined || definition.options.virtual) {
    throw new TypeError(message);
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Whether the record's association is loaded (Ecto's `assoc_loaded?/1`). */
export function isLoaded(record: object, name: string): boolean {
  return Object.hasOwn(record, name);
}

/**
 * A new record of the association's schema, with the key referring to the
 * record set for `hasMany` and `hasOne` (Ecto's `build_assoc/3`).
 */
export function buildAssoc<
  R extends object,
  N extends AssociationName<SchemaOf<R>>,
>(
  record: R,
  name: N,
  attrs?: Partial<New<RelatedSchema<SchemaOf<R>, N>>>,
): New<RelatedSchema<SchemaOf<R>, N>>;
export function buildAssoc(
  record: object,
  name: string,
  attrs: Readonly<Record<string, unknown>> = {},
): object {
  const owner = getMeta(record)?.schema;
  if (owner === undefined) {
    throw new TypeError("buildAssoc expects a record created by a schema");
  }
  const reflection = association(owner, name);
  const built = reflection.related.new(attrs) as Record<string, unknown>;
  if (reflection.kind === "hasMany" || reflection.kind === "hasOne") {
    built[reflection.relatedKey] =
      (record as Record<string, unknown>)[reflection.ownerKey] ?? null;
  }
  return built;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The declared associations of a schema. */
export type AssociationsOf<S> = S extends {
  readonly associations: infer A extends object;
}
  ? A
  : Empty;

/** The association names of a schema. */
export type AssociationName<S> = keyof AssociationsOf<S> & string;

/** The related schema of an association. */
export type RelatedSchema<S, N> = N extends keyof AssociationsOf<S>
  ? AssociationsOf<S>[N] extends { readonly related: () => infer R }
    ? R extends AnySchema
      ? R
      : never
    : never
  : never;

type TableOf<DB, R> = R extends AnySchema
  ? R["source"] & keyof DB & string
  : never;

/** The query a preload refinement receives: all columns of the related table. */
export type PreloadQuery<DB, R> = SelectQueryBuilder<
  DB,
  TableOf<DB, R>,
  Selectable<DB[TableOf<DB, R>]>
>;

/**
 * Refines a preload query, e.g. to order or filter the related records
 * (Ecto's preload query). It must keep all columns of the related table.
 */
export type PreloadRefine<DB, R> = (
  query: PreloadQuery<DB, R>,
  // biome-ignore lint/suspicious/noExplicitAny: any query; rows are checked when loaded
) => SelectQueryBuilder<any, any, any>;

type PreloadValue<DB, R> =
  | true
  | PreloadSpec<R, DB>
  | PreloadRefine<DB, R>
  | readonly [PreloadRefine<DB, R>, PreloadSpec<R, DB>];

/**
 * What to preload (Ecto's preloads): an association name, an array of
 * specs, or an object whose values are `true`, nested specs, a function
 * refining the query, or `[refine, nested]`.
 *
 * ```ts
 * Repo.preload(users, ["profile", { posts: [(q) => q.orderBy("id"), "tags"] }]);
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: the database type defaults to any, as for Repo
export type PreloadSpec<S, DB = any> =
  | AssociationName<S>
  | readonly PreloadSpec<S, DB>[]
  | {
      readonly [N in AssociationName<S>]?: PreloadValue<
        DB,
        RelatedSchema<S, N>
      >;
    };

// biome-ignore lint/complexity/noBannedTypes: the type with no properties
type Empty = {};

type UnionToIntersection<U> = (
  U extends unknown
    ? (x: U) => void
    : never
) extends (x: infer I) => void
  ? I
  : never;

type Nested<V> = V extends readonly [unknown, infer P]
  ? P
  : V extends true | ((...args: never[]) => unknown)
    ? never
    : V;

type LoadedAssociation<S, N, P> = AssociationsOf<S>[N &
  keyof AssociationsOf<S>] extends {
  readonly cardinality: infer C;
}
  ? C extends "one"
    ? Preloaded<RelatedSchema<S, N>, P> | null
    : Preloaded<RelatedSchema<S, N>, P>[]
  : never;

/** The association properties a preload spec adds to records of `S`. */
export type PreloadedFields<S, P> = [P] extends [never]
  ? Empty
  : [P] extends [string]
    ? { [N in P & AssociationName<S>]: LoadedAssociation<S, N, never> }
    : [P] extends [readonly (infer E)[]]
      ? UnionToIntersection<E extends unknown ? PreloadedFields<S, E> : never> &
          Empty
      : {
          [N in keyof P & AssociationName<S>]: LoadedAssociation<
            S,
            N,
            Nested<P[N]>
          >;
        };

/**
 * A record of `S` with the associations of preload spec `P` loaded, e.g.
 * `Preloaded<typeof Post, { author: true; comments: "author" }>`.
 */
export type Preloaded<S, P = never> = S extends AnySchema
  ? Infer<S> & PreloadedFields<S, P>
  : never;
