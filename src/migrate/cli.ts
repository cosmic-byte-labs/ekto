/**
 * The `ekto` command: `ekto migrate`, `ekto rollback`, `ekto status`,
 * `ekto gen.migration <name>` (Ecto's `mix ecto.migrate`, `ecto.rollback`,
 * `ecto.migrations` and `ecto.gen.migration`), `ekto gen.schema`
 * (Phoenix's `mix phx.gen.schema`) and `ekto gen.schemas`, which writes
 * schemas for an existing database's tables.
 *
 * The configuration file (`ekto.config.ts` or `ekto.config.js`, or
 * `--config`) default-exports an `EktoConfig`, or a function returning it.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { MigrationLockStrategy } from "../adapter.ts";
import { createRepo, type RepoConfig } from "../repo.ts";
import {
  generate,
  generateSchema,
  generateSchemas,
  type Language,
  type MigrationFormat,
  parseAttrs,
} from "./gen.ts";
import { createMigrator, fileMigrations } from "./runner.ts";

export { generate };

export interface EktoConfig {
  /**
   * The Repo's configuration, e.g. `{ adapter: postgres(), url }`; the
   * commands start the Repo themselves, as Ecto's mix tasks do.
   */
  readonly repo: RepoConfig;
  /** `migrations` by default, relative to the working directory. */
  readonly migrationsFolder?: string;
  /** The table of executed versions, `schema_migrations` by default. */
  readonly migrationSource?: string;
  /**
   * Whether and how to lock while migrating, `true` (a table lock) by
   * default, or `"pgAdvisoryLock"`; see `MigratorOptions.migrationLock`.
   */
  readonly migrationLock?: boolean | MigrationLockStrategy;
  /** With `"pgAdvisoryLock"`, the wait before trying again, 5000 ms by default. */
  readonly migrationAdvisoryLockRetryIntervalMs?: number;
  /** With `"pgAdvisoryLock"`, how many times to try again, `Infinity` by default. */
  readonly migrationAdvisoryLockMaxTries?: number;
  /** Where `gen.schema` writes schemas, `src/schemas` by default. */
  readonly schemasFolder?: string;
  /** The migrations `gen.schema` writes: `ekto` (the default), `kysely` or `none`. */
  readonly migrationFormat?: MigrationFormat;
  /**
   * Whether `gen.schema` gives schemas a UUID primary key and references,
   * `false` by default (Phoenix's `generators: [binary_id: true]`);
   * `--binary-id` and `--no-binary-id` override it.
   */
  readonly binaryId?: boolean;
  /**
   * The language of the files the generators write, `"ts"` (the default) or
   * `"js"`; `--js` and `--ts` override it.
   */
  readonly language?: Language;
}

const USAGE = `usage: ekto <command> [options]

commands:
  migrate               run pending migrations, all by default
  rollback              roll back migrations, the last one by default
  status                list migrations and whether they ran
  gen.migration <name>  create a migration file
  gen.schema <Name> <table> [field:type[:unique]...]
                        create a schema and its migration, e.g.
                        gen.schema Post posts title body:text user_id:references:users
  gen.schemas [table[:Name]...]
                        create schemas for the database's tables, all by default

options:
  --all                 run (or roll back) every migration
  --step N              run (or roll back) N migrations
  --to VERSION          run up to (or roll back down to) VERSION, inclusive
  --to-exclusive VERSION  as --to, without VERSION itself
  --no-lock             do not lock the migrations table
  --pool-size N         migrate, rollback and status: the Repo's pool size (default 2)
  --config FILE         configuration file (default: ekto.config.ts or .js)
  --migrations DIR      migrations folder (overrides the configuration)
  --schemas DIR         schemas folder, for gen.schema (overrides the configuration)
  --migration FORMAT    gen.schema's migration: ekto, kysely or none
  --no-migration        as --migration none
  --binary-id           gen.schema: UUID primary key and references
  --no-binary-id        gen.schema: bigserial primary key (overrides the configuration)
  --js                  gen.*: write JavaScript files (or language: "js" in the config)
  --ts                  gen.*: write TypeScript files (overrides the configuration)
`;

async function loadConfig(path: string | undefined): Promise<EktoConfig> {
  const candidates = path
    ? [path]
    : [
        "ekto.config.ts",
        "ekto.config.mts",
        "ekto.config.js",
        "ekto.config.mjs",
      ];
  const file = candidates.map((c) => resolve(c)).find((c) => existsSync(c));
  if (file === undefined)
    throw new Error(
      path
        ? `configuration file ${path} not found`
        : "no ekto.config.ts or ekto.config.js in the working directory (use --config)",
    );
  const module = await import(pathToFileURL(file).href);
  const config = module.default;
  const resolved: EktoConfig =
    typeof config === "function" ? await config() : config;
  if (!resolved?.repo?.adapter)
    throw new Error(
      `${file} must default-export { repo: { adapter, ... } } or a function returning it`,
    );
  return resolved;
}

const pad = (s: string, n: number) => s.padEnd(n);

