/**
 * Preloading associations (Ecto.Repo.Preloader) and association queries
 * (`Ecto.assoc/2`). Used by the Repo, which gives the database access.
 *
 * Each association is loaded with one query over all the records, filtered
 * by their keys, and the related records are matched to their owners in
 * memory; nested preloads then run over all the related records at once.
 */

import { inspect } from "node:util";
import type { Kysely, SelectQueryBuilder } from "kysely";
import { association, type Reflection } from "./association.ts";
import { type AnySchema, getMeta, putMeta } from "./schema.ts";

/** What the preloader needs from the Repo. */
export interface PreloadContext {
  // biome-ignore lint/suspicious/noExplicitAny: queries over any tables
  readonly db: Kysely<any>;
  /** Runs a read query and returns the raw rows. */
  rows(query: AnyQuery, source: string): Promise<readonly Row[]>;
  /** Loads a row as a record, checking that no column is missing. */
  loadRow(schema: AnySchema, row: Row): object;
  /** Loads a raw column value with the type of a schema's field. */
  loadField(schema: AnySchema, field: string, raw: unknown): unknown;
  /** Casts and dumps a value compared with a schema's field in a query. */
  param(schema: AnySchema, field: string, value: unknown): unknown;
}

export interface PreloadOptions {
  /** Reload associations that are already loaded (Ecto's `:force`). */
  readonly force?: boolean;
}

type Row = Readonly<Record<string, unknown>>;
type Rec = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: any query
type AnyQuery = SelectQueryBuilder<any, any, any>;
type Refine = (query: AnyQuery) => AnyQuery;

/** A normalized preload: per association, its query refinement and nested preloads. */
type Preloads = Map<string, { query: Refine | undefined; nested: Preloads }>;

/** The column under which a many-to-many query selects the owner key. */
const OWNER_KEY = "__ekto_owner_key";

/** `Repo.preload`: preloads into a record, a list of records or null. */
export async function preload(
  context: PreloadContext,
  input: unknown,
  spec: unknown,
  options: PreloadOptions = {},
): Promise<unknown> {
  if (input === null || input === undefined) return input;
  const preloads = normalize(spec, spec, new Map());
  const force = options.force ?? false;
  if (Array.isArray(input)) {
    return preloadEach(context, input, preloads, force);
  }
  if (typeof input !== "object") {
    throw new TypeError(
      `Repo.preload expects a record, a list of records or null, got: ${inspect(input)}`,
    );
  }
  const [record] = await preloadEach(context, [input], preloads, force);
  return record;
}

/** Normalizes a preload spec, merging repeated associations (Ecto's `normalize`). */
function normalize(spec: unknown, original: unknown, into: Preloads): Preloads {
  if (typeof spec === "string") {
    merge(into, spec, undefined, new Map());
  } else if (Array.isArray(spec)) {
    for (const item of spec) normalize(item, original, into);
  } else if (isPlainObject(spec)) {
    for (const [name, value] of Object.entries(spec)) {
      if (value === true) {
        merge(into, name, undefined, new Map());
      } else if (typeof value === "function") {
        merge(into, name, value as Refine, new Map());
      } else if (Array.isArray(value) && typeof value[0] === "function") {
        if (value.length !== 2) invalid(value, original);
        merge(into, name, value[0], normalize(value[1], original, new Map()));
      } else {
        merge(into, name, undefined, normalize(value, original, new Map()));
      }
    }
  } else {
    invalid(spec, original);
  }
  return into;
}

function invalid(spec: unknown, original: unknown): never {
  throw new TypeError(
    `invalid preload ${inspect(spec)} in ${inspect(original)}; preload expects ` +
      "an association name, an object or an array of them",
  );
}

function merge(
  into: Preloads,
  name: string,
  query: Refine | undefined,
  nested: Preloads,
): void {
  const existing = into.get(name);
  if (existing === undefined) {
    into.set(name, { query, nested });
    return;
  }
  if (existing.query !== undefined && query !== undefined) {
    throw new TypeError(
      `cannot preload ${name} as it has been supplied more than once with different queries`,
    );
  }
  existing.query ??= query;
  for (const [child, value] of nested) {
    merge(existing.nested, child, value.query, value.nested);
  }
}

/**
 * Preloads into a list of records of one schema, which may contain nulls
 * (Ecto's `preload_each`). Returns copies; the given records are unchanged.
 */
