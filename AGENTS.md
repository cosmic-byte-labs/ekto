# Working on ekto

This file is for coding agents (Claude Code reads it through `CLAUDE.md`). People start with
[README.md](README.md).

ekto is an Ecto-inspired data layer for TypeScript: schemas, changesets, composable queries, and a
Repo that is the only part that touches the database. It is a library; there is no server to run.

## Commands

```bash
pnpm install --frozen-lockfile   # once per worktree (slot setup does it)
pnpm check                       # lint + typecheck + tests + build + docs:check; run before pushing
pnpm test                        # node --test over src/**/*.test.ts
node --test src/index.test.ts    # one file
pnpm test:coverage               # tests with Node's built-in coverage
EKTO_PG_URL=postgres://… pnpm test  # also run the Repo tests against PostgreSQL (skipped without it)
pnpm format                      # Biome: fix formatting and lint where it can
pnpm build                       # tsc → dist/ (tests excluded)
pnpm docs:build                  # TypeDoc → docs/api/ (git-ignored); docs:check only validates
```

## Conventions

- **pnpm only, for working on ekto.** Do not add `package-lock.json` or `yarn.lock`. The pnpm
  version is pinned in `package.json` `packageManager` and in `.slot` `[tools]`. Users of the
  package can use any package manager: user-facing docs show npm (`npm install`, `npx ekto`).
- **TypeScript runs natively in Node** (type stripping), with no tsx or ts-node. So only erasable
  syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties.
  Use `as const` objects and unions instead of enums.
- **Relative imports use the `.ts` extension** (`import { x } from "./schema.ts"`); `tsc` rewrites
  them to `.js` in `dist/` (`rewriteRelativeImportExtensions`). Type-only imports use `import type`
  (`verbatimModuleSyntax`).
- **Tests sit beside the code** as `*.test.ts`, using `node:test` and `node:assert/strict`. Shared
  test helpers are `*.test-helper.ts`; neither ships in the package.
- **Node support:** the package supports Node ≥ 24.3 (`engines`), the first Node 24 that strips
  types without a warning; CI tests 24 and 26. Do not use APIs newer than Node 24 in `src/`
  without a fallback.
- Formatting is Biome's (2-space indent, double quotes). Do not hand-format against it.
- **API docs are TypeDoc's**, from the doc comments of what the entry points in `typedoc.json`
  export (one per `package.json` export; each entry file has a `@module` tag). `docs:check` fails
  on warnings. A public type that refers to an unexported helper type warns: export the helper,
  or add it to `intentionallyNotExported` if it is internal. TypeDoc does not support TypeScript
  7 yet, so `.pnpmfile.cjs` gives it TypeScript 6.0 of its own; the build stays on 7.
- **Guides** are Markdown in `guides/`, after Ecto's guides (ex_doc extras), listed in
  `typedoc.json` `projectDocuments` with a `title` and `group` in their frontmatter; TypeDoc
  renders them beside the API docs. Keep their examples working: run them against a database when
  you change them or the API they use.
