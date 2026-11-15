/**
 * Generators: `ekto gen.migration` (Ecto's `mix ecto.gen.migration`) and
 * `ekto gen.schema` (Phoenix's `mix phx.gen.schema`).
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapter } from "../adapter.ts";
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
        field: `t.array(types.${known[0]})`,
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

/** The schema module: the schema, its record type and a changeset function. */
export function schemaSource(spec: SchemaSpec): string {
  checkSpec(spec);
  const name = spec.name.split(".").at(-1) as string;
  const param = name[0]?.toLowerCase() + name.slice(1);
  const cast = spec.attrs.filter((a) => !a.reference).map((a) => a.name);
  const unique = spec.attrs.filter((a) => a.unique).map((a) => a.name);
  const usesTypes = spec.attrs.some((a) => a.field.includes("types."));
  const imports = [
    "type Changeset",
    "cast",
    "type Infer",
    "type New",
    "pipe",
    "schema",
    "t",
    ...(usesTypes ? ["types"] : []),
    ...(unique.length > 0 ? ["uniqueConstraint"] : []),
    "validateRequired",
  ];
  const fields = [
    spec.binaryId ? "id: t.uuid().primaryKey().autogenerate()" : "id: t.id()",
    ...spec.attrs.map((a) => `${a.name}: ${a.field}`),
    "...t.timestamps()",
  ];
  const steps = [
    `cast(${param}, attrs, ${list(cast)})`,
    `validateRequired(${list(cast)})`,
    ...unique.map((u) => `uniqueConstraint(${JSON.stringify(u)})`),
  ];
  return `import {
${imports.map((i) => `  ${i},`).join("\n")}
} from "ekto";

export const ${name} = schema(${JSON.stringify(spec.table)}, {
${fields.map((f) => `  ${f},`).join("\n")}
});
export type ${name} = Infer<typeof ${name}>;

export function changeset<D extends ${name} | New<typeof ${name}>>(
  ${param}: D | Changeset<D>,
  attrs: unknown,
): Changeset<D> {
  return pipe(
${steps.map((s) => `    ${s},`).join("\n")}
  );
}
`;
}

/** The commands of the schema's migration (as `migrationSource` writes them). */
function migrationCommands(spec: SchemaSpec): Command[] {
  return record("up", (m) => {
    m.create(table(spec.table, { primaryKey: !spec.binaryId }), (t) => {
      if (spec.binaryId) t.add("id", "uuid", { primaryKey: true });
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
    `    m.create(table(${tbl}${spec.binaryId ? ", { primaryKey: false }" : ""}), (t) => {`,
    ...(spec.binaryId
      ? ['      t.add("id", "uuid", { primaryKey: true });']
      : []),
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