async function preloadEach(
  context: PreloadContext,
  records: readonly unknown[],
  preloads: Preloads,
  force: boolean,
): Promise<unknown[]> {
  const sample = records.find(
    (record) => record !== null && record !== undefined,
  );
  if (preloads.size === 0 || sample === undefined) return [...records];
  const schema = schemaOf(sample);
  const owners = records.filter(
    (record): record is Rec => record !== null && record !== undefined,
  );
  for (const record of owners) {
    const other = getMeta(record)?.schema;
    if (other !== schema) {
      throw new TypeError(
        "expected a homogeneous list containing records of the same schema, " +
          `got: ${schema.source} and ${other === undefined ? inspect(record) : other.source}`,
      );
    }
  }

  // Ecto runs these queries in parallel; ekto runs them in turn, as a
  // transaction has a single connection.
  const loaded = new Map<string, (owner: Rec) => unknown>();
  for (const [name, { query, nested }] of preloads) {
    const reflection = association(schema, name);
    loaded.set(
      name,
      await preloadAssociation(
        context,
        reflection,
        owners,
        query,
        nested,
        force,
      ),
    );
  }

  return records.map((record) => {
    if (record === null || record === undefined) return record;
    const copy = putMeta(record as Rec, {});
    for (const [name, valueFor] of loaded) copy[name] = valueFor(record as Rec);
    return copy;
  });
}

/**
 * Loads one association for the owners and returns a function giving each
 * owner's value (Ecto's `fetch_ids`, `fetch_query`, `assoc_map` and
 * `load_assoc`).
 */
async function preloadAssociation(
  context: PreloadContext,
  reflection: Reflection,
  owners: readonly Rec[],
  query: Refine | undefined,
  nested: Preloads,
  force: boolean,
): Promise<(owner: Rec) => unknown> {
  const { name, cardinality, ownerKey } = reflection;
  const many = cardinality === "many";

  // Already loaded associations are kept (unless forced), but still get the
  // nested preloads.
  const isLoaded = (owner: Rec) => !force && Object.hasOwn(owner, name);
  const ids: unknown[] = [];
  const seen = new Set<unknown>();
  const children: unknown[] = [];
  for (const owner of owners) {
    if (isLoaded(owner)) {
      const value = owner[name];
      if (many && Array.isArray(value)) children.push(...value);
      else if (!many && value !== null && value !== undefined)
        children.push(value);
      continue;
    }
    const id = owner[ownerKey];
    if (id === null || id === undefined) continue;
    const key = keyOf(ownerParam(context, reflection, id));
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }

  const fetched =
    ids.length > 0 ? await fetch(context, reflection, ids, query) : [];
  children.push(...fetched.map(([, child]) => child));

  // Nested preloads run once over all related records, loaded and fetched.
  const preloaded = new Map<unknown, unknown>();
  if (nested.size > 0 && children.length > 0) {
    const results = await preloadEach(context, children, nested, force);
    for (const [i, child] of children.entries()) {
      preloaded.set(child, results[i]);
    }
  }
  const final = (child: unknown) =>
    preloaded.has(child) ? preloaded.get(child) : child;

  const byKey = new Map<unknown, unknown>();
  for (const [key, child] of fetched) {
    if (many) {
      const list = byKey.get(key) as unknown[] | undefined;
      if (list === undefined) byKey.set(key, [final(child)]);
      else list.push(final(child));
    } else {
      // As in Ecto, the last record wins when several match.
      byKey.set(key, final(child));
    }
  }

  return (owner) => {
    if (isLoaded(owner)) {
      const value = owner[name];
      if (many && Array.isArray(value)) return value.map(final);
      return value === null || value === undefined ? value : final(value);
    }
    const id = owner[ownerKey];
    const found =
      id === null || id === undefined
        ? undefined
        : byKey.get(keyOf(ownerParam(context, reflection, id)));
    return found ?? (many ? [] : null);
  };
}

/**
 * Fetches the related records of the given owner keys, each with the key
 * of the owner it belongs to.
 */
async function fetch(
  context: PreloadContext,
  reflection: Reflection,
  ids: readonly unknown[],
  refine: Refine | undefined,
): Promise<[key: unknown, record: object][]> {
  const { related, relatedKey } = reflection;
  const base = baseQuery(context, related);
  const refined = refine === undefined ? base : refine(base);
  if (!isSelectQuery(refined)) {
    throw new TypeError(
      `the preload query for ${reflection.name} must return a Kysely select query, got: ${inspect(refined)}`,
    );
  }
  const query = filter(context, reflection, refined, ids, true);
  const rows = await context.rows(query, related.source);
  return rows.map((row) => {
    const record = context.loadRow(related, row) as Rec;
    const join = reflection.join;
    const key =
      join === undefined
        ? relatedParam(context, reflection, record[relatedKey])
        : ownerParam(
            context,
            reflection,
            context.loadField(
              reflection.owner,
              reflection.ownerKey,
              row[OWNER_KEY],
            ),
          );
    return [keyOf(key), record];
  });
}

