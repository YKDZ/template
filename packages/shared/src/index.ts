import * as v from "valibot";

export const PackageAdditionSupport = {
  Supported: "supported",
  Unsupported: "unsupported",
} as const;

export type PackageAdditionSupport =
  (typeof PackageAdditionSupport)[keyof typeof PackageAdditionSupport];

export const packageAdditionSupportValues = [
  PackageAdditionSupport.Supported,
  PackageAdditionSupport.Unsupported,
] as const satisfies readonly PackageAdditionSupport[];

export type PackageRole = "runtime-service" | "shared-library";

export type PackageSourcePreset =
  | "hono-api"
  | "ts-lib"
  | "vike-app"
  | "vue-app";

export type PackageLinkIntent = {
  readonly consumerPackagePath: string;
  readonly providerPackagePath: string;
};

export type PackageManager = "pnpm";

export type ProjectKind = "single-package" | "multi-package";

export type FeatureName =
  | "pnpm-catalog"
  | "oxc-format-lint"
  | "strict-typescript"
  | "root-check"
  | "fix-command"
  | "devcontainer"
  | "github-actions"
  | "dependabot"
  | "rustfmt-clippy"
  | "cargo-test"
  | "native-binary-release";

export type PresetGeneration = "supported" | "future";

export type BuiltInPreset = {
  name: string;
  title: string;
  description: string;
  generation: PresetGeneration;
  supportedPackageManagers: readonly PackageManager[];
  supportedProjectKinds: readonly ProjectKind[];
  packageAdditionSupport: PackageAdditionSupport;
  features: readonly FeatureName[];
};

export type PresetFile = {
  schemaVersion: 1;
  name: string;
  title: string;
  description: string;
  supportedPackageManagers: PackageManager[];
  supportedProjectKinds: ProjectKind[];
  features: FeatureName[];
};

export type ProjectPackage = {
  name: string;
  path: string;
  role?: PackageRole;
  sourcePreset?: PackageSourcePreset;
};

export type ProjectBlueprint = {
  schemaVersion: 1;
  preset: string;
  packageManager?: PackageManager;
  projectKind: ProjectKind;
  features: FeatureName[];
  packages?: ProjectPackage[];
  packageLinkIntents?: PackageLinkIntent[];
};

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export type PresetCatalogValidationOptions = {
  readonly presets?: readonly BuiltInPreset[];
  readonly presetLabel?: string;
};

export type PresetSourceManifestPresetSource = {
  roots: string[];
  files: string[];
  sharedResources: string[];
};

export type ProjectionCapabilityKind =
  | "workspace-library-package"
  | "workspace-node-packages"
  | "rust-binary-workspace"
  | "strict-typescript-root"
  | "oxc-format-lint"
  | "node-pnpm-devcontainer"
  | "github-maintenance";

export type WorkspaceLibraryPackageCapabilityDeclaration = {
  readonly kind: "workspace-library-package";
  readonly workspacePackageGlob: "packages/*";
  readonly packageRole: "shared-library";
  readonly packageSourcePreset: "ts-lib";
  readonly sourceFiles: readonly string[];
};

export type WorkspaceNodePackageKind = "hono-api" | "vike-app" | "vue-app";
export type WorkspaceNodePackagePath = "apps/api" | "apps/web";

export type WorkspaceNodePackageDeclaration = {
  readonly kind: WorkspaceNodePackageKind;
  readonly path: WorkspaceNodePackagePath;
  readonly sourceFiles: readonly string[];
};

export type WorkspaceNodePackagesCapabilityDeclaration = {
  readonly kind: "workspace-node-packages";
  readonly workspacePackageGlob: "apps/*";
  readonly packages: readonly WorkspaceNodePackageDeclaration[];
  readonly packageLinks?: readonly {
    readonly consumerPackagePath: "apps/web";
    readonly providerPackagePath: "apps/api" | "packages/db";
  }[];
};

export type RustBinaryWorkspaceCapabilityDeclaration = {
  readonly kind: "rust-binary-workspace";
  readonly workspacePackageGlob: "packages/*";
  readonly sourceFiles: readonly string[];
  readonly cargoDependencies?: readonly string[];
  readonly devcontainerResourceId: string;
  readonly editorCustomizationResourceId: string;
};

export type StrictTypescriptRootCapabilityDeclaration = {
  readonly kind: "strict-typescript-root";
};

export type OxcFormatLintCapabilityDeclaration = {
  readonly kind: "oxc-format-lint";
  readonly editorCustomizationResourceId: string;
};

export type NodePnpmDevcontainerCapabilityDeclaration = {
  readonly kind: "node-pnpm-devcontainer";
  readonly devcontainerResourceId: string;
};

export type GithubMaintenanceCapabilityDeclaration = {
  readonly kind: "github-maintenance";
};

export type ProjectionCapabilityDeclaration =
  | WorkspaceLibraryPackageCapabilityDeclaration
  | WorkspaceNodePackagesCapabilityDeclaration
  | RustBinaryWorkspaceCapabilityDeclaration
  | StrictTypescriptRootCapabilityDeclaration
  | OxcFormatLintCapabilityDeclaration
  | NodePnpmDevcontainerCapabilityDeclaration
  | GithubMaintenanceCapabilityDeclaration;

