import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import { builtInPresetProjections } from "../templates/registry.js";
import type {
  BuiltInPreset,
  FeatureName,
  PackageManager,
  ProjectKind,
  ValidationIssue,
  ValidationResult,
} from "./declarations.js";
import { PackageAdditionSupport } from "./package-addition-support.js";
import { packageTemplateRoot } from "./runtime-paths.js";

export type PresetSourceManifestPreset = BuiltInPreset;

export type PresetSourceManifest = {
  schemaVersion: 1;
  name: string;
  presets: PresetSourceManifestPreset[];
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

const presetSourceManifestSchema = v.strictObject({
  schemaVersion: v.literal(1),
  name: nonEmptyString,
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
      }),
    ),
    v.minLength(1),
  ),
});

function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  if (!issue.path || issue.path.length === 0) {
    return "$";
  }

  return issue.path.reduce((path, item) => {
    if (typeof item.key === "number") {
      return `${path}[${item.key}]`;
    }

    return `${path}.${String(item.key)}`;
  }, "$");
}

function shapeIssues(issues: v.BaseIssue<unknown>[]): ValidationIssue[] {
  return issues.map((issue) => {
    const path = formatIssuePath(issue);
    const missingPresetMetadata = path.match(/^\$\.presets\[\d+\]\.(.+)$/);

    if (missingPresetMetadata && issue.message.includes("received undefined")) {
      return {
        path,
        message: `Preset metadata is missing required field: ${missingPresetMetadata[1]}`,
      };
    }

    return {
      path,
      message: path.match(/^\$\.presets\[\d+\]\.packageAdditionSupport$/)
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
  path: string,
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
    path,
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
  ]);
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

function builtInRegistryBridgeIssues(
  manifest: PresetSourceManifest,
): ValidationIssue[] {
  const projectionsByName = new Map(
    builtInPresetProjections.map((projection) => [
      projection.metadata.name,
      projection,
    ]),
  );
  const presetsByName = new Map(
    manifest.presets.map((preset, index) => [preset.name, { preset, index }]),
  );
  const issues: ValidationIssue[] = [];

  manifest.presets.forEach((preset, index) => {
    const projection = projectionsByName.get(preset.name);

    if (preset.generation === "supported" && !projection) {
      issues.push({
        path: `$.presets[${index}].name`,
        message: `Supported built-in Preset ${preset.name} must have a registry projection until generation no longer uses the registry bridge`,
      });
      return;
    }

    if (
      projection &&
      preset.packageAdditionSupport !==
        projection.metadata.packageAdditionSupport
    ) {
      issues.push({
        path: `$.presets[${index}].packageAdditionSupport`,
        message: `Built-in Preset ${preset.name} Package Addition Support must match the registry projection: ${projection.metadata.packageAdditionSupport}`,
      });
    }
  });

  builtInPresetProjections.forEach((projection) => {
    const manifestPreset = presetsByName.get(projection.metadata.name);

    if (!manifestPreset) {
      issues.push({
        path: "$.presets",
        message: `Registry projection ${projection.metadata.name} must be declared as a supported built-in Preset until generation no longer uses the registry bridge`,
      });
      return;
    }

    if (manifestPreset.preset.generation !== "supported") {
      issues.push({
        path: `$.presets[${manifestPreset.index}].generation`,
        message: `Registry projection ${projection.metadata.name} must be declared as a supported built-in Preset until generation no longer uses the registry bridge`,
      });
    }
  });

  return issues;
}

export function validatePresetSourceManifest(
  input: unknown,
): ValidationResult<PresetSourceManifest> {
  const result = v.safeParse(presetSourceManifestSchema, input);

  if (!result.success) {
    return { ok: false, issues: shapeIssues(result.issues) };
  }

  const semanticIssues = [
    ...duplicatePresetNameIssues(result.output.presets),
    ...duplicatePresetMetadataArrayIssues(result.output.presets),
    ...unsupportedProjectShapeIssues(result.output.presets),
  ];

  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return {
    ok: true,
    value: {
      ...result.output,
      presets: result.output.presets.map((preset) => ({
        ...preset,
        supportedPackageManagers: [
          ...preset.supportedPackageManagers,
        ] as PackageManager[],
        supportedProjectKinds: [
          ...preset.supportedProjectKinds,
        ] as ProjectKind[],
        features: [...preset.features] as FeatureName[],
      })),
    },
  };
}

export function validateBuiltInPresetSourceManifest(
  input: unknown,
): ValidationResult<PresetSourceManifest> {
  const result = validatePresetSourceManifest(input);

  if (!result.ok) {
    return result;
  }

  const bridgeIssues = builtInRegistryBridgeIssues(result.value);
  if (bridgeIssues.length > 0) {
    return { ok: false, issues: bridgeIssues };
  }

  return result;
}

export function loadPresetSourceManifestFile(
  filePath: string,
): PresetSourceManifest {
  const result = validatePresetSourceManifest(
    JSON.parse(readFileSync(filePath, "utf8")) as unknown,
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

export function loadBuiltInPresetSourceManifest(): PresetSourceManifest {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = packageTemplateRoot(moduleDir, "preset-source.json");
  const result = validateBuiltInPresetSourceManifest(
    JSON.parse(readFileSync(filePath, "utf8")) as unknown,
  );

  if (!result.ok) {
    throw new Error(
      `Built-in Preset Source Manifest is invalid:\n${result.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return result.value;
}
