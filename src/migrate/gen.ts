/**
 * Generators: `ekto gen.migration` (Ecto's `mix ecto.gen.migration`) and
 * `ekto gen.schema` (Phoenix's `mix phx.gen.schema`).
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Kysely } from "kysely";
import type { Adapter, TableDescription } from "../adapter.ts";
import {
  type ColumnOptions,
  type ColumnType,
  type Command,
  index,
  type Reference,
  record,
  references,
  table,
} from "./dsl.ts";

/** `20260115103000`, the UTC time (Ecto's `timestamp/0`). */
export function timestamp(date: Date): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

/** `AddUsers` and `add users` become `add_users` (Macro.underscore). */
export function underscore(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z\d]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

const MIGRATION_TEMPLATE = `import { migration } from "ekto/migrate";

export default migration({
  change(m) {},
});
`;

/**
 * Creates `<folder>/<timestamp>_<name>.ts` with `contents` (an empty
 * migration by default) and returns its path. Names must be unique, as
 * Ecto requires.
 */
export async function generate(
  folder: string,
  name: string,
  now = new Date(),
  contents = MIGRATION_TEMPLATE,
): Promise<string> {
  const base = underscore(name);
  if (base === "")
    throw new Error(`expected a migration name, got ${JSON.stringify(name)}`);
  await mkdir(folder, { recursive: true });
  const existing = (await readdir(folder)).find(
    (f) => f.replace(/^\d+_/, "").replace(/\.[^.]+$/, "") === base,
  );
  if (existing)
    throw new Error(`migration name ${base} is already used by ${existing}`);
  const file = join(folder, `${timestamp(now)}_${base}.ts`);
  await writeFile(file, contents, { flag: "wx" });
  return file;
}

// ---------------------------------------------------------------------------
// gen.schema
// ---------------------------------------------------------------------------

/** A field of a generated schema. */
export interface SchemaAttr {
  readonly name: string;
  /** The field, as TypeScript (e.g. `t.string()`). */
  readonly field: string;
  /** The migration column type, or the reference for `references`. */
  readonly column: ColumnType | Reference;
  /** The column type as migration source (e.g. `"string"`). */
  readonly columnSource: string;
  /** References are not cast (as Phoenix generates them). */
  readonly reference: boolean;
  readonly unique: boolean;
}

