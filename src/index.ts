// Public entry point of ekto.

export type {
  Adapter,
  ConstraintViolation,
  QueryEvent,
  QueryResult,
} from "./adapter.ts";
export * from "./changeset.ts";
export {
  ChangeError,
  ConstraintError,
  MultiplePrimaryKeyError,
  MultipleResultsError,
  NoPrimaryKeyFieldError,
  NoPrimaryKeyValueError,
  NoResultsError,
  SchemaMismatchError,
  StaleEntryError,
} from "./errors.ts";
export type {
  DriverTypes,
  DriverValue,
  DriverValueOf,
  KyselyColumn,
  KyselyTable,
  KyselyTables,
} from "./kysely.ts";
export {
  createRepo,
  type DeleteOptions,
  type ExecResult,
  type InsertOptions,
  type Query,
  type QueryRows,
  type Repo,
  type RepoConfig,
  type RowOf,
  type SchemaQuery,
  type UpdateOptions,
  type WriteResult,
} from "./repo.ts";
export {
  type AnyField,
  type AnySchema,
  type DefaultFlags,
  Field,
  type FieldFlags,
  type FieldName,
  type FieldOptions,
  type Fields,
  getMeta,
  type Infer,
  isSchema,
  type Loader,
  load,
  type Meta,
  meta,
  type New,
  putMeta,
  type RecordState,
  type Schema,
  schema,
  t,
  type ValueOfField,
} from "./schema.ts";
export {
  isQueryable,
  type Queryable,
  Sql,
  type SqlSyntax,
  sql,
} from "./sql.ts";
/** The built-in types, for use in custom types and schemaless changesets. */
export * as types from "./type.ts";
export {
  type BaseType,
  CastError,
  type CastErrorMeta,
  type CastResult,
  castValue,
  castValueOrThrow,
  dumpValue,
  equalValues,
  error,
  loadValue,
  ok,
  type PrimitiveType,
  type Type,
  type ValueOf,
} from "./type.ts";
