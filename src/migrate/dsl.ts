/**
 * The migration DSL (Ecto.Migration): `table`, `index`, `references`,
 * `constraint` and the commands a migration's `change`, `up` or `down`
 * records. Running them is the runner's job; turning them into SQL is the
 * adapter's (`Adapter.ddl`).
 */

import type { Kysely } from "kysely";

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * A column type: one of ekto's primitive types (`"string"`, `"utc_datetime"`,
 * `"map"`…), a migration type such as `"bigserial"` or `"text"`, any other
 * database type name (passed through), or `["array", type]`.
 */
export type ColumnType = string | readonly ["array", ColumnType];

/** A default written as SQL as is, e.g. `fragment("now()")` (Ecto's `fragment/1`). */
export interface Fragment {
  readonly kind: "fragment";
  readonly sql: string;
}

export type DefaultValue =
  | string
  | number
  | boolean
  | null
  | Fragment
  | readonly unknown[]
  | { readonly [key: string]: unknown };

export interface ColumnOptions {
  /** `false` adds `NOT NULL`. */
  readonly null?: boolean;
  readonly default?: DefaultValue;
  readonly primaryKey?: boolean;
  readonly size?: number;
  readonly precision?: number;
  readonly scale?: number;
}

/** What a column was before `modify`, so the change can be reversed. */
export type FromOption =
  | ColumnType
  | Reference
  | ({ readonly type: ColumnType | Reference } & ColumnOptions);

export interface ModifyOptions extends ColumnOptions {
  readonly from?: FromOption;
}

export interface Table {
  readonly kind: "table";
  readonly name: string;
  /** The primary key `create` adds, or `null` for none. */
  readonly primaryKey: {
    readonly name: string;
    readonly type: ColumnType;
  } | null;
  /** Appended to `CREATE TABLE` (e.g. `"STRICT"` on SQLite). */
  readonly options: string | undefined;
}

export interface TableOptions {
  /**
   * The primary key column `create` adds: `id bigserial` by default, `false`
   * for none (Ecto's `:primary_key`).
   */
  readonly primaryKey?:
    | boolean
    | { readonly name?: string; readonly type?: ColumnType };
  readonly options?: string;
}

/** A table, for `create`, `alter`, `drop` and `rename` (Ecto's `table/2`). */
export function table(name: string, options: TableOptions = {}): Table {
  const { primaryKey = true } = options;
  return Object.freeze({
    kind: "table",
    name,
    primaryKey:
      primaryKey === false
        ? null
        : {
            name: (primaryKey === true ? undefined : primaryKey.name) ?? "id",
            type:
              (primaryKey === true ? undefined : primaryKey.type) ??
              "bigserial",
          },
    options: options.options,
  });
}

export interface Index {
  readonly kind: "index";
  readonly table: string;
  /** Column names (quoted) or SQL expressions (used as is), e.g. `"lower(email)"`. */
  readonly columns: readonly string[];
  readonly name: string;
  readonly unique: boolean;
  readonly where: string | undefined;
  readonly using: string | undefined;
  readonly include: readonly string[];
  readonly nullsDistinct: boolean | undefined;
}

export interface IndexOptions {
  /** Defaults to `<table>_<columns>_index`. */
  readonly name?: string;
  readonly unique?: boolean;
  /** A partial index's condition. */
  readonly where?: string;
  /** The index method (PostgreSQL), e.g. `"gin"`. */
  readonly using?: string;
  /** Columns stored in the index (PostgreSQL `INCLUDE`). */
  readonly include?: readonly string[];
  /** PostgreSQL 15+ `NULLS [NOT] DISTINCT`. */
  readonly nullsDistinct?: boolean;
}

// Ecto's `column_name/1`: non-word characters become "_", trailing ones go.
const indexNamePart = (column: string) =>
  column.replace(/[^\w]/g, "_").replace(/_+$/, "");

/** An index (Ecto's `index/3`). */
export function index(
  table: string,
  columns: string | readonly string[],
  options: IndexOptions = {},
): Index {
  const list = typeof columns === "string" ? [columns] : [...columns];
  return Object.freeze({
    kind: "index",
    table,
    columns: Object.freeze(list),
    name:
      options.name ?? [table, ...list, "index"].map(indexNamePart).join("_"),
    unique: options.unique ?? false,
    where: options.where,
    using: options.using,
    include: Object.freeze([...(options.include ?? [])]),
    nullsDistinct: options.nullsDistinct,
  });
}

/** A unique index (Ecto's `unique_index/3`). */
export function uniqueIndex(
  table: string,
  columns: string | readonly string[],
  options: Omit<IndexOptions, "unique"> = {},
): Index {
  return index(table, columns, { ...options, unique: true });
}

