/**
 * Migration commands as PostgreSQL DDL, following ecto_sql's
 * `Ecto.Adapters.Postgres.Connection.execute_ddl/1`.
 */

import type {
  ColumnChange,
  ColumnOptions,
  ColumnType,
  Constraint,
  DdlCommand,
  DefaultValue,
  DropMode,
  FromOption,
  Index,
  Reference,
  Table,
} from "../migrate/dsl.ts";
import { quoteIdentifierAnsi as quote } from "../sql.ts";

const isReference = (value: unknown): value is Reference =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "reference";

const single = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Ecto's `ecto_to_db/1`, for ekto's type names and Ecto's migration types.
const DB_TYPES: Readonly<Record<string, string>> = {
  id: "integer",
  serial: "serial",
  bigserial: "bigserial",
  string: "varchar",
  binary: "bytea",
  map: "jsonb",
  uuid: "uuid",
  utc_datetime: "timestamp",
  utc_datetime_msec: "timestamp",
};

function dbType(type: ColumnType): string {
  if (typeof type === "string") return DB_TYPES[type] ?? type;
  return `${dbType(type[1])}[]`;
}

function columnTypeName(type: ColumnType, options: ColumnOptions): string {
  if (typeof type !== "string") return `${columnTypeName(type[1], options)}[]`;
  if (type === "time" || type === "utc_datetime") return `${dbType(type)}(0)`;
  const name = dbType(type);
  if (type === "utc_datetime_msec")
    return options.precision === undefined
      ? name
      : `${name}(${options.precision})`;
  if (options.size !== undefined) return `${name}(${options.size})`;
  if (options.precision !== undefined)
    return `${name}(${options.precision},${options.scale ?? 0})`;
  if (type === "string") return `${name}(255)`;
  return name;
}

/** The PostgreSQL type of a column type or reference (Ecto's `column_type/2`). */
export function postgresColumnType(
  type: ColumnType | Reference,
  options: ColumnOptions = {},
): string {
  return isReference(type)
    ? referenceColumnType(type.type, options)
    : columnTypeName(type, options);
}

function referenceColumnType(type: ColumnType, options: ColumnOptions) {
  if (type === "serial") return "integer";
  if (type === "bigserial") return "bigint";
  return columnTypeName(type, options);
}

function defaultType(value: DefaultValue, type: ColumnType): string {
  if (Array.isArray(value)) {
    if (typeof type === "string" || type[0] !== "array")
      throw new TypeError(
        `unknown default ${JSON.stringify(value)} for type ${JSON.stringify(type)}`,
      );
    const inner = type[1];
    return `ARRAY[${value.map((v) => defaultType(v as DefaultValue, inner)).join(",")}]::${dbType(type)}`;
  }
  if (typeof value === "string") {
    if (value.includes("\0"))
      throw new TypeError(
        `default values are interpolated as UTF-8 strings and cannot contain null bytes. ${JSON.stringify(value)} is invalid`,
      );
    return single(value);
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "object" && value !== null) {
    if ((value as { kind?: unknown }).kind === "fragment")
      return (value as { sql: string }).sql;
    if (type === "map") return single(JSON.stringify(value));
  }
  throw new TypeError(
    `unknown default ${JSON.stringify(value)} for type ${JSON.stringify(type)}. ` +
      "default may be a string, number, boolean, array, object (when the type is map) or a fragment(...)",
  );
}

const defaultExpr = (options: ColumnOptions, type: ColumnType) =>
  !("default" in options)
    ? ""
    : options.default === null
      ? " DEFAULT NULL"
      : ` DEFAULT ${defaultType(options.default as DefaultValue, type)}`;

const nullExpr = (value: boolean | undefined) =>
  value === false ? " NOT NULL" : value === true ? " NULL" : "";

const columnOptions = (type: ColumnType, options: ColumnOptions) =>
  defaultExpr(options, type) + nullExpr(options.null);

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

const validate = (value: boolean) => (value ? "" : " NOT VALID");

const referenceName = (ref: Reference, table: Table, column: string) =>
  quote(ref.name ?? `${table.name}_${column}_fkey`);

const referenceExpr = (ref: Reference, table: Table, column: string) =>
  `CONSTRAINT ${referenceName(ref, table, column)} FOREIGN KEY (${quote(column)}) ` +
  `REFERENCES ${quote(ref.table)}(${quote(ref.column)})` +
  ON_DELETE[ref.onDelete] +
  ON_UPDATE[ref.onUpdate] +
  validate(ref.validate);

function fromReference(from: FromOption | undefined): Reference | undefined {
  if (isReference(from)) return from;
  if (
    typeof from === "object" &&
    !Array.isArray(from) &&
    isReference((from as { type?: unknown }).type)
  )
    return (from as { type: Reference }).type;
  return undefined;
}

const dropReferenceExpr = (
  ref: Reference | undefined,
  table: Table,
  column: string,
) => (ref ? `DROP CONSTRAINT ${referenceName(ref, table, column)}, ` : "");

function columnDefinition(table: Table, change: ColumnChange): string {
  if (change.op !== "add")
    throw new TypeError(`${change.op} cannot be used in create`);
  const { name, type, options } = change;
  if (isReference(type))
    return `${quote(name)} ${referenceColumnType(type.type, options)}${columnOptions(type.type, options)}, ${referenceExpr(type, table, name)}`;
  return `${quote(name)} ${columnTypeName(type, options)}${columnOptions(type, options)}`;
}

