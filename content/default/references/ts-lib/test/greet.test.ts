import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { greet } from "../src/index.ts";

void describe("greet", () => {
  void it("returns a greeting for a valid name", () => {
    assert.deepStrictEqual(greet("Ada"), { message: "Hello, Ada" });
  });

  void it("trims surrounding whitespace from a name", () => {
    assert.deepStrictEqual(greet("  Ada Lovelace  "), {
      message: "Hello, Ada Lovelace",
    });
  });

  void it("rejects a name that is empty after trimming", () => {
    assert.throws(() => greet(" \t\n "));
  });
});
