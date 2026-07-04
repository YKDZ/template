import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadBuiltInPresetSourceManifest,
  manifestReferencedSourceFiles,
} from "@ykdz/template-builtin-source";
import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import { builtInTemplateBoundaryProjections } from "@ykdz/template-checks/check-template-boundary";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import type { PresetProjectionPlan } from "@ykdz/template-core/preset-projection";
import {
  checkTemplateSourceBoundary,
  templateBoundaryDebtAllowlist,
} from "@ykdz/template-core/template-boundary-check";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const templatesRoot = path.join(
  repoRoot,
  "packages",
  "builtin-source",
  "templates",
);

function builtInManifestReferencedSourceFiles(): string[] {
  return manifestReferencedSourceFiles(
    loadBuiltInPresetSourceManifest(),
    templatesRoot,
  );
}

function builtInProjectionSourceFile(): string {
  return path.join(repoRoot, "packages/core/src/projection-capabilities.ts");
}

function minimalPlan(
  operations: PresetProjectionPlan["operations"],
): PresetProjectionPlan {
  return {
    sourceRoot: ".",
    operations,
    checkPlan: { components: [], environmentNeeds: [] },
    fixPlan: { components: [] },
    dependencyMaintenancePolicy: { ecosystems: [], interval: "weekly" },
    packageScripts: {},
    capabilities: {
      rootCheck: true,
      fixCommand: true,
      githubActions: true,
      dependabot: true,
      devcontainer: true,
    },
  };
}