/** The field types `gen.schema` knows: the field and the column type. */
const ATTR_TYPES: Readonly<Record<string, readonly [string, string]>> = {
  string: ["string", "string"],
  text: ["string", "text"],
  integer: ["integer", "integer"],
  float: ["float", "float"],
  decimal: ["decimal", "decimal"],
  boolean: ["boolean", "boolean"],
  map: ["map", "map"],
  binary: ["binary", "binary"],
  uuid: ["uuid", "uuid"],
  date: ["date", "date"],
  time: ["time", "time"],
  utc_datetime: ["utcDatetime", "utc_datetime"],
  utc_datetime_msec: ["utcDatetimeMsec", "utc_datetime_msec"],
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses `name:type[:unique]` attributes as `mix phx.gen.schema` does: the
 * type defaults to `string`; `array:<type>`, `enum:<value>:<value>…` and
 * `references:<table>` take arguments.
 */
export function parseAttrs(
  specs: readonly string[],
  options: { readonly binaryId?: boolean } = {},
): SchemaAttr[] {
  const attrs = specs.map((spec): SchemaAttr => {
    let [name = "", type = "string", ...args] = spec.split(":");
    const unique = args.at(-1) === "unique";
    if (unique) args = args.slice(0, -1);
    if (type === "unique" && args.length === 0) {
      type = "string";
      return { ...attr(name, type, []), unique: true };
    }
    return { ...attr(name, type, args), unique };
  });
  const seen = new Set<string>();
  for (const a of attrs) {
    if (seen.has(a.name)) throw new Error(`duplicate field ${a.name}`);
    seen.add(a.name);
  }
  return attrs;

  function attr(name: string, type: string, args: string[]): SchemaAttr {
    if (!IDENTIFIER.test(name))
      throw new Error(`invalid field name ${JSON.stringify(name)}`);
    if (["id", "inserted_at", "updated_at"].includes(name))
      throw new Error(`${name} is added by the generator`);
    const base = { name, unique: false, reference: false };
    if (type === "references") {
      const [to] = args;
      if (to === undefined || args.length !== 1 || !IDENTIFIER.test(to))
        throw new Error(`expected ${name}:references:<table>`);
      const refType = options.binaryId ? "uuid" : undefined;
      return {
        ...base,
        reference: true,
        field: options.binaryId ? "t.uuid()" : "t.integer()",
        column: references(to, refType ? { type: refType } : {}),
        columnSource: `references(${JSON.stringify(to)}${refType ? `, { type: "${refType}" }` : ""})`,
      };
    }
    if (type === "array") {
      const known =
        args.length === 1 ? ATTR_TYPES[args[0] as string] : undefined;
      if (known === undefined)
        throw new Error(`expected ${name}:array:<type>, e.g. array:string`);
      return {
        ...base,
        field: `t.array(t.${known[0]})`,
        column: ["array", known[1]],
        columnSource: `["array", ${JSON.stringify(known[1])}]`,
      };
    }
    if (type === "enum") {
      if (args.length === 0 || !args.every((v) => v !== ""))
        throw new Error(`expected ${name}:enum:<value>:<value>…`);
      return {
        ...base,
        field: `t.enum(${JSON.stringify(args).replaceAll(",", ", ")})`,
        column: "string",
        columnSource: '"string"',
      };
    }
    const known = ATTR_TYPES[type];
    if (known === undefined || args.length > 0)
      throw new Error(
        `unknown type ${[type, ...args].join(":")} for ${name}; expected one of ${[...Object.keys(ATTR_TYPES), "array", "enum", "references"].join(", ")}`,
      );
    return {
      ...base,
      field: `t.${known[0]}()`,
      column: known[1],
      columnSource: JSON.stringify(known[1]),
    };
  }
}

/** A schema to generate. */
export interface SchemaSpec {
  /** The schema's name, e.g. `Post` or `Blog.Post` (which goes in `blog/post.ts`). */
  readonly name: string;
  readonly table: string;
  readonly attrs: readonly SchemaAttr[];
  /** A UUID primary key (Phoenix's `--binary-id`). */
  readonly binaryId?: boolean;
}

/** The schema's file, relative to the schemas folder: `Blog.Post` is `blog/post.ts`. */
export function schemaFile(name: string): string {
  return `${name.split(".").map(underscore).join("/")}.ts`;
}

function checkSpec(spec: SchemaSpec) {
  if (!/^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)*$/.test(spec.name))
    throw new Error(
      `expected a schema name such as Post or Blog.Post, got ${JSON.stringify(spec.name)}`,
    );
  if (!IDENTIFIER.test(spec.table))
    throw new Error(`invalid table name ${JSON.stringify(spec.table)}`);
}

const list = (names: readonly string[]) =>
  `[${names.map((n) => JSON.stringify(n)).join(", ")}]`;

/** A field of a schema module. */
interface ModuleField {
  /** As written in the schema, e.g. `email: t.string()` or `...t.timestamps()`. */
  readonly source: string;
  /** The field's name, when the changeset casts it. */
  readonly cast?: string;
  readonly required?: boolean;
  /** A unique index on it: its name, or `true` for the conventional one. */
  readonly unique?: string | true;
}

