import { describe, expect, it } from "vitest";

import { formatPresetCatalog } from "../../src/application.ts";

describe("template CLI business rules", () => {
  it("renders the registry-owned Preset Catalog deterministically", () => {
    const catalog = formatPresetCatalog();

    expect(catalog).toContain("Built-in presets");
    expect(catalog).toContain("ts-lib:");
    expect(catalog).toContain("ts-cli:");
  });
});
