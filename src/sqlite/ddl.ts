/**
 * Migration commands as SQLite DDL, following ecto_sqlite3's
 * `Ecto.Adapters.SQLite3.Connection.execute_ddl/1`.
 */

import type {
  ColumnChange,
  ColumnOptions,
  ColumnType,
  DdlCommand,
  DefaultValue,
  DropMode,
  Index,
  Reference,
  Table,
} from "../migrate/dsl.ts";
import { quoteIdentifierAnsi as quote } from "../sql.ts";

const isReference = (value: unknown): value is Reference =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "reference";

const escapeString = (value: string) => value.replaceAll("'", "''");

// ecto_sqlite3's DataType.column_type/2. Columns have affinities, not
// types, so sizes are ignored; decimals keep precision and scale.
const SQLITE_TYPES: Readonly<Record<string, string>> = {
  id: "INTEGER",
  serial: "INTEGER",
  bigserial: "INTEGER",
  boolean: "INTEGER",
  integer: "INTEGER",
  bigint: "INTEGER",
  string: "TEXT",
  float: "NUMERIC",
  binary: "BLOB",
  date: "TEXT",
  utc_datetime: "TEXT",
  utc_datetime_msec: "TEXT",
  time: "TEXT",
  timestamp: "TEXT",
  map: "TEXT",
  uuid: "TEXT",
};

function columnType(type: ColumnType, options: ColumnOptions): string {
  if (typeof type !== "string") return "TEXT";
  if (type === "decimal")
    return options.precision === undefined
      ? "DECIMAL"
      : `DECIMAL(${options.precision},${options.scale ?? 0})`;
  return SQLITE_TYPES[type] ?? type.toUpperCase();
}

/** The SQLite type of a column type or reference (ecto_sqlite3's `column_type/2`). */
export function sqliteColumnType(
  type: ColumnType | Reference,
  options: ColumnOptions = {},
): string {
  return columnType(isReference(type) ? type.type : type, options);
}

function defaultExpr(options: ColumnOptions): string {
  if (!("default" in options)) return "";
  const value = options.default as DefaultValue;
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "string") return ` DEFAULT '${escapeString(value)}'`;
  if (typeof value === "number" || typeof value === "boolean")
    return ` DEFAULT ${value}`;
  if ((value as { kind?: unknown }).kind === "fragment")
    return ` DEFAULT ${(value as { sql: string }).sql}`;
  return ` DEFAULT ('${escapeString(JSON.stringify(value))}')`;
}

const nullExpr = (value: boolean | undefined) =>
  value === false ? " NOT NULL" : value === true ? " NULL" : "";

function pkExpr(primaryKey: boolean, type: ColumnType) {
  if (!primaryKey) return "";
  return type === "serial" || type === "bigserial"
    ? " PRIMARY KEY AUTOINCREMENT"
    : " PRIMARY KEY";
}

function columnOptions(
  composite: boolean,
  type: ColumnType,
  options: ColumnOptions,
): string {
  return (
    defaultExpr(options) +
    nullExpr(options.null) +
    pkExpr(!composite && options.primaryKey === true, type)
  );
}

const ON_DELETE: Readonly<Record<Reference["onDelete"], string>> = {
  nothing: "",
  nilifyAll: " ON DELETE SET NULL",
  defaultAll: " ON DELETE SET DEFAULT",
  deleteAll: " ON DELETE CASCADE",
  restrict: " ON DELETE RESTRICT",
};

const ON_UPDATE: Readonly<Record<Reference["onUpdate"], string>> = {
  nothing: "",
  nilifyAll: " ON UPDATE SET NULL",
  updateAll: " ON UPDATE CASCADE",
  restrict: " ON UPDATE RESTRICT",
};

const referenceExpr = (ref: Reference, table: Table, column: string) =>
  ` CONSTRAINT ${quote(ref.name ?? `${table.name}_${column}_fkey`)}` +
  ` REFERENCES ${quote(ref.table)}(${quote(ref.column)})` +
  ON_DELETE[ref.onDelete] +
  ON_UPDATE[ref.onUpdate];

function column(
  table: Table,
  composite: boolean,
  name: string,
  type: ColumnType | Reference,
  options: ColumnOptions,
): string {
  if (isReference(type))
    return (
      `${quote(name)} ${columnType(type.type, options)}` +
      columnOptions(composite, type.type, options) +
      referenceExpr(type, table, name)
    );
  return `${quote(name)} ${columnType(type, options)}${columnOptions(composite, type, options)}`;
}