export type OnDelete =
  | "nothing"
  | "deleteAll"
  | "nilifyAll"
  | "defaultAll"
  | "restrict";
export type OnUpdate = "nothing" | "updateAll" | "nilifyAll" | "restrict";

export interface Reference {
  readonly kind: "reference";
  readonly table: string;
  readonly column: string;
  /** The column type; serial types become their integer type. */
  readonly type: ColumnType;
  /** The constraint name; defaults to `<table>_<column>_fkey`. */
  readonly name: string | undefined;
  readonly onDelete: OnDelete;
  readonly onUpdate: OnUpdate;
  /** `false` adds the constraint `NOT VALID` (PostgreSQL). */
  readonly validate: boolean;
}

export interface ReferenceOptions {
  /** The referenced column, `id` by default. */
  readonly column?: string;
  /** Defaults to `bigserial`, as the default primary key. */
  readonly type?: ColumnType;
  readonly name?: string;
  readonly onDelete?: OnDelete;
  readonly onUpdate?: OnUpdate;
  readonly validate?: boolean;
}

const ON_DELETE = [
  "nothing",
  "deleteAll",
  "nilifyAll",
  "defaultAll",
  "restrict",
];
const ON_UPDATE = ["nothing", "updateAll", "nilifyAll", "restrict"];

/** A foreign key column type, for `add` and `modify` (Ecto's `references/2`). */
export function references(
  table: string,
  options: ReferenceOptions = {},
): Reference {
  const { onDelete = "nothing", onUpdate = "nothing" } = options;
  if (!ON_DELETE.includes(onDelete))
    throw new TypeError(`unknown onDelete value: ${JSON.stringify(onDelete)}`);
  if (!ON_UPDATE.includes(onUpdate))
    throw new TypeError(`unknown onUpdate value: ${JSON.stringify(onUpdate)}`);
  return Object.freeze({
    kind: "reference",
    table,
    column: options.column ?? "id",
    type: options.type ?? "bigserial",
    name: options.name,
    onDelete,
    onUpdate,
    validate: options.validate ?? true,
  });
}

export interface Constraint {
  readonly kind: "constraint";
  readonly table: string;
  readonly name: string;
  readonly check: string | undefined;
  readonly exclude: string | undefined;
  readonly validate: boolean;
}

export interface ConstraintOptions {
  /** A check constraint's condition. */
  readonly check?: string;
  /** An exclusion constraint (PostgreSQL), after `EXCLUDE USING`. */
  readonly exclude?: string;
  /** `false` adds the constraint `NOT VALID` (PostgreSQL). */
  readonly validate?: boolean;
}

/** A check or exclusion constraint (Ecto's `constraint/3`). */
export function constraint(
  table: string,
  name: string,
  options: ConstraintOptions,
): Constraint {
  if ((options.check === undefined) === (options.exclude === undefined))
    throw new TypeError(
      `constraint ${name} expects exactly one of the check or exclude options`,
    );
  return Object.freeze({
    kind: "constraint",
    table,
    name,
    check: options.check,
    exclude: options.exclude,
    validate: options.validate ?? true,
  });
}