/** The schema module: the schema, its record type and a changeset function. */
function renderSchema(
  name: string,
  table: string,
  fields: readonly ModuleField[],
): string {
  const short = name.split(".").at(-1) as string;
  const param = short[0]?.toLowerCase() + short.slice(1);
  const cast = fields.flatMap((f) => (f.cast ? [f.cast] : []));
  const required = fields.flatMap((f) =>
    f.cast && f.required ? [f.cast] : [],
  );
  const unique = fields.flatMap((f) =>
    f.cast && f.unique ? [[f.cast, f.unique] as const] : [],
  );
  const imports = [
    "type Changeset",
    "cast",
    "type Infer",
    "type New",
    "pipe",
    "schema",
    "t",
    ...(unique.length > 0 ? ["uniqueConstraint"] : []),
    ...(required.length > 0 ? ["validateRequired"] : []),
  ];
  const steps = [
    `cast(${param}, attrs, ${list(cast)})`,
    ...(required.length > 0 ? [`validateRequired(${list(required)})`] : []),
    ...unique.map(
      ([field, index]) =>
        `uniqueConstraint(${JSON.stringify(field)}${index === true ? "" : `, { name: ${JSON.stringify(index)} }`})`,
    ),
  ];
  return `import {
${imports.map((i) => `  ${i},`).join("\n")}
} from "ekto";

export const ${short} = schema(${JSON.stringify(table)}, {
${fields.map((f) => `  ${f.source},`).join("\n")}
});
export type ${short} = Infer<typeof ${short}>;

export function changeset<D extends ${short} | New<typeof ${short}>>(
  ${param}: D | Changeset<D>,
  attrs: unknown,
): Changeset<D> {
  return pipe(
${steps.map((s) => `    ${s},`).join("\n")}
  );
}
`;
}

/**
 * The schema module of `gen.schema`, as Phoenix writes it: every field but
 * references is cast and required.
 */
export function schemaSource(spec: SchemaSpec): string {
  checkSpec(spec);
  return renderSchema(spec.name, spec.table, [
    {
      source: spec.binaryId
        ? "id: t.uuid({ primaryKey: true, autogenerate: true })"
        : "id: t.id()",
    },
    ...spec.attrs.map((a) => ({
      source: `${a.name}: ${a.field}`,
      ...(!a.reference && { cast: a.name, required: true }),
      ...(a.unique && { unique: true as const }),
    })),
    { source: "...t.timestamps()" },
  ]);
}

const FIELDS: Readonly<Record<string, string>> = {
  string: "string",
  text: "string",
  integer: "integer",
  bigint: "integer",
  float: "float",
  decimal: "decimal",
  boolean: "boolean",
  map: "map",
  binary: "binary",
  uuid: "uuid",
  date: "date",
  time: "time",
  utc_datetime: "utcDatetime",
  utc_datetime_msec: "utcDatetimeMsec",
};

/** `t.integer()` with options: `t.integer({ nullable: true })`. */
function withOptions(field: string, options: readonly string[]): string {
  if (options.length === 0) return field;
  const config = `{ ${options.join(", ")} }`;
  return field.endsWith("()")
    ? `${field.slice(0, -1)}${config})`
    : `${field.slice(0, -1)}, ${config})`;
}

/** The field of a column (`t.integer()`), or `undefined` for unknown types. */
function fieldOf(type: ColumnType | undefined): string | undefined {
  if (type === undefined) return undefined;
  if (typeof type !== "string") {
    const inner = typeof type[1] === "string" ? FIELDS[type[1]] : undefined;
    return inner === undefined ? undefined : `t.array(t.${inner})`;
  }
  const field = FIELDS[type];
  return field === undefined ? undefined : `t.${field}()`;
}

/**
 * The schema module of an existing table: its columns become fields,
 * nullable ones `{ nullable: true }`; the changeset casts all but the primary key,
 * foreign keys and timestamps, and requires the columns that are `NOT NULL`
 * without a default. Columns of unknown types become `t.any()`.
 */
