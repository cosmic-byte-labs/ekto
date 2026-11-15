import assert from "node:assert/strict";
import { test } from "node:test";

test("the package entry point loads", async () => {
  const ekto = await import("./index.ts");
  assert.equal(typeof ekto, "object");
});
