/**
 * The tables of a PostgreSQL database (its current schema), for generating
 * schemas from it.
 */

import { type Kysely, sql } from "kysely";
import type { ColumnDescription, TableDescription } from "../adapter.ts";
import type { ColumnType } from "../migrate/dsl.ts";

// The migration types of PostgreSQL's types (the inverse of the DDL's).
const TYPES: Readonly<Record<string, string>> = {
  int2: "integer",
  int4: "integer",
  int8: "bigint",
  float4: "float",
  float8: "float",
  numeric: "decimal",
  bool: "boolean",
  varchar: "string",
  bpchar: "string",
  citext: "string",
  name: "string",
  text: "text",
  bytea: "binary",
  json: "map",
  jsonb: "map",
  uuid: "uuid",
  date: "date",
  time: "time",
};

function columnType(
  udt: string,
  precision: number | null,
): ColumnType | undefined {
  if (udt.startsWith("_")) {
    const inner = columnType(udt.slice(1), precision);
    return inner === undefined ? undefined : ["array", inner];
  }
  if (udt === "timestamp" || udt === "timestamptz")
    return precision === 0 ? "utc_datetime" : "utc_datetime_msec";
  return TYPES[udt];
}

/** `Adapter.describeTables` for PostgreSQL. */
export async function describeTables(
  // biome-ignore lint/suspicious/noExplicitAny: any database
  db: Kysely<any>,
): Promise<readonly TableDescription[]> {
  const columns = await sql<{
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    datetime_precision: number | null;
    is_identity: string;
  }>`
    SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable,
      c.column_default, c.datetime_precision, c.is_identity
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`.execute(db);
  const primaryKeys = await sql<{ table_name: string; column_name: string }>`
    SELECT cl.relname AS table_name, a.attname AS column_name
    FROM pg_index i
    JOIN pg_class cl ON cl.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary AND n.nspname = current_schema()`.execute(db);
  const foreignKeys = await sql<{
    table_name: string;
    column_name: string;
    ref_table: string;
    ref_column: string;
  }>`
    SELECT cl.relname AS table_name, a.attname AS column_name,
      rcl.relname AS ref_table, ra.attname AS ref_column
    FROM pg_constraint co
    JOIN pg_class cl ON cl.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class rcl ON rcl.oid = co.confrelid
    JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = co.conkey[1]
    JOIN pg_attribute ra ON ra.attrelid = co.confrelid AND ra.attnum = co.confkey[1]
    WHERE co.contype = 'f' AND cardinality(co.conkey) = 1
      AND n.nspname = current_schema()
    ORDER BY co.conname`.execute(db);
  const unique = await sql<{
    table_name: string;
    column_name: string;
    index_name: string;
  }>`
    SELECT cl.relname AS table_name, a.attname AS column_name,
      ic.relname AS index_name
    FROM pg_index i
    JOIN pg_class cl ON cl.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indisunique AND NOT i.indisprimary AND i.indnatts = 1
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND n.nspname = current_schema()
    ORDER BY ic.relname`.execute(db);

  const pk = new Set(
    primaryKeys.rows.map((r) => `${r.table_name}.${r.column_name}`),
  );
  const tables = new Map<string, ColumnDescription[]>();
  for (const c of columns.rows) {
    const list = tables.get(c.table_name) ?? [];
    tables.set(c.table_name, list);
    list.push({
      name: c.column_name,
      dbType: c.udt_name,
      type: columnType(c.udt_name, c.datetime_precision),
      nullable: c.is_nullable === "YES",
      hasDefault: c.column_default !== null || c.is_identity === "YES",
      primaryKey: pk.has(`${c.table_name}.${c.column_name}`),
      generated:
        c.is_identity === "YES" ||
        (c.column_default?.startsWith("nextval(") ?? false),
    });
  }
  return [...tables].map(([name, cols]) => ({
    name,
    columns: cols,
    foreignKeys: foreignKeys.rows
      .filter((f) => f.table_name === name)
      .map((f) => ({
        column: f.column_name,
        table: f.ref_table,
        references: f.ref_column,
      })),
    uniqueIndexes: unique.rows
      .filter((u) => u.table_name === name)
      .map((u) => ({ column: u.column_name, name: u.index_name })),
  }));
}
