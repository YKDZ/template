import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
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

export type PresetSourceManifestPresetSource = {
  roots: string[];
  files: string[];
  sharedResources: string[];
};

export type PresetSourceManifestPreset = BuiltInPreset & {
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

export type PresetSourceManifestValidationOptions = {
  readonly sourceRoot?: string;
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

    if (
      issue.message.startsWith("Invalid key:") &&
      /\.(body|content|text)$/.test(path)
    ) {
      const key = path.split(".").at(-1);

      return {
        path,
        message: `Preset Source Manifests must reference Generated Repository file bodies by path, not inline ${key}`,
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
  options: PresetSourceManifestValidationOptions = {},
): ValidationResult<PresetSourceManifest> {
  const result = v.safeParse(presetSourceManifestSchema, input);

  if (!result.success) {
    return { ok: false, issues: shapeIssues(result.issues) };
  }

  const semanticIssues = [
    ...duplicateValueIssues(
      result.output.sharedResources.map((resource) => resource.id),
      "$.sharedResources.id",
    ),
    ...duplicatePresetNameIssues(result.output.presets),
    ...duplicatePresetMetadataArrayIssues(result.output.presets),
    ...unsupportedProjectShapeIssues(result.output.presets),
    ...sharedResourcePathIssues(result.output, options.sourceRoot),
    ...presetSourceReferenceIssues(result.output, options.sourceRoot),
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
      presets: result.output.presets.map((preset) => ({
        ...preset,
        supportedPackageManagers: [
          ...preset.supportedPackageManagers,
        ] as PackageManager[],
        supportedProjectKinds: [
          ...preset.supportedProjectKinds,
        ] as ProjectKind[],
        features: [...preset.features] as FeatureName[],
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

  const bridgeIssues = builtInRegistryBridgeIssues(result.value);
  if (bridgeIssues.length > 0) {
    return { ok: false, issues: bridgeIssues };
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

export function loadBuiltInPresetSourceManifest(): PresetSourceManifest {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = packageTemplateRoot(moduleDir, "preset-source.json");
  const result = validateBuiltInPresetSourceManifest(
    JSON.parse(readFileSync(filePath, "utf8")) as unknown,
    { sourceRoot: path.dirname(filePath) },
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
