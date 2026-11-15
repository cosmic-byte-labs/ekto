import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { postgresSyntax } from "./postgres/index.ts";
import { isQueryable, type Queryable, Sql, sql } from "./sql.ts";
import { sqliteSyntax } from "./sqlite/index.ts";
import type { Equal, Expect } from "./type-test.test-helper.ts";

describe("sql", () => {
  test("binds values as parameters", () => {
    const email = "a@b.c'; drop table users; --";
    const query = sql`select * from users where email = ${email} and age > ${18}`;
    assert.deepEqual(query.compile(postgresSyntax), {
      sql: "select * from users where email = $1 and age > $2",
      params: [email, 18],
    });
    assert.deepEqual(query.compile(sqliteSyntax), {
      sql: "select * from users where email = ? and age > ?",
      params: [email, 18],
    });
  });

  test("inlines nested sql values, numbering parameters in order", () => {
    const adult = sql`age >= ${18}`;
    const query = sql`select * from users where name = ${"Ann"} and ${adult} limit ${10}`;
    assert.deepEqual(query.compile(postgresSyntax), {
      sql: "select * from users where name = $1 and age >= $2 limit $3",
      params: ["Ann", 18, 10],
    });
  });

  test("binds null, objects and arrays as single values", () => {
    const query = sql`${null} ${{ a: 1 }} ${[1, 2]}`;
    assert.deepEqual(query.compile(postgresSyntax).params, [
      null,
      { a: 1 },
      [1, 2],
    ]);
  });

  test("rejects undefined", () => {
    assert.throws(() => sql`${undefined}`, /undefined/);
  });

  test("identifier quotes names", () => {
    const query = sql`select ${sql.identifier('we"ird')} from ${sql.identifier("users")}`;
    assert.equal(
      query.compile(postgresSyntax).sql,
      'select "we""ird" from "users"',
    );
    assert.throws(() => sql.identifier(""), TypeError);
  });

  test("splice binds a comma-separated list", () => {
    const query = sql`select * from users where id in (${sql.splice([1, 2, 3])})`;
    assert.deepEqual(query.compile(postgresSyntax), {
      sql: "select * from users where id in ($1, $2, $3)",
      params: [1, 2, 3],
    });
    assert.throws(() => sql.splice([]), TypeError);
  });

  test("sql values are immutable", () => {
    const query = sql`select 1`;
    assert.ok(query instanceof Sql);
    assert.ok(Object.isFrozen(query) && Object.isFrozen(query.parts));
  });

  test("carries the row type", () => {
    const query = sql<{ n: number }>`select count(*) as n from users`;
    type _row = Expect<Equal<typeof query, Sql<{ n: number }>>>;
    type _compiled = Expect<
      Equal<ReturnType<typeof query.compile>, Queryable<{ n: number }>>
    >;
    assert.ok(true);
  });
});

describe("isQueryable", () => {
  test("recognises { sql, params }", () => {
    assert.ok(isQueryable({ sql: "select 1", params: [] }));
    assert.ok(!isQueryable({ sql: "select 1" }));
    assert.ok(!isQueryable(sql`select 1`));
    assert.ok(!isQueryable(null));
  });
});