export type PresetProjectionDeclaration = {
  readonly capabilities: readonly ProjectionCapabilityDeclaration[];
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

export type PresetSourceManifest = {
  schemaVersion: 1;
  name: string;
  sharedResources: PresetSourceManifestSharedResource[];
  presets: PresetSourceManifestPreset[];
};

export const packageManagerValues = [
  "pnpm",
] as const satisfies readonly PackageManager[];

export const presetGenerationValues = [
  "supported",
  "future",
] as const satisfies readonly PresetGeneration[];

export const projectKindValues = [
  "single-package",
  "multi-package",
] as const satisfies readonly ProjectKind[];

export const projectKindJsonSchemaEnum = [
  "multi-package",
] as const satisfies readonly ProjectKind[];

export const featureNameValues = [
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
] as const satisfies readonly FeatureName[];

export const packageManagerJsonSchemaEnum = packageManagerValues;

export const presetGenerationJsonSchemaEnum = presetGenerationValues;

export const featureNameJsonSchemaEnum = featureNameValues;

export const projectionCapabilityKinds = [
  "workspace-library-package",
  "workspace-node-packages",
  "rust-binary-workspace",
  "strict-typescript-root",
  "oxc-format-lint",
  "node-pnpm-devcontainer",
  "github-maintenance",
] satisfies readonly ProjectionCapabilityKind[];

export const packageLeafNamePattern = "^[a-z0-9][a-z0-9-]*$";

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
          generation: { enum: presetGenerationJsonSchemaEnum },
          supportedPackageManagers: {
            type: "array",
            items: { enum: packageManagerJsonSchemaEnum },
            uniqueItems: true,
          },
          supportedProjectKinds: {
            type: "array",
            minItems: 1,
            items: { enum: projectKindJsonSchemaEnum },
            uniqueItems: true,
          },
          packageAdditionSupport: { enum: packageAdditionSupportValues },
          features: {
            type: "array",
            items: { enum: featureNameJsonSchemaEnum },
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
                              kind: {
                                enum: ["hono-api", "vike-app", "vue-app"],
                              },
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
                              providerPackagePath: {
                                enum: ["apps/api", "packages/db"],
                              },
                            },
                          },
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "kind",
                        "workspacePackageGlob",
                        "sourceFiles",
                        "devcontainerResourceId",
                        "editorCustomizationResourceId",
                      ],
                      properties: {
                        kind: { const: "rust-binary-workspace" },
                        workspacePackageGlob: { const: "packages/*" },
                        sourceFiles: {
                          type: "array",
                          minItems: 1,
                          items: { type: "string", minLength: 1 },
                        },
                        devcontainerResourceId: {
                          type: "string",
                          minLength: 1,
                        },
                        editorCustomizationResourceId: {
                          type: "string",
                          minLength: 1,
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: { kind: { const: "strict-typescript-root" } },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind", "editorCustomizationResourceId"],
                      properties: {
                        kind: { const: "oxc-format-lint" },
                        editorCustomizationResourceId: {
                          type: "string",
                          minLength: 1,
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind", "devcontainerResourceId"],
                      properties: {
                        kind: { const: "node-pnpm-devcontainer" },
                        devcontainerResourceId: {
                          type: "string",
                          minLength: 1,
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: { kind: { const: "github-maintenance" } },
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
export const presetGenerationSchema = v.picklist(presetGenerationValues);
export const packageManagerSchema = v.picklist(packageManagerValues);
export const projectKindSchema = v.picklist(projectKindValues);
export const featureNameSchema = v.picklist(featureNameValues);
const packageRoleSchema = v.picklist([
  "runtime-service",
  "shared-library",
] as const);
const packageSourcePresetSchema = v.picklist([
  "hono-api",
  "ts-lib",
  "vike-app",
  "vue-app",
] as const);
const presetSourceManifestPresetSourceSchema = v.strictObject({
  roots: v.optional(v.array(nonEmptyString), []),
  files: v.optional(v.array(nonEmptyString), []),
  sharedResources: v.optional(v.array(nonEmptyString), []),
});
export const presetProjectionDeclarationSchema = v.strictObject({
  capabilities: v.array(
    v.looseObject({
      kind: v.string(),
    }),
  ),
});
export const presetSourceManifestSchema = v.strictObject({
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
  presets: v.pipe(
    v.array(
      v.strictObject({
        name: nonEmptyString,
        title: nonEmptyString,
        description: nonEmptyString,
        generation: presetGenerationSchema,
        supportedPackageManagers: v.array(packageManagerSchema),
        supportedProjectKinds: v.pipe(
          v.array(projectKindSchema),
          v.minLength(1),
        ),
        packageAdditionSupport: v.picklist(packageAdditionSupportValues),
        features: v.array(featureNameSchema),
        dependencyCatalog: v.optional(v.array(nonEmptyString), []),
        projection: v.optional(presetProjectionDeclarationSchema),
        source: v.optional(presetSourceManifestPresetSourceSchema),
      }),
    ),
    v.minLength(1),
  ),
});

export const presetFileJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ykdz.dev/schemas/project-kit/preset-file.schema.json",
  title: "Project Kit Preset File",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "name",
    "title",
    "description",
    "supportedPackageManagers",
    "supportedProjectKinds",
    "features",
  ],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    supportedPackageManagers: {
      type: "array",
      items: { enum: packageManagerJsonSchemaEnum },
      uniqueItems: true,
    },
    supportedProjectKinds: {
      type: "array",
      minItems: 1,
      items: { enum: projectKindJsonSchemaEnum },
      uniqueItems: true,
    },
    features: {
      type: "array",
      items: { enum: featureNameJsonSchemaEnum },
      uniqueItems: true,
    },
  },
} as const;

export const blueprintJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ykdz.dev/schemas/project-kit/blueprint.schema.json",
  title: "Project Kit Blueprint",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "preset", "projectKind", "features"],
  properties: {
    schemaVersion: { const: 1 },
    preset: { type: "string", minLength: 1 },
    packageManager: { enum: packageManagerJsonSchemaEnum },
    projectKind: { enum: projectKindJsonSchemaEnum },
    features: {
      type: "array",
      items: { enum: featureNameJsonSchemaEnum },
      uniqueItems: true,
    },
    packages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path"],
        properties: {
          name: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          role: { enum: ["runtime-service", "shared-library"] },
          sourcePreset: { enum: ["hono-api", "ts-lib", "vike-app", "vue-app"] },
        },
      },
    },
    packageLinkIntents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["consumerPackagePath", "providerPackagePath"],
        properties: {
          consumerPackagePath: { type: "string", minLength: 1 },
          providerPackagePath: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export const presetFileSchema = v.strictObject({
  schemaVersion: v.literal(1),
  name: nonEmptyString,
  title: nonEmptyString,
  description: nonEmptyString,
  supportedPackageManagers: v.array(packageManagerSchema),
  supportedProjectKinds: v.pipe(v.array(projectKindSchema), v.minLength(1)),
  features: v.array(featureNameSchema),
});

export const projectBlueprintSchema = v.strictObject({
  schemaVersion: v.literal(1),
  preset: nonEmptyString,
  packageManager: v.optional(packageManagerSchema),
  projectKind: projectKindSchema,
  features: v.array(featureNameSchema),
  packages: v.optional(
    v.array(
      v.strictObject({
        name: nonEmptyString,
        path: nonEmptyString,
        role: v.optional(packageRoleSchema),
        sourcePreset: v.optional(packageSourcePresetSchema),
      }),
    ),
  ),
  packageLinkIntents: v.optional(
    v.array(
      v.strictObject({
        consumerPackagePath: nonEmptyString,
        providerPackagePath: nonEmptyString,
      }),
    ),
  ),
});

function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  if (!issue.path || issue.path.length === 0) {
    return "$";
  }

  return issue.path.reduce((path, item) => `${path}.${String(item.key)}`, "$");
}

function shapeIssues(issues: v.BaseIssue<unknown>[]): ValidationIssue[] {
  return issues.map((issue) => ({
    path: formatIssuePath(issue),
    message: issue.message,
  }));
}

function duplicateIssues(values: string[], path: string): ValidationIssue[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].map((value) => ({
    path,
    message: `Duplicate value: ${value}`,
  }));
}