function columnChange(table: Table, change: ColumnChange): string {
  const name = quote(change.name);
  switch (change.op) {
    case "add":
    case "addIfNotExists": {
      const prefix =
        change.op === "add" ? "ADD COLUMN " : "ADD COLUMN IF NOT EXISTS ";
      const { type, options } = change;
      if (isReference(type))
        return `${prefix}${name} ${referenceColumnType(type.type, options)}${columnOptions(type.type, options)}, ADD ${referenceExpr(type, table, change.name)}`;
      return `${prefix}${name} ${columnTypeName(type, options)}${columnOptions(type, options)}`;
    }
    case "modify": {
      const { type, options } = change;
      const columnType = isReference(type) ? type.type : type;
      const typeName = isReference(type)
        ? referenceColumnType(type.type, options)
        : columnTypeName(type, options);
      return (
        dropReferenceExpr(fromReference(options.from), table, change.name) +
        `ALTER COLUMN ${name} TYPE ${typeName}` +
        (isReference(type)
          ? `, ADD ${referenceExpr(type, table, change.name)}`
          : "") +
        (options.null === true
          ? `, ALTER COLUMN ${name} DROP NOT NULL`
          : options.null === false
            ? `, ALTER COLUMN ${name} SET NOT NULL`
            : "") +
        ("default" in options
          ? `, ALTER COLUMN ${name} SET${defaultExpr(options, columnType)}`
          : "")
      );
    }
    case "remove":
      return `${isReference(change.type) ? dropReferenceExpr(change.type, table, change.name) : ""}DROP COLUMN ${name}`;
    case "removeIfExists":
      return `${isReference(change.type) ? `DROP CONSTRAINT IF EXISTS ${referenceName(change.type, table, change.name)}, ` : ""}DROP COLUMN IF EXISTS ${name}`;
  }
}

function pkDefinition(columns: readonly ColumnChange[], prefix: string) {
  const pks = columns
    .filter(
      (c) =>
        c.op !== "remove" &&
        c.op !== "removeIfExists" &&
        c.options.primaryKey === true,
    )
    .map((c) => quote(c.name));
  return pks.length === 0 ? "" : `${prefix}PRIMARY KEY (${pks.join(",")})`;
}

// Index columns are names unless they look like expressions (Ecto quotes
// atoms and keeps strings as written; ekto only has strings).
const indexExpr = (column: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ? quote(column) : column;

const dropMode = (mode: DropMode) => (mode === "cascade" ? " CASCADE" : "");

function createTable(
  command: "create" | "createIfNotExists",
  table: Table,
  columns: readonly ColumnChange[],
): string {
  return (
    `CREATE TABLE ${command === "createIfNotExists" ? "IF NOT EXISTS " : ""}` +
    `${quote(table.name)} (` +
    columns.map((c) => columnDefinition(table, c)).join(", ") +
    pkDefinition(columns, ", ") +
    ")" +
    (table.options === undefined ? "" : ` ${table.options}`)
  );
}

function createIndex(
  command: "create" | "createIfNotExists",
  index: Index,
): string {
  return (
    `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ` +
    (command === "createIfNotExists" ? "IF NOT EXISTS " : "") +
    `${quote(index.name)} ON ${quote(index.table)}` +
    (index.using === undefined ? "" : ` USING ${index.using}`) +
    ` (${index.columns.map(indexExpr).join(", ")})` +
    (index.include.length === 0
      ? ""
      : ` INCLUDE (${index.include.map(indexExpr).join(", ")})`) +
    (index.nullsDistinct === undefined
      ? ""
      : index.nullsDistinct
        ? " NULLS DISTINCT"
        : " NULLS NOT DISTINCT") +
    (index.where === undefined ? "" : ` WHERE ${index.where}`)
  );
}

function constraintExpr(constraint: Constraint): string {
  const body =
    constraint.check !== undefined
      ? ` CHECK (${constraint.check})`
      : ` EXCLUDE USING ${constraint.exclude}`;
  return `CONSTRAINT ${quote(constraint.name)}${body}${validate(constraint.validate)}`;
}

/** The SQL statements for a migration command on PostgreSQL. */
export function postgresDdl(command: DdlCommand): readonly string[] {
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
      return [
        `ALTER TABLE ${quote(object.table)} ADD ${constraintExpr(object)}`,
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
          return [
            `ALTER TABLE ${quote(object.table)} DROP CONSTRAINT ${ifExists}${quote(object.name)}${mode}`,
          ];
      }
      break;
    }
    case "alter":
      return [
        `ALTER TABLE ${quote(command.object.name)} ` +
          command.changes
            .map((c) => columnChange(command.object, c))
            .join(", ") +
          pkDefinition(command.changes, ", ADD "),
      ];
    case "renameTable":
      return [
        `ALTER TABLE ${quote(command.object.name)} RENAME TO ${quote(command.to.name)}`,
      ];
    case "renameColumn":
      return [
        `ALTER TABLE ${quote(command.object.name)} RENAME ${quote(command.from)} TO ${quote(command.to)}`,
      ];
    case "renameIndex":
      return [
        `ALTER INDEX ${quote(command.object.name)} RENAME TO ${quote(command.to)}`,
      ];
    case "execute":
      return [command.sql];
  }
  throw new TypeError("unknown migration command");
}
