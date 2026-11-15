/**
 * The tables of a SQLite database, for generating schemas from it.
 */

import { type Kysely, sql } from "kysely";
import type { TableDescription } from "../adapter.ts";
import type { ColumnType } from "../migrate/dsl.ts";

// The migration type of a declared column type. SQLite keeps the declared
// type as written, so the types ekto's migrations write (INTEGER, TEXT…) and
// common ones are recognized; booleans, dates and maps written by ekto's
// migrations are INTEGER and TEXT, and come back as such.
function columnType(declared: string): ColumnType | undefined {
  const type = declared.toUpperCase();
  if (type === "BOOLEAN" || type === "BOOL") return "boolean";
  if (type === "DATE") return "date";
  if (type === "TIME") return "time";
  if (/^(DATETIME|TIMESTAMP|UTC_DATETIME)/.test(type)) return "utc_datetime";
  if (type === "UUID") return "uuid";
  if (type === "JSON" || type === "MAP") return "map";
  if (type.startsWith("DECIMAL")) return "decimal";
  if (type.includes("INT")) return "integer";
  if (/CHAR|CLOB|TEXT/.test(type)) return "string";
  if (type === "" || type.includes("BLOB")) return "binary";
  if (/REAL|FLOA|DOUB|NUMERIC/.test(type)) return "float";
  return undefined;
}

/** `Adapter.describeTables` for SQLite. */
export async function describeTables(
  // biome-ignore lint/suspicious/noExplicitAny: any database
  db: Kysely<any>,
): Promise<readonly TableDescription[]> {
  const { rows: tables } = await sql<{ name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`.execute(db);
  const result: TableDescription[] = [];
  for (const { name } of tables) {
    const { rows: columns } = await sql<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${name}) ORDER BY cid`.execute(
      db,
    );
    const pks = columns.filter((c) => c.pk > 0);
    const { rows: fks } = await sql<{
      from: string;
      table: string;
      to: string | null;
      id: number;
    }>`SELECT "from", "table", "to", id FROM pragma_foreign_key_list(${name})`.execute(
      db,
    );
    const { rows: indexes } = await sql<{ name: string }>`
      SELECT name FROM pragma_index_list(${name})
      WHERE "unique" = 1 AND origin != 'pk' AND partial = 0
      ORDER BY name`.execute(db);
    const uniqueIndexes = [];
    for (const index of indexes) {
      const { rows } = await sql<{
        name: string | null;
      }>`SELECT name FROM pragma_index_info(${index.name})`.execute(db);
      const column = rows[0]?.name;
      if (rows.length === 1 && column != null)
        uniqueIndexes.push({ column, name: index.name });
    }
    result.push({
      name,
      columns: columns.map((c) => ({
        name: c.name,
        dbType: c.type,
        type: columnType(c.type),
        // Primary keys other than the rowid alias may be null in SQLite.
        nullable: c.notnull === 0 && c.pk === 0,
        hasDefault: c.dflt_value !== null,
        primaryKey: c.pk > 0,
        // An INTEGER PRIMARY KEY is the rowid.
        generated:
          c.pk > 0 && pks.length === 1 && c.type.toUpperCase() === "INTEGER",
      })),
      // Single-column keys only.
      foreignKeys: fks
        .filter((f) => fks.filter((o) => o.id === f.id).length === 1)
        .map((f) => ({
          column: f.from,
          table: f.table,
          references: f.to ?? "id",
        })),
      uniqueIndexes,
    });
  }
  return result;
}
