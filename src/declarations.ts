import * as v from "valibot";

export type PresetName = "ts-lib" | "ts-app" | "node-cli";

export type BuiltInPreset = {
  name: PresetName;
  title: string;
  description: string;
  generation: "supported" | "future";
  supportedPackageManagers: readonly PackageManager[];
  supportedProjectKinds: readonly ProjectKind[];
  features: readonly FeatureName[];
};

export type PackageManager = "pnpm";

export type ProjectKind = "single-package";

export type FeatureName =
  | "pnpm-catalog"
  | "oxc-format-lint"
  | "strict-typescript"
  | "root-check"
  | "fix-command"
  | "devcontainer"
  | "github-actions"
  | "dependabot";

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
};

export type ProjectBlueprint = {
  schemaVersion: 1;
  preset: string;
  packageManager: PackageManager;
  projectKind: ProjectKind;
  features: FeatureName[];
  packages?: ProjectPackage[];
};

export const builtInPresets: readonly BuiltInPreset[] = [
  {
    name: "ts-lib",
    title: "TypeScript library",
    description: "Strict TypeScript package with pnpm catalog tooling.",
    generation: "supported",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: [
      "pnpm-catalog",
      "oxc-format-lint",
      "strict-typescript",
      "root-check",
      "fix-command",
      "devcontainer",
      "github-actions",
      "dependabot"
    ]
  },
  {
    name: "ts-app",
    title: "TypeScript application",
    description: "Future application preset metadata.",
    generation: "future",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: []
  },
  {
    name: "node-cli",
    title: "Node.js CLI",
    description: "Future command-line preset metadata.",
    generation: "future",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: []
  }
];

const featureNames: FeatureName[] = [
  "pnpm-catalog",
  "oxc-format-lint",
  "strict-typescript",
  "root-check",
  "fix-command",
  "devcontainer",
  "github-actions",
  "dependabot"
];

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
    "features"
  ],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    supportedPackageManagers: {
      type: "array",
      minItems: 1,
      items: { enum: ["pnpm"] },
      uniqueItems: true
    },
    supportedProjectKinds: {
      type: "array",
      minItems: 1,
      items: { enum: ["single-package"] },
      uniqueItems: true
    },
    features: {
      type: "array",
      items: { enum: featureNames },
      uniqueItems: true
    }
  }
} as const;

export const blueprintJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ykdz.dev/schemas/project-kit/blueprint.schema.json",
  title: "Project Kit Blueprint",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "preset", "packageManager", "projectKind", "features"],
  properties: {
    schemaVersion: { const: 1 },
    preset: { type: "string", minLength: 1 },
    packageManager: { enum: ["pnpm"] },
    projectKind: { enum: ["single-package"] },
    features: {
      type: "array",
      items: { enum: featureNames },
      uniqueItems: true
    },
    packages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path"],
        properties: {
          name: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 }
        }
      }
    }
  }
} as const;

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const packageManagerSchema = v.picklist(["pnpm"] as const);
const projectKindSchema = v.picklist(["single-package"] as const);
const featureNameSchema = v.picklist(featureNames);

export const presetFileSchema = v.strictObject({
  schemaVersion: v.literal(1),
  name: nonEmptyString,
  title: nonEmptyString,
  description: nonEmptyString,
  supportedPackageManagers: v.pipe(v.array(packageManagerSchema), v.minLength(1)),
  supportedProjectKinds: v.pipe(v.array(projectKindSchema), v.minLength(1)),
  features: v.array(featureNameSchema)
});

export const projectBlueprintSchema = v.strictObject({
  schemaVersion: v.literal(1),
  preset: nonEmptyString,
  packageManager: packageManagerSchema,
  projectKind: projectKindSchema,
  features: v.array(featureNameSchema),
  packages: v.optional(
    v.array(
      v.strictObject({
        name: nonEmptyString,
        path: nonEmptyString
      })
    )
  )
});

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  if (!issue.path || issue.path.length === 0) {
    return "$";
  }

  return issue.path.reduce((path, item) => `${path}.${String(item.key)}`, "$");
}