function generationSupportIssue(
  preset: BuiltInPreset,
  path: string,
): ValidationIssue | undefined {
  if (preset.generation === "supported") {
    return undefined;
  }

  return {
    path,
    message: `Preset ${preset.name} is not supported for generation in this version`,
  };
}

function unsupportedSinglePackageProjectShapeIssue(
  path: string,
): ValidationIssue {
  return {
    path,
    message:
      "single-package Project Shape is unsupported in V1; use the workspace monorepo Project Shape",
  };
}

function formatBracketIssuePath(issue: v.BaseIssue<unknown>): string {
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

function presetSourceShapeIssues(
  issues: v.BaseIssue<unknown>[],
): ValidationIssue[] {
  return issues.map((issue) => {
    const validationPath = formatBracketIssuePath(issue);
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
      validationPath === "$.fixtureMatrix"
    ) {
      return {
        path: validationPath,
        message:
          "Preset Source Manifests must contain production facts only; remove fixtureMatrix",
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

type ParsedPresetSourceManifest = v.InferOutput<
  typeof presetSourceManifestSchema
>;
type ParsedPresetSourceManifestPreset =
  ParsedPresetSourceManifest["presets"][number];

function duplicatePresetNameIssues(
  presets: readonly ParsedPresetSourceManifestPreset[],
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
  presets: readonly ParsedPresetSourceManifestPreset[],
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

function unsupportedProjectShapeIssues(
  presets: readonly ParsedPresetSourceManifestPreset[],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyStringArray(value: unknown[]): string[] | undefined {
  const strings: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return undefined;
    }

    strings.push(entry);
  }

  return strings.length === 0 ? undefined : strings;
}

const projectionCapabilityKindSet = new Set<string>(projectionCapabilityKinds);
const workspaceNodePackageKindSet = new Set<string>([
  "hono-api",
  "vike-app",
  "vue-app",
]);
const workspaceNodePackagePathSet = new Set<string>(["apps/api", "apps/web"]);

function isProjectionCapabilityKind(
  value: string,
): value is ProjectionCapabilityKind {
  return projectionCapabilityKindSet.has(value);
}

function isWorkspaceNodePackageKind(
  value: unknown,
): value is WorkspaceNodePackageKind {
  return typeof value === "string" && workspaceNodePackageKindSet.has(value);
}

function isWorkspaceNodePackagePath(
  value: unknown,
): value is WorkspaceNodePackagePath {
  return typeof value === "string" && workspaceNodePackagePathSet.has(value);
}

const exactCapabilityKeys: Record<ProjectionCapabilityKind, readonly string[]> =
  {
    "workspace-library-package": [
      "kind",
      "workspacePackageGlob",
      "packageRole",
      "packageSourcePreset",
      "sourceFiles",
    ],
    "workspace-node-packages": [
      "kind",
      "workspacePackageGlob",
      "packages",
      "packageLinks",
    ],
    "rust-binary-workspace": [
      "kind",
      "workspacePackageGlob",
      "sourceFiles",
      "cargoDependencies",
      "devcontainerResourceId",
      "editorCustomizationResourceId",
    ],
    "strict-typescript-root": ["kind"],
    "oxc-format-lint": ["kind", "editorCustomizationResourceId"],
    "node-pnpm-devcontainer": ["kind", "devcontainerResourceId"],
    "github-maintenance": ["kind"],
  };

const requiredPlanCapabilityProviders: readonly {
  readonly kind: ProjectionCapabilityKind;
  readonly label: string;
}[] = [
  { kind: "strict-typescript-root", label: "root check command" },
  { kind: "oxc-format-lint", label: "fix command" },
  { kind: "github-maintenance", label: "GitHub Actions maintenance" },
  { kind: "github-maintenance", label: "Dependabot maintenance" },
  { kind: "node-pnpm-devcontainer", label: "development container support" },
];

function unknownCapabilityPropertyIssues(
  kind: ProjectionCapabilityKind,
  capability: Record<string, unknown>,
  pathPrefix: string,
): ValidationIssue[] {
  const allowedKeys = new Set(exactCapabilityKeys[kind]);

  return Object.keys(capability)
    .filter((key) => !allowedKeys.has(key))
    .map((key) => ({
      path: `${pathPrefix}.${key}`,
      message: `Projection Capability ${kind} does not support property: ${key}`,
    }));
}

function parseWorkspaceLibraryPackageCapability(
  capability: Record<string, unknown>,
  pathPrefix: string,
): WorkspaceLibraryPackageCapabilityDeclaration | ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sourceFiles: string[] = [];

  if (capability.workspacePackageGlob !== "packages/*") {
    issues.push({
      path: `${pathPrefix}.workspacePackageGlob`,
      message:
        "workspace-library-package currently supports workspacePackageGlob: packages/*",
    });
  }

  if (capability.packageRole !== "shared-library") {
    issues.push({
      path: `${pathPrefix}.packageRole`,
      message:
        "workspace-library-package currently supports packageRole: shared-library",
    });
  }

  if (capability.packageSourcePreset !== "ts-lib") {
    issues.push({
      path: `${pathPrefix}.packageSourcePreset`,
      message:
        "workspace-library-package currently supports packageSourcePreset: ts-lib",
    });
  }

  if (!Array.isArray(capability.sourceFiles)) {
    issues.push({
      path: `${pathPrefix}.sourceFiles`,
      message:
        "workspace-library-package sourceFiles must be a non-empty array",
    });
  } else {
    const parsedSourceFiles = nonEmptyStringArray(capability.sourceFiles);
    if (parsedSourceFiles === undefined) {
      issues.push({
        path: `${pathPrefix}.sourceFiles`,
        message:
          "workspace-library-package sourceFiles must be a non-empty array of paths",
      });
    } else {
      sourceFiles = parsedSourceFiles;
    }
  }

  if (issues.length > 0) {
    return issues;
  }

  return {
    kind: "workspace-library-package",
    workspacePackageGlob: "packages/*",
    packageRole: "shared-library",
    packageSourcePreset: "ts-lib",
    sourceFiles,
  };
}

function parseWorkspaceNodePackage(
  value: unknown,
  pathPrefix: string,
): WorkspaceNodePackageDeclaration | ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isRecord(value)) {
    return [
      {
        path: pathPrefix,
        message: "workspace-node-packages package must be an object",
      },
    ];
  }

  const kind = isWorkspaceNodePackageKind(value.kind) ? value.kind : undefined;
  const packagePath = isWorkspaceNodePackagePath(value.path)
    ? value.path
    : undefined;
  let sourceFiles: string[] = [];

  if (kind === undefined) {
    issues.push({
      path: `${pathPrefix}.kind`,
      message:
        "workspace-node-packages package kind must be hono-api, vike-app, or vue-app",
    });
  }

  if (packagePath === undefined) {
    issues.push({
      path: `${pathPrefix}.path`,
      message:
        "workspace-node-packages package path must be apps/api or apps/web",
    });
  }

  if (!Array.isArray(value.sourceFiles)) {
    issues.push({
      path: `${pathPrefix}.sourceFiles`,
      message:
        "workspace-node-packages package sourceFiles must be a non-empty array",
    });
  } else {
    const parsedSourceFiles = nonEmptyStringArray(value.sourceFiles);
    if (parsedSourceFiles === undefined) {
      issues.push({
        path: `${pathPrefix}.sourceFiles`,
        message:
          "workspace-node-packages package sourceFiles must be a non-empty array of paths",
      });
    } else {
      sourceFiles = parsedSourceFiles;
    }
  }

  const allowedKeys = new Set(["kind", "path", "sourceFiles"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push({
        path: `${pathPrefix}.${key}`,
        message: `workspace-node-packages package does not support property: ${key}`,
      });
    }
  }

  if (issues.length > 0) {
    return issues;
  }

  if (kind === undefined || packagePath === undefined) {
    throw new Error(
      `workspace-node-packages package validation failed without diagnostics at ${pathPrefix}`,
    );
  }

  return {
    kind,
    path: packagePath,
    sourceFiles,
  };
}

function parseWorkspaceNodePackageLinks(
  value: unknown,
  pathPrefix: string,
  declaredPackagePaths: ReadonlySet<string>,
  issues: ValidationIssue[],
): WorkspaceNodePackagesCapabilityDeclaration["packageLinks"] | undefined {
  if (!Array.isArray(value)) {
    issues.push({
      path: pathPrefix,
      message: "workspace-node-packages packageLinks must be an array",
    });
    return undefined;
  }

  return value.flatMap((link, linkIndex) => {
    const linkPath = `${pathPrefix}[${linkIndex}]`;
    const linkIssues: ValidationIssue[] = [];

    if (!isRecord(link)) {
      issues.push({
        path: linkPath,
        message: "workspace-node-packages packageLink must be an object",
      });
      return [];
    }

    const allowedKeys = new Set(["consumerPackagePath", "providerPackagePath"]);
    for (const key of Object.keys(link)) {
      if (!allowedKeys.has(key)) {
        linkIssues.push({
          path: `${linkPath}.${key}`,
          message: `workspace-node-packages packageLink does not support property: ${key}`,
        });
      }
    }

    const consumerPackagePath =
      typeof link.consumerPackagePath === "string"
        ? link.consumerPackagePath
        : undefined;
    const providerPackagePath =
      typeof link.providerPackagePath === "string"
        ? link.providerPackagePath
        : undefined;
    const isSupportedLink =
      consumerPackagePath === "apps/web" &&
      (providerPackagePath === "apps/api" ||
        providerPackagePath === "packages/db");

    if (!isSupportedLink) {
      linkIssues.push({
        path: linkPath,
        message:
          "workspace-node-packages currently supports links from apps/web to apps/api or packages/db",
      });
    } else {
      if (!declaredPackagePaths.has(consumerPackagePath)) {
        linkIssues.push({
          path: `${linkPath}.consumerPackagePath`,
          message:
            "workspace-node-packages packageLink consumerPackagePath must reference a package declared in the same packages array: apps/web",
        });
      }

      if (
        providerPackagePath !== "packages/db" &&
        !declaredPackagePaths.has(providerPackagePath)
      ) {
        linkIssues.push({
          path: `${linkPath}.providerPackagePath`,
          message:
            "workspace-node-packages packageLink providerPackagePath must reference a package declared in the same packages array or the vike db package: apps/api, packages/db",
        });
      }
    }

    if (linkIssues.length > 0) {
      issues.push(...linkIssues);
      return [];
    }

    return [
      {
        consumerPackagePath: "apps/web" as const,
        providerPackagePath: providerPackagePath as "apps/api" | "packages/db",
      },
    ];
  });
}

function parseWorkspaceNodePackagesCapability(
  capability: Record<string, unknown>,
  pathPrefix: string,
): WorkspaceNodePackagesCapabilityDeclaration | ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const workspacePackageGlob =
    capability.workspacePackageGlob === "apps/*"
      ? capability.workspacePackageGlob
      : undefined;

  if (workspacePackageGlob === undefined) {
    issues.push({
      path: `${pathPrefix}.workspacePackageGlob`,
      message:
        "workspace-node-packages currently supports workspacePackageGlob: apps/*",
    });
  }

  if (!Array.isArray(capability.packages) || capability.packages.length === 0) {
    issues.push({
      path: `${pathPrefix}.packages`,
      message: "workspace-node-packages packages must be a non-empty array",
    });
  }

  const packages = Array.isArray(capability.packages)
    ? capability.packages.flatMap((nodePackage, packageIndex) => {
        const packagePath = `${pathPrefix}.packages[${packageIndex}]`;
        const parsed = parseWorkspaceNodePackage(nodePackage, packagePath);
        if (Array.isArray(parsed)) {
          issues.push(...parsed);
          return [];
        }
        return [parsed];
      })
    : [];

  const packageLinks =
    capability.packageLinks === undefined
      ? undefined
      : parseWorkspaceNodePackageLinks(
          capability.packageLinks,
          `${pathPrefix}.packageLinks`,
          new Set(packages.map((nodePackage) => nodePackage.path)),
          issues,
        );

  if (issues.length > 0) {
    return issues;
  }

  if (workspacePackageGlob === undefined) {
    throw new Error(
      `workspace-node-packages validation failed without workspacePackageGlob diagnostic at ${pathPrefix}`,
    );
  }

  return {
    kind: "workspace-node-packages",
    workspacePackageGlob,
    packages,
    ...(packageLinks === undefined ? {} : { packageLinks }),
  };
}

function parseRustBinaryWorkspaceCapability(
  capability: Record<string, unknown>,
  pathPrefix: string,
): RustBinaryWorkspaceCapabilityDeclaration | ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sourceFiles: string[] = [];
  let cargoDependencies: string[] = [];
  let devcontainerResourceId = "";
  let editorCustomizationResourceId = "";

  if (capability.workspacePackageGlob !== "packages/*") {
    issues.push({
      path: `${pathPrefix}.workspacePackageGlob`,
      message:
        "rust-binary-workspace currently supports workspacePackageGlob: packages/*",
    });
  }

  if (!Array.isArray(capability.sourceFiles)) {
    issues.push({
      path: `${pathPrefix}.sourceFiles`,
      message: "rust-binary-workspace sourceFiles must be a non-empty array",
    });
  } else {
    const parsedSourceFiles = nonEmptyStringArray(capability.sourceFiles);
    if (parsedSourceFiles === undefined) {
      issues.push({
        path: `${pathPrefix}.sourceFiles`,
        message:
          "rust-binary-workspace sourceFiles must be a non-empty array of paths",
      });
    } else {
      sourceFiles = parsedSourceFiles;
    }
  }

  if (capability.cargoDependencies !== undefined) {
    if (!Array.isArray(capability.cargoDependencies)) {
      issues.push({
        path: `${pathPrefix}.cargoDependencies`,
        message: "rust-binary-workspace cargoDependencies must be an array",
      });
    } else {
      const parsedCargoDependencies = nonEmptyStringArray(
        capability.cargoDependencies,
      );
      if (parsedCargoDependencies === undefined) {
        issues.push({
          path: `${pathPrefix}.cargoDependencies`,
          message:
            "rust-binary-workspace cargoDependencies must be an array of dependency names",
        });
      } else {
        cargoDependencies = parsedCargoDependencies;
      }
    }
  }

  if (
    typeof capability.devcontainerResourceId !== "string" ||
    capability.devcontainerResourceId.length === 0
  ) {
    issues.push({
      path: `${pathPrefix}.devcontainerResourceId`,
      message:
        "rust-binary-workspace must declare a devcontainerResourceId Shared Resource id",
    });
  } else {
    devcontainerResourceId = capability.devcontainerResourceId;
  }

  if (
    typeof capability.editorCustomizationResourceId !== "string" ||
    capability.editorCustomizationResourceId.length === 0
  ) {
    issues.push({
      path: `${pathPrefix}.editorCustomizationResourceId`,
      message:
        "rust-binary-workspace must declare an editorCustomizationResourceId Shared Resource id",
    });
  } else {
    editorCustomizationResourceId = capability.editorCustomizationResourceId;
  }

  if (issues.length > 0) {
    return issues;
  }

  return {
    kind: "rust-binary-workspace",
    workspacePackageGlob: "packages/*",
    sourceFiles,
    ...(cargoDependencies.length === 0 ? {} : { cargoDependencies }),
    devcontainerResourceId,
    editorCustomizationResourceId,
  };
}