export function tableSchemaSource(
  name: string,
  table: TableDescription,
): string {
  checkSpec({ name, table: table.name, attrs: [] });
  const fks = new Set(table.foreignKeys.map((f) => f.column));
  const pks = table.columns.filter((c) => c.primaryKey);
  const columns = new Map(table.columns.map((c) => [c.name, c]));
  const inserted = columns.get("inserted_at");
  const updated = columns.get("updated_at");
  const timestamps =
    inserted !== undefined &&
    updated !== undefined &&
    inserted.type === updated.type &&
    (inserted.type === "utc_datetime" ||
      inserted.type === "utc_datetime_msec" ||
      inserted.dbType.toUpperCase() === "TEXT");
  const fields: ModuleField[] = [];
  for (const c of table.columns) {
    if (timestamps && (c === inserted || c === updated)) {
      if (c === inserted)
        fields.push({
          source:
            c.type === "utc_datetime_msec"
              ? '...t.timestamps({ type: "utcDatetimeMsec" })'
              : "...t.timestamps()",
        });
      continue;
    }
    const key = IDENTIFIER.test(c.name) ? c.name : JSON.stringify(c.name);
    if (
      c.primaryKey &&
      pks.length === 1 &&
      c.generated &&
      fieldOf(c.type) === "t.integer()"
    ) {
      fields.push({ source: `${key}: t.id()` });
      continue;
    }
    const options: string[] = [];
    if (c.primaryKey) {
      options.push("primaryKey: true");
      if (c.hasDefault) options.push("readAfterWrites: true");
      else if (c.type === "uuid") options.push("autogenerate: true");
    } else if (c.hasDefault && !c.nullable)
      options.push("readAfterWrites: true");
    if (c.nullable) options.push("nullable: true");
    const field = withOptions(fieldOf(c.type) ?? "t.any()", options);
    const comment = fieldOf(c.type) === undefined ? ` /* ${c.dbType} */` : "";
    const unique = table.uniqueIndexes.find((u) => u.column === c.name);
    const conventional = `${table.name}_${c.name}_index`;
    fields.push({
      source: `${key}: ${field}${comment}`,
      ...(!c.primaryKey &&
        !fks.has(c.name) && {
          cast: c.name,
          required: !c.nullable && !c.hasDefault,
        }),
      ...(unique && {
        unique: unique.name === conventional ? (true as const) : unique.name,
      }),
    });
  }
  return renderSchema(name, table.name, fields);
}

/** `blog_posts` becomes `BlogPost`: camel-cased, the last word singular. */
export function schemaName(table: string): string {
  const words = table.split("_").filter((w) => w !== "");
  const last = words.pop() ?? "";
  const singular = last
    .replace(/ies$/, "y")
    .replace(/(ss|x|ch|sh)es$/, "$1")
    .replace(/([^siu])s$/, "$1");
  return [...words, singular]
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join("");
}

/** The commands of the schema's migration (as `migrationSource` writes them). */
function migrationCommands(spec: SchemaSpec): Command[] {
  return record("up", (m) => {
    m.create(table(spec.table), (t) => {
      t.add("id", spec.binaryId ? "uuid" : "bigserial", { primaryKey: true });
      for (const a of spec.attrs) t.add(a.name, a.column);
      t.timestamps();
    });
    for (const a of spec.attrs)
      if (a.unique) m.create(index(spec.table, [a.name], { unique: true }));
    for (const a of spec.attrs)
      if (a.reference && !a.unique) m.create(index(spec.table, [a.name]));
  });
}

/** The schema's migration in ekto's DSL (as `mix phx.gen.schema` writes it). */
export function migrationSource(spec: SchemaSpec): string {
  checkSpec(spec);
  const tbl = JSON.stringify(spec.table);
  const lines = [
    `    m.create(table(${tbl}), (t) => {`,
    `      t.add("id", ${spec.binaryId ? '"uuid"' : '"bigserial"'}, { primaryKey: true });`,
    ...spec.attrs.map(
      (a) => `      t.add(${JSON.stringify(a.name)}, ${a.columnSource});`,
    ),
    "      t.timestamps();",
    "    });",
    ...spec.attrs
      .filter((a) => a.unique)
      .map((a) => `    m.create(uniqueIndex(${tbl}, ${list([a.name])}));`),
    ...spec.attrs
      .filter((a) => a.reference && !a.unique)
      .map((a) => `    m.create(index(${tbl}, ${list([a.name])}));`),
  ];
  const imports = [
    ...(spec.attrs.some((a) => a.reference && !a.unique) ? ["index"] : []),
    "migration",
    ...(spec.attrs.some((a) => a.reference) ? ["references"] : []),
    "table",
    ...(spec.attrs.some((a) => a.unique) ? ["uniqueIndex"] : []),
  ];
  return `import { ${imports.join(", ")} } from "ekto/migrate";

export default migration({
  change(m) {
${lines.join("\n")}
  },
});
`;
}

