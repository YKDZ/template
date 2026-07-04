import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import * as v from "valibot";

import type {
  BuiltInPreset,
  FeatureName,
  PackageManager,
  ProjectKind,
  ValidationIssue,
  ValidationResult,
} from "./declarations.js";
import {
  loadTemplateDependencyCatalog,
  type TemplateDependencyCatalog,
} from "./dependency-catalog.js";
import { PackageAdditionSupport } from "./package-addition-support.js";
import {
  normalizePresetProjectionDeclaration,
  projectionCapabilityIssues,
  type PresetProjectionDeclaration,
} from "./projection-capabilities.js";

export type PresetSourceManifestPresetSource = {
  roots: string[];
  files: string[];
  sharedResources: string[];
};

export type PresetSourceManifestPreset = BuiltInPreset & {
  dependencyCatalog?: string[];
  projection?: PresetProjectionDeclaration;
  source?: PresetSourceManifestPresetSource;
};

export type PresetSourceManifestSharedResource = {
  id: string;
  path: string;
};

export type PresetSourceFixtureMatrixPresetSupport = {
  preset: string;
};

export type PresetSourceFixtureMatrixPackageAdditionSupport = {
  preset: string;
  packageLeafName: string;
};

export type PresetSourceFixtureMatrixCombination = {
  basePreset: string;
  addedPreset: string;
  linkFrom?: string[];
};

export type PresetSourceFixtureMatrixSemanticSkip = {
  basePreset: string;
  addedPreset: string;
  reason: string;
};

export type PresetSourceFixtureMatrixContract = {
  initSupport: PresetSourceFixtureMatrixPresetSupport[];
  packageAdditionSupport: PresetSourceFixtureMatrixPackageAdditionSupport[];
  supportedCombinations: PresetSourceFixtureMatrixCombination[];
  semanticSkips: PresetSourceFixtureMatrixSemanticSkip[];
  checkRequirements: string[];
  environmentPreparation: string[];
};

export type PresetSourceManifest = {
  schemaVersion: 1;
  name: string;
  sharedResources: PresetSourceManifestSharedResource[];
  fixtureMatrix?: PresetSourceFixtureMatrixContract;
  presets: PresetSourceManifestPreset[];
};

export type PresetSourceManifestValidationOptions = {
  readonly sourceRoot?: string;
  readonly dependencyCatalog?: TemplateDependencyCatalog;
};

const featureNames = [
  "pnpm-catalog",
  "oxc-format-lint",
  "strict-typescript",
  "root-check",
  "fix-command",
  "devcontainer",
  "github-actions",
  "dependabot",
  "rustfmt-clippy",
  "cargo-test",
  "native-binary-release",
] satisfies FeatureName[];

const packageLeafNamePattern = "^[a-z0-9][a-z0-9-]*$";
const packageLeafNameRegExp = new RegExp(packageLeafNamePattern);
const requiredFixtureMatrixCheckRequirements = [
  "machine-verifiable-next-steps",
  "root-check-ci",
] as const;
const requiredFixtureMatrixEnvironmentPreparation = [
  "playwright-browser-assets",
] as const;