function parseOxcFormatLintCapability(
  capability: Record<string, unknown>,
  pathPrefix: string,
): OxcFormatLintCapabilityDeclaration | ValidationIssue[] {
  if (
    typeof capability.editorCustomizationResourceId !== "string" ||
    capability.editorCustomizationResourceId.length === 0
  ) {
    return [
      {
        path: `${pathPrefix}.editorCustomizationResourceId`,
        message:
          "oxc-format-lint must declare an editorCustomizationResourceId Shared Resource id",
      },
    ];
  }

  return {
    kind: "oxc-format-lint",
    editorCustomizationResourceId: capability.editorCustomizationResourceId,
  };
}

function parseNodePnpmDevcontainerCapability(
  capability: Record<string, unknown>,
  pathPrefix: string,
): NodePnpmDevcontainerCapabilityDeclaration | ValidationIssue[] {
  if (
    typeof capability.devcontainerResourceId !== "string" ||
    capability.devcontainerResourceId.length === 0
  ) {
    return [
      {
        path: `${pathPrefix}.devcontainerResourceId`,
        message:
          "node-pnpm-devcontainer must declare a devcontainerResourceId Shared Resource id",
      },
    ];
  }

  return {
    kind: "node-pnpm-devcontainer",
    devcontainerResourceId: capability.devcontainerResourceId,
  };
}

