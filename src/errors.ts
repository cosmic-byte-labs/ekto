/**
 * Errors Repo throws, modelled on Ecto's exceptions (`Ecto.StaleEntryError`,
 * `Ecto.NoResultsError`, …). Expected failures (invalid changesets,
 * constraint violations the changeset declares) are returned, not thrown.
 */

import { inspect } from "node:util";
import type { Action, AnyChangeset, ConstraintType } from "./changeset.ts";

/**
 * An update or delete matched no row: the record was deleted, or a filter
 * such as an optimistic lock no longer matches (Ecto.StaleEntryError).
 */
export class StaleEntryError extends Error {
  readonly action: Action;
  readonly changeset: AnyChangeset;

  constructor(action: Action, changeset: AnyChangeset) {
    super(
      `attempted to ${action} a stale entry; the row may have been changed or deleted`,
    );
    this.name = "StaleEntryError";
    this.action = action;
    this.changeset = changeset;
  }
}

/** A write by primary key was attempted on a schema without one (Ecto.NoPrimaryKeyFieldError). */
export class NoPrimaryKeyFieldError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(`schema ${source} has no primary key`);
    this.name = "NoPrimaryKeyFieldError";
    this.source = source;
  }
}

/** A record without a primary key value was updated or deleted (Ecto.NoPrimaryKeyValueError). */
export class NoPrimaryKeyValueError extends Error {
  readonly record: object;

  constructor(record: object) {
    super("record is missing its primary key value");
    this.name = "NoPrimaryKeyValueError";
    this.record = record;
  }
}

/** A changed value could not be dumped for the database (Ecto.ChangeError). */
export class ChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeError";
  }
}

/** A query expected to return a result returned none (Ecto.NoResultsError). */
export class NoResultsError extends Error {
  readonly sql: string;

  constructor(sql: string) {
    super(`expected at least one result but got none in query:\n\n${sql}`);
    this.name = "NoResultsError";
    this.sql = sql;
  }
}

/** A query expected to return at most one result returned more (Ecto.MultipleResultsError). */
export class MultipleResultsError extends Error {
  readonly sql: string;
  readonly count: number;

  constructor(sql: string, count: number) {
    super(`expected at most one result but got ${count} in query:\n\n${sql}`);
    this.name = "MultipleResultsError";
    this.sql = sql;
    this.count = count;
  }
}

/**
 * A write touched more than one row when one was expected, so the primary
 * key does not identify a single row (Ecto.MultiplePrimaryKeyError).
 */
export class MultiplePrimaryKeyError extends Error {
  readonly source: string;
  readonly count: number;

  constructor(action: Action, source: string, count: number) {
    super(
      `expected ${action} on ${source} to affect one row, got ${count}; ` +
        "the primary key does not identify a single row",
    );
    this.name = "MultiplePrimaryKeyError";
    this.source = source;
    this.count = count;
  }
}

/**
 * The database reported a constraint violation the changeset did not
 * declare (Ecto.ConstraintError). Declare it, e.g. with `uniqueConstraint`,
 * to get a changeset error instead. Writes through `Repo.exec` have no
 * changeset, so their violations are always thrown.
 */
export class ConstraintError extends Error {
  readonly type: ConstraintType;
  readonly constraint: string;

  constructor(
    action: string,
    type: ConstraintType,
    constraint: string,
    changeset: AnyChangeset | undefined,
  ) {
    const fn = constraintFunction(type);
    let advice: string;
    if (changeset === undefined) {
      advice =
        "The write bypassed changesets (Repo.exec). Write through a changeset\n" +
        `and call \`${fn}\` on it to get a changeset error instead.`;
    } else {
      const declared =
        changeset.constraints.length === 0
          ? "The changeset has not defined any constraint."
          : `The changeset defined the following constraints:\n\n${changeset.constraints
              .map(
                (c) =>
                  `    * ${inspect(c.constraint)} (${constraintFunction(c.type)})`,
              )
              .join("\n")}`;
      advice =
        "If you would like to stop this constraint violation from raising an\n" +
        "exception and instead add it as an error to your changeset, please\n" +
        `call \`${fn}\` on your changeset with the constraint name as the\n` +
        "`name` option.\n\n" +
        declared;
    }
    super(
      `constraint error when attempting to ${action} record:\n\n` +
        `    * ${inspect(constraint)} (${fn})\n\n` +
        advice,
    );
    this.name = "ConstraintError";
    this.type = type;
    this.constraint = constraint;
  }
}

/**
 * Rows a query returned for a schema lack some of its persisted columns, so
 * they cannot be loaded as records of it (`Repo.all(Schema, query)`).
 */
export class SchemaMismatchError extends Error {
  readonly source: string;
  readonly missing: readonly string[];

  constructor(source: string, missing: readonly string[], hint = "") {
    super(
      `the query for schema ${source} did not return the columns ${missing.join(", ")}; ` +
        `select all of the schema's columns (e.g. \`selectAll("${source}")\`)${hint}`,
    );
    this.name = "SchemaMismatchError";
    this.source = source;
    this.missing = missing;
  }
}

function constraintFunction(type: ConstraintType): string {
  return {
    unique: "uniqueConstraint",
    foreign_key: "foreignKeyConstraint",
    check: "checkConstraint",
    exclusion: "exclusionConstraint",
  }[type];
}
