import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidationIssue, ValidationResult } from "./declarations.js";
import {
  collectGeneratedManifestCatalogDependencies,
  renderGeneratedPnpmWorkspaceYaml,
} from "./dependency-catalog.js";
import {
  checkedDockerfileFirstNodePnpmDevcontainer,
  nodePnpmToolLayer,
} from "./devcontainer.js";
import {
  editorCustomizationForCapabilities,
  type EditorCustomizationCapability,
} from "./editor-customization.js";
import type { GenerationContext } from "./generation-context.js";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "./module-graph.js";
import {
  packageManifestExposureFields,
  type PackageRole,
  type PackageSourcePreset,
  planPackageLinks,
} from "./package-linking.js";
import type { PresetProjectionPlan } from "./preset-projection.js";
import type { PresetSourceManifestPreset } from "./preset-source.js";
import type { DependencyMaintenancePolicy } from "./project-github.js";
import type { RenderOperation } from "./renderer.js";
import { packageTemplateRoot } from "./runtime-paths.js";

export type ProjectionCapabilityKind =
  | "workspace-library-package"
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

export type StrictTypescriptRootCapabilityDeclaration = {
  readonly kind: "strict-typescript-root";
};

export type OxcFormatLintCapabilityDeclaration = {
  readonly kind: "oxc-format-lint";
};

export type NodePnpmDevcontainerCapabilityDeclaration = {
  readonly kind: "node-pnpm-devcontainer";
};

export type GithubMaintenanceCapabilityDeclaration = {
  readonly kind: "github-maintenance";
};

export type ProjectionCapabilityDeclaration =
  | WorkspaceLibraryPackageCapabilityDeclaration
  | StrictTypescriptRootCapabilityDeclaration
  | OxcFormatLintCapabilityDeclaration
  | NodePnpmDevcontainerCapabilityDeclaration
  | GithubMaintenanceCapabilityDeclaration;

export type PresetProjectionDeclaration = {
  readonly capabilities: readonly ProjectionCapabilityDeclaration[];
};

type ProjectionPlanCapabilityFlag = keyof PresetProjectionPlan["capabilities"];

type ProjectionCapabilityInterpreter<
  T extends ProjectionCapabilityDeclaration,
> = {
  readonly kind: T["kind"];
  contribute(options: {
    readonly capability: T;
    readonly state: ProjectionCompositionState;
  }): void;
};

type ProjectionOperationFactory = (options: {
  readonly context: GenerationContext;
  readonly state: ProjectionCompositionState;
  readonly packageScripts: Record<string, string>;
  readonly packageScriptsByPath: ReadonlyMap<string, Record<string, string>>;
}) => readonly RenderOperation[];

type ProjectionCompositionState = {
  sourceRoot?: string;
  sourceRoots: Record<string, string>;
  rootCheckComponents: CheckPlan["components"];
  packageCheckComponents: CheckPlan["components"];
  rootFixComponents: FixPlan["components"];
  packageFixComponents: FixPlan["components"];
  rootScriptFragments: Record<string, string>;
  packageScriptFragments: Record<string, string>;
  rootDevDependencies: Set<string>;
  packageDependencies: Set<string>;
  packageDevDependencies: Set<string>;
  dependencyMaintenanceEcosystems: DependencyMaintenancePolicy["ecosystems"];
  package?: WorkspaceLibraryPackageCapabilityDeclaration;
  editorCustomizationCapabilities: EditorCustomizationCapability[];
  operationFactories: ProjectionOperationFactory[];
  flags: Partial<Record<ProjectionPlanCapabilityFlag, true>>;
};

const projectionCapabilityKinds = [
  "workspace-library-package",
  "strict-typescript-root",
  "oxc-format-lint",
  "node-pnpm-devcontainer",
  "github-maintenance",
] satisfies readonly ProjectionCapabilityKind[];

const projectionCapabilityKindSet = new Set<string>(projectionCapabilityKinds);

const strictTypescriptRootBoundary: ComponentOwner = {
  kind: "workspace-orchestration",
  path: ".",
};

const workspacePackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const workspacePackageCollectionBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "packages/*",
};