function duplicateCapabilityIssues(
  capabilities: readonly ProjectionCapabilityDeclaration[],
): ValidationIssue[] {
  const firstSeen = new Map<ProjectionCapabilityKind, number>();
  const issues: ValidationIssue[] = [];

  capabilities.forEach((capability, index) => {
    const firstIndex = firstSeen.get(capability.kind);
    if (firstIndex === undefined) {
      firstSeen.set(capability.kind, index);
      return;
    }

    issues.push({
      path: `$.capabilities[${index}].kind`,
      message: `Duplicate Projection Capability kind: ${capability.kind}`,
    });
  });

  return issues;
}

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function capabilityCompositionIssues(
  capabilities: readonly ProjectionCapabilityDeclaration[],
): ValidationIssue[] {
  const kinds = new Set(capabilities.map((capability) => capability.kind));
  const issues: ValidationIssue[] = [];
  const companionKinds = uniqueValues(
    capabilities
      .map((capability) => capability.kind)
      .filter((kind) => kind !== "rust-binary-workspace"),
  );

  if (kinds.has("rust-binary-workspace") && companionKinds.length > 0) {
    issues.push({
      path: "$.capabilities",
      message:
        "rust-binary-workspace is a complete domain capability and must be selected by itself; remove companion Projection Capabilities: " +
        companionKinds.join(", "),
    });
    return issues;
  }

  if (
    !kinds.has("workspace-library-package") &&
    !kinds.has("workspace-node-packages") &&
    !kinds.has("rust-binary-workspace")
  ) {
    issues.push({
      path: "$.capabilities",
      message:
        "Projection Capability composition must include a workspace package layout capability",
    });
  }

  if (
    kinds.has("strict-typescript-root") &&
    !kinds.has("workspace-library-package") &&
    !kinds.has("workspace-node-packages")
  ) {
    issues.push({
      path: "$.capabilities",
      message:
        "strict-typescript-root requires a workspace package layout so package typecheck tasks have a workspace target",
    });
  }

  if (kinds.has("node-pnpm-devcontainer") && !kinds.has("oxc-format-lint")) {
    issues.push({
      path: "$.capabilities",
      message:
        "node-pnpm-devcontainer requires oxc-format-lint so editor customization is derived from declared tooling",
    });
  }

  for (const requirement of requiredPlanCapabilityProviders) {
    if (!kinds.has(requirement.kind) && !kinds.has("rust-binary-workspace")) {
      issues.push({
        path: "$.capabilities",
        message: `Projection Capability composition must include ${requirement.kind} to provide ${requirement.label}`,
      });
    }
  }

  return issues;
}

