import { loadBuiltInPresetSourceManifest } from "@ykdz/template-builtin-source";
import {
  collectGeneratedManifestCatalogDependencies,
  loadTemplateDependencyCatalog,
  renderGeneratedPnpmWorkspaceYaml,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-core/dependency-catalog";

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

  it("collects generated manifest catalog dependencies and rejects inline specifiers", () => {
    expect(
      collectGeneratedManifestCatalogDependencies([
        {
          dependencies: {
            valibot: "catalog:",
          },
          devDependencies: {
            typescript: "catalog:",
          },
        },
        {
          devDependencies: {
            typescript: "catalog:",
            turbo: "catalog:",
          },
        },
      ]),
    ).toEqual(["turbo", "typescript", "valibot"]);

    expect(() =>
      collectGeneratedManifestCatalogDependencies([
        {
          dependencies: {
            valibot: "^1.4.2",
          },
        },
      ]),
    ).toThrow(
      "Generated manifest dependency valibot must use catalog:, got ^1.4.2",
    );
  });

  it("renders Dependency Catalog versions required by built-in Preset Source declarations", () => {
    const dependencies = [
      ...new Set(
        loadBuiltInPresetSourceManifest().presets.flatMap(
          (preset) => preset.dependencyCatalog ?? [],
        ),
      ),
    ].sort();
    const templateCatalog = loadTemplateDependencyCatalog();
    const workspaceYaml = renderGeneratedPnpmWorkspaceYaml({ dependencies });
    const selectedCatalog =
      selectTemplateDependencyCatalogEntries(dependencies);

    expect(selectedCatalog).toEqual(
      Object.fromEntries(
        dependencies.map((dependency) => [
          dependency,
          templateCatalog[dependency],
        ]),
      ),
    );

    for (const [dependency, version] of Object.entries(selectedCatalog)) {
      const key = dependency.startsWith("@")
        ? JSON.stringify(dependency)
        : dependency;

      expect(workspaceYaml).toContain(`${key}: ${version}`);
    }
  });
});
