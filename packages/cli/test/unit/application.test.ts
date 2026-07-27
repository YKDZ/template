import { describe, expect, it } from "vitest";

import {
  formatPresetCatalog,
  normalizeNpmScope,
} from "../../src/application.ts";

describe("template CLI business rules", () => {
  it("normalizes an optional leading npm scope marker", () => {
    expect(normalizeNpmScope("@acme")).toBe("acme");
    expect(normalizeNpmScope("acme.tools")).toBe("acme.tools");
  });

  it("renders the registry-owned Preset Catalog deterministically", () => {
    const catalog = formatPresetCatalog();

    expect(catalog).toContain("Built-in presets");
    expect(catalog).toContain("ts-lib:");
    expect(catalog).toContain("ts-cli:");
  });
});