export function validatePresetProjectionDeclaration(
  input: unknown,
): ValidationResult<PresetProjectionDeclaration> {
  if (!isRecord(input) || !Array.isArray(input.capabilities)) {
    return {
      ok: false,
      issues: [
        {
          path: "$.capabilities",
          message: "Projection Declaration must select Projection Capabilities",
        },
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  const capabilities: ProjectionCapabilityDeclaration[] = [];

  input.capabilities.forEach((capability, index) => {
    const pathPrefix = `$.capabilities[${index}]`;

    if (!isRecord(capability)) {
      issues.push({
        path: pathPrefix,
        message: "Projection Capability must be an object",
      });
      return;
    }

    if (typeof capability.kind !== "string") {
      issues.push({
        path: `${pathPrefix}.kind`,
        message: "Projection Capability kind is required",
      });
      return;
    }

    if (!isProjectionCapabilityKind(capability.kind)) {
      issues.push({
        path: `${pathPrefix}.kind`,
        message: `Unknown Projection Capability kind: ${capability.kind}`,
      });
      return;
    }

    const kind = capability.kind;
    issues.push(
      ...unknownCapabilityPropertyIssues(kind, capability, pathPrefix),
    );

    if (kind === "workspace-library-package") {
      const workspaceCapability = parseWorkspaceLibraryPackageCapability(
        capability,
        pathPrefix,
      );
      if (Array.isArray(workspaceCapability)) {
        issues.push(...workspaceCapability);
        return;
      }
      capabilities.push(workspaceCapability);
      return;
    }

    if (kind === "workspace-node-packages") {
      const workspaceCapability = parseWorkspaceNodePackagesCapability(
        capability,
        pathPrefix,
      );
      if (Array.isArray(workspaceCapability)) {
        issues.push(...workspaceCapability);
        return;
      }
      capabilities.push(workspaceCapability);
      return;
    }

    if (kind === "rust-binary-workspace") {
      const workspaceCapability = parseRustBinaryWorkspaceCapability(
        capability,
        pathPrefix,
      );
      if (Array.isArray(workspaceCapability)) {
        issues.push(...workspaceCapability);
        return;
      }
      capabilities.push(workspaceCapability);
      return;
    }

    if (kind === "oxc-format-lint") {
      const oxcFormatLintCapability = parseOxcFormatLintCapability(
        capability,
        pathPrefix,
      );
      if (Array.isArray(oxcFormatLintCapability)) {
        issues.push(...oxcFormatLintCapability);
        return;
      }
      capabilities.push(oxcFormatLintCapability);
      return;
    }

    if (kind === "node-pnpm-devcontainer") {
      const nodePnpmDevcontainerCapability =
        parseNodePnpmDevcontainerCapability(capability, pathPrefix);
      if (Array.isArray(nodePnpmDevcontainerCapability)) {
        issues.push(...nodePnpmDevcontainerCapability);
        return;
      }
      capabilities.push(nodePnpmDevcontainerCapability);
      return;
    }

    capabilities.push({ kind });
  });

  if (issues.length === 0) {
    issues.push(...duplicateCapabilityIssues(capabilities));
    issues.push(...capabilityCompositionIssues(capabilities));
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: { capabilities } };
}

export function projectionCapabilityIssues(
  presets: readonly { readonly projection?: unknown }[],
): ValidationIssue[] {
  return presets.flatMap((preset, presetIndex) => {
    if (preset.projection === undefined) {
      return [];
    }

    const result = validatePresetProjectionDeclaration(preset.projection);

    return result.ok
      ? []
      : result.issues.map((issue) => ({
          path: `$.presets[${presetIndex}].projection${issue.path.slice(1)}`,
          message: issue.message,
        }));
  });
}

function projectionCapabilitySharedResourceIssues(
  manifest: ParsedPresetSourceManifest,
): ValidationIssue[] {
  const sharedResourceIds = new Set(
    manifest.sharedResources.map((resource) => resource.id),
  );
  const issues: ValidationIssue[] = [];

  manifest.presets.forEach((preset, presetIndex) => {
    if (preset.projection === undefined) {
      return;
    }

    const result = validatePresetProjectionDeclaration(preset.projection);
    if (!result.ok) {
      return;
    }

    result.value.capabilities.forEach((capability, capabilityIndex) => {
      if (capability.kind === "oxc-format-lint") {
        const resourceId = capability.editorCustomizationResourceId;
        if (!sharedResourceIds.has(resourceId)) {
          issues.push({
            path: `$.presets[${presetIndex}].projection.capabilities[${capabilityIndex}].editorCustomizationResourceId`,
            message: `Projection Capability oxc-format-lint references undeclared Shared Resource: ${resourceId}`,
          });
        }
      }

      if (capability.kind === "node-pnpm-devcontainer") {
        const resourceId = capability.devcontainerResourceId;
        if (!sharedResourceIds.has(resourceId)) {
          issues.push({
            path: `$.presets[${presetIndex}].projection.capabilities[${capabilityIndex}].devcontainerResourceId`,
            message: `Projection Capability node-pnpm-devcontainer references undeclared Shared Resource: ${resourceId}`,
          });
        }
      }

      if (capability.kind === "rust-binary-workspace") {
        const devcontainerResourceId = capability.devcontainerResourceId;
        if (!sharedResourceIds.has(devcontainerResourceId)) {
          issues.push({
            path: `$.presets[${presetIndex}].projection.capabilities[${capabilityIndex}].devcontainerResourceId`,
            message: `Projection Capability rust-binary-workspace references undeclared Shared Resource: ${devcontainerResourceId}`,
          });
        }

        const editorCustomizationResourceId =
          capability.editorCustomizationResourceId;
        if (!sharedResourceIds.has(editorCustomizationResourceId)) {
          issues.push({
            path: `$.presets[${presetIndex}].projection.capabilities[${capabilityIndex}].editorCustomizationResourceId`,
            message: `Projection Capability rust-binary-workspace references undeclared Shared Resource: ${editorCustomizationResourceId}`,
          });
        }
      }
    });
  });

  return issues;
}

export function normalizePresetProjectionDeclaration(
  declaration: unknown,
): PresetProjectionDeclaration {
  const result = validatePresetProjectionDeclaration(declaration);

  if (!result.ok) {
    throw new Error(
      `Projection Declaration is invalid:\n${result.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return result.value;
}

function normalizePresetSourceManifestOutput(
  manifest: ParsedPresetSourceManifest,
): PresetSourceManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    sharedResources: manifest.sharedResources.map((resource) => ({
      ...resource,
    })),
    presets: manifest.presets.map((preset) => ({
      name: preset.name,
      title: preset.title,
      description: preset.description,
      generation: preset.generation,
      packageAdditionSupport: preset.packageAdditionSupport,
      supportedPackageManagers: [...preset.supportedPackageManagers],
      supportedProjectKinds: [...preset.supportedProjectKinds],
      features: [...preset.features],
      dependencyCatalog: [...preset.dependencyCatalog],
      ...(preset.projection
        ? {
            projection: normalizePresetProjectionDeclaration(preset.projection),
          }
        : {}),
      ...(preset.source
        ? {
            source: {
              roots: [...preset.source.roots],
              files: [...preset.source.files],
              sharedResources: [...preset.source.sharedResources],
            },
          }
        : {}),
    })),
  };
}

export function validatePresetSourceManifestDeclaration(
  input: unknown,
): ValidationResult<PresetSourceManifest> {
  const result = v.safeParse(presetSourceManifestSchema, input);

  if (!result.success) {
    return { ok: false, issues: presetSourceShapeIssues(result.issues) };
  }

  const parsedManifest = result.output;
  const semanticIssues = [
    ...duplicateValueIssues(
      parsedManifest.sharedResources.map((resource) => resource.id),
      "$.sharedResources.id",
    ),
    ...duplicatePresetNameIssues(parsedManifest.presets),
    ...duplicatePresetMetadataArrayIssues(parsedManifest.presets),
    ...unsupportedProjectShapeIssues(parsedManifest.presets),
    ...projectionCapabilityIssues(parsedManifest.presets),
    ...projectionCapabilitySharedResourceIssues(parsedManifest),
  ];

  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return {
    ok: true,
    value: normalizePresetSourceManifestOutput(parsedManifest),
  };
}

export function findPreset(
  presets: readonly BuiltInPreset[],
  name: string,
): BuiltInPreset | undefined {
  return presets.find((preset) => preset.name === name);
}

export function validatePresetFile(
  input: unknown,
  options: PresetCatalogValidationOptions = {},
): ValidationResult<PresetFile> {
  const result = v.safeParse(presetFileSchema, input);

  if (!result.success) {
    return { ok: false, issues: shapeIssues(result.issues) };
  }

  const semanticIssues = [
    ...duplicateIssues(
      result.output.supportedPackageManagers,
      "$.supportedPackageManagers",
    ),
    ...duplicateIssues(
      result.output.supportedProjectKinds,
      "$.supportedProjectKinds",
    ),
    ...duplicateIssues(result.output.features, "$.features"),
  ];

  if (result.output.supportedProjectKinds.includes("single-package")) {
    semanticIssues.push(
      unsupportedSinglePackageProjectShapeIssue("$.supportedProjectKinds"),
    );
  }

  const catalogPreset = findPreset(options.presets ?? [], result.output.name);
  const unsupportedGeneration = catalogPreset
    ? generationSupportIssue(catalogPreset, "$.name")
    : undefined;

  if (unsupportedGeneration) {
    semanticIssues.push(unsupportedGeneration);
  }

  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return { ok: true, value: result.output };
}

function normalizeProjectBlueprint(
  blueprint: v.InferOutput<typeof projectBlueprintSchema>,
): ProjectBlueprint {
  return {
    schemaVersion: blueprint.schemaVersion,
    preset: blueprint.preset,
    ...(blueprint.packageManager === undefined
      ? {}
      : { packageManager: blueprint.packageManager }),
    projectKind: blueprint.projectKind,
    features: [...blueprint.features],
    ...(blueprint.packages === undefined
      ? {}
      : {
          packages: blueprint.packages.map((projectPackage) => ({
            name: projectPackage.name,
            path: projectPackage.path,
            ...(projectPackage.role === undefined
              ? {}
              : { role: projectPackage.role }),
            ...(projectPackage.sourcePreset === undefined
              ? {}
              : { sourcePreset: projectPackage.sourcePreset }),
          })),
        }),
    ...(blueprint.packageLinkIntents === undefined
      ? {}
      : {
          packageLinkIntents: blueprint.packageLinkIntents.map((intent) => ({
            consumerPackagePath: intent.consumerPackagePath,
            providerPackagePath: intent.providerPackagePath,
          })),
        }),
  };
}

function packagePathIssue(
  packagePath: string,
  path: string,
): ValidationIssue | undefined {
  const segments = packagePath.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0 || segment === ".")
  ) {
    return {
      path,
      message:
        "Package Path must be exactly two non-root path segments, such as apps/web or packages/ui",
    };
  }

  return undefined;
}

export function validateProjectBlueprint(
  input: unknown,
  options: PresetCatalogValidationOptions = {},
): ValidationResult<ProjectBlueprint> {
  const result = v.safeParse(projectBlueprintSchema, input);

  if (!result.success) {
    return { ok: false, issues: shapeIssues(result.issues) };
  }

  const blueprint = normalizeProjectBlueprint(result.output);
  const preset = findPreset(options.presets ?? [], blueprint.preset);
  const semanticIssues: ValidationIssue[] = [
    ...duplicateIssues(blueprint.features, "$.features"),
  ];

  if (blueprint.projectKind === "single-package") {
    semanticIssues.push(
      unsupportedSinglePackageProjectShapeIssue("$.projectKind"),
    );
  }

  if (options.presets && !preset) {
    semanticIssues.push({
      path: "$.preset",
      message: `Unknown ${options.presetLabel ?? "built-in"} preset: ${blueprint.preset}`,
    });
  } else if (preset) {
    const unsupportedGeneration = generationSupportIssue(preset, "$.preset");

    if (unsupportedGeneration) {
      semanticIssues.push(unsupportedGeneration);
    }

    if (
      blueprint.packageManager &&
      !preset.supportedPackageManagers.includes(blueprint.packageManager)
    ) {
      semanticIssues.push({
        path: "$.packageManager",
        message: `${blueprint.packageManager} is not supported by preset ${preset.name}`,
      });
    }

    if (
      !blueprint.packageManager &&
      preset.supportedPackageManagers.length > 0
    ) {
      semanticIssues.push({
        path: "$.packageManager",
        message: `packageManager is required by preset ${preset.name}`,
      });
    }

    if (!preset.supportedProjectKinds.includes(blueprint.projectKind)) {
      semanticIssues.push({
        path: "$.projectKind",
        message: `${blueprint.projectKind} is not supported by preset ${preset.name}`,
      });
    }

    const supportedFeatures = new Set<string>(preset.features);
    for (const feature of blueprint.features) {
      if (!supportedFeatures.has(feature)) {
        semanticIssues.push({
          path: "$.features",
          message: `${feature} is not supported by preset ${preset.name}`,
        });
      }
    }
  }

  if (blueprint.packages) {
    semanticIssues.push(
      ...duplicateIssues(
        blueprint.packages.map((projectPackage) => projectPackage.name),
        "$.packages.name",
      ),
      ...duplicateIssues(
        blueprint.packages.map((projectPackage) => projectPackage.path),
        "$.packages.path",
      ),
      ...blueprint.packages.flatMap((projectPackage, index) => {
        const issue = packagePathIssue(
          projectPackage.path,
          `$.packages[${index}].path`,
        );
        return issue === undefined ? [] : [issue];
      }),
    );
  }

  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return { ok: true, value: blueprint };
}
