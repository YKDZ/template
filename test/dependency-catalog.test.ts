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
import { parse as parseYaml } from "yaml";

describe("Template Dependency Catalog projection", () => {
  it("renders the explicit Generated Repository pnpm workspace policy", () => {
    const workspace = parseYaml(
      renderGeneratedPnpmWorkspaceYaml({ dependencies: [] }),
    ) as Record<string, unknown>;

    expect(workspace).toMatchObject({
      nodeLinker: "isolated",
      injectWorkspacePackages: true,
      dedupeInjectedDeps: false,
      syncInjectedDepsAfterScripts: ["build:run"],
      minimumReleaseAge: 1440,
      minimumReleaseAgeStrict: true,
    });
  });

  it("only weakens workspace policy through named, evidence-backed exceptions", () => {
    expect(() =>
      renderGeneratedPnpmWorkspaceYaml({
        dependencies: [],
        dependencyLinker: { kind: "hoisted", evidence: "" },
      }),
    ).toThrow("Hoisted linking requires single-line compatibility evidence");

    const workspaceYaml = renderGeneratedPnpmWorkspaceYaml({
      dependencies: [],
      dependencyLinker: {
        kind: "hoisted",
        evidence: "upstream-tool#123 cannot resolve symlinked dependencies",
      },
      minimumReleaseAgeExclude: ["urgent-security-fix"],
    });
    const workspace = parseYaml(workspaceYaml) as Record<string, unknown>;

    expect(workspaceYaml).toContain(
      "# Hoisted linker compatibility evidence: upstream-tool#123 cannot resolve symlinked dependencies",
    );
    expect(workspace).toMatchObject({
      nodeLinker: "hoisted",
      minimumReleaseAgeExclude: ["urgent-security-fix"],
    });
  });

  it.each([
    { exclusions: [""], reason: "non-empty" },
    { exclusions: ["react", "react"], reason: "unique" },
    { exclusions: ["react@19.0.0"], reason: "exact npm package identities" },
    { exclusions: ["@scope/*"], reason: "exact npm package identities" },
    { exclusions: ["React"], reason: "exact npm package identities" },
    { exclusions: ["@scope"], reason: "exact npm package identities" },
  ])(
    "rejects invalid dependency maturity exclusions: $exclusions",
    ({ exclusions, reason }) => {
      expect(() =>
        renderGeneratedPnpmWorkspaceYaml({
          dependencies: [],
          minimumReleaseAgeExclude: exclusions,
        }),
      ).toThrow(reason);
    },
  );

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
    const workspaceYaml = renderGeneratedPnpmWorkspaceYaml({
      dependencies,
      pnpmfile: ".pnpmfile.cts",
    });
    const selectedCatalog =
      selectTemplateDependencyCatalogEntries(dependencies);

    expect(selectedCatalog).toMatchObject({
      typescript: "npm:@typescript/typescript6@^6.0.2",
      "typescript-7": "npm:typescript@^7.0.2",
    });
    expect(workspaceYaml).toContain("autoInstallPeers: false");
    expect(workspaceYaml).toContain('"pinia>typescript": "-"');
    expect(workspaceYaml).toContain('"valibot>typescript": "-"');
    expect(workspaceYaml).toContain('"vue>typescript": "-"');
    expect(workspaceYaml).toContain("pnpmfile: .pnpmfile.cts");
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
