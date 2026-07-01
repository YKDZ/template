import { selectTemplateDependencyCatalogEntries } from "../src/dependency-catalog.js";

describe("Template Dependency Catalog projection", () => {
  it("selects only requested dependency versions in stable dependency order", () => {
    expect(
      selectTemplateDependencyCatalogEntries(["typescript", "@types/node"], {
        "@types/node": "^24.0.0",
        hono: "^4.10.0",
        typescript: "^6.0.3",
      }),
    ).toEqual({
      "@types/node": "^24.0.0",
      typescript: "^6.0.3",
    });
  });
});