// The types Kysely's schema builder accepts as strings (its
// `isColumnDataType`); others are written with `sql`.
const KYSELY_TYPES = new Set([
  "bigint",
  "bigserial",
  "blob",
  "boolean",
  "bytea",
  "date",
  "decimal",
  "double precision",
  "integer",
  "json",
  "jsonb",
  "numeric",
  "real",
  "serial",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
  "varchar",
]);
const KYSELY_TYPE_PATTERNS = [
  /^(varchar|char|binary|varbinary)\(\d+\)$/,
  /^(time|timetz|timestamp|timestamptz|datetime)\(\d+\)$/,
  /^(decimal|numeric)\(\d+, \d+\)$/,
];

function kyselyType(type: string): string {
  const lower = type.toLowerCase();
  return KYSELY_TYPES.has(lower) ||
    KYSELY_TYPE_PATTERNS.some((p) => p.test(lower))
    ? JSON.stringify(lower)
    : `sql\`${type.replaceAll("`", "\\`")}\``;
}

const KYSELY_ON_DELETE: Readonly<Record<Reference["onDelete"], string>> = {
  nothing: "",
  deleteAll: "cascade",
  nilifyAll: "set null",
  defaultAll: "set default",
  restrict: "restrict",
};

const isReference = (value: unknown): value is Reference =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "reference";

/**
 * The schema's migration as a Kysely migration (`up` and `down` with Kysely's
 * schema builder), for applications migrating with Kysely's Migrator. The
 * column types are the adapter's, as an ekto migration would create them.
 */
export function kyselyMigrationSource(
  spec: SchemaSpec,
  adapter: Adapter,
): string {
  checkSpec(spec);
  const columnType = adapter.columnType?.bind(adapter);
  if (columnType === undefined)
    throw new Error(
      `the ${adapter.name} adapter cannot generate Kysely migrations`,
    );
  const up: string[] = [];
  let usesSql = false;
  const type = (t: ColumnType | Reference, options: ColumnOptions) => {
    const result = kyselyType(columnType(t, options));
    if (result.startsWith("sql")) usesSql = true;
    return result;
  };
  for (const command of migrationCommands(spec)) {
    if (command.command !== "create") continue;
    const object = command.object;
    if (object.kind === "table") {
      const lines = [
        "  await db.schema",
        `    .createTable(${JSON.stringify(object.name)})`,
      ];
      const columns = (command as { columns: readonly ColumnChangeAdd[] })
        .columns;
      for (const c of columns) {
        const modifiers: string[] = [];
        if (c.options.primaryKey) modifiers.push(".primaryKey()");
        // SQLite's AUTOINCREMENT, as ekto's SQLite migrations write serials.
        if (
          c.options.primaryKey &&
          adapter.name === "sqlite" &&
          (c.type === "serial" || c.type === "bigserial")
        )
          modifiers.push(".autoIncrement()");
        if (c.options.null === false) modifiers.push(".notNull()");
        if (isReference(c.type)) {
          modifiers.push(
            `.references(${JSON.stringify(`${c.type.table}.${c.type.column}`)})`,
          );
          const onDelete = KYSELY_ON_DELETE[c.type.onDelete];
          if (onDelete !== "")
            modifiers.push(`.onDelete(${JSON.stringify(onDelete)})`);
        }
        lines.push(
          `    .addColumn(${JSON.stringify(c.name)}, ${type(c.type, c.options)}${modifiers.length > 0 ? `, (col) => col${modifiers.join("")}` : ""})`,
        );
      }
      up.push(`${lines.join("\n")}\n    .execute();`);
    } else if (object.kind === "index") {
      up.push(
        "  await db.schema\n" +
          `    .createIndex(${JSON.stringify(object.name)})\n` +
          (object.unique ? "    .unique()\n" : "") +
          `    .on(${JSON.stringify(object.table)})\n` +
          `    .columns(${list(object.columns)})\n` +
          "    .execute();",
      );
    }
  }
  return `import ${usesSql ? "{ type Kysely, sql }" : "type { Kysely }"} from "kysely";

// biome-ignore lint/suspicious/noExplicitAny: migrations run on any database
export async function up(db: Kysely<any>): Promise<void> {
${up.join("\n")}
}

// biome-ignore lint/suspicious/noExplicitAny: migrations run on any database
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable(${JSON.stringify(spec.table)}).execute();
}
`;
}

