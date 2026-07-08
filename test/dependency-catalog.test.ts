import { loadBuiltInPresetSourceManifest } from "@ykdz/template-builtin-source";
import {
  collectGeneratedManifestCatalogDependencies,
  loadTemplateCargoDependencyVersions,
  loadTemplateDependencyCatalog,
  renderCargoLockForPackage,
  renderCargoDependencyTomlEntries,
  renderGeneratedPnpmWorkspaceYaml,
  selectTemplateCargoDependencyVersions,
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

  it("selects Cargo dependency versions from the template Cargo manifest", () => {
    expect(
      selectTemplateCargoDependencyVersions(["anyhow"], {
        anyhow: "1.0.100",
        serde: "1.0.228",
      }),
    ).toEqual({
      anyhow: "1.0.100",
    });

    expect(
      renderCargoDependencyTomlEntries(["anyhow"], { anyhow: "1.0.100" }),
    ).toEqual(['anyhow = "1.0.100"']);
    expect(loadTemplateCargoDependencyVersions()).toHaveProperty("anyhow");
  });

  it("projects the template Cargo lockfile with the generated package identity", () => {
    expect(
      renderCargoLockForPackage({
        packageName: "demo-rust",
        packageVersion: "0.1.0",
      }),
    ).toContain('name = "demo-rust"\nversion = "0.1.0"');
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
    ].toSorted();
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