/** Runs the command line `args`; returns the exit code. */
export async function main(
  args: readonly string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      config: { type: "string" },
      migrations: { type: "string" },
      step: { type: "string" },
      to: { type: "string" },
      "to-exclusive": { type: "string" },
      all: { type: "boolean" },
      "no-lock": { type: "boolean" },
      "pool-size": { type: "string" },
      schemas: { type: "string" },
      migration: { type: "string" },
      "no-migration": { type: "boolean" },
      "binary-id": { type: "boolean" },
      "no-binary-id": { type: "boolean" },
      js: { type: "boolean" },
      ts: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.js && values.ts)
    throw new Error("expected --js or --ts, not both");
  const languageOf = (config: EktoConfig | undefined): Language => {
    if (values.js) return "js";
    if (values.ts) return "ts";
    const language = config?.language ?? "ts";
    if (language !== "ts" && language !== "js")
      throw new Error(
        `expected the language "ts" or "js" in the configuration, got ${JSON.stringify(language)}`,
      );
    return language;
  };
  if (values.help || command === undefined) {
    out(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const number = (name: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value))
      throw new Error(`--${name} expects a number, got ${value}`);
    return Number(value);
  };
  const strategy = {
    ...(values.all && { all: true }),
    ...(values.step !== undefined && { step: number("step", values.step) }),
    ...(values.to !== undefined && { to: number("to", values.to) }),
    ...(values["to-exclusive"] !== undefined && {
      toExclusive: number("to-exclusive", values["to-exclusive"]),
    }),
  };

  if (command === "gen.migration" || command === "gen.schema") {
    // The configuration is optional: generating needs no database.
    let config: EktoConfig | undefined;
    try {
      config = await loadConfig(values.config);
    } catch (error) {
      if (values.config !== undefined) throw error;
    }
    const migrationsFolder =
      values.migrations ?? config?.migrationsFolder ?? "migrations";
    const language = languageOf(config);
    let files: string[];
    if (command === "gen.migration") {
      if (rest.length !== 1)
        throw new Error("usage: ekto gen.migration <name>");
      files = [
        await generate(migrationsFolder, rest[0] as string, { language }),
      ];
    } else {
      const [name, table, ...attrs] = rest;
      if (name === undefined || table === undefined)
        throw new Error(
          "usage: ekto gen.schema <Name> <table> [field:type[:unique]...]",
        );
      const binaryId = values["binary-id"]
        ? true
        : values["no-binary-id"]
          ? false
          : (config?.binaryId ?? false);
      files = await generateSchema(
        { name, table, attrs: parseAttrs(attrs, { binaryId }), binaryId },
        {
          schemasFolder:
            values.schemas ?? config?.schemasFolder ?? "src/schemas",
          migrationsFolder,
          migration: values["no-migration"]
            ? "none"
            : ((values.migration as MigrationFormat | undefined) ??
              config?.migrationFormat ??
              "ekto"),
          ...(config && { adapter: config.repo.adapter }),
          language,
        },
      );
    }
    for (const file of files) out(`* creating ${file}`);
    return 0;
  }

  if (command === "gen.schemas") {
    const config = await loadConfig(values.config);
    const repo = createRepo(config.repo);
    try {
      const tables =
        rest.length === 0
          ? undefined
          : new Map(
              rest.map((arg) => {
                const [table = "", name] = arg.split(":");
                return [table, name] as const;
              }),
            );
      const { written, skipped } = await generateSchemas(
        repo.kysely,
        repo.adapter,
        {
          schemasFolder:
            values.schemas ?? config.schemasFolder ?? "src/schemas",
          ...(tables && { tables }),
          language: languageOf(config),
          exclude: [
            config.migrationSource ?? "schema_migrations",
            "kysely_migration",
            "kysely_migration_lock",
          ],
        },
      );
      for (const file of written) out(`* creating ${file}`);
      for (const file of skipped) out(`* skipping ${file} (it exists)`);
      return 0;
    } finally {
      await repo.stop();
    }
  }

  if (!["migrate", "rollback", "status"].includes(command)) {
    out(USAGE);
    throw new Error(`unknown command ${command}`);
  }
  const config = await loadConfig(values.config);
  // Started for the command with a pool of two, as `mix ecto.migrate`
  // starts the Repo: one connection for the lock, one for the migrations.
  const repo = createRepo({
    ...config.repo,
    poolSize: number("pool-size", values["pool-size"]) ?? 2,
  });
  try {
    const migrator = createMigrator({
      repo,
      migrations: fileMigrations(
        values.migrations ?? config.migrationsFolder ?? "migrations",
      ),
      ...(config.migrationSource !== undefined && {
        migrationSource: config.migrationSource,
      }),
      migrationLock: values["no-lock"] ? false : config.migrationLock,
      ...(config.migrationAdvisoryLockRetryIntervalMs !== undefined && {
        migrationAdvisoryLockRetryIntervalMs:
          config.migrationAdvisoryLockRetryIntervalMs,
      }),
      ...(config.migrationAdvisoryLockMaxTries !== undefined && {
        migrationAdvisoryLockMaxTries: config.migrationAdvisoryLockMaxTries,
      }),
    });
    if (command === "status") {
      // As `mix ecto.migrations` prints it.
      const statuses = await migrator.status();
      out(`\n  ${pad("Status", 10)}${pad("Migration ID", 16)}Migration Name`);
      out("-".repeat(50));
      for (const s of statuses)
        out(`  ${pad(s.status, 10)}${pad(String(s.version), 16)}${s.name}`);
      out("");
      return 0;
    }
    const ran =
      command === "migrate"
        ? await migrator.migrate(strategy)
        : await migrator.rollback(strategy);
    if (ran.length === 0)
      out(`Migrations already ${command === "migrate" ? "up" : "down"}`);
    for (const m of ran)
      out(
        `== ${command === "migrate" ? "Migrated" : "Rolled back"} ${m.version} ${m.name}`,
      );
    return 0;
  } finally {
    await repo.stop();
  }
}
