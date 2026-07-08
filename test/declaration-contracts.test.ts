import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findBuiltInPreset,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import type {
  PresetSourceManifest,
  PresetSourceManifestPreset,
  PresetSourceManifestSharedResource,
} from "@ykdz/template-shared";
import {
  normalizePresetProjectionDeclaration,
  validatePresetSourceManifestDeclaration,
  validatePresetProjectionDeclaration,
  validateProjectBlueprint as validateSharedProjectBlueprint,
} from "@ykdz/template-shared";
import { execa } from "execa";
import * as ts from "typescript";
import * as v from "valibot";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "packages", "cli", "src", "cli.ts");
const declarationConsumerRoots = [
  "packages/builtin-source/src",
  "packages/builtin-source/templates",
  "packages/checks/src",
  "packages/cli/src",
  "packages/core/src",
] as const;
const ignoredDeclarationConsumerDirectories = new Set([
  ".cache",
  ".local",
  ".turbo",
  "dist",
  "generated",
  "local",
  "node_modules",
]);

function repoPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function isMaintainedTypeScriptFile(filePath: string): boolean {
  const normalizedPath = repoPath(filePath);
  const fileName = path.posix.basename(normalizedPath);

  return (
    normalizedPath.endsWith(".ts") &&
    !fileName.startsWith("generated-") &&
    !fileName.endsWith(".generated.ts")
  );
}

async function discoverDeclarationConsumerFiles(): Promise<string[]> {
  const files: string[] = [];

  async function visit(relativeDirectory: string): Promise<void> {
    const entries = await readdir(path.join(repoRoot, relativeDirectory), {
      withFileTypes: true,
    });

    for (const entry of entries.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = path.join(relativeDirectory, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDeclarationConsumerDirectories.has(entry.name)) {
          await visit(relativePath);
        }
        continue;
      }

      if (entry.isFile() && isMaintainedTypeScriptFile(relativePath)) {
        files.push(repoPath(relativePath));
      }
    }
  }

  for (const root of declarationConsumerRoots) {
    await visit(root);
  }

  return files.toSorted();
}

function importedDeclarationNames(
  source: string,
  moduleName: string,
): string[] {
  const names: string[] = [];
  const sourceFile = ts.createSourceFile(
    "declaration-consumer.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      names.push(
        ...statement.importClause.namedBindings.elements.map(
          (element) => element.propertyName?.text ?? element.name.text,
        ),
      );
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      names.push(
        ...statement.exportClause.elements.map(
          (element) => element.propertyName?.text ?? element.name.text,
        ),
      );
    }
  }

  return names;
}

function template(args: string[]) {
  return execa("pnpm", ["exec", "tsx", cliPath, ...args], { cwd: repoRoot });
}

async function expectTemplateFailure(
  args: string[],
  expectedStderr: string | readonly string[],
): Promise<void> {
  try {
    await template(args);
  } catch (error) {
    const stderr = stderrFromError(error);
    const expectedMessages =
      typeof expectedStderr === "string" ? [expectedStderr] : expectedStderr;

    for (const expectedMessage of expectedMessages) {
      expect(stderr).toContain(expectedMessage);
    }

    return;
  }

  throw new Error(`Expected template command to fail: ${args.join(" ")}`);
}

function stderrFromError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    return error.stderr;
  }

  throw error;
}

