import { test } from "node:test";
import assert from "node:assert/strict";

test("node runs TypeScript tests natively", () => {
  const x: number = 2 + 2;
  assert.equal(x, 4);
});