function baseQuery(context: PreloadContext, related: AnySchema): AnyQuery {
  return context.db.selectFrom(related.source).selectAll(related.source);
}

/**
 * Filters a query of the related schema to the given owner keys (Ecto's
 * `assoc_query`). For a many-to-many association, it joins the join table,
 * and selects the owner key when `selectOwner` is set.
 */
function filter(
  context: PreloadContext,
  reflection: Reflection,
  query: AnyQuery,
  ids: readonly unknown[],
  selectOwner: boolean,
): AnyQuery {
  const { related, relatedKey, join } = reflection;
  if (join !== undefined) {
    const values = ids.map((id) => ownerParam(context, reflection, id));
    const joined = query
      .innerJoin(
        join.source,
        `${join.source}.${join.relatedKey}`,
        `${related.source}.${relatedKey}`,
      )
      .where(`${join.source}.${join.ownerKey}`, "in", values);
    return selectOwner
      ? joined.select(`${join.source}.${join.ownerKey} as ${OWNER_KEY}`)
      : joined;
  }
  const column = `${related.source}.${relatedKey}`;
  const values = ids.map((id) => relatedParam(context, reflection, id));
  return values.length === 1
    ? query.where(column, "=", values[0])
    : query.where(column, "in", values);
}

/** An owner key as a query parameter, of the related key's type. */
function relatedParam(
  context: PreloadContext,
  reflection: Reflection,
  value: unknown,
): unknown {
  return context.param(reflection.related, reflection.relatedKey, value);
}

/** An owner key as a query parameter: for a join table, of the owner key's type. */
function ownerParam(
  context: PreloadContext,
  reflection: Reflection,
  value: unknown,
): unknown {
  return reflection.join === undefined
    ? relatedParam(context, reflection, value)
    : context.param(reflection.owner, reflection.ownerKey, value);
}

/** A Map key for a dumped value, so equal keys that are objects match. */
function keyOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value instanceof Uint8Array) {
    return `bytes:${Buffer.from(value).toString("hex")}`;
  }
  return `json:${JSON.stringify(value)}`;
}

/**
 * `Repo.assoc`: a query of the records associated with the given records
 * (Ecto's `Ecto.assoc/2`). Records whose key is null match nothing.
 */
export function assocQuery(
  context: PreloadContext,
  input: unknown,
  name: string,
): AnyQuery {
  if (input === null || input === undefined) {
    throw new TypeError(`cannot retrieve association ${name} for ${input}`);
  }
  const records = Array.isArray(input) ? input : [input];
  if (records.length === 0) {
    throw new TypeError(`cannot retrieve association ${name} for empty list`);
  }
  const schema = schemaOf(records[0]);
  const reflection = association(schema, name);
  const ids: unknown[] = [];
  const seen = new Set<unknown>();
  for (const record of records) {
    const other =
      typeof record === "object" && record !== null
        ? getMeta(record)?.schema
        : undefined;
    if (other !== schema) {
      throw new TypeError(
        "expected a homogeneous list containing records of the same schema, " +
          `got: ${schema.source} and ${other === undefined ? inspect(record) : other.source}`,
      );
    }
    const id = (record as Rec)[reflection.ownerKey];
    if (id === null || id === undefined) continue;
    const key = keyOf(ownerParam(context, reflection, id));
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  const base = baseQuery(context, reflection.related);
  if (ids.length === 0) {
    // `IN ()` is not valid SQL; no key matches nothing.
    return base.where((eb) => eb.lit(false));
  }
  return filter(context, reflection, base, ids, false);
}

function schemaOf(record: unknown): AnySchema {
  const schema =
    typeof record === "object" && record !== null
      ? getMeta(record)?.schema
      : undefined;
  if (schema === undefined) {
    throw new TypeError(
      `associations need records created by a schema, got: ${inspect(record)}`,
    );
  }
  return schema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSelectQuery(value: unknown): value is AnyQuery {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toOperationNode?: unknown }).toOperationNode ===
      "function" &&
    (value as AnyQuery).toOperationNode().kind === "SelectQueryNode"
  );
}
