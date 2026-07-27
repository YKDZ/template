import { describe, expect, it } from "vitest";

import { greet } from "../../src/main.ts";

describe("greet", () => {
  it("normalizes a name and returns a deterministic greeting", () => {
    expect(greet("  Ada Lovelace  ")).toEqual({
      message: "Hello, Ada Lovelace",
    });
  });

  it("rejects an empty normalized name", () => {
    expect(() => greet("   ")).toThrow("Name must not be empty");
  });
});