function columnChange(table: Table, change: ColumnChange): string {
  switch (change.op) {
    case "add": {
      // A NOT NULL column added to a table needs a constant default, which
      // date-times cannot have, so their null option is dropped (as
      // ecto_sqlite3 does).
      let options = change.options;
      if (
        change.type === "utc_datetime" ||
        change.type === "utc_datetime_msec"
      ) {
        const { null: _, ...rest } = options;
        options = rest;
      }
      return `ADD COLUMN ${column(table, false, change.name, change.type, options)}`;
    }
    case "remove":
      return `DROP COLUMN ${quote(change.name)}`;
    case "modify":
      throw new TypeError("ALTER COLUMN not supported by SQLite3");
    default:
      throw new TypeError(`${change.op} is not supported by SQLite3`);
  }
}

const dropMode = (mode: DropMode) => {
  if (mode === "cascade")
    throw new TypeError("SQLite3 does not support CASCADE in this command");
  return "";
};

const indexExpr = (column: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ? quote(column) : column;

function createIndex(
  command: "create" | "createIfNotExists",
  index: Index,
): string {
  if (index.include.length > 0)
    throw new TypeError("include is not supported with SQLite3");
  if (index.using !== undefined)
    throw new TypeError("using is not supported with SQLite3");
  if (index.nullsDistinct !== undefined)
    throw new TypeError("nullsDistinct is not supported with SQLite3");
  return (
    `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ` +
    (command === "createIfNotExists" ? "IF NOT EXISTS " : "") +
    `${quote(index.name)} ON ${quote(index.table)} ` +
    `(${index.columns.map(indexExpr).join(", ")})` +
    (index.where === undefined ? "" : ` WHERE ${index.where}`)
  );
}

function createTable(
  command: "create" | "createIfNotExists",
  table: Table,
  columns: readonly ColumnChange[],
): string {
  const pks = columns
    .filter((c) => c.op === "add" && c.options.primaryKey === true)
    .map((c) => quote(c.name));
  const composite = pks.length > 1;
  return (
    `CREATE TABLE ${command === "createIfNotExists" ? "IF NOT EXISTS " : ""}` +
    `${quote(table.name)} (` +
    columns
      .map((c) => {
        if (c.op !== "add")
          throw new TypeError(`${c.op} cannot be used in create`);
        return column(table, composite, c.name, c.type, c.options);
      })
      .join(", ") +
    (composite ? `, PRIMARY KEY (${pks.join(",")})` : "") +
    ")" +
    (table.options === undefined ? "" : ` ${table.options}`)
  );
}

/** The SQL statements for a migration command on SQLite. */
export function sqliteDdl(command: DdlCommand): readonly string[] {
  switch (command.command) {
    case "create":
    case "createIfNotExists": {
      const object = command.object;
      if (object.kind === "table")
        return [
          createTable(
            command.command,
            object,
            (command as { columns: readonly ColumnChange[] }).columns,
          ),
        ];
      if (object.kind === "index")
        return [createIndex(command.command, object)];
      if (command.command === "createIfNotExists")
        throw new TypeError(
          "createIfNotExists is not supported for constraints",
        );
      if (object.exclude !== undefined)
        throw new TypeError("SQLite3 does not support exclusion constraints");
      if (!object.validate)
        throw new TypeError(
          "SQLite3 does not support validate: false in constraints",
        );
      return [
        `ALTER TABLE ${quote(object.table)} ADD CONSTRAINT ${quote(object.name)} CHECK (${object.check})`,
      ];
    }
    case "drop":
    case "dropIfExists": {
      const ifExists = command.command === "dropIfExists" ? "IF EXISTS " : "";
      const object = command.object;
      const mode = dropMode(command.mode);
      switch (object.kind) {
        case "table":
          return [`DROP TABLE ${ifExists}${quote(object.name)}${mode}`];
        case "index":
          return [`DROP INDEX ${ifExists}${quote(object.name)}${mode}`];
        case "constraint":
          if (command.command === "dropIfExists")
            throw new TypeError(
              "SQLite3 does not support dropIfExists for constraints",
            );
          return [
            `ALTER TABLE ${quote(object.table)} DROP CONSTRAINT ${quote(object.name)}${mode}`,
          ];
      }
      break;
    }
    case "alter":
      return command.changes.map(
        (c) =>
          `ALTER TABLE ${quote(command.object.name)} ${columnChange(command.object, c)}`,
      );
    case "renameTable":
      return [
        `ALTER TABLE ${quote(command.object.name)} RENAME TO ${quote(command.to.name)}`,
      ];
    case "renameColumn":
      return [
        `ALTER TABLE ${quote(command.object.name)} RENAME COLUMN ${quote(command.from)} TO ${quote(command.to)}`,
      ];
    case "renameIndex":
      return [
        ...sqliteDdl({
          command: "drop",
          object: command.object,
          mode: "restrict",
        }),
        ...sqliteDdl({
          command: "create",
          object: { ...command.object, name: command.to },
        }),
      ];
    case "execute":
      return [command.sql];
  }
  throw new TypeError("unknown migration command");
}