export const presetSourceManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ykdz.dev/schemas/template/preset-source-manifest.schema.json",
  title: "Preset Source Manifest",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name", "presets"],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1 },
    sharedResources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path"],
        properties: {
          id: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
        },
      },
    },
    fixtureMatrix: {
      type: "object",
      additionalProperties: false,
      required: [
        "initSupport",
        "packageAdditionSupport",
        "supportedCombinations",
        "semanticSkips",
        "checkRequirements",
        "environmentPreparation",
      ],
      properties: {
        initSupport: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["preset"],
            properties: {
              preset: { type: "string", minLength: 1 },
            },
          },
        },
        packageAdditionSupport: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["preset", "packageLeafName"],
            properties: {
              preset: { type: "string", minLength: 1 },
              packageLeafName: {
                type: "string",
                minLength: 1,
                pattern: packageLeafNamePattern,
              },
            },
          },
        },
        supportedCombinations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["basePreset", "addedPreset"],
            properties: {
              basePreset: { type: "string", minLength: 1 },
              addedPreset: { type: "string", minLength: 1 },
              linkFrom: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
        semanticSkips: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["basePreset", "addedPreset", "reason"],
            properties: {
              basePreset: { type: "string", minLength: 1 },
              addedPreset: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
            },
          },
        },
        checkRequirements: {
          type: "array",
          items: {
            enum: [...requiredFixtureMatrixCheckRequirements],
          },
          uniqueItems: true,
        },
        environmentPreparation: {
          type: "array",
          items: {
            enum: [...requiredFixtureMatrixEnvironmentPreparation],
          },
          uniqueItems: true,
        },
      },
    },
    presets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "title",
          "description",
          "generation",
          "supportedPackageManagers",
          "supportedProjectKinds",
          "packageAdditionSupport",
          "features",
        ],
        properties: {
          name: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          generation: { enum: ["supported", "future"] },
          supportedPackageManagers: {
            type: "array",
            items: { enum: ["pnpm"] },
            uniqueItems: true,
          },
          supportedProjectKinds: {
            type: "array",
            minItems: 1,
            items: { enum: ["multi-package"] },
            uniqueItems: true,
          },
          packageAdditionSupport: {
            enum: [
              PackageAdditionSupport.Supported,
              PackageAdditionSupport.Unsupported,
            ],
          },
          features: {
            type: "array",
            items: { enum: featureNames },
            uniqueItems: true,
          },
          dependencyCatalog: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
          projection: {
            type: "object",
            additionalProperties: false,
            required: ["capabilities"],
            properties: {
              capabilities: {
                type: "array",
                items: {
                  oneOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "kind",
                        "workspacePackageGlob",
                        "packageRole",
                        "packageSourcePreset",
                        "sourceFiles",
                      ],
                      properties: {
                        kind: { const: "workspace-library-package" },
                        workspacePackageGlob: { const: "packages/*" },
                        packageRole: { const: "shared-library" },
                        packageSourcePreset: { const: "ts-lib" },
                        sourceFiles: {
                          type: "array",
                          minItems: 1,
                          items: { type: "string", minLength: 1 },
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind", "workspacePackageGlob", "packages"],
                      properties: {
                        kind: { const: "workspace-node-packages" },
                        workspacePackageGlob: { const: "apps/*" },
                        packages: {
                          type: "array",
                          minItems: 1,
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["kind", "path", "sourceFiles"],
                            properties: {
                              kind: { enum: ["hono-api", "vue-app"] },
                              path: { enum: ["apps/api", "apps/web"] },
                              sourceFiles: {
                                type: "array",
                                minItems: 1,
                                items: { type: "string", minLength: 1 },
                              },
                            },
                          },
                        },
                        packageLinks: {
                          type: "array",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: [
                              "consumerPackagePath",
                              "providerPackagePath",
                            ],
                            properties: {
                              consumerPackagePath: { const: "apps/web" },
                              providerPackagePath: { const: "apps/api" },
                            },
                          },
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind", "workspacePackageGlob", "sourceFiles"],
                      properties: {
                        kind: { const: "rust-binary-workspace" },
                        workspacePackageGlob: { const: "packages/*" },
                        sourceFiles: {
                          type: "array",
                          minItems: 1,
                          items: { type: "string", minLength: 1 },
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: {
                        kind: { const: "strict-typescript-root" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: {
                        kind: { const: "oxc-format-lint" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: {
                        kind: { const: "node-pnpm-devcontainer" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: {
                        kind: { const: "github-maintenance" },
                      },
                    },
                  ],
                },
              },
            },
          },
          source: {
            type: "object",
            additionalProperties: false,
            properties: {
              roots: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              files: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              sharedResources: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const packageManagerSchema = v.picklist(["pnpm"] as const);
const projectKindSchema = v.picklist([
  "single-package",
  "multi-package",
] as const);
const packageAdditionSupportSchema = v.picklist([
  PackageAdditionSupport.Supported,
  PackageAdditionSupport.Unsupported,
] as const);
const featureNameSchema = v.picklist(featureNames);
const presetSourceManifestPresetSourceSchema = v.strictObject({
  roots: v.optional(v.array(nonEmptyString), []),
  files: v.optional(v.array(nonEmptyString), []),
  sharedResources: v.optional(v.array(nonEmptyString), []),
});
const fixtureMatrixPresetSupportSchema = v.strictObject({
  preset: nonEmptyString,
});
const fixtureMatrixPackageAdditionSupportSchema = v.strictObject({
  preset: nonEmptyString,
  packageLeafName: v.pipe(
    v.string(),
    v.regex(
      packageLeafNameRegExp,
      "Fixture Matrix Package Addition packageLeafName must be a lowercase package leaf name using letters, numbers, and hyphens",
    ),
  ),
});
const fixtureMatrixCombinationSchema = v.strictObject({
  basePreset: nonEmptyString,
  addedPreset: nonEmptyString,
  linkFrom: v.optional(v.array(nonEmptyString), []),
});
const fixtureMatrixSemanticSkipSchema = v.strictObject({
  basePreset: nonEmptyString,
  addedPreset: nonEmptyString,
  reason: nonEmptyString,
});
const fixtureMatrixContractSchema = v.strictObject({
  initSupport: v.array(fixtureMatrixPresetSupportSchema),
  packageAdditionSupport: v.array(fixtureMatrixPackageAdditionSupportSchema),
  supportedCombinations: v.array(fixtureMatrixCombinationSchema),
  semanticSkips: v.array(fixtureMatrixSemanticSkipSchema),
  checkRequirements: v.array(
    v.picklist(requiredFixtureMatrixCheckRequirements),
  ),
  environmentPreparation: v.array(
    v.picklist(requiredFixtureMatrixEnvironmentPreparation),
  ),
});
const projectionCapabilityKindSchema = v.string();
const presetProjectionDeclarationSchema = v.strictObject({
  capabilities: v.array(
    v.looseObject({
      kind: projectionCapabilityKindSchema,
    }),
  ),
});

const presetSourceManifestSchema = v.strictObject({
  schemaVersion: v.literal(1),
  name: nonEmptyString,
  sharedResources: v.optional(
    v.array(
      v.strictObject({
        id: nonEmptyString,
        path: nonEmptyString,
      }),
    ),
    [],
  ),
  fixtureMatrix: v.optional(fixtureMatrixContractSchema),
  presets: v.pipe(
    v.array(
      v.strictObject({
        name: nonEmptyString,
        title: nonEmptyString,
        description: nonEmptyString,
        generation: v.picklist(["supported", "future"] as const),
        supportedPackageManagers: v.array(packageManagerSchema),
        supportedProjectKinds: v.pipe(
          v.array(projectKindSchema),
          v.minLength(1),
        ),
        packageAdditionSupport: packageAdditionSupportSchema,
        features: v.array(featureNameSchema),
        dependencyCatalog: v.optional(v.array(nonEmptyString), []),
        projection: v.optional(presetProjectionDeclarationSchema),
        source: v.optional(presetSourceManifestPresetSourceSchema),
      }),
    ),
    v.minLength(1),
  ),
});

function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  if (!issue.path || issue.path.length === 0) {
    return "$";
  }

  return issue.path.reduce((issuePath, item) => {
    if (typeof item.key === "number") {
      return `${issuePath}[${item.key}]`;
    }

    return `${issuePath}.${String(item.key)}`;
  }, "$");
}

function shapeIssues(issues: v.BaseIssue<unknown>[]): ValidationIssue[] {
  return issues.map((issue) => {
    const validationPath = formatIssuePath(issue);
    const missingPresetMetadata = validationPath.match(
      /^\$\.presets\[\d+\]\.(.+)$/,
    );

    if (missingPresetMetadata && issue.message.includes("received undefined")) {
      return {
        path: validationPath,
        message: `Preset metadata is missing required field: ${missingPresetMetadata[1]}`,
      };
    }

    if (
      issue.message.startsWith("Invalid key:") &&
      /\.(body|content|text)$/.test(validationPath)
    ) {
      const key = validationPath.split(".").at(-1);

      return {
        path: validationPath,
        message: `Preset Source Manifests must reference Generated Repository file bodies by path, not inline ${key}`,
      };
    }

    return {
      path: validationPath,
      message: validationPath.match(
        /^\$\.presets\[\d+\]\.packageAdditionSupport$/,
      )
        ? "Package Addition Support must be one of: supported, unsupported"
        : issue.message,
    };
  });
}

function duplicatePresetNameIssues(
  presets: readonly PresetSourceManifestPreset[],
): ValidationIssue[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const preset of presets) {
    if (seen.has(preset.name)) {
      duplicates.add(preset.name);
    }
    seen.add(preset.name);
  }

  return [...duplicates].map((name) => ({
    path: "$.presets.name",
    message: `Duplicate Preset name: ${name}`,
  }));
}

function duplicateValueIssues(
  values: readonly string[],
  validationPath: string,
): ValidationIssue[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].map((value) => ({
    path: validationPath,
    message: `Duplicate value: ${value}`,
  }));
}

function duplicatePresetMetadataArrayIssues(
  presets: readonly PresetSourceManifestPreset[],
): ValidationIssue[] {
  return presets.flatMap((preset, index) => [
    ...duplicateValueIssues(
      preset.supportedPackageManagers,
      `$.presets[${index}].supportedPackageManagers`,
    ),
    ...duplicateValueIssues(
      preset.supportedProjectKinds,
      `$.presets[${index}].supportedProjectKinds`,
    ),
    ...duplicateValueIssues(preset.features, `$.presets[${index}].features`),
    ...duplicateValueIssues(
      preset.dependencyCatalog ?? [],
      `$.presets[${index}].dependencyCatalog`,
    ),
  ]);
}

function fixtureCombinationKey(
  combination: Pick<
    PresetSourceFixtureMatrixCombination,
    "basePreset" | "addedPreset" | "linkFrom"
  >,
): string {
  return [
    combination.basePreset,
    combination.addedPreset,
    ...(combination.linkFrom ?? []),
  ].join("\0");
}

function fixtureCombinationPairKey(
  combination: Pick<
    PresetSourceFixtureMatrixCombination,
    "basePreset" | "addedPreset"
  >,
): string {
  return [combination.basePreset, combination.addedPreset].join("\0");
}

function fixtureMatrixContractIssues(
  manifest: PresetSourceManifest,
): ValidationIssue[] {
  if (!manifest.fixtureMatrix) {
    return [];
  }

  const issues: ValidationIssue[] = [];
  const presetsByName = new Map(
    manifest.presets.map((preset) => [preset.name, preset]),
  );
  const initPresets = new Set(
    manifest.fixtureMatrix.initSupport.map((support) => support.preset),
  );
  const addablePresets = new Set(
    manifest.fixtureMatrix.packageAdditionSupport.map(
      (support) => support.preset,
    ),
  );
  const validInitPresets = new Set<string>();
  const validAddablePresets = new Set<string>();
  const supportedCombinationKeys = new Set<string>();
  const supportedCombinationPairKeys = new Set<string>();
  const semanticSkipKeys = new Set<string>();
  const semanticSkipPairKeys = new Set<string>();

  manifest.fixtureMatrix.initSupport.forEach((support, index) => {
    const preset = presetsByName.get(support.preset);
    if (!preset) {
      issues.push({
        path: `$.fixtureMatrix.initSupport[${index}].preset`,
        message: `Fixture Matrix init support references unknown Preset: ${support.preset}`,
      });
      return;
    }

    if (preset.generation !== "supported") {
      issues.push({
        path: `$.fixtureMatrix.initSupport[${index}].preset`,
        message: `Fixture Matrix init support must reference supported Presets: ${support.preset}`,
      });
      return;
    }

    validInitPresets.add(support.preset);
  });

  manifest.presets.forEach((preset, index) => {
    if (
      preset.generation === "supported" &&
      preset.packageAdditionSupport === PackageAdditionSupport.Supported &&
      !addablePresets.has(preset.name)
    ) {
      issues.push({
        path: `$.presets[${index}].packageAdditionSupport`,
        message: `Fixture Matrix Package Addition support must declare supported Preset: ${preset.name}`,
      });
    }
  });

  manifest.fixtureMatrix.packageAdditionSupport.forEach((support, index) => {
    const preset = presetsByName.get(support.preset);
    if (!preset) {
      issues.push({
        path: `$.fixtureMatrix.packageAdditionSupport[${index}].preset`,
        message: `Fixture Matrix Package Addition support references unknown Preset: ${support.preset}`,
      });
      return;
    }

    if (preset.packageAdditionSupport !== PackageAdditionSupport.Supported) {
      issues.push({
        path: `$.fixtureMatrix.packageAdditionSupport[${index}].preset`,
        message: `Fixture Matrix Package Addition support must match Preset metadata: ${support.preset} is ${preset.packageAdditionSupport}`,
      });
      return;
    }

    validAddablePresets.add(support.preset);
  });

  manifest.fixtureMatrix.supportedCombinations.forEach((combination, index) => {
    const key = fixtureCombinationKey(combination);
    supportedCombinationPairKeys.add(fixtureCombinationPairKey(combination));
    if (supportedCombinationKeys.has(key)) {
      issues.push({
        path: `$.fixtureMatrix.supportedCombinations[${index}]`,
        message: `Duplicate Fixture Matrix supported combination: ${combination.basePreset} + ${combination.addedPreset}`,
      });
    }
    supportedCombinationKeys.add(key);

    if (!initPresets.has(combination.basePreset)) {
      issues.push({
        path: `$.fixtureMatrix.supportedCombinations[${index}].basePreset`,
        message: `Fixture Matrix supported combination base Preset is not init-supported: ${combination.basePreset}`,
      });
    }

    if (!addablePresets.has(combination.addedPreset)) {
      issues.push({
        path: `$.fixtureMatrix.supportedCombinations[${index}].addedPreset`,
        message: `Fixture Matrix supported combination added Preset is not Package Addition-supported: ${combination.addedPreset}`,
      });
    }
  });

  manifest.fixtureMatrix.semanticSkips.forEach((skip, index) => {
    const key = fixtureCombinationKey(skip);
    semanticSkipPairKeys.add(fixtureCombinationPairKey(skip));
    if (semanticSkipKeys.has(key)) {
      issues.push({
        path: `$.fixtureMatrix.semanticSkips[${index}]`,
        message: `Duplicate Fixture Matrix semantic skip: ${skip.basePreset} + ${skip.addedPreset}`,
      });
    }
    semanticSkipKeys.add(key);

    if (!initPresets.has(skip.basePreset)) {
      issues.push({
        path: `$.fixtureMatrix.semanticSkips[${index}].basePreset`,
        message: `Fixture Matrix semantic skip base Preset is not init-supported: ${skip.basePreset}`,
      });
    }

    if (!presetsByName.has(skip.addedPreset)) {
      issues.push({
        path: `$.fixtureMatrix.semanticSkips[${index}].addedPreset`,
        message: `Fixture Matrix semantic skip references unknown added Preset: ${skip.addedPreset}`,
      });
    }
  });

  for (const basePreset of validInitPresets) {
    for (const addedPreset of validAddablePresets) {
      const key = fixtureCombinationPairKey({ basePreset, addedPreset });
      if (
        !supportedCombinationPairKeys.has(key) &&
        !semanticSkipPairKeys.has(key)
      ) {
        issues.push({
          path: "$.fixtureMatrix.supportedCombinations",
          message: `Fixture Matrix must explicitly cover supported combination or semantic skip: ${basePreset} + ${addedPreset}`,
        });
      }
    }
  }

  for (const checkRequirement of requiredFixtureMatrixCheckRequirements) {
    if (!manifest.fixtureMatrix.checkRequirements.includes(checkRequirement)) {
      issues.push({
        path: "$.fixtureMatrix.checkRequirements",
        message: `Fixture Matrix check requirements must include ${checkRequirement}`,
      });
    }
  }

  for (const environmentPreparation of requiredFixtureMatrixEnvironmentPreparation) {
    if (
      !manifest.fixtureMatrix.environmentPreparation.includes(
        environmentPreparation,
      )
    ) {
      issues.push({
        path: "$.fixtureMatrix.environmentPreparation",
        message: `Fixture Matrix environment preparation must include ${environmentPreparation}`,
      });
    }
  }

  for (const key of semanticSkipPairKeys) {
    if (supportedCombinationPairKeys.has(key)) {
      issues.push({
        path: "$.fixtureMatrix.semanticSkips",
        message:
          "Fixture Matrix semantic skips must not duplicate supported combinations",
      });
    }
  }

  return [
    ...duplicateValueIssues(
      manifest.fixtureMatrix.initSupport.map((support) => support.preset),
      "$.fixtureMatrix.initSupport.preset",
    ),
    ...duplicateValueIssues(
      manifest.fixtureMatrix.packageAdditionSupport.map(
        (support) => support.preset,
      ),
      "$.fixtureMatrix.packageAdditionSupport.preset",
    ),
    ...duplicateValueIssues(
      manifest.fixtureMatrix.checkRequirements,
      "$.fixtureMatrix.checkRequirements",
    ),
    ...duplicateValueIssues(
      manifest.fixtureMatrix.environmentPreparation,
      "$.fixtureMatrix.environmentPreparation",
    ),
    ...issues,
  ];
}

function dependencyCatalogReferenceIssues(
  presets: readonly PresetSourceManifestPreset[],
  dependencyCatalog: TemplateDependencyCatalog,
): ValidationIssue[] {
  return presets.flatMap((preset, presetIndex) =>
    (preset.dependencyCatalog ?? [])
      .filter((dependency) => dependencyCatalog[dependency] === undefined)
      .map((dependency) => ({
        path: `$.presets[${presetIndex}].dependencyCatalog`,
        message: `Preset ${preset.name} references missing Template Dependency Catalog entry: ${dependency}`,
      })),
  );
}

function unsupportedProjectShapeIssues(
  presets: readonly PresetSourceManifestPreset[],
): ValidationIssue[] {
  return presets.flatMap((preset, index) =>
    preset.supportedProjectKinds.includes("single-package")
      ? [
          {
            path: `$.presets[${index}].supportedProjectKinds`,
            message:
              "single-package Project Shape is unsupported in V1; use the workspace monorepo Project Shape",
          },
        ]
      : [],
  );
}

function resolvePresetSourcePath(
  sourceRoot: string,
  referencePath: string,
): string | { issue: string } {
  if (path.isAbsolute(referencePath)) {
    return { issue: `Preset Source paths must be relative: ${referencePath}` };
  }

  const resolvedRoot = path.resolve(sourceRoot);
  const resolvedPath = path.resolve(resolvedRoot, referencePath);
  const insideRoot =
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);

  if (!insideRoot) {
    return {
      issue: `Preset Source path escapes its source boundary: ${referencePath}`,
    };
  }

  return resolvedPath;
}

function realPresetSourcePathIssue(
  sourceRoot: string,
  referencePath: string,
  resolvedPath: string,
): string | undefined {
  const realRoot = realpathSync(sourceRoot);
  const realPath = realpathSync(resolvedPath);
  const insideRoot =
    realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`);

  return insideRoot
    ? undefined
    : `Preset Source path escapes its source boundary: ${referencePath}`;
}

function sharedResourcePathIssues(
  manifest: PresetSourceManifest,
  sourceRoot: string | undefined,
): ValidationIssue[] {
  if (sourceRoot === undefined) {
    return [];
  }

  return manifest.sharedResources.flatMap((resource, index) => {
    const resolvedPath = resolvePresetSourcePath(sourceRoot, resource.path);

    if (typeof resolvedPath !== "string") {
      return [
        {
          path: `$.sharedResources[${index}].path`,
          message: resolvedPath.issue,
        },
      ];
    }

    if (!existsSync(resolvedPath)) {
      return [
        {
          path: `$.sharedResources[${index}].path`,
          message: `Shared Resource ${resource.id} path does not exist: ${resource.path}`,
        },
      ];
    }

    const realPathIssue = realPresetSourcePathIssue(
      sourceRoot,
      resource.path,
      resolvedPath,
    );
    if (realPathIssue) {
      return [
        {
          path: `$.sharedResources[${index}].path`,
          message: realPathIssue,
        },
      ];
    }

    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDependencySemverSpecifier(value: string): boolean {
  return /^(?:[~^]|[<>=]=?)?\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?(?:\s|$|\|\|)/.test(
    value,
  );
}

function inlineDependencyCatalogSpecifierIssues(
  input: unknown,
): ValidationIssue[] {
  if (!isRecord(input) || !Array.isArray(input.presets)) {
    return [];
  }

  return input.presets.flatMap((preset, presetIndex) => {
    if (!isRecord(preset)) {
      return [];
    }

    if (Array.isArray(preset.dependencyCatalog)) {
      return preset.dependencyCatalog.flatMap((specifier, dependencyIndex) =>
        typeof specifier === "string" && isDependencySemverSpecifier(specifier)
          ? [
              {
                path: `$.presets[${presetIndex}].dependencyCatalog[${dependencyIndex}]`,
                message: `Preset Source Manifests must reference Template Dependency Catalog entries by name, not inline semver specifier ${specifier}`,
              },
            ]
          : [],
      );
    }

    if (!isRecord(preset.dependencyCatalog)) {
      return [];
    }

    return Object.entries(preset.dependencyCatalog)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && isDependencySemverSpecifier(entry[1]),
      )
      .map(([dependency, specifier]) => ({
        path: `$.presets[${presetIndex}].dependencyCatalog.${dependency}`,
        message: `Preset Source Manifests must reference Template Dependency Catalog entries by name, not inline semver specifier ${specifier}`,
      }));
  });
}

function presetSourceReferenceIssues(
  manifest: PresetSourceManifest,
  sourceRoot: string | undefined,
): ValidationIssue[] {
  const sharedResourceIds = new Set(
    manifest.sharedResources.map((resource) => resource.id),
  );

  return manifest.presets.flatMap((preset, presetIndex) => {
    const source = preset.source;

    if (!source) {
      return [];
    }

    const sharedResourceIssues = source.sharedResources
      .filter((resourceId) => !sharedResourceIds.has(resourceId))
      .map((resourceId) => ({
        path: `$.presets[${presetIndex}].source.sharedResources`,
        message: `Preset ${preset.name} references undeclared Shared Resource: ${resourceId}`,
      }));

    const pathIssues =
      sourceRoot === undefined
        ? []
        : [
            ...source.roots.map((sourcePath, index) => ({
              path: `$.presets[${presetIndex}].source.roots[${index}]`,
              sourcePath,
              kind: "source root",
            })),
            ...source.files.map((sourcePath, index) => ({
              path: `$.presets[${presetIndex}].source.files[${index}]`,
              sourcePath,
              kind: "source file",
            })),
          ].flatMap(({ path: issuePath, sourcePath, kind }) => {
            const resolvedPath = resolvePresetSourcePath(
              sourceRoot,
              sourcePath,
            );

            if (typeof resolvedPath !== "string") {
              return [{ path: issuePath, message: resolvedPath.issue }];
            }

            if (!existsSync(resolvedPath)) {
              return [
                {
                  path: issuePath,
                  message: `Preset ${preset.name} ${kind} does not exist: ${sourcePath}`,
                },
              ];
            }

            const realPathIssue = realPresetSourcePathIssue(
              sourceRoot,
              sourcePath,
              resolvedPath,
            );
            if (realPathIssue) {
              return [{ path: issuePath, message: realPathIssue }];
            }

            return [];
          });

    return [...sharedResourceIssues, ...pathIssues];
  });
}

function supportedProjectionDeclarationIssues(
  presets: readonly PresetSourceManifestPreset[],
): ValidationIssue[] {
  return presets.flatMap((preset, index) =>
    preset.generation === "supported" && preset.projection === undefined
      ? [
          {
            path: `$.presets[${index}].projection`,
            message: `Supported Preset ${preset.name} must declare a Projection Declaration`,
          },
        ]
      : [],
  );
}

export function validatePresetSourceManifest(
  input: unknown,
  options: PresetSourceManifestValidationOptions = {},
): ValidationResult<PresetSourceManifest> {
  const inlineDependencyIssues = inlineDependencyCatalogSpecifierIssues(input);
  if (inlineDependencyIssues.length > 0) {
    return { ok: false, issues: inlineDependencyIssues };
  }

  const result = v.safeParse(presetSourceManifestSchema, input);

  if (!result.success) {
    return { ok: false, issues: shapeIssues(result.issues) };
  }

  const parsedManifest = result.output as PresetSourceManifest;
  const semanticIssues = [
    ...duplicateValueIssues(
      parsedManifest.sharedResources.map((resource) => resource.id),
      "$.sharedResources.id",
    ),
    ...duplicatePresetNameIssues(parsedManifest.presets),
    ...duplicatePresetMetadataArrayIssues(parsedManifest.presets),
    ...unsupportedProjectShapeIssues(parsedManifest.presets),
    ...fixtureMatrixContractIssues(parsedManifest),
    ...dependencyCatalogReferenceIssues(
      parsedManifest.presets,
      options.dependencyCatalog ?? loadTemplateDependencyCatalog(),
    ),
    ...projectionCapabilityIssues(parsedManifest.presets),
    ...sharedResourcePathIssues(parsedManifest, options.sourceRoot),
    ...presetSourceReferenceIssues(parsedManifest, options.sourceRoot),
  ];

  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return {
    ok: true,
    value: {
      ...result.output,
      sharedResources: result.output.sharedResources.map((resource) => ({
        ...resource,
      })),
      fixtureMatrix: result.output.fixtureMatrix
        ? {
            initSupport: result.output.fixtureMatrix.initSupport.map(
              (support) => ({ ...support }),
            ),
            packageAdditionSupport:
              result.output.fixtureMatrix.packageAdditionSupport.map(
                (support) => ({ ...support }),
              ),
            supportedCombinations:
              result.output.fixtureMatrix.supportedCombinations.map(
                (combination) => ({
                  ...combination,
                  linkFrom: [...(combination.linkFrom ?? [])],
                }),
              ),
            semanticSkips: result.output.fixtureMatrix.semanticSkips.map(
              (skip) => ({ ...skip }),
            ),
            checkRequirements: [
              ...result.output.fixtureMatrix.checkRequirements,
            ],
            environmentPreparation: [
              ...result.output.fixtureMatrix.environmentPreparation,
            ],
          }
        : undefined,
      presets: parsedManifest.presets.map((preset) => ({
        ...preset,
        supportedPackageManagers: [
          ...preset.supportedPackageManagers,
        ] as PackageManager[],
        supportedProjectKinds: [
          ...preset.supportedProjectKinds,
        ] as ProjectKind[],
        features: [...preset.features] as FeatureName[],
        dependencyCatalog: [...(preset.dependencyCatalog ?? [])],
        projection: preset.projection
          ? normalizePresetProjectionDeclaration(preset.projection)
          : undefined,
        source: preset.source
          ? {
              roots: [...preset.source.roots],
              files: [...preset.source.files],
              sharedResources: [...preset.source.sharedResources],
            }
          : undefined,
      })),
    },
  };
}

export function validateBuiltInPresetSourceManifest(
  input: unknown,
  options: PresetSourceManifestValidationOptions = {},
): ValidationResult<PresetSourceManifest> {
  const result = validatePresetSourceManifest(input, options);

  if (!result.ok) {
    return result;
  }

  const projectionIssues = supportedProjectionDeclarationIssues(
    result.value.presets,
  );
  if (projectionIssues.length > 0) {
    return { ok: false, issues: projectionIssues };
  }

  return result;
}

function listPresetSourceFiles(sourcePath: string): string[] {
  const stats = statSync(sourcePath);

  if (stats.isFile()) {
    return [sourcePath];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  return readdirSync(sourcePath, { withFileTypes: true }).flatMap((entry) =>
    listPresetSourceFiles(path.join(sourcePath, entry.name)),
  );
}

export function manifestReferencedSourceFiles(
  manifest: PresetSourceManifest,
  sourceRoot: string,
): string[] {
  const files = new Set<string>();

  function addReference(referencePath: string): void {
    for (const file of listPresetSourceFiles(
      path.resolve(sourceRoot, referencePath),
    )) {
      files.add(file);
    }
  }

  for (const resource of manifest.sharedResources) {
    addReference(resource.path);
  }

  for (const preset of manifest.presets) {
    for (const root of preset.source?.roots ?? []) {
      addReference(root);
    }

    for (const file of preset.source?.files ?? []) {
      addReference(file);
    }
  }

  return [...files].sort();
}

export function loadPresetSourceManifestFile(
  filePath: string,
): PresetSourceManifest {
  const result = validatePresetSourceManifest(
    JSON.parse(readFileSync(filePath, "utf8")) as unknown,
    { sourceRoot: path.dirname(filePath) },
  );

  if (!result.ok) {
    throw new Error(
      `Preset Source Manifest is invalid:\n${result.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return result.value;
}

export function findPresetSourceManifestPreset(
  manifest: PresetSourceManifest,
  presetName: string,
): PresetSourceManifestPreset | undefined {
  return manifest.presets.find((preset) => preset.name === presetName);
}
