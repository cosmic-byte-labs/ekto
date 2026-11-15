/**
 * The `ekto` command: `ekto migrate`, `ekto rollback`, `ekto status` and
 * `ekto gen <name>` (Ecto's `mix ecto.migrate`, `ecto.rollback`,
 * `ecto.migrations` and `ecto.gen.migration`).
 *
 * The configuration file (`ekto.config.ts` or `ekto.config.js`, or
 * `--config`) default-exports `{ db, adapter, migrationsFolder? }`, or a
 * function returning it.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Kysely } from "kysely";
import type { Adapter } from "../adapter.ts";
import { createMigrator, fileMigrations } from "./runner.ts";

export interface EktoConfig {
  // biome-ignore lint/suspicious/noExplicitAny: any database
  readonly db: Kysely<any>;
  readonly adapter: Adapter;
  /** `migrations` by default, relative to the working directory. */
  readonly migrationsFolder?: string;
  readonly migrationTableName?: string;
}

const USAGE = `usage: ekto <command> [options]

commands:
  migrate             run pending migrations (--step N, --to NAME)
  rollback            roll back migrations (--step N, --to NAME, --all)
  status              list migrations and whether they ran
  gen <name>          create a migration file

options:
  --config FILE       configuration file (default: ekto.config.ts or .js)
  --migrations DIR    migrations folder (overrides the configuration)
`;

/** `20260115103000`, the UTC time (Ecto's `timestamp/0`). */
function timestamp(date: Date): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

/** `AddUsers` and `add users` become `add_users` (Macro.underscore). */
function underscore(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z\d]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

const TEMPLATE = `import { migration } from "ekto/migrate";

export default migration({
  change(m) {},
});
`;

/** Creates `<folder>/<timestamp>_<name>.ts` and returns its path. */
export async function generate(
  folder: string,
  name: string,
  now = new Date(),
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
  await writeFile(file, TEMPLATE, { flag: "wx" });
  return file;
}

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
  if (!resolved?.db || !resolved.adapter)
    throw new Error(
      `${file} must default-export { db, adapter } or a function returning it`,
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
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    out(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const step = values.step === undefined ? undefined : Number(values.step);

  if (command === "gen") {
    if (rest.length !== 1) throw new Error("usage: ekto gen <name>");
    let folder = values.migrations;
    if (folder === undefined) {
      // The configuration is optional here: generating needs no database.
      try {
        folder = (await loadConfig(values.config)).migrationsFolder;
      } catch {}
    }
    const file = await generate(folder ?? "migrations", rest[0] as string);
    out(`created ${file}`);
    return 0;
  }

  if (!["migrate", "rollback", "status"].includes(command)) {
    out(USAGE);
    throw new Error(`unknown command ${command}`);
  }
  const config = await loadConfig(values.config);
  try {
    const migrator = createMigrator({
      db: config.db,
      adapter: config.adapter,
      migrations: fileMigrations(
        values.migrations ?? config.migrationsFolder ?? "migrations",
      ),
      migrationTableName: config.migrationTableName,
    });
    if (command === "status") {
      const statuses = await migrator.status();
      out(`\n${pad("Status", 8)}Migration`);
      out("-".repeat(40));
      for (const s of statuses) out(`${pad(s.status, 8)}${s.name}`);
      out("");
      return 0;
    }
    const ran =
      command === "migrate"
        ? await migrator.migrate({ step, to: values.to })
        : await migrator.rollback({ step, to: values.to, all: values.all });
    if (ran.length === 0)
      out(
        command === "migrate"
          ? "Migrations already up"
          : "No migrations to roll back",
      );
    for (const name of ran)
      out(`== ${command === "migrate" ? "Migrated" : "Rolled back"} ${name}`);
    return 0;
  } finally {
    await config.db.destroy();
  }
}