/** SQL used as is, e.g. as a column default (Ecto's `fragment/1`). */
export function fragment(sql: string): Fragment {
  return Object.freeze({ kind: "fragment", sql });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type ColumnChange =
  | {
      readonly op: "add" | "addIfNotExists";
      readonly name: string;
      readonly type: ColumnType | Reference;
      readonly options: ColumnOptions;
    }
  | {
      readonly op: "modify";
      readonly name: string;
      readonly type: ColumnType | Reference;
      readonly options: ModifyOptions;
    }
  | {
      readonly op: "remove";
      readonly name: string;
      /** Known when given, which makes the removal reversible. */
      readonly type: ColumnType | Reference | undefined;
      readonly options: ColumnOptions;
    }
  | {
      readonly op: "removeIfExists";
      readonly name: string;
      readonly type: ColumnType | Reference | undefined;
    };

export type DropMode = "restrict" | "cascade";

/** A schema change, which the adapter turns into SQL (`Adapter.ddl`). */
export type DdlCommand =
  | {
      readonly command: "create" | "createIfNotExists";
      readonly object: Table;
      readonly columns: readonly ColumnChange[];
    }
  | {
      readonly command: "create" | "createIfNotExists";
      readonly object: Index | Constraint;
    }
  | {
      readonly command: "drop" | "dropIfExists";
      readonly object: Table | Index | Constraint;
      readonly mode: DropMode;
    }
  | {
      readonly command: "alter";
      readonly object: Table;
      readonly changes: readonly ColumnChange[];
    }
  | {
      readonly command: "renameTable";
      readonly object: Table;
      readonly to: Table;
    }
  | {
      readonly command: "renameColumn";
      readonly object: Table;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly command: "renameIndex";
      readonly object: Index;
      readonly to: string;
    }
  | { readonly command: "execute"; readonly sql: string };

/** SQL, or a function given the migration's Kysely handle (a transaction). */
// biome-ignore lint/suspicious/noExplicitAny: any database
export type Executable = string | ((db: Kysely<any>) => Promise<void>);

/** A recorded migration command. */
export type Command =
  | DdlCommand
  | {
      readonly command: "executeReversible";
      readonly up: Executable;
      readonly down: Executable | undefined;
    };

// ---------------------------------------------------------------------------
// The migration context
// ---------------------------------------------------------------------------

export interface TimestampsOptions extends ColumnOptions {
  /** `utc_datetime` by default, as `t.timestamps()` in schemas. */
  readonly type?: ColumnType;
  readonly insertedAt?: string | false;
  readonly updatedAt?: string | false;
}

/** Column changes inside `create` (only `add` and `timestamps`) or `alter`. */
export interface TableBuilder {
  /** Adds a column (Ecto's `add/3`). */
  add(
    name: string,
    type: ColumnType | Reference,
    options?: ColumnOptions,
  ): void;
  /** Adds a column if it does not exist yet (`alter` only). */
  addIfNotExists(
    name: string,
    type: ColumnType | Reference,
    options?: ColumnOptions,
  ): void;
  /**
   * Changes a column's type and options (`alter` only). Reversible when
   * `from` says what the column was.
   */
  modify(
    name: string,
    type: ColumnType | Reference,
    options?: ModifyOptions,
  ): void;
  /** Removes a column (`alter` only); reversible when the type is given. */
  remove(
    name: string,
    type?: ColumnType | Reference,
    options?: ColumnOptions,
  ): void;
  /** Removes a column if it exists (`alter` only). */
  removeIfExists(name: string, type?: ColumnType | Reference): void;
  /** Adds `inserted_at` and `updated_at`, `NOT NULL` (Ecto's `timestamps/1`). */
  timestamps(options?: TimestampsOptions): void;
}

export interface DropOptions {
  readonly mode?: DropMode;
}

/** What a migration's `change`, `up` and `down` receive. */
export interface MigrationContext {
  /** `"up"` when migrating, `"down"` when rolling back. */
  readonly direction: "up" | "down";
  /** Creates a table with its primary key and the columns `fn` adds. */
  create(table: Table, fn?: (t: TableBuilder) => void): void;
  create(object: Index | Constraint): void;
  createIfNotExists(table: Table, fn?: (t: TableBuilder) => void): void;
  createIfNotExists(object: Index): void;
  alter(table: Table, fn: (t: TableBuilder) => void): void;
  drop(object: Table | Index | Constraint, options?: DropOptions): void;
  dropIfExists(object: Table | Index | Constraint, options?: DropOptions): void;
  rename(object: Table, options: { readonly to: Table }): void;
  rename(object: Index, options: { readonly to: string }): void;
  rename(object: Table, column: string, options: { readonly to: string }): void;
  /**
   * Runs SQL or a function. In `change`, give `down` too, or the migration
   * cannot be rolled back (Ecto's `execute/1` and `execute/2`).
   */
  execute(up: Executable, down?: Executable): void;
}

const isReference = (type: unknown): type is Reference =>
  typeof type === "object" &&
  type !== null &&
  (type as { kind?: unknown }).kind === "reference";

function tableBuilder(inCreate: boolean): {
  builder: TableBuilder;
  changes: ColumnChange[];
} {
  const changes: ColumnChange[] = [];
  const alterOnly = (op: string) => {
    if (inCreate)
      throw new TypeError(`${op} can only be used in alter, not create`);
  };
  const builder: TableBuilder = {
    add(name, type, options = {}) {
      changes.push({ op: "add", name, type, options });
    },
    addIfNotExists(name, type, options = {}) {
      alterOnly("addIfNotExists");
      changes.push({ op: "addIfNotExists", name, type, options });
    },
    modify(name, type, options = {}) {
      alterOnly("modify");
      changes.push({ op: "modify", name, type, options });
    },
    remove(name, type, options = {}) {
      alterOnly("remove");
      changes.push({ op: "remove", name, type, options });
    },
    removeIfExists(name, type) {
      alterOnly("removeIfExists");
      changes.push({ op: "removeIfExists", name, type });
    },
    timestamps(options = {}) {
      const {
        type = "utc_datetime",
        insertedAt = "inserted_at",
        updatedAt = "updated_at",
        ...rest
      } = options;
      const columnOptions = { null: false, ...rest };
      if (insertedAt !== false) builder.add(insertedAt, type, columnOptions);
      if (updatedAt !== false) builder.add(updatedAt, type, columnOptions);
    },
  };
  return { builder, changes };
}

/** Runs a migration function and returns the commands it recorded. */
export function record(
  direction: "up" | "down",
  fn: (m: MigrationContext) => void,
): Command[] {
  const commands: Command[] = [];
  const createTable = (
    command: "create" | "createIfNotExists",
    table: Table,
    fn: ((t: TableBuilder) => void) | undefined,
  ) => {
    const { builder, changes } = tableBuilder(true);
    if (table.primaryKey)
      builder.add(table.primaryKey.name, table.primaryKey.type, {
        primaryKey: true,
      });
    fn?.(builder);
    commands.push({ command, object: table, columns: changes });
  };
  const context: MigrationContext = {
    direction,
    create(object: Table | Index | Constraint, fn?: (t: TableBuilder) => void) {
      if (object.kind === "table") createTable("create", object, fn);
      else commands.push({ command: "create", object });
    },
    createIfNotExists(object: Table | Index, fn?: (t: TableBuilder) => void) {
      if (object.kind === "table") createTable("createIfNotExists", object, fn);
      else commands.push({ command: "createIfNotExists", object });
    },
    alter(table, fn) {
      const { builder, changes } = tableBuilder(false);
      fn(builder);
      commands.push({ command: "alter", object: table, changes });
    },
    drop(object, options = {}) {
      commands.push({
        command: "drop",
        object,
        mode: options.mode ?? "restrict",
      });
    },
    dropIfExists(object, options = {}) {
      commands.push({
        command: "dropIfExists",
        object,
        mode: options.mode ?? "restrict",
      });
    },
    rename(
      object: Table | Index,
      columnOrOptions: string | { readonly to: Table | string },
      options?: { readonly to: string },
    ) {
      if (typeof columnOrOptions === "string") {
        if (object.kind !== "table" || options === undefined)
          throw new TypeError("rename(table, column, { to }) expects a table");
        commands.push({
          command: "renameColumn",
          object,
          from: columnOrOptions,
          to: options.to,
        });
      } else if (object.kind === "table") {
        const { to } = columnOrOptions;
        if (typeof to === "string")
          throw new TypeError("rename(table, { to }) expects to: table(...)");
        commands.push({ command: "renameTable", object, to });
      } else {
        const { to } = columnOrOptions;
        if (typeof to !== "string")
          throw new TypeError("rename(index, { to }) expects the new name");
        commands.push({ command: "renameIndex", object, to });
      }
    },
    execute(up, down) {
      commands.push(
        typeof up === "string" && down === undefined
          ? { command: "execute", sql: up }
          : { command: "executeReversible", up, down },
      );
    },
  } as MigrationContext;
  fn(context);
  return commands;
}

/** Describes a command for error messages (Ecto's `command/1`). */
export function describe(command: Command): string {
  switch (command.command) {
    case "execute":
      return `execute ${JSON.stringify(command.sql)}`;
    case "executeReversible":
      return "execute";
    case "alter":
      return `alter table ${command.object.name}`;
    case "renameTable":
      return `rename table ${command.object.name} to ${command.to.name}`;
    case "renameColumn":
      return `rename column ${command.from} to ${command.to} on table ${command.object.name}`;
    case "renameIndex":
      return `rename index ${command.object.name} to ${command.to}`;
    default: {
      const verb = command.command.replace(
        /[A-Z]/g,
        (c) => ` ${c.toLowerCase()}`,
      );
      const object = command.object;
      const what =
        object.kind === "index"
          ? `${object.unique ? "unique index" : "index"} ${object.name}`
          : `${object.kind} ${object.name}`;
      return `${verb} ${what}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Reversal (Ecto.Migration.Runner's reverse/1)
// ---------------------------------------------------------------------------

function reverseChanges(
  changes: readonly ColumnChange[],
): ColumnChange[] | undefined {
  const reversed: ColumnChange[] = [];
  for (const change of changes) {
    switch (change.op) {
      case "remove":
        if (change.type === undefined) return undefined;
        reversed.unshift({
          op: "add",
          name: change.name,
          type: change.type,
          options: change.options,
        });
        break;
      case "add":
        reversed.unshift({
          op: "remove",
          name: change.name,
          type: change.type,
          options: {},
        });
        break;
      case "modify": {
        const { from, ...options } = change.options;
        if (from === undefined) return undefined;
        const [type, fromOptions] =
          typeof from === "object" && !Array.isArray(from) && !isReference(from)
            ? (() => {
                const { type, ...rest } = from as {
                  type: ColumnType | Reference;
                } & ColumnOptions;
                return [type, rest] as const;
              })()
            : [from as ColumnType | Reference, options];
        reversed.unshift({
          op: "modify",
          name: change.name,
          type,
          options: {
            ...fromOptions,
            from: { type: change.type, ...options },
          },
        });
        break;
      }
      default:
        return undefined;
    }
  }
  return reversed;
}

/** The command that undoes `command`, or `undefined` when there is none. */
export function reverse(command: Command): Command | undefined {
  switch (command.command) {
    case "create":
    case "createIfNotExists": {
      const drop = command.command === "create" ? "drop" : "dropIfExists";
      return { command: drop, object: command.object, mode: "restrict" };
    }
    case "drop":
    case "dropIfExists": {
      // Dropped indexes can be recreated from their definition; tables and
      // constraints cannot.
      if (command.object.kind !== "index") return undefined;
      const create =
        command.command === "drop" ? "create" : "createIfNotExists";
      return { command: create, object: command.object };
    }
    case "renameTable":
      return { command: "renameTable", object: command.to, to: command.object };
    case "renameColumn":
      return { ...command, from: command.to, to: command.from };
    case "renameIndex":
      return {
        command: "renameIndex",
        object: { ...command.object, name: command.to },
        to: command.object.name,
      };
    case "alter": {
      const changes = reverseChanges(command.changes);
      return changes && { command: "alter", object: command.object, changes };
    }
    case "executeReversible":
      return command.down === undefined
        ? undefined
        : { command: "executeReversible", up: command.down, down: command.up };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const MIGRATION = Symbol.for("ekto.migration");

/** How a migration runs (Ecto's `@disable_ddl_transaction` and `@disable_migration_lock`). */
export interface MigrationRunOptions {
  /**
   * Runs the migration outside a transaction, for commands that cannot run
   * in one, such as `CREATE INDEX CONCURRENTLY` on PostgreSQL.
   */
  readonly disableDdlTransaction?: boolean;
  /** Runs the migration without holding the migration lock. */
  readonly disableMigrationLock?: boolean;
}

export type MigrationDefinition = MigrationRunOptions &
  (
    | { readonly change: (m: MigrationContext) => void }
    | {
        readonly up: (m: MigrationContext) => void;
        readonly down?: (m: MigrationContext) => void;
      }
  );

export interface Migration {
  readonly [MIGRATION]: true;
  readonly disableDdlTransaction: boolean;
  readonly disableMigrationLock: boolean;
  /** The commands to run when migrating. */
  up(): Command[];
  /** The commands to run when rolling back, or `undefined` when irreversible. */
  readonly down: (() => Command[]) | undefined;
}

/** Thrown when a migration cannot be rolled back (Ecto.MigrationError). */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Defines a migration. Write `change` when every command can be reversed
 * (rollback runs the reversed commands in reverse order), or `up` and
 * `down`. Migrations describe tables, never schemas: they must keep working
 * after the schemas change.
 *
 * ```ts
 * export default migration({
 *   change(m) {
 *     m.create(table("users"), (t) => {
 *       t.add("email", "string", { null: false });
 *       t.timestamps();
 *     });
 *     m.create(uniqueIndex("users", ["email"]));
 *   },
 * });
 * ```
 */
export function migration(definition: MigrationDefinition): Migration {
  const runOptions = {
    [MIGRATION]: true as const,
    disableDdlTransaction: definition.disableDdlTransaction === true,
    disableMigrationLock: definition.disableMigrationLock === true,
  };
  if ("change" in definition) {
    const { change } = definition;
    return Object.freeze({
      ...runOptions,
      up: () => record("up", change),
      down: () =>
        record("down", change)
          .reverse()
          .map((command) => {
            const reversed = reverse(command);
            if (reversed === undefined)
              throw new MigrationError(
                `cannot reverse migration command: ${describe(command)}. ` +
                  "You will need to explicitly define up and down in your migration",
              );
            return reversed;
          }),
    });
  }
  const { up, down } = definition;
  return Object.freeze({
    ...runOptions,
    up: () => record("up", up),
    down: down && (() => record("down", down)),
  });
}

/** Whether `value` was created by `migration()`. */
export function isMigration(value: unknown): value is Migration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [MIGRATION]?: unknown })[MIGRATION] === true
  );
}