const requiredPlanCapabilityProviders: readonly {
  readonly flag: ProjectionPlanCapabilityFlag;
  readonly kind: ProjectionCapabilityKind;
  readonly label: string;
}[] = [
  {
    flag: "rootCheck",
    kind: "strict-typescript-root",
    label: "root check command",
  },
  {
    flag: "fixCommand",
    kind: "oxc-format-lint",
    label: "fix command",
  },
  {
    flag: "githubActions",
    kind: "github-maintenance",
    label: "GitHub Actions maintenance",
  },
  {
    flag: "dependabot",
    kind: "github-maintenance",
    label: "Dependabot maintenance",
  },
  {
    flag: "devcontainer",
    kind: "node-pnpm-devcontainer",
    label: "development container support",
  },
];

const exactCapabilityKeys: Record<ProjectionCapabilityKind, readonly string[]> =
  {
    "workspace-library-package": [
      "kind",
      "workspacePackageGlob",
      "packageRole",
      "packageSourcePreset",
      "sourceFiles",
    ],
    "strict-typescript-root": ["kind"],
    "oxc-format-lint": ["kind"],
    "node-pnpm-devcontainer": ["kind"],
    "github-maintenance": ["kind"],
  };

const dependencyMaintenanceEcosystems: DependencyMaintenancePolicy["ecosystems"] =
  ["npm", "github-actions", "docker"];

const capabilityInterpreters = {
  "workspace-library-package": {
    kind: "workspace-library-package",
    contribute({ capability, state }) {
      state.package = capability;
      state.sourceRoot = templateSourceRoot(capability.packageSourcePreset);
      state.packageDependencies.add("valibot");
      state.operationFactories.push(workspaceLibraryPackageOperations);
    },
  },
  "strict-typescript-root": {
    kind: "strict-typescript-root",
    contribute({ state }) {
      state.rootCheckComponents.push({
        kind: "typescript-typecheck",
        owner: strictTypescriptRootBoundary,
      });
      state.rootCheckComponents.push({
        kind: "turbo-package-typecheck",
        owner: workspacePackageCollectionBoundary,
      });
      state.rootCheckComponents.push({
        kind: "turbo-package-check",
        owner: workspacePackageCollectionBoundary,
      });
      state.packageCheckComponents.push({
        kind: "typescript-typecheck",
        owner: workspacePackageBoundary,
      });
      state.rootScriptFragments.typecheck =
        "tsc -p tsconfig.config.json --noEmit";
      state.packageScriptFragments.typecheck = "tsc -p tsconfig.json --noEmit";
      state.rootDevDependencies.add("typescript");
      state.packageDevDependencies.add("@types/node");
      state.packageDevDependencies.add("typescript");
      state.flags.rootCheck = true;
      state.operationFactories.push(strictTypescriptOperations);
    },
  },
  "oxc-format-lint": {
    kind: "oxc-format-lint",
    contribute({ state }) {
      state.sourceRoots.sharedOxc = sharedOxcSourceRoot();
      state.rootCheckComponents.unshift(
        {
          kind: "oxc-format-check",
          owner: strictTypescriptRootBoundary,
        },
        {
          kind: "oxc-lint",
          owner: strictTypescriptRootBoundary,
        },
      );
      state.packageCheckComponents.push(
        { kind: "oxc-lint", owner: workspacePackageBoundary },
        { kind: "oxc-format-check", owner: workspacePackageBoundary },
      );
      state.rootFixComponents.push(
        {
          kind: "oxc-format-write",
          owner: strictTypescriptRootBoundary,
        },
        {
          kind: "oxc-lint-fix",
          owner: strictTypescriptRootBoundary,
        },
        {
          kind: "turbo-package-fix",
          owner: workspacePackageCollectionBoundary,
        },
      );
      state.packageFixComponents.push(
        { kind: "oxc-format-write", owner: workspacePackageBoundary },
        { kind: "oxc-lint-fix", owner: workspacePackageBoundary },
      );
      state.rootScriptFragments["format:check"] =
        "oxfmt --check --config oxfmt.config.ts oxlint.config.ts oxfmt.config.ts";
      state.rootScriptFragments["format:write"] =
        "oxfmt --write --config oxfmt.config.ts oxlint.config.ts oxfmt.config.ts";
      state.rootScriptFragments.lint =
        "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts --deny-warnings";
      state.rootScriptFragments["lint:fix"] =
        "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts --fix --deny-warnings";
      state.packageScriptFragments["format:check"] =
        "oxfmt --check --config ../../oxfmt.config.ts .";
      state.packageScriptFragments["format:write"] =
        "oxfmt --write --config ../../oxfmt.config.ts .";
      state.packageScriptFragments.lint =
        "oxlint --config ../../oxlint.config.ts . --deny-warnings";
      state.packageScriptFragments["lint:fix"] =
        "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings";
      state.rootDevDependencies.add("oxfmt");
      state.rootDevDependencies.add("oxlint");
      state.packageDevDependencies.add("oxfmt");
      state.packageDevDependencies.add("oxlint");
      state.editorCustomizationCapabilities.push("oxc-format-lint");
      state.flags.fixCommand = true;
      state.operationFactories.push(oxcFormatLintOperations);
    },
  },
  "node-pnpm-devcontainer": {
    kind: "node-pnpm-devcontainer",
    contribute({ state }) {
      state.sourceRoots.sharedDevcontainer = sharedDevcontainerSourceRoot();
      state.flags.devcontainer = true;
      state.operationFactories.push(nodePnpmDevcontainerOperations);
    },
  },
  "github-maintenance": {
    kind: "github-maintenance",
    contribute({ state }) {
      state.dependencyMaintenanceEcosystems.push(
        ...dependencyMaintenanceEcosystems,
      );
      state.flags.githubActions = true;
      state.flags.dependabot = true;
      state.operationFactories.push(githubMaintenanceOperations);
    },
  },
} satisfies {
  readonly [Kind in ProjectionCapabilityKind]: ProjectionCapabilityInterpreter<
    Extract<ProjectionCapabilityDeclaration, { kind: Kind }>
  >;
};

