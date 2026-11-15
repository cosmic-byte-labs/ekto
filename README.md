# ekto

An Ecto-inspired data layer for TypeScript: schemas, changesets that turn database constraint
violations into field errors, composable queries, and a Repo that is the only part of your code
that touches the database. Inspired by Elixir's [Ecto](https://hexdocs.pm/ecto); not affiliated
with it.

**Status:** early development, nothing usable yet.

## Development

Needs Node 26 (22.19+ works) and pnpm 12.

```bash
pnpm install
pnpm check   # lint, typecheck, tests, build
```