const stringEnumJsonSchema = v.object({
  enum: v.array(v.string()),
});
const presetJsonSchemaOutput = v.object({
  title: v.string(),
  type: v.string(),
  required: v.array(v.string()),
  properties: v.object({
    supportedProjectKinds: v.object({
      items: stringEnumJsonSchema,
    }),
  }),
});
const blueprintJsonSchemaOutput = v.object({
  title: v.string(),
  type: v.string(),
  required: v.array(v.string()),
  properties: v.object({
    projectKind: stringEnumJsonSchema,
  }),
});
const projectionCapabilityJsonSchema = v.looseObject({
  properties: v.looseObject({
    kind: v.object({
      const: v.string(),
    }),
  }),
});
const presetSourceJsonSchemaOutput = v.object({
  title: v.string(),
  type: v.string(),
  required: v.array(v.string()),
  properties: v.object({
    presets: v.object({
      items: v.object({
        required: v.array(v.string()),
        properties: v.object({
          packageAdditionSupport: stringEnumJsonSchema,
          projection: v.object({
            properties: v.object({
              capabilities: v.object({
                items: v.object({
                  oneOf: v.array(projectionCapabilityJsonSchema),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
});

function parseJsonWithSchema<const Schema extends v.GenericSchema>(
  text: string,
  schema: Schema,
): v.InferOutput<Schema> {
  return v.parse(schema, JSON.parse(text) as unknown);
}

function validPresetSourceManifest(): PresetSourceManifest {
  return {
    schemaVersion: 1,
    name: "custom-source",
    sharedResources: [{ id: "shared-oxc-node", path: "shared/oxc/node" }],
    presets: [
      {
        name: "custom-lib",
        title: "Custom library",
        description: "A custom strict TypeScript library preset.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: "unsupported",
        features: ["strict-typescript", "root-check"],
      },
    ],
  };
}

function firstPreset(
  manifest: PresetSourceManifest,
): PresetSourceManifestPreset {
  const preset = manifest.presets[0];
  if (!preset) {
    throw new Error("Test manifest must contain a preset");
  }

  return preset;
}

function firstSharedResource(
  manifest: PresetSourceManifest,
): PresetSourceManifestSharedResource {
  const resource = manifest.sharedResources[0];
  if (!resource) {
    throw new Error("Test manifest must contain a shared resource");
  }

  return resource;
}

describe("declaration contracts", () => {
  it("keeps stable declaration vocabulary imported from the Template Contract Library", async () => {
    const declarationConsumerFiles = await discoverDeclarationConsumerFiles();
    const forbiddenImports = [
      "@ykdz/template-core/declarations",
      "@ykdz/template-core/package-addition-support",
      "./declarations.js",
      "./package-addition-support.js",
    ];
    const offenders: string[] = [];

    for (const file of declarationConsumerFiles) {
      const source = await readFile(path.join(repoRoot, file), "utf8");

      for (const forbiddenImport of forbiddenImports) {
        if (source.includes(forbiddenImport)) {
          offenders.push(`${file} imports ${forbiddenImport}`);
        }
      }

      const presetSourceCoreNames = importedDeclarationNames(
        source,
        "@ykdz/template-core/preset-source",
      );
      const importsPresetSourceContractFromCore = presetSourceCoreNames.some(
        (name) =>
          [
            "PresetSourceManifest",
            "PresetSourceManifestPreset",
            "PresetSourceManifestSharedResource",
            "presetSourceManifestJsonSchema",
          ].includes(name),
      );
      if (importsPresetSourceContractFromCore) {
        offenders.push(`${file} imports Preset Source contracts from core`);
      }

      const projectionCoreNames = importedDeclarationNames(
        source,
        "@ykdz/template-core/projection-capabilities",
      );
      const importsProjectionContractFromCore = projectionCoreNames.some(
        (name) =>
          [
            "PresetProjectionDeclaration",
            "ProjectionCapabilityDeclaration",
            "validateProjectionCapabilities",
            "normalizePresetProjectionDeclaration",
          ].includes(name),
      );
      if (importsProjectionContractFromCore) {
        offenders.push(
          `${file} imports Projection Declaration contracts from core`,
        );
      }
    }

    expect(declarationConsumerFiles).toContain("packages/cli/src/cli.ts");
    expect(offenders).toEqual([]);
  });

  it("accepts a Project Blueprint through the Template Contract Library", () => {
    expect(
      validateSharedProjectBlueprint({
        schemaVersion: 1,
        preset: "ts-lib",
        packageManager: "pnpm",
        projectKind: "multi-package",
        features: ["pnpm-catalog"],
      }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        preset: "ts-lib",
        packageManager: "pnpm",
        projectKind: "multi-package",
        features: ["pnpm-catalog"],
      },
    });
  });

  it("validates Preset Source Manifest declarations through the Template Contract Library", () => {
    expect(
      validatePresetSourceManifestDeclaration(validPresetSourceManifest()),
    ).toEqual({
      ok: true,
      value: {
        ...validPresetSourceManifest(),
        presets: [
          {
            ...firstPreset(validPresetSourceManifest()),
            dependencyCatalog: [],
          },
        ],
      },
    });

    const builtInResult = validatePresetSourceManifestDeclaration(
      loadBuiltInPresetSourceManifest(),
    );
    expect(builtInResult).toMatchObject({ ok: true });
    if (!builtInResult.ok) {
      throw new Error("Built-in Preset Source Manifest must be valid");
    }
    const builtInProviderPackagePaths = [
      ...new Set(
        builtInResult.value.presets.flatMap((preset) =>
          (preset.projection?.capabilities ?? []).flatMap((capability) =>
            capability.kind === "workspace-node-packages"
              ? (capability.packageLinks ?? []).map(
                  (link) => link.providerPackagePath,
                )
              : [],
          ),
        ),
      ),
    ].toSorted();
    expect(builtInProviderPackagePaths).toContain("packages/db");
    expect(Object.hasOwn(builtInResult.value, "fixtureMatrix")).toBe(false);

    const duplicateManifest = validPresetSourceManifest();
    duplicateManifest.presets = [
      ...duplicateManifest.presets,
      { ...duplicateManifest.presets[0]! },
    ];

    expect(validatePresetSourceManifestDeclaration(duplicateManifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets.name",
          message: "Duplicate Preset name: custom-lib",
        },
      ],
    });
  });

  it("validates Projection Capability Shared Resource ids against Preset Source-local resources", () => {
    const manifest = validPresetSourceManifest();
    manifest.sharedResources = [
      { id: "custom-editor-declarations", path: "shared/editor.json" },
      { id: "custom-devcontainer-fragments", path: "shared/devcontainer" },
    ];
    firstPreset(manifest).projection = {
      capabilities: [
        {
          kind: "workspace-library-package",
          workspacePackageGlob: "packages/*",
          packageRole: "shared-library",
          packageSourcePreset: "ts-lib",
          sourceFiles: ["src/index.ts"],
        },
        { kind: "strict-typescript-root" },
        {
          kind: "oxc-format-lint",
          editorCustomizationResourceId: "custom-editor-declarations",
        },
        {
          kind: "node-pnpm-devcontainer",
          devcontainerResourceId: "custom-devcontainer-fragments",
        },
        { kind: "github-maintenance" },
      ],
    };

    expect(validatePresetSourceManifestDeclaration(manifest)).toEqual({
      ok: true,
      value: {
        ...manifest,
        presets: [
          {
            ...firstPreset(manifest),
            dependencyCatalog: [],
          },
        ],
      },
    });

    const unknownResourceManifest: PresetSourceManifest = {
      ...manifest,
      presets: [
        {
          ...firstPreset(manifest),
          projection: {
            capabilities: [
              ...firstPreset(manifest).projection!.capabilities.slice(0, 2),
              {
                kind: "oxc-format-lint",
                editorCustomizationResourceId: "missing-editor-declarations",
              },
              ...firstPreset(manifest).projection!.capabilities.slice(3),
            ],
          },
        },
      ],
    };

    expect(
      validatePresetSourceManifestDeclaration(unknownResourceManifest),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].projection.capabilities[2].editorCustomizationResourceId",
          message:
            "Projection Capability oxc-format-lint references undeclared Shared Resource: missing-editor-declarations",
        },
      ],
    });
  });

  it("validates Projection Declarations through the Template Contract Library", () => {
    const declaration = normalizePresetProjectionDeclaration({
      capabilities: [
        {
          kind: "workspace-library-package",
          workspacePackageGlob: "packages/*",
          packageRole: "shared-library",
          packageSourcePreset: "ts-lib",
          sourceFiles: ["src/index.ts"],
        },
        { kind: "strict-typescript-root" },
        {
          kind: "oxc-format-lint",
          editorCustomizationResourceId: "shared-editor-customization",
        },
        {
          kind: "node-pnpm-devcontainer",
          devcontainerResourceId: "shared-devcontainer",
        },
        { kind: "github-maintenance" },
      ],
    });

    expect(validatePresetProjectionDeclaration(declaration)).toEqual({
      ok: true,
      value: declaration,
    });
    expect(
      validatePresetProjectionDeclaration({
        capabilities: [{ kind: "unknown-capability" }],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[0].kind",
          message: "Unknown Projection Capability kind: unknown-capability",
        },
      ],
    });
    expect(
      validatePresetProjectionDeclaration({
        capabilities: [
          {
            kind: "workspace-library-package",
            workspacePackageGlob: "packages/*",
            packageRole: "shared-library",
            packageSourcePreset: "ts-lib",
            sourceFiles: ["src/index.ts"],
          },
          { kind: "strict-typescript-root" },
          { kind: "oxc-format-lint" },
          { kind: "node-pnpm-devcontainer" },
          { kind: "github-maintenance" },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[2].editorCustomizationResourceId",
          message:
            "oxc-format-lint must declare an editorCustomizationResourceId Shared Resource id",
        },
        {
          path: "$.capabilities[3].devcontainerResourceId",
          message:
            "node-pnpm-devcontainer must declare a devcontainerResourceId Shared Resource id",
        },
      ],
    });
    expect(
      validatePresetProjectionDeclaration({
        capabilities: [
          {
            kind: "rust-binary-workspace",
            workspacePackageGlob: "packages/*",
            sourceFiles: ["src/main.rs"],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[0].devcontainerResourceId",
          message:
            "rust-binary-workspace must declare a devcontainerResourceId Shared Resource id",
        },
        {
          path: "$.capabilities[0].editorCustomizationResourceId",
          message:
            "rust-binary-workspace must declare an editorCustomizationResourceId Shared Resource id",
        },
      ],
    });
  });

  it("lists the built-in preset catalog", async () => {
    const result = await template(["presets"]);

    expect(result.stdout).toContain("Built-in presets");
    expect(result.stdout).toContain("ts-lib");
    expect(result.stdout).toContain("TypeScript library");
    expect(result.stdout).toContain("vue-app");
    expect(result.stdout).toContain("Vue app");
    expect(result.stdout).toContain("vue-hono-app");
    expect(result.stdout).toContain("Vue Hono app");
    expect(result.stdout).toContain("(supported)");
  });

  it("prints published JSON Schemas for declarations", async () => {
    const presetSchema = parseJsonWithSchema(
      (await template(["schema", "preset"])).stdout,
      presetJsonSchemaOutput,
    );
    const blueprintSchema = parseJsonWithSchema(
      (await template(["schema", "blueprint"])).stdout,
      blueprintJsonSchemaOutput,
    );

    expect(presetSchema).toMatchObject({
      title: "Project Kit Preset File",
      type: "object",
    });
    expect(presetSchema.required).toContain("name");
    expect(presetSchema.required).toContain("features");
    expect(presetSchema.properties.supportedProjectKinds.items.enum).toEqual([
      "multi-package",
    ]);

    expect(blueprintSchema).toMatchObject({
      title: "Project Kit Blueprint",
      type: "object",
    });
    expect(blueprintSchema.required).toContain("preset");
    expect(blueprintSchema.required).not.toContain("packageManager");
    expect(blueprintSchema.properties.projectKind.enum).toEqual([
      "multi-package",
    ]);
  });

  it("prints the Preset Source Manifest JSON Schema", async () => {
    const presetSourceSchema = parseJsonWithSchema(
      (await template(["schema", "preset-source"])).stdout,
      presetSourceJsonSchemaOutput,
    );

    expect(presetSourceSchema).toMatchObject({
      title: "Preset Source Manifest",
      type: "object",
    });
    expect(presetSourceSchema.required).toContain("presets");
    expect(Object.hasOwn(presetSourceSchema.properties, "fixtureMatrix")).toBe(
      false,
    );
    expect(presetSourceSchema.properties.presets.items.required).toEqual(
      expect.arrayContaining([
        "name",
        "title",
        "description",
        "generation",
        "supportedPackageManagers",
        "supportedProjectKinds",
        "packageAdditionSupport",
        "features",
      ]),
    );
    expect(
      presetSourceSchema.properties.presets.items.properties
        .packageAdditionSupport.enum,
    ).toEqual(["supported", "unsupported"]);

    const capabilitySchemas =
      presetSourceSchema.properties.presets.items.properties.projection
        .properties.capabilities.items.oneOf;
    const nodeWorkspaceSchema = capabilitySchemas.find(
      (schema) => schema.properties.kind.const === "workspace-node-packages",
    );
    const rustBinaryWorkspaceSchema = capabilitySchemas.find(
      (schema) => schema.properties.kind.const === "rust-binary-workspace",
    );
    const oxcFormatLintSchema = capabilitySchemas.find(
      (schema) => schema.properties.kind.const === "oxc-format-lint",
    );
    const nodePnpmDevcontainerSchema = capabilitySchemas.find(
      (schema) => schema.properties.kind.const === "node-pnpm-devcontainer",
    );
    const builtInProviderPackagePaths = [
      ...new Set(
        loadBuiltInPresetSourceManifest().presets.flatMap((preset) =>
          (preset.projection?.capabilities ?? []).flatMap((capability) =>
            capability.kind === "workspace-node-packages"
              ? (capability.packageLinks ?? []).map(
                  (link) => link.providerPackagePath,
                )
              : [],
          ),
        ),
      ),
    ].toSorted();
    const supportedProviderPackagePaths = ["apps/api", "packages/db"];

    expect(builtInProviderPackagePaths).toContain("packages/db");
    expect(supportedProviderPackagePaths).toEqual(
      expect.arrayContaining(builtInProviderPackagePaths),
    );

    expect(nodeWorkspaceSchema).toMatchObject({
      additionalProperties: false,
      required: ["kind", "workspacePackageGlob", "packages"],
      properties: {
        workspacePackageGlob: { const: "apps/*" },
        packages: {
          minItems: 1,
          items: {
            additionalProperties: false,
            required: ["kind", "path", "sourceFiles"],
            properties: {
              kind: { enum: ["hono-api", "vike-app", "vue-app"] },
              path: { enum: ["apps/api", "apps/web"] },
              sourceFiles: { minItems: 1 },
            },
          },
        },
        packageLinks: {
          items: {
            additionalProperties: false,
            required: ["consumerPackagePath", "providerPackagePath"],
            properties: {
              consumerPackagePath: { const: "apps/web" },
              providerPackagePath: { enum: supportedProviderPackagePaths },
            },
          },
        },
      },
    });
    expect(rustBinaryWorkspaceSchema).toMatchObject({
      additionalProperties: false,
      required: [
        "kind",
        "workspacePackageGlob",
        "sourceFiles",
        "devcontainerResourceId",
        "editorCustomizationResourceId",
      ],
      properties: {
        devcontainerResourceId: { type: "string", minLength: 1 },
        editorCustomizationResourceId: { type: "string", minLength: 1 },
      },
    });
    expect(oxcFormatLintSchema).toMatchObject({
      additionalProperties: false,
      required: ["kind", "editorCustomizationResourceId"],
      properties: {
        editorCustomizationResourceId: { type: "string", minLength: 1 },
      },
    });
    expect(nodePnpmDevcontainerSchema).toMatchObject({
      additionalProperties: false,
      required: ["kind", "devcontainerResourceId"],
      properties: {
        devcontainerResourceId: { type: "string", minLength: 1 },
      },
    });
  });

  it("validates Preset Source Manifest references relative to the manifest file through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-cli-"));
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validPresetSourceManifest();
    firstPreset(manifest).source = {
      files: ["custom-lib/src/index.ts"],
      roots: [],
      sharedResources: [],
    };

    await mkdir(path.join(workspace, "shared/oxc/node"), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await expectTemplateFailure(
      ["preset-source", "validate", manifestPath],
      "Preset custom-lib source file does not exist: custom-lib/src/index.ts",
    );
  });

  it("rejects Preset Source Manifest path escapes through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-cli-"));
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validPresetSourceManifest();
    firstSharedResource(manifest).path = "../shared/oxc/node";

    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await expectTemplateFailure(
      ["preset-source", "validate", manifestPath],
      "Preset Source path escapes its source boundary: ../shared/oxc/node",
    );
  });

  it("advertises pnpm support for the Rust preset task layer", () => {
    expect(findBuiltInPreset("rust-bin")?.supportedPackageManagers).toEqual([
      "pnpm",
    ]);
  });

  it("validates a workspace monorepo JSON preset file through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-preset-"));
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-lib",
          title: "Custom library",
          description: "A custom strict TypeScript library preset.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["multi-package"],
          features: ["strict-typescript", "root-check"],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["preset", "validate", presetPath]);

    expect(result.stdout).toContain("Preset file is valid");
    expect(result.stdout).toContain("custom-lib");
  });

  it("validates a Preset Source Manifest through the CLI", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-source-"),
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-source",
          presets: [
            {
              name: "custom-lib",
              title: "Custom library",
              description: "A custom strict TypeScript library preset.",
              generation: "supported",
              supportedPackageManagers: ["pnpm"],
              supportedProjectKinds: ["multi-package"],
              packageAdditionSupport: "unsupported",
              features: ["strict-typescript", "root-check"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["preset-source", "validate", manifestPath]);

    expect(result.stdout).toContain("Preset Source Manifest is valid");
    expect(result.stdout).toContain("custom-source");
    expect(result.stdout).toContain("custom-lib");
  });

  it("rejects duplicate Preset Source Manifest array values through the CLI", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-source-duplicates-"),
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-source",
          presets: [
            {
              name: "custom-lib",
              title: "Custom library",
              description: "A custom strict TypeScript library preset.",
              generation: "supported",
              supportedPackageManagers: ["pnpm", "pnpm"],
              supportedProjectKinds: ["multi-package", "multi-package"],
              packageAdditionSupport: "unsupported",
              features: ["strict-typescript", "strict-typescript"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["preset-source", "validate", manifestPath],
      [
        "$.presets[0].supportedPackageManagers: Duplicate value: pnpm",
        "$.presets[0].supportedProjectKinds: Duplicate value: multi-package",
        "$.presets[0].features: Duplicate value: strict-typescript",
      ],
    );
  });

  it("validates the built-in Preset Source Manifest through the CLI", async () => {
    const result = await template([
      "preset-source",
      "validate",
      "packages/builtin-source/templates/preset-source.json",
    ]);

    expect(result.stdout).toContain("Preset Source Manifest is valid");
    expect(result.stdout).toContain("built-in");
    expect(result.stdout).toContain("ts-lib");
    expect(result.stdout).toContain("vue-hono-app");
    expect(result.stdout).toContain("rust-bin");
  });

  it("rejects supported built-in Preset Source Manifests without Projection Declarations through the CLI", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-source-bridge-"),
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "built-in",
          presets: [
            {
              name: "missing-supported",
              title: "Missing supported preset",
              description: "A supported built-in preset with no projection.",
              generation: "supported",
              supportedPackageManagers: ["pnpm"],
              supportedProjectKinds: ["multi-package"],
              packageAdditionSupport: "unsupported",
              features: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["preset-source", "validate", manifestPath],
      "Supported Preset missing-supported must declare a Projection Declaration",
    );
  });

  it("rejects preset files that claim single-package support in V1", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-single-package-preset-"),
    );
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-lib",
          title: "Custom library",
          description: "A custom strict TypeScript library preset.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["single-package"],
          features: ["strict-typescript", "root-check"],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["preset", "validate", presetPath],
      "single-package Project Shape is unsupported in V1",
    );
  });

  it("rejects future built-in preset references in preset files", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-future-preset-"),
    );
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "node-cli",
          title: "Node CLI",
          description: "A future built-in preset reference.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["multi-package"],
          features: [],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["preset", "validate", presetPath],
      "Preset node-cli is not supported for generation in this version",
    );
  });

  it("rejects Post Commands in user Preset Files", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-post-commands-"),
    );
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-lib",
          title: "Custom library",
          description: "A custom strict TypeScript library preset.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["single-package"],
          features: ["strict-typescript", "root-check"],
          postCommands: [
            {
              command: "pnpm",
              args: ["install"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["preset", "validate", presetPath],
      ["Preset file is invalid", "$.postCommands"],
    );
  });

  it("validates a project blueprint against the built-in preset catalog", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-blueprint-"));
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: ["strict-typescript", "root-check"],
          packages: [{ name: "@demo-lib/demo-lib", path: "packages/demo-lib" }],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["blueprint", "validate", blueprintPath]);

    expect(result.stdout).toContain("Blueprint is valid");
    expect(result.stdout).toContain("ts-lib");
  });

  it("validates stable Package Definition intent in project blueprints", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-package-definition-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: ["strict-typescript", "root-check"],
          packages: [
            {
              name: "@demo-lib/demo-lib",
              path: "packages/demo-lib",
              role: "shared-library",
              sourcePreset: "ts-lib",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["blueprint", "validate", blueprintPath]);

    expect(result.stdout).toContain("Blueprint is valid");
    expect(result.stdout).toContain("ts-lib");
  });

  it("validates a multi-package vue-hono-app blueprint", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-fullstack-blueprint-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "vue-hono-app",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: ["strict-typescript", "root-check"],
          packages: [
            { name: "@demo/web", path: "apps/web" },
            { name: "@demo/api", path: "apps/api" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["blueprint", "validate", blueprintPath]);

    expect(result.stdout).toContain("Blueprint is valid");
    expect(result.stdout).toContain("vue-hono-app");
  });

  it("reports schema validation failures with useful paths", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-invalid-"));
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          name: "",
          title: "Broken preset",
          description: "Missing required declaration fields.",
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["preset", "validate", presetPath],
      ["Preset file is invalid", "$.schemaVersion"],
    );
  });

  it("reports semantic blueprint failures before generation", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-semantic-"));
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-app",
          packageManager: "pnpm",
          projectKind: "single-package",
          features: ["strict-typescript"],
          packages: [
            { name: "app", path: "packages/app" },
            { name: "app", path: "packages/app" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["blueprint", "validate", blueprintPath],
      [
        "strict-typescript is not supported by preset ts-app",
        "$.packages.name",
      ],
    );
  });

  it("rejects single-package blueprints because V1 only supports workspace monorepos", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-single-package-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "single-package",
          features: ["strict-typescript", "root-check"],
          packages: [{ name: "api", path: "packages/api" }],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["blueprint", "validate", blueprintPath],
      "single-package Project Shape is unsupported in V1",
    );
  });

  it("rejects root Package Boundary paths in project blueprints", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-root-package-boundary-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: ["strict-typescript", "root-check"],
          packages: [{ name: "app", path: "." }],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["blueprint", "validate", blueprintPath],
      [
        "$.packages[0].path",
        "Package Path must be exactly two non-root path segments",
      ],
    );
  });

  it("rejects future built-in presets in project blueprints", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-future-blueprint-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-app",
          packageManager: "pnpm",
          projectKind: "single-package",
          features: [],
          packages: [{ name: "app", path: "." }],
        },
        null,
        2,
      )}\n`,
    );

    await expectTemplateFailure(
      ["blueprint", "validate", blueprintPath],
      "Preset ts-app is not supported for generation in this version",
    );
  });

  it("accepts only JSON declaration files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-only-"));
    const presetPath = path.join(workspace, "preset.yaml");
    await writeFile(presetPath, "schemaVersion: 1\n");

    await expectTemplateFailure(
      ["preset", "validate", presetPath],
      "Declaration files must be JSON",
    );
  });
});
