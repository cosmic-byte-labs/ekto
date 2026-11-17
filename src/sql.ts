/**
 * Raw SQL: the `sql` template tag (ekto's `fragment`) and `Queryable`, the
 * `{ sql, params }` shape the Repo runs.
 *
 * Interpolated values are always bound as parameters, never spliced into the
 * text:
 *
 * ```ts
 * sql`select * from users where lower(email) = ${email.toLowerCase()}`
 * ```
 *
 * A `sql` value is dialect-neutral: placeholders (`$1` on PostgreSQL, `?` on
 * SQLite) and identifier quoting are only decided when the Repo compiles it.
 */

/** Already compiled SQL with its parameters; any query builder can produce one. */
export interface Queryable<Row = unknown> {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Type only: the row type the query returns. */
  readonly __row?: Row;
}

/** Whether `value` looks like a `Queryable` (`{ sql: string, params: array }`). */
export function isQueryable(value: unknown): value is Queryable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Queryable).sql === "string" &&
    Array.isArray((value as Queryable).params)
  );
}

/** How a dialect writes placeholders and identifiers. */
export interface SqlSyntax {
  /** The placeholder of the parameter at `index` (0-based). */
  placeholder(index: number): string;
  /** `name` quoted as an identifier. */
  quoteIdentifier(name: string): string;
}

type Part =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "identifier"; readonly name: string };

/** A piece of SQL with bound values, built with the `sql` tag. */
export class Sql<Row = unknown> {
  readonly parts: readonly Part[];
  /** Type only: the row type the query returns. */
  declare readonly __row?: Row;

  constructor(parts: readonly Part[]) {
    this.parts = Object.freeze([...parts]);
    Object.freeze(this);
  }

  /** The SQL text and parameters for a dialect. */
  compile(syntax: SqlSyntax): Queryable<Row> {
    let text = "";
    const params: unknown[] = [];
    for (const part of this.parts) {
      if (part.kind === "text") text += part.text;
      else if (part.kind === "identifier")
        text += syntax.quoteIdentifier(part.name);
      else {
        text += syntax.placeholder(params.length);
        params.push(part.value);
      }
    }
    return { sql: text, params };
  }
}

/** An identifier (table or column name) to quote, see `sql.identifier`. */
class Identifier {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

/** Values to bind as a comma-separated list, see `sql.splice`. */
class Splice {
  readonly values: readonly unknown[];
  constructor(values: readonly unknown[]) {
    this.values = values;
  }
}

function partsOf(value: unknown): Part[] {
  if (value instanceof Sql) return [...value.parts];
  if (value instanceof Identifier)
    return [{ kind: "identifier", name: value.name }];
  if (value instanceof Splice) {
    return value.values.flatMap((item, i) => [
      ...(i > 0 ? [{ kind: "text", text: ", " } as const] : []),
      ...partsOf(item),
    ]);
  }
  if (value === undefined) {
    // Almost always a bug (a missing property); bind `null` explicitly.
    throw new TypeError("cannot bind undefined in sql; use null");
  }
  return [{ kind: "value", value }];
}

function tag<Row = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Sql<Row> {
  const parts: Part[] = [];
  strings.forEach((text, i) => {
    if (text !== "") parts.push({ kind: "text", text });
    if (i < values.length) parts.push(...partsOf(values[i]));
  });
  return new Sql<Row>(parts);
}

/**
 * Raw SQL with bound values (Ecto's `fragment`). Interpolated values become
 * parameters; interpolated `sql` values are inlined, so fragments compose.
 * The type argument is the row type, for `Repo.all` and `Repo.query`:
 *
 * ```ts
 * const adults = sql`age >= ${18}`;
 * await Repo.query(sql<{ n: number }>`select count(*) as n from users where ${adults}`);
 * ```
 */
export const sql: typeof tag & {
  /**
   * A table or column name, quoted for the dialect (Ecto's `identifier/1`).
   * Only for names you trust: quoting does not make user input safe to use
   * as a name.
   */
  identifier(name: string): Identifier;
  /**
   * Binds each value as a parameter, separated by commas (Ecto's `splice/1`):
   * `sql\`id in (${sql.splice(ids)})\``. Throws on an empty list, which would
   * be invalid SQL.
   */
  splice(values: readonly unknown[]): Splice;
} = Object.assign(tag, {
  identifier(name: string): Identifier {
    if (name === "" || name.includes("\0")) {
      throw new TypeError(`invalid identifier: ${JSON.stringify(name)}`);
    }
    return new Identifier(name);
  },
  splice(values: readonly unknown[]): Splice {
    if (values.length === 0)
      throw new TypeError("sql.splice needs at least one value");
    return new Splice([...values]);
  },
});

/** Quotes an identifier with double quotes, doubling any inside (standard SQL). */
export function quoteIdentifierAnsi(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