interface ColumnChangeAdd {
  readonly name: string;
  readonly type: ColumnType | Reference;
  readonly options: ColumnOptions;
}

export type MigrationFormat = "ekto" | "kysely" | "none";

export interface GenerateSchemaOptions {
  readonly schemasFolder: string;
  readonly migrationsFolder: string;
  readonly migration: MigrationFormat;
  /** Needed for Kysely migrations. */
  readonly adapter?: Adapter;
  readonly now?: Date;
}

/** Writes the schema file and its migration; returns the files written. */
export async function generateSchema(
  spec: SchemaSpec,
  options: GenerateSchemaOptions,
): Promise<string[]> {
  const schema = schemaSource(spec);
  let migration: string | undefined;
  if (options.migration === "ekto") migration = migrationSource(spec);
  else if (options.migration === "kysely") {
    if (options.adapter === undefined)
      throw new Error(
        "Kysely migrations need the adapter: add an ekto.config.ts",
      );
    migration = kyselyMigrationSource(spec, options.adapter);
  } else if (options.migration !== "none")
    throw new Error(
      `expected the migration format ekto, kysely or none, got ${options.migration}`,
    );
  const file = join(options.schemasFolder, schemaFile(spec.name));
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const files: string[] = [];
  if (migration !== undefined)
    files.push(
      await generate(
        options.migrationsFolder,
        `create_${spec.table}`,
        options.now,
        migration,
      ),
    );
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, schema, { flag: "wx" });
  return [file, ...files];
}

export interface GenerateSchemasOptions {
  readonly schemasFolder: string;
  /** The tables, each with its schema name (inferred when `undefined`); every table by default. */
  readonly tables?: ReadonlyMap<string, string | undefined>;
  /** Tables left out when `tables` is not given (e.g. the migrations table). */
  readonly exclude?: readonly string[];
}

/**
 * Writes a schema for each table of the database; existing files are
 * skipped. Returns the files written and skipped.
 */
export async function generateSchemas(
  // biome-ignore lint/suspicious/noExplicitAny: any database
  db: Kysely<any>,
  adapter: Adapter,
  options: GenerateSchemasOptions,
): Promise<{ written: string[]; skipped: string[] }> {
  if (adapter.describeTables === undefined)
    throw new Error(`the ${adapter.name} adapter cannot describe tables`);
  const described = await adapter.describeTables(db);
  let tables: [TableDescription, string][];
  if (options.tables === undefined) {
    const exclude = new Set(options.exclude ?? []);
    tables = described
      .filter((t) => !exclude.has(t.name))
      .map((t) => [t, schemaName(t.name)]);
  } else {
    tables = [...options.tables].map(([name, schema]) => {
      const table = described.find((t) => t.name === name);
      if (table === undefined) throw new Error(`no table ${name}`);
      return [table, schema ?? schemaName(name)];
    });
  }
  const sources = tables.map(
    ([table, name]) =>
      [
        join(options.schemasFolder, schemaFile(name)),
        tableSchemaSource(name, table),
      ] as const,
  );
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [file, source] of sources) {
    if (existsSync(file)) {
      skipped.push(file);
      continue;
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source, { flag: "wx" });
    written.push(file);
  }
  return { written, skipped };
}
