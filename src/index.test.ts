import assert from "node:assert/strict";
import { test } from "node:test";

test("the package entry point exports the public API", async () => {
  const ekto = await import("./index.ts");
  assert.equal(typeof ekto.schema, "function");
  assert.equal(typeof ekto.t.string, "function");
  assert.equal(ekto.types.integer.type, "integer");
  assert.equal(typeof ekto.createRepo, "function");
  assert.equal(typeof ekto.StaleEntryError, "function");
  assert.equal(typeof ekto.hasMany, "function");
  assert.equal(typeof ekto.queries, "function");
});