describe("Template Boundary Check", () => {
  it("accepts all built-in init and Package Addition projections without temporary allowlisted debt", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const projections = await builtInTemplateBoundaryProjections(manifest);

    expect(projections.map((projection) => projection.name)).toEqual(
      expect.arrayContaining([
        "ts-lib",
        "hono-api",
        "vue-app",
        "vue-hono-app",
        "rust-bin",
        "ts-lib package addition",
        "hono-api package addition",
        "vue-app package addition",
      ]),
    );
    expect(
      projections.find(
        (projection) => projection.name === "vue-app package addition",
      )?.plan.operations,
    ).toContainEqual(
      expect.objectContaining({
        kind: "writeTextTemplate",
        from: "playwright.package-addition.config.ts",
        to: "apps/template-boundary-check/playwright.config.ts",
      }),
    );

    const result = await checkTemplateSourceBoundary({
      projections,
      manifestReferencedSourceFiles: builtInManifestReferencedSourceFiles(),
    });

    expect(result).toMatchObject({
      ok: true,
      violations: [],
      allowlistedDebt: [],
      unusedAllowlistEntries: [],
    });
  });

  it("fails built-in Package Addition protected templates missing manifest source declarations", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const projections = await builtInTemplateBoundaryProjections(manifest);
    const result = await checkTemplateSourceBoundary({
      projections,
      manifestReferencedSourceFiles:
        builtInManifestReferencedSourceFiles().filter(
          (sourceFile) =>
            !sourceFile.endsWith(
              path.join(
                "templates",
                "vue-app",
                "playwright.package-addition.config.ts",
              ),
            ),
        ),
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        preset: "vue-app package addition",
        generatedPath: "apps/template-boundary-check/playwright.config.ts",
        operationKind: "writeTextTemplate",
        owningFunction: "planPresetSourcePackageAddition",
      }),
    );
  });

  it("fails unlisted protected Generated Repository outputs with path and owning function diagnostics", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectSyntheticPreset() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: ".github/dependabot.yml",',
        '        text: "version: 2\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: ".github/dependabot.yml",
              text: "version: 2\n",
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        generatedPath: ".github/dependabot.yml",
        owningFunction: "projectSyntheticPreset",
      }),
    ]);
  });

  it("fails protected Generated Repository outputs copied from undeclared template source", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectCopiedTemplateSource() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "copyFile",',
        '        from: "github/dependabot.yml",',
        '        to: ".github/dependabot.yml",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "copyFile",
              from: "github/dependabot.yml",
              to: ".github/dependabot.yml",
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        generatedPath: ".github/dependabot.yml",
        operationKind: "copyFile",
        owningFunction: "projectCopiedTemplateSource",
      }),
    ]);
  });

  it("accepts protected Generated Repository outputs copied from manifest-declared template source", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    const referencedSourcePath = path.join(workspace, "github/dependabot.yml");
    await mkdir(path.dirname(referencedSourcePath), { recursive: true });
    await writeFile(referencedSourcePath, "version: 2\n", "utf8");
    await writeFile(
      projectionPath,
      [
        "function projectCopiedTemplateSource() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "copyFile",',
        '        from: "github/dependabot.yml",',
        '        to: ".github/dependabot.yml",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: {
            ...minimalPlan([
              {
                kind: "copyFile",
                from: "github/dependabot.yml",
                to: ".github/dependabot.yml",
              },
            ]),
            sourceRoot: workspace,
          },
        },
      ],
      manifestReferencedSourceFiles: [referencedSourcePath],
    });

    expect(result).toMatchObject({
      ok: true,
      violations: [],
      allowlistedDebt: [],
    });
  });

  it("accepts manifest-referenced protected source files without hiding inline protected bodies", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    const referencedSourcePath = path.join(workspace, "dependabot.yml");
    await writeFile(referencedSourcePath, "version: 2\n", "utf8");
    await writeFile(
      projectionPath,
      [
        "function projectManifestReferencedSource() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "copyFile",',
        '        from: "dependabot.yml",',
        '        to: ".github/dependabot.yml",',
        "      },",
        "      {",
        '        kind: "writeText",',
        '        to: ".github/dependabot.yml",',
        '        text: "version: 2\\nupdates: []\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: {
            ...minimalPlan([
              {
                kind: "copyFile",
                from: "dependabot.yml",
                to: ".github/dependabot.yml",
              },
              {
                kind: "writeText",
                to: ".github/dependabot.yml",
                text: "version: 2\nupdates: []\n",
              },
            ]),
            sourceRoot: workspace,
          },
        },
      ],
      manifestReferencedSourceFiles: [referencedSourcePath],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        generatedPath: ".github/dependabot.yml",
        operationKind: "writeText",
        owningFunction: "projectManifestReferencedSource",
      }),
    ]);
  });

  it("fails unlisted inline package-local tool configuration outputs", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectRustPreset() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: "packages/cli/rustfmt.toml",',
        '        text: "edition = \\"2024\\"\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic-rust",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: "packages/cli/rustfmt.toml",
              text: 'edition = "2024"\n',
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: "packages/cli/rustfmt.toml",
        owningFunction: "projectRustPreset",
      }),
    );
  });

  it("accepts narrow structural machine declarations at protected JSON paths", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectStructuralMachineDeclarations() {",
        "  const developmentContainer = planDevelopmentContainer();",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: "turbo.json",',
        "        value: {",
        "          tasks: {",
        '            check: { dependsOn: ["^build"] },',
        "            dev: { cache: false, persistent: true },",
        "          },",
        "        },",
        "      },",
        "      {",
        '        kind: "writeJson",',
        '        to: "tsconfig.config.json",',
        "        value: {",
        "          compilerOptions: {",
        '            module: "NodeNext",',
        '            moduleResolution: "NodeNext",',
        "            noEmitOnError: true,",
        "            skipLibCheck: false,",
        "            strict: true,",
        '            target: "ES2022",',
        "          },",
        '          include: ["oxlint.config.ts", "oxfmt.config.ts"],',
        "        },",
        "      },",
        "      {",
        '        kind: "writeJson",',
        '        to: ".devcontainer/devcontainer.json",',
        "        value: developmentContainer.devcontainer,",
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: "turbo.json",
              value: {
                tasks: {
                  check: { dependsOn: ["^build"] },
                  dev: { cache: false, persistent: true },
                },
              },
            },
            {
              kind: "writeJson",
              to: "tsconfig.config.json",
              value: {
                compilerOptions: {
                  module: "NodeNext",
                  moduleResolution: "NodeNext",
                  noEmitOnError: true,
                  skipLibCheck: false,
                  strict: true,
                  target: "ES2022",
                },
                include: ["oxlint.config.ts", "oxfmt.config.ts"],
              },
            },
            {
              kind: "writeJson",
              to: ".devcontainer/devcontainer.json",
              value: {
                name: "demo",
                build: { dockerfile: "Dockerfile" },
              },
            },
          ]),
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      violations: [],
      allowlistedDebt: [],
    });
  });

  it("rejects arbitrary inline bodies at structurally classified protected JSON paths", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectArbitraryProtectedJson() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: "turbo.json",',
        '        value: { scripts: { check: "pnpm test" } },',
        "      },",
        "      {",
        '        kind: "writeJson",',
        '        to: ".devcontainer/devcontainer.json",',
        '        value: { name: "demo" },',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: "turbo.json",
              value: { scripts: { check: "pnpm test" } },
            },
            {
              kind: "writeJson",
              to: ".devcontainer/devcontainer.json",
              value: { name: "demo" },
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          generatedPath: "turbo.json",
          owningFunction: "projectArbitraryProtectedJson",
        }),
        expect.objectContaining({
          generatedPath: ".devcontainer/devcontainer.json",
          owningFunction: "projectArbitraryProtectedJson",
        }),
      ]),
    );
  });

  it("rejects structural turbo.json declarations with extra root keys", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectTurboWithExtraRootKey() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: "turbo.json",',
        "        value: { tasks: {}, arbitrary: true },",
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: "turbo.json",
              value: { tasks: {}, arbitrary: true },
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: "turbo.json",
        owningFunction: "projectTurboWithExtraRootKey",
      }),
    );
  });

  it("rejects structural tsconfig.config.json declarations with extra root keys", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectTsconfigWithExtraRootKey() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: "tsconfig.config.json",',
        "        value: {",
        "          compilerOptions: {",
        '            module: "NodeNext",',
        '            moduleResolution: "NodeNext",',
        "            noEmitOnError: true,",
        "            skipLibCheck: false,",
        "            strict: true,",
        '            target: "ES2022",',
        "          },",
        '          include: ["oxlint.config.ts"],',
        "          arbitrary: true,",
        "        },",
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: "tsconfig.config.json",
              value: {
                compilerOptions: {
                  module: "NodeNext",
                  moduleResolution: "NodeNext",
                  noEmitOnError: true,
                  skipLibCheck: false,
                  strict: true,
                  target: "ES2022",
                },
                include: ["oxlint.config.ts"],
                arbitrary: true,
              },
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: "tsconfig.config.json",
        owningFunction: "projectTsconfigWithExtraRootKey",
      }),
    );
  });

  it("rejects structural tsconfig.config.json declarations with invalid compiler option values", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectTsconfigWithInvalidCompilerOptions() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: "tsconfig.config.json",',
        "        value: {",
        "          compilerOptions: {",
        '            module: "NodeNext",',
        '            moduleResolution: "NodeNext",',
        "            noEmitOnError: true,",
        "            skipLibCheck: false,",
        '            strict: "true",',
        '            target: "ES2022",',
        "          },",
        '          include: ["oxlint.config.ts"],',
        "        },",
        "      },",
        "      {",
        '        kind: "writeJson",',
        '        to: "tsconfig.config.json",',
        "        value: {",
        "          compilerOptions: {",
        '            module: "CommonJS",',
        '            moduleResolution: "NodeNext",',
        "            noEmitOnError: true,",
        "            skipLibCheck: false,",
        "            strict: true,",
        '            target: "ES2022",',
        "          },",
        '          include: ["oxlint.config.ts"],',
        "        },",
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: "tsconfig.config.json",
              value: {
                compilerOptions: {
                  module: "NodeNext",
                  moduleResolution: "NodeNext",
                  noEmitOnError: true,
                  skipLibCheck: false,
                  strict: "true",
                  target: "ES2022",
                },
                include: ["oxlint.config.ts"],
              },
            },
            {
              kind: "writeJson",
              to: "tsconfig.config.json",
              value: {
                compilerOptions: {
                  module: "CommonJS",
                  moduleResolution: "NodeNext",
                  noEmitOnError: true,
                  skipLibCheck: false,
                  strict: true,
                  target: "ES2022",
                },
                include: ["oxlint.config.ts"],
              },
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          generatedPath: "tsconfig.config.json",
          owningFunction: "projectTsconfigWithInvalidCompilerOptions",
        }),
        expect.objectContaining({
          generatedPath: "tsconfig.config.json",
          owningFunction: "projectTsconfigWithInvalidCompilerOptions",
        }),
      ]),
    );
    expect(result.violations).toHaveLength(2);
  });

  it("does not let duplicate protected paths inherit another owner's allowlist entry", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function allowedLegacyProjection() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: ".github/dependabot.yml",',
        '        text: "version: 2\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
        "function newUnlistedProjection() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: ".github/dependabot.yml",',
        '        text: "version: 2\\nupdates: []\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: ".github/dependabot.yml",
              text: "version: 2\nupdates: []\n",
            },
          ]),
        },
      ],
      allowlist: [
        {
          preset: "synthetic",
          generatedPath: ".github/dependabot.yml",
          owningFunction: "allowedLegacyProjection",
          reason: "existing debt",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: ".github/dependabot.yml",
        owningFunction: "newUnlistedProjection",
      }),
    );
    expect(result.allowlistedDebt).toEqual([]);
  });

  it("attributes protected outputs whose generated path comes from a template literal", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectRustPreset() {",
        '  const packagePath = "packages/cli";',
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        "        to: `${packagePath}/rustfmt.toml`,",
        '        text: "edition = \\"2024\\"\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic-rust",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: "packages/cli/rustfmt.toml",
              text: 'edition = "2024"\n',
            },
          ]),
        },
      ],
    });

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: "packages/cli/rustfmt.toml",
        owningFunction: "projectRustPreset",
      }),
    );
  });

  it("does not let a structured editor settings operation hide an inline settings body in the same function", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectEditorCustomization() {",
        "  const editorCustomization = editorCustomizationForCapabilities([]);",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: ".vscode/settings.json",',
        "        value: editorCustomization.settings,",
        "      },",
        "      {",
        '        kind: "writeJson",',
        '        to: ".vscode/settings.json",',
        '        value: { "editor.formatOnSave": true },',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: ".vscode/settings.json",
              value: { "editor.formatOnSave": true },
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: ".vscode/settings.json",
        owningFunction: "projectEditorCustomization",
      }),
    );
  });

  it("accepts editor extensions operations with exactly editor customization recommendations", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectEditorCustomization() {",
        "  const editorCustomization = editorCustomizationForCapabilities([]);",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: ".vscode/extensions.json",',
        "        value: {",
        "          recommendations: editorCustomization.extensions,",
        "        },",
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: ".vscode/extensions.json",
              value: {
                recommendations: [],
              },
            },
          ]),
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      violations: [],
      allowlistedDebt: [],
    });
  });

  it("rejects editor extensions operations with extra inline value properties", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectEditorCustomization() {",
        "  const editorCustomization = editorCustomizationForCapabilities([]);",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeJson",',
        '        to: ".vscode/extensions.json",',
        "        value: {",
        "          recommendations: editorCustomization.extensions,",
        "        },",
        "      },",
        "      {",
        '        kind: "writeJson",',
        '        to: ".vscode/extensions.json",',
        "        value: {",
        "          recommendations: editorCustomization.extensions,",
        "          unwanted: true,",
        "        },",
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeJson",
              to: ".vscode/extensions.json",
              value: {
                recommendations: [],
                unwanted: true,
              },
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: ".vscode/extensions.json",
        owningFunction: "projectEditorCustomization",
      }),
    );
  });

  it("rejects unused allowlist entries for checked projections", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectCopiedTemplateSource() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "copyFile",',
        '        from: "github/dependabot.yml",',
        '        to: ".github/dependabot.yml",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "copyFile",
              from: "github/dependabot.yml",
              to: ".github/dependabot.yml",
            },
          ]),
        },
      ],
      allowlist: [
        {
          preset: "synthetic",
          generatedPath: ".github/dependabot.yml",
          owningFunction: "projectCopiedTemplateSource",
          reason: "stale debt entry",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.unusedAllowlistEntries).toEqual([
      {
        preset: "synthetic",
        generatedPath: ".github/dependabot.yml",
        owningFunction: "projectCopiedTemplateSource",
        reason: "stale debt entry",
      },
    ]);
  });

  it("accepts allowlisted current boundary debt while reporting it explicitly", async () => {
    const targetDir = path.join(tmpdir(), "demo-ts-lib");
    const projection = findBuiltInPresetProjection("ts-lib")!;
    const blueprint = projection.blueprint({ targetDir });
    const plan = projection.project(
      assembleGenerationContext({
        targetDir,
        blueprint,
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.2.3",
          },
          source: "online",
          diagnostics: [],
        },
      }),
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "ts-lib",
          sourceFilePath: builtInProjectionSourceFile(),
          plan,
        },
      ],
      manifestReferencedSourceFiles: builtInManifestReferencedSourceFiles(),
      allowlist: templateBoundaryDebtAllowlist,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.allowlistedDebt).not.toContainEqual(
      expect.objectContaining({
        preset: "ts-lib",
        generatedPath: ".devcontainer/Dockerfile",
      }),
    );
    expect(result.allowlistedDebt).not.toContainEqual(
      expect.objectContaining({
        preset: "ts-lib",
        generatedPath: ".vscode/extensions.json",
      }),
    );
    expect(result.allowlistedDebt).not.toContainEqual(
      expect.objectContaining({
        preset: "ts-lib",
        generatedPath: ".vscode/settings.json",
      }),
    );
  });

  it.each(["vue-app", "vue-hono-app"] as const)(
    "accepts %s browser Dockerfile fragment composition without allowlisted debt",
    async (presetName) => {
      const targetDir = path.join(tmpdir(), `demo-${presetName}`);
      const projection = findBuiltInPresetProjection(presetName)!;
      const blueprint = projection.blueprint({ targetDir });
      const plan = projection.project(
        assembleGenerationContext({
          targetDir,
          blueprint,
          toolchain: {
            nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
            packageManagerPin: {
              kind: "PackageManagerPin",
              value: "pnpm@11.2.3",
            },
            source: "online",
            diagnostics: [],
          },
        }),
      );

      const result = await checkTemplateSourceBoundary({
        projections: [
          {
            name: presetName,
            sourceFilePath: builtInProjectionSourceFile(),
            plan,
          },
        ],
        manifestReferencedSourceFiles: builtInManifestReferencedSourceFiles(),
        allowlist: templateBoundaryDebtAllowlist,
      });

      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.allowlistedDebt).not.toContainEqual(
        expect.objectContaining({
          preset: presetName,
          generatedPath: ".devcontainer/Dockerfile",
        }),
      );
    },
  );

  it("accepts rust-bin Dockerfile fragment composition without allowlisted Dockerfile debt", async () => {
    const targetDir = path.join(tmpdir(), "demo-rust-bin");
    const projection = findBuiltInPresetProjection("rust-bin")!;
    const blueprint = projection.blueprint({ targetDir });
    const plan = projection.project(
      assembleGenerationContext({
        targetDir,
        blueprint,
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.2.3",
          },
          source: "online",
          diagnostics: [],
        },
      }),
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "rust-bin",
          sourceFilePath: builtInProjectionSourceFile(),
          plan,
        },
      ],
      manifestReferencedSourceFiles: builtInManifestReferencedSourceFiles(),
      allowlist: templateBoundaryDebtAllowlist,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.allowlistedDebt).not.toContainEqual(
      expect.objectContaining({
        preset: "rust-bin",
        generatedPath: ".devcontainer/Dockerfile",
      }),
    );
  });

  it("accepts protected Generated Repository outputs copied from manifest-declared template source", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    const referencedSourcePath = path.join(workspace, "github/dependabot.yml");
    await mkdir(path.dirname(referencedSourcePath), { recursive: true });
    await writeFile(referencedSourcePath, "version: 2\n", "utf8");
    await writeFile(
      projectionPath,
      [
        "function projectCopiedTemplateSource() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "copyFile",',
        '        from: "github/dependabot.yml",',
        '        to: ".github/dependabot.yml",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: {
            ...minimalPlan([
              {
                kind: "copyFile",
                from: "github/dependabot.yml",
                to: ".github/dependabot.yml",
              },
            ]),
            sourceRoot: workspace,
          },
        },
      ],
      manifestReferencedSourceFiles: [referencedSourcePath],
    });

    expect(result).toMatchObject({
      ok: true,
      violations: [],
      allowlistedDebt: [],
    });
  });
});
