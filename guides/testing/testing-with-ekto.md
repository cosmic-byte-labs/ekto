---

title: Testing with ekto
group: Testing
---

# Testing with ekto

After you have successfully set up your database connection with ekto for your application, its
usage for your tests requires further changes, especially if you want to leverage the test
sandbox of `ekto/testing`, which runs each test in a transaction that is rolled back when the test
ends. This guide follows Ecto's [Testing with Ecto](https://hexdocs.pm/ecto/testing-with-ecto.html)
and uses Node's built-in test runner, `node:test`.

Tests use a database of their own. As ekto's repo is configured in code, choose the database from
the environment where the repo is created, in `src/repo.ts`:

```ts
import { createRepo } from "ekto";
import { type KyselyDB, postgres } from "ekto/postgres";
import { Person } from "./person.ts";

export type DB = KyselyDB<[typeof Person]>;

export const repo = createRepo<DB>({
  adapter: postgres(),
  url:
    process.env.NODE_ENV === "test"
      ? "postgres://postgres:postgres@localhost/myapp_test"
      : process.env.DATABASE_URL,
});
```

Thereby, we configure the database connection for our test setup. In this case, we use a Postgres
database, which the sandbox will wrap each test in a transaction of.

Lastly, you need to set up the sandbox for your tests. You can enable it either for all the tests
of a file, or individually for each test. Let's start with the former, with
{@link ekto/testing!sandbox | sandbox}:

```ts
// test/person.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sandbox } from "ekto/testing";
import { Person } from "../src/person.ts";
import { repo } from "../src/repo.ts";

sandbox(repo);

test("inserts a person", async () => {
  await repo.insert(Person.new({ first_name: "Ann" }));
  assert.equal((await repo.all(Person)).length, 1);
});

test("starts from an empty table", async () => {
  assert.equal((await repo.all(Person)).length, 0);
});
```

`sandbox(repo)` registers a `beforeEach` that checks out a sandbox transaction and an `afterEach`
that rolls it back. While a test runs, the application's repo (`repo` and `repo.kysely`) runs on
the sandbox's transaction, so the code under test needs no changes. This is Ecto's _shared_
sandbox mode: tests of such a file must run one at a time, which is `node:test`'s default within
a file. To use it with another test runner, pass its hooks:
`sandbox(repo, { beforeEach, afterEach })`.

In case you want tests to run concurrently, use
{@link ekto/testing!withSandbox | withSandbox} on each individual test, in a suite whose tests
run concurrently:

```ts
import { describe, test } from "node:test";
import { withSandbox } from "ekto/testing";

describe("people", { concurrency: true }, () => {
  test("inserts a person", () =>
    withSandbox(repo, async () => {
      await repo.insert(Person.new({ first_name: "Ann" }));
      assert.equal((await repo.all(Person)).length, 1);
    }));

  test("starts from an empty table", () =>
    withSandbox(repo, async () => {
      assert.equal((await repo.all(Person)).length, 0);
    }));
});
```

`withSandbox` gives the sandbox only to the async context of the function it runs: the queries
the function makes, and those of any async work it starts, run on its transaction, while other
tests run on their own. On PostgreSQL, each sandbox holds one connection of the pool until it ends,
so the pool's size bounds how many such tests run at once.

For more control, {@link ekto/testing!checkout | checkout} returns a sandboxed repo and a
`checkin` function that rolls it back:

```ts
import { after, before } from "node:test";
import { checkout, type SandboxCheckout } from "ekto/testing";
import type { DB } from "../src/repo.ts";

let box: SandboxCheckout<DB>;
before(async () => {
  box = await checkout(repo);
});
after(() => box.checkin());
```

Only `box.repo` runs on that sandbox; the application's `repo` does not.

For convenience reasons, you can also define scripts to set up your database before running your
tests. Change the following content in your `package.json`:

```json
{
  "scripts": {
    "test": "NODE_ENV=test ekto migrate && NODE_ENV=test node --test"
  }
}
```

with an `ekto.config.ts` that chooses the database as the repo does. ekto does not create
databases: create the test database once with `createdb myapp_test`.