function shapeIssues(issues: v.BaseIssue<unknown>[]): ValidationIssue[] {
  return issues.map((issue) => ({
    path: formatIssuePath(issue),
    message: issue.message
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
    message: `Duplicate value: ${value}`
  }));
}

function generationSupportIssue(
  preset: BuiltInPreset,
  path: string
): ValidationIssue | undefined {
  if (preset.generation === "supported") {
    return undefined;
  }

  return {
    path,
    message: `Preset ${preset.name} is not supported for generation in this version`
  };
}

export function validatePresetFile(input: unknown): ValidationResult<PresetFile> {
  const result = v.safeParse(presetFileSchema, input);

  if (!result.success) {
    return { ok: false, issues: shapeIssues(result.issues) };
  }

  const semanticIssues = [
    ...duplicateIssues(result.output.supportedPackageManagers, "$.supportedPackageManagers"),
    ...duplicateIssues(result.output.supportedProjectKinds, "$.supportedProjectKinds"),
    ...duplicateIssues(result.output.features, "$.features")
  ];

  const builtInPreset = findBuiltInPreset(result.output.name);
  const unsupportedGeneration = builtInPreset
    ? generationSupportIssue(builtInPreset, "$.name")
    : undefined;

  if (unsupportedGeneration) {
    semanticIssues.push(unsupportedGeneration);
  }

  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return { ok: true, value: result.output };
}

export function findBuiltInPreset(name: string): BuiltInPreset | undefined {
  return builtInPresets.find((preset) => preset.name === name);
}

export function validateProjectBlueprint(
  input: unknown
): ValidationResult<ProjectBlueprint> {
  const result = v.safeParse(projectBlueprintSchema, input);

  if (!result.success) {
    return { ok: false, issues: shapeIssues(result.issues) };
  }

  const blueprint = result.output;
  const preset = findBuiltInPreset(blueprint.preset);
  const semanticIssues: ValidationIssue[] = [
    ...duplicateIssues(blueprint.features, "$.features")
  ];

  if (!preset) {
    semanticIssues.push({
      path: "$.preset",
      message: `Unknown built-in preset: ${blueprint.preset}`
    });
  } else {
    const unsupportedGeneration = generationSupportIssue(preset, "$.preset");

    if (unsupportedGeneration) {
      semanticIssues.push(unsupportedGeneration);
    }

    if (!preset.supportedPackageManagers.includes(blueprint.packageManager)) {
      semanticIssues.push({
        path: "$.packageManager",
        message: `${blueprint.packageManager} is not supported by preset ${preset.name}`
      });
    }

    if (!preset.supportedProjectKinds.includes(blueprint.projectKind)) {
      semanticIssues.push({
        path: "$.projectKind",
        message: `${blueprint.projectKind} is not supported by preset ${preset.name}`
      });
    }

    const supportedFeatures = new Set<string>(preset.features);
    for (const feature of blueprint.features) {
      if (!supportedFeatures.has(feature)) {
        semanticIssues.push({
          path: "$.features",
          message: `${feature} is not supported by preset ${preset.name}`
        });
      }
    }
  }

  if (blueprint.packages) {
    if (blueprint.projectKind === "single-package" && blueprint.packages.length > 1) {
      semanticIssues.push({
        path: "$.packages",
        message: "single-package blueprints support exactly one package"
      });
    }

    semanticIssues.push(
      ...duplicateIssues(
        blueprint.packages.map((projectPackage) => projectPackage.name),
        "$.packages.name"
      ),
      ...duplicateIssues(
        blueprint.packages.map((projectPackage) => projectPackage.path),
        "$.packages.path"
      )
    );
  }

  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return { ok: true, value: blueprint };
}
