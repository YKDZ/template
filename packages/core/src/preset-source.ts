import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type {
  BuiltInPreset,
  PresetSourceManifest,
  PresetSourceManifestPreset,
  PresetSourceManifestPresetSource,
  PresetSourceManifestSharedResource,
  ValidationIssue,
  ValidationResult,
} from "@ykdz/template-shared";
import {
  presetSourceManifestJsonSchema,
  validatePresetSourceManifestDeclaration,
} from "@ykdz/template-shared";

import {
  loadTemplateDependencyCatalog,
  type TemplateDependencyCatalog,
} from "./dependency-catalog.js";

export { presetSourceManifestJsonSchema };
export type {
  BuiltInPreset,
  PresetSourceManifest,
  PresetSourceManifestPreset,
  PresetSourceManifestPresetSource,
  PresetSourceManifestSharedResource,
};

export type PresetSourceManifestValidationOptions = {
  readonly sourceRoot?: string;
  readonly dependencyCatalog?: TemplateDependencyCatalog;
};

type CoreSemanticPresetSource = {
  readonly roots: readonly string[];
  readonly files: readonly string[];
  readonly sharedResources: readonly string[];
};

type CoreSemanticPreset = {
  readonly manifestIndex?: number;
  readonly name: string;
  readonly dependencyCatalog?: readonly string[];
  readonly source?: CoreSemanticPresetSource;
};

type CoreSemanticSharedResource = PresetSourceManifestSharedResource & {
  readonly manifestIndex?: number;
};

type CoreSemanticManifest = {
  readonly sharedResources: readonly CoreSemanticSharedResource[];
  readonly presets: readonly CoreSemanticPreset[];
};

function dependencyCatalogReferenceIssues(
  presets: readonly Pick<
    CoreSemanticPreset,
    "dependencyCatalog" | "manifestIndex" | "name"
  >[],
  dependencyCatalog: TemplateDependencyCatalog,
): ValidationIssue[] {
  return presets.flatMap((preset, fallbackPresetIndex) => {
    const presetIndex = preset.manifestIndex ?? fallbackPresetIndex;

    return (preset.dependencyCatalog ?? [])
      .filter((dependency) => dependencyCatalog[dependency] === undefined)
      .map((dependency) => ({
        path: `$.presets[${presetIndex}].dependencyCatalog`,
        message: `Preset ${preset.name} references missing Template Dependency Catalog entry: ${dependency}`,
      }));
  });
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
  manifest: Pick<CoreSemanticManifest, "sharedResources">,
  sourceRoot: string | undefined,
): ValidationIssue[] {
  if (sourceRoot === undefined) {
    return [];
  }

  return manifest.sharedResources.flatMap((resource, fallbackResourceIndex) => {
    const resourceIndex = resource.manifestIndex ?? fallbackResourceIndex;
    const resolvedPath = resolvePresetSourcePath(sourceRoot, resource.path);

    if (typeof resolvedPath !== "string") {
      return [
        {
          path: `$.sharedResources[${resourceIndex}].path`,
          message: resolvedPath.issue,
        },
      ];
    }

    if (!existsSync(resolvedPath)) {
      return [
        {
          path: `$.sharedResources[${resourceIndex}].path`,
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
          path: `$.sharedResources[${resourceIndex}].path`,
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

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

function corePresetSourceFromUnknown(
  source: unknown,
): CoreSemanticPresetSource | undefined {
  if (!isRecord(source)) {
    return undefined;
  }

  return {
    roots: stringArray(source.roots) ?? [],
    files: stringArray(source.files) ?? [],
    sharedResources: stringArray(source.sharedResources) ?? [],
  };
}

function coreSemanticManifestFromUnknown(
  input: unknown,
): CoreSemanticManifest | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const sharedResources = Array.isArray(input.sharedResources)
    ? input.sharedResources.flatMap((resource, manifestIndex) =>
        isRecord(resource) &&
        typeof resource.id === "string" &&
        typeof resource.path === "string"
          ? [{ id: resource.id, path: resource.path, manifestIndex }]
          : [],
      )
    : [];

  const presets = Array.isArray(input.presets)
    ? input.presets.flatMap((preset, manifestIndex) => {
        if (!isRecord(preset) || typeof preset.name !== "string") {
          return [];
        }

        const source = corePresetSourceFromUnknown(preset.source);

        return [
          {
            manifestIndex,
            name: preset.name,
            dependencyCatalog: stringArray(preset.dependencyCatalog) ?? [],
            ...(source === undefined ? {} : { source }),
          },
        ];
      })
    : [];

  return { sharedResources, presets };
}

function presetSourceReferenceIssues(
  manifest: CoreSemanticManifest,
  sourceRoot: string | undefined,
): ValidationIssue[] {
  const sharedResourceIds = new Set(
    manifest.sharedResources.map((resource) => resource.id),
  );

  return manifest.presets.flatMap((preset, fallbackPresetIndex) => {
    const presetIndex = preset.manifestIndex ?? fallbackPresetIndex;
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

function coreSemanticIssues(
  manifest: CoreSemanticManifest,
  options: PresetSourceManifestValidationOptions,
): ValidationIssue[] {
  return [
    ...dependencyCatalogReferenceIssues(
      manifest.presets,
      options.dependencyCatalog ?? loadTemplateDependencyCatalog(),
    ),
    ...sharedResourcePathIssues(manifest, options.sourceRoot),
    ...presetSourceReferenceIssues(manifest, options.sourceRoot),
  ];
}

function supportedProjectionDeclarationIssues(
  presets: readonly {
    readonly generation: "supported" | "future";
    readonly projection?: unknown;
    readonly name: string;
  }[],
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

  const result = validatePresetSourceManifestDeclaration(input);
  const manifest = result.ok
    ? result.value
    : coreSemanticManifestFromUnknown(input);
  const semanticIssues = manifest ? coreSemanticIssues(manifest, options) : [];

  if (!result.ok || semanticIssues.length > 0) {
    return {
      ok: false,
      issues: [...(result.ok ? [] : result.issues), ...semanticIssues],
    };
  }

  return {
    ok: true,
    value: result.value,
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

  return [...files].toSorted();
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