export function validateProjectionCapabilities(
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

    if (!projectionCapabilityKindSet.has(capability.kind)) {
      issues.push({
        path: `${pathPrefix}.kind`,
        message: `Unknown Projection Capability kind: ${capability.kind}`,
      });
      return;
    }

    const kind = capability.kind as ProjectionCapabilityKind;
    issues.push(...unknownCapabilityPropertyIssues(capability, pathPrefix));

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

    capabilities.push({ kind } as ProjectionCapabilityDeclaration);
  });

  if (issues.length === 0) {
    issues.push(...duplicateCapabilityIssues(capabilities));
    issues.push(...capabilityCompositionIssues(capabilities));
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      capabilities,
    },
  };
}

export function projectionCapabilityIssues(
  presets: readonly PresetSourceManifestPreset[],
): ValidationIssue[] {
  return presets.flatMap((preset, presetIndex) => {
    if (preset.projection === undefined) {
      return [];
    }

    const result = validateProjectionCapabilities(preset.projection);

    return result.ok
      ? []
      : result.issues.map((issue) => ({
          path: `$.presets[${presetIndex}].projection${issue.path.slice(1)}`,
          message: issue.message,
        }));
  });
}

export function normalizePresetProjectionDeclaration(
  declaration: PresetProjectionDeclaration,
): PresetProjectionDeclaration {
  const result = validateProjectionCapabilities(declaration);

  if (!result.ok) {
    throw new Error(
      `Projection Declaration is invalid:\n${result.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return result.value;
}

export function interpretPresetProjectionDeclaration(options: {
  readonly preset: PresetSourceManifestPreset;
  readonly declaration: PresetProjectionDeclaration;
  readonly context: GenerationContext;
}): PresetProjectionPlan {
  const validation = validateProjectionCapabilities(options.declaration);
  if (!validation.ok) {
    throw new Error(
      `Projection Declaration is invalid:\n${validation.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const state = createProjectionCompositionState();
  for (const capability of validation.value.capabilities) {
    capabilityInterpreters[capability.kind].contribute({
      capability: capability as never,
      state,
    });
  }

  const checkPlan: CheckPlan = {
    components: state.rootCheckComponents,
    environmentNeeds: [],
  };
  const fixPlan: FixPlan = {
    components: state.rootFixComponents,
  };
  const packageScripts = projectRootPackageScripts(
    checkPlan,
    fixPlan,
    state.rootScriptFragments,
  );
  const packageScriptsByPath = packageScriptsByWorkspacePath(state);
  const dependencyMaintenancePolicy: DependencyMaintenancePolicy = {
    ecosystems: uniqueValues(state.dependencyMaintenanceEcosystems),
    interval: "weekly",
  };

  if (state.sourceRoot === undefined) {
    throw new Error(
      "Projection Capability composition did not provide sourceRoot",
    );
  }

  return {
    sourceRoot: state.sourceRoot,
    sourceRoots: state.sourceRoots,
    operations: state.operationFactories.flatMap((factory) =>
      factory({
        context: options.context,
        state,
        packageScripts,
        packageScriptsByPath,
      }),
    ),
    checkPlan,
    fixPlan,
    dependencyMaintenancePolicy,
    packageScripts,
    capabilities: completePlanCapabilityFlags(state.flags),
  };
}

export function loadBuiltInPresetProjectionDeclaration(
  presetName: string,
): PresetProjectionDeclaration {
  const manifestPath = path.join(
    packageTemplateRoot(path.dirname(fileURLToPath(import.meta.url))),
    "preset-source.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;

  if (!isRecord(manifest) || !Array.isArray(manifest.presets)) {
    throw new Error("Built-in Preset Source Manifest must declare presets");
  }

  const preset = manifest.presets.find(
    (candidate) => isRecord(candidate) && candidate.name === presetName,
  );

  if (!isRecord(preset) || preset.projection === undefined) {
    throw new Error(
      `Built-in Preset ${presetName} must declare a Projection Declaration`,
    );
  }

  const result = validateProjectionCapabilities(preset.projection);
  if (!result.ok) {
    throw new Error(
      `Built-in Preset ${presetName} Projection Declaration is invalid:\n${result.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return result.value;
}

function createProjectionCompositionState(): ProjectionCompositionState {
  return {
    sourceRoots: {},
    rootCheckComponents: [],
    packageCheckComponents: [],
    rootFixComponents: [],
    packageFixComponents: [],
    rootScriptFragments: {},
    packageScriptFragments: {},
    rootDevDependencies: new Set(["turbo"]),
    packageDependencies: new Set(),
    packageDevDependencies: new Set(),
    dependencyMaintenanceEcosystems: [],
    editorCustomizationCapabilities: [],
    operationFactories: [],
    flags: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownCapabilityPropertyIssues(
  capability: Record<string, unknown>,
  pathPrefix: string,
): ValidationIssue[] {
  const kind = capability.kind as ProjectionCapabilityKind;
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
  } else if (
    capability.sourceFiles.length === 0 ||
    !capability.sourceFiles.every(
      (sourceFile) => typeof sourceFile === "string",
    )
  ) {
    issues.push({
      path: `${pathPrefix}.sourceFiles`,
      message:
        "workspace-library-package sourceFiles must be a non-empty array of paths",
    });
  }

  if (issues.length > 0) {
    return issues;
  }

  return {
    kind: "workspace-library-package",
    workspacePackageGlob: "packages/*",
    packageRole: "shared-library",
    packageSourcePreset: "ts-lib",
    sourceFiles: capability.sourceFiles as string[],
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

function capabilityCompositionIssues(
  capabilities: readonly ProjectionCapabilityDeclaration[],
): ValidationIssue[] {
  const kinds = new Set(capabilities.map((capability) => capability.kind));
  const issues: ValidationIssue[] = [];

  if (!kinds.has("workspace-library-package")) {
    issues.push({
      path: "$.capabilities",
      message:
        "Projection Capability composition must include workspace-library-package to define the workspace package layout",
    });
  }

  if (
    kinds.has("strict-typescript-root") &&
    !kinds.has("workspace-library-package")
  ) {
    issues.push({
      path: "$.capabilities",
      message:
        "strict-typescript-root requires workspace-library-package so package typecheck tasks have a workspace target",
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
    if (!kinds.has(requirement.kind)) {
      issues.push({
        path: "$.capabilities",
        message: `Projection Capability composition must include ${requirement.kind} to provide ${requirement.label}`,
      });
    }
  }

  return issues;
}

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function completePlanCapabilityFlags(
  flags: Partial<Record<ProjectionPlanCapabilityFlag, true>>,
): PresetProjectionPlan["capabilities"] {
  const missing = requiredPlanCapabilityProviders.filter(
    (requirement) => flags[requirement.flag] !== true,
  );

  if (missing.length > 0) {
    throw new Error(
      `Projection Capability composition did not provide required plan capabilities: ${missing
        .map((requirement) => requirement.flag)
        .join(", ")}`,
    );
  }

  return {
    rootCheck: true,
    fixCommand: true,
    githubActions: true,
    dependabot: true,
    devcontainer: true,
  };
}

function packageScriptsByWorkspacePath(
  state: ProjectionCompositionState,
): ReadonlyMap<string, Record<string, string>> {
  if (state.package === undefined) {
    return new Map();
  }

  return new Map([
    [
      state.package.workspacePackageGlob,
      projectPackageScripts(
        {
          components: state.packageCheckComponents,
          environmentNeeds: [],
        },
        {
          components: state.packageFixComponents,
        },
        state.packageScriptFragments,
      ),
    ],
  ]);
}

function projectRootPackageScripts(
  checkPlan: CheckPlan,
  fixPlan: FixPlan,
  fragments: Record<string, string>,
): Record<string, string> {
  return {
    check: renderRootCheckCommand(checkPlan),
    fix: renderFixCommand(fixPlan),
    ...fragments,
  };
}

function projectPackageScripts(
  checkPlan: CheckPlan,
  fixPlan: FixPlan,
  fragments: Record<string, string>,
): Record<string, string> {
  return {
    check: renderRootCheckCommand(checkPlan),
    fix: renderFixCommand(fixPlan),
    ...fragments,
  };
}

function packageCollection(workspacePackageGlob: "packages/*"): string {
  return workspacePackageGlob.slice(0, -"/*".length);
}

function workspacePackagePath(
  context: GenerationContext,
  capability: WorkspaceLibraryPackageCapabilityDeclaration,
): string {
  return `${packageCollection(capability.workspacePackageGlob)}/${context.projectName.value}`;
}

function workspacePackageName(
  context: GenerationContext,
  capability: WorkspaceLibraryPackageCapabilityDeclaration,
): string {
  const packageDefinition = context.blueprint.packages?.find(
    (pkg) => pkg.path === workspacePackagePath(context, capability),
  );

  return (
    packageDefinition?.name ??
    `@${context.projectName.value}/${context.projectName.value}`
  );
}

function packageLinkPlanFor(
  context: GenerationContext,
  capability: WorkspaceLibraryPackageCapabilityDeclaration,
) {
  return planPackageLinks([
    {
      name: workspacePackageName(context, capability),
      path: workspacePackagePath(context, capability),
      role: capability.packageRole as PackageRole,
      sourcePreset: capability.packageSourcePreset as PackageSourcePreset,
    },
  ]);
}

function rootPackageJson(
  context: GenerationContext,
  packageScripts: Record<string, string>,
  state: ProjectionCompositionState,
): Record<string, unknown> {
  return {
    name: context.projectName.value,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: packageScripts,
    devDependencies: catalogDependencies(state.rootDevDependencies),
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
    packageManager: context.toolchain.packageManagerPin.value,
  };
}

function libraryPackageJson(
  context: GenerationContext,
  state: ProjectionCompositionState,
  capability: WorkspaceLibraryPackageCapabilityDeclaration,
  scripts: Record<string, string>,
): Record<string, unknown> {
  const packagePath = workspacePackagePath(context, capability);
  const packageExposure = packageLinkPlanFor(
    context,
    capability,
  ).exposuresByPackagePath.get(packagePath);

  if (packageExposure === undefined) {
    throw new Error(`Missing Package Exposure for ${packagePath}`);
  }

  const exposureFields = packageManifestExposureFields(packageExposure);

  return {
    name: workspacePackageName(context, capability),
    version: "0.0.0",
    private: true,
    type: "module",
    imports: exposureFields.imports,
    exports: exposureFields.exports,
    dependencies: catalogDependencies(state.packageDependencies),
    scripts,
    devDependencies: catalogDependencies(state.packageDevDependencies),
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
  };
}

function catalogDependencies(
  dependencies: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    [...dependencies].sort().map((dependency) => [dependency, "catalog:"]),
  );
}

function generationRecord(context: GenerationContext): Record<string, unknown> {
  return {
    packageName: "@ykdz/template",
    version: "0.0.0",
    command: `template init --preset ${context.blueprint.preset}`,
    toolchain: {
      nodeLtsMajor: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
      source: context.toolchain.source,
    },
  };
}

function workspaceLibraryPackageOperations({
  context,
  state,
  packageScripts,
  packageScriptsByPath,
}: {
  readonly context: GenerationContext;
  readonly state: ProjectionCompositionState;
  readonly packageScripts: Record<string, string>;
  readonly packageScriptsByPath: ReadonlyMap<string, Record<string, string>>;
}): RenderOperation[] {
  if (state.package === undefined) {
    throw new Error("workspace-library-package capability state is missing");
  }

  const capability = state.package;
  const packagePath = workspacePackagePath(context, capability);
  const workspacePackageScripts = packageScriptsByPath.get(
    capability.workspacePackageGlob,
  );

  if (workspacePackageScripts === undefined) {
    throw new Error(
      `Missing package scripts for ${capability.workspacePackageGlob}`,
    );
  }

  const rootManifest = rootPackageJson(context, packageScripts, state);
  const packageManifest = libraryPackageJson(
    context,
    state,
    capability,
    workspacePackageScripts,
  );
  const packageLinkPlan = packageLinkPlanFor(context, capability);

  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: rootManifest,
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: renderGeneratedPnpmWorkspaceYaml({
        packages: [capability.workspacePackageGlob],
        dependencies: collectGeneratedManifestCatalogDependencies([
          rootManifest,
          packageManifest,
        ]),
      }),
    },
    {
      kind: "writeJson",
      to: "turbo.json",
      value: {
        tasks: {
          build: packageLinkPlan.turboTasks.build,
          check: packageLinkPlan.turboTasks.check,
          typecheck: packageLinkPlan.turboTasks.typecheck,
          test: packageLinkPlan.turboTasks.test,
          "test:e2e": packageLinkPlan.turboTasks["test:e2e"],
          fix: {
            cache: false,
          },
        },
      },
    },
    {
      kind: "writeJson",
      to: `${packagePath}/package.json`,
      value: packageManifest,
      multilineArrays: ["files"],
    },
    {
      kind: "writeText",
      to: ".gitignore",
      text: [
        "node_modules",
        "dist",
        ".env",
        ".template/",
        ".pnpm-store/",
        "",
      ].join("\n"),
    },
    ...capability.sourceFiles.map((sourceFile) => ({
      kind: "copyFile" as const,
      from: sourceFile,
      to: `${packagePath}/${sourceFile}`,
    })),
    {
      kind: "writeJson",
      to: ".template/blueprint.json",
      value: context.blueprint,
    },
    {
      kind: "writeJson",
      to: ".template/generated-by.json",
      value: generationRecord(context),
    },
  ];
}

function strictTypescriptOperations({
  context,
  state,
}: {
  readonly context: GenerationContext;
  readonly state: ProjectionCompositionState;
}): RenderOperation[] {
  if (state.package === undefined) {
    throw new Error(
      "strict-typescript-root requires workspace-library-package",
    );
  }

  return [
    {
      kind: "writeJson",
      to: "tsconfig.json",
      value: {
        files: [],
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
      to: `${workspacePackagePath(context, state.package)}/tsconfig.json`,
      value: {
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
          rootDir: "src",
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
    },
  ];
}

function oxcFormatLintOperations(): RenderOperation[] {
  const editorCustomization = editorCustomizationForCapabilities([
    "oxc-format-lint",
  ]);

  return [
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "node/oxlint.config.ts",
      to: "oxlint.config.ts",
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: "oxfmt.config.ts",
    },
    {
      kind: "writeJson",
      to: ".vscode/extensions.json",
      value: {
        recommendations: editorCustomization.extensions,
      },
      multilineArrays: ["recommendations"],
    },
    {
      kind: "writeJson",
      to: ".vscode/settings.json",
      value: editorCustomization.settings,
    },
  ];
}

function nodePnpmDevcontainerOperations({
  context,
  state,
}: {
  readonly context: GenerationContext;
  readonly state: ProjectionCompositionState;
}): RenderOperation[] {
  const editorCustomization = editorCustomizationForCapabilities(
    state.editorCustomizationCapabilities,
  );
  const developmentContainer = checkedDockerfileFirstNodePnpmDevcontainer({
    name: context.projectName.value,
    layer: nodePnpmToolLayer({
      nodeVersion: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
    }),
    extensions: editorCustomization.extensions,
    settings: editorCustomization.settings,
  });

  return [
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: developmentContainer.devcontainer,
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedDevcontainer",
      from: "node-pnpm.Dockerfile",
      to: ".devcontainer/Dockerfile",
    },
  ];
}

function githubMaintenanceOperations(): RenderOperation[] {
  return [
    {
      kind: "copyFile",
      from: ".github/workflows/check.yml",
      to: ".github/workflows/check.yml",
    },
    {
      kind: "copyFile",
      from: ".github/dependabot.yml",
      to: ".github/dependabot.yml",
    },
  ];
}

function templateSourceRoot(sourcePreset: "ts-lib"): string {
  return packageTemplateRoot(
    path.dirname(fileURLToPath(import.meta.url)),
    sourcePreset,
  );
}

function sharedOxcSourceRoot(): string {
  return packageTemplateRoot(
    path.dirname(fileURLToPath(import.meta.url)),
    "shared",
    "oxc",
  );
}

function sharedDevcontainerSourceRoot(): string {
  return packageTemplateRoot(
    path.dirname(fileURLToPath(import.meta.url)),
    "shared",
    "devcontainer",
  );
}
