import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidationIssue, ValidationResult } from "./declarations.js";
import {
  collectGeneratedManifestCatalogDependencies,
  collectGeneratedManifestCatalogReferences,
  renderGeneratedPnpmWorkspaceYaml,
} from "./dependency-catalog.js";
import {
  browserTestToolLayer,
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
  | "workspace-node-packages"
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

export type WorkspaceNodePackageKind = "hono-api" | "vue-app";

export type WorkspaceNodePackageDeclaration = {
  readonly kind: WorkspaceNodePackageKind;
  readonly path: "apps/api" | "apps/web";
  readonly sourceFiles: readonly string[];
};

export type WorkspaceNodePackagesCapabilityDeclaration = {
  readonly kind: "workspace-node-packages";
  readonly workspacePackageGlob: "apps/*";
  readonly packages: readonly WorkspaceNodePackageDeclaration[];
  readonly packageLinks?: readonly {
    readonly consumerPackagePath: "apps/web";
    readonly providerPackagePath: "apps/api";
  }[];
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
  | WorkspaceNodePackagesCapabilityDeclaration
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
  rootCheckEnvironmentNeeds: CheckPlan["environmentNeeds"];
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
  nodeWorkspace?: WorkspaceNodePackagesCapabilityDeclaration;
  editorCustomizationCapabilities: EditorCustomizationCapability[];
  operationFactories: ProjectionOperationFactory[];
  flags: Partial<Record<ProjectionPlanCapabilityFlag, true>>;
};

const projectionCapabilityKinds = [
  "workspace-library-package",
  "workspace-node-packages",
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
    "workspace-node-packages": [
      "kind",
      "workspacePackageGlob",
      "packages",
      "packageLinks",
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
  "workspace-node-packages": {
    kind: "workspace-node-packages",
    contribute({ capability, state }) {
      state.nodeWorkspace = capability;
      state.sourceRoot = templateSourceRootForPreset(
        sourceRootPreset(capability),
      );
      state.operationFactories.push(workspaceNodePackagesOperations);
      if (capability.packages.length > 1) {
        state.rootScriptFragments.dev = "turbo run dev --parallel";
      }
      if (hasVuePackage(capability)) {
        state.rootCheckEnvironmentNeeds.push({
          kind: "playwright-browser-assets",
          browser: "chromium",
          owner: { kind: "package-boundary", path: "apps/web" },
        });
        state.editorCustomizationCapabilities.push("vue", "tailwind");
      }
      state.editorCustomizationCapabilities.push("vitest");
    },
  },
  "strict-typescript-root": {
    kind: "strict-typescript-root",
    contribute({ state }) {
      state.rootCheckComponents.push({
        kind: "typescript-typecheck",
        owner: strictTypescriptRootBoundary,
      });
      const workspaceBoundary = workspaceBoundaryForState(state);
      state.rootCheckComponents.push({
        kind: "turbo-package-typecheck",
        owner: workspaceBoundary,
      });
      if (state.nodeWorkspace !== undefined) {
        state.rootCheckComponents.push({
          kind: "turbo-package-build",
          owner: workspaceBoundary,
        });
        state.rootCheckComponents.push({
          kind: "turbo-package-test",
          owner: workspaceBoundary,
        });
        if (hasVuePackage(state.nodeWorkspace)) {
          state.rootCheckComponents.push({
            kind: "turbo-package-e2e-test",
            owner: workspaceBoundary,
          });
        }
      }
      state.rootCheckComponents.push({
        kind: "turbo-package-check",
        owner: workspaceBoundary,
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
          owner: workspaceBoundaryForState(state),
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
    environmentNeeds: state.rootCheckEnvironmentNeeds,
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
    rootCheckEnvironmentNeeds: [],
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
    !capability.sourceFiles.every(isNonEmptyString)
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

function parseWorkspaceNodePackagesCapability(
  capability: Record<string, unknown>,
  pathPrefix: string,
): WorkspaceNodePackagesCapabilityDeclaration | ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (capability.workspacePackageGlob !== "apps/*") {
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

  return {
    kind: "workspace-node-packages",
    workspacePackageGlob: "apps/*",
    packages,
    ...(packageLinks === undefined ? {} : { packageLinks }),
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

  if (value.kind !== "hono-api" && value.kind !== "vue-app") {
    issues.push({
      path: `${pathPrefix}.kind`,
      message:
        "workspace-node-packages package kind must be hono-api or vue-app",
    });
  }

  if (value.path !== "apps/api" && value.path !== "apps/web") {
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
  } else if (
    value.sourceFiles.length === 0 ||
    !value.sourceFiles.every(isNonEmptyString)
  ) {
    issues.push({
      path: `${pathPrefix}.sourceFiles`,
      message:
        "workspace-node-packages package sourceFiles must be a non-empty array of paths",
    });
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

  return {
    kind: value.kind as WorkspaceNodePackageKind,
    path: value.path as "apps/api" | "apps/web",
    sourceFiles: value.sourceFiles as string[],
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

    if (
      link.consumerPackagePath !== "apps/web" ||
      link.providerPackagePath !== "apps/api"
    ) {
      linkIssues.push({
        path: linkPath,
        message:
          "workspace-node-packages currently supports links from apps/web to apps/api",
      });
    } else {
      if (!declaredPackagePaths.has(link.consumerPackagePath)) {
        linkIssues.push({
          path: `${linkPath}.consumerPackagePath`,
          message:
            "workspace-node-packages packageLink consumerPackagePath must reference a package declared in the same packages array: apps/web",
        });
      }

      if (!declaredPackagePaths.has(link.providerPackagePath)) {
        linkIssues.push({
          path: `${linkPath}.providerPackagePath`,
          message:
            "workspace-node-packages packageLink providerPackagePath must reference a package declared in the same packages array: apps/api",
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
        providerPackagePath: "apps/api" as const,
      },
    ];
  });
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

  if (
    !kinds.has("workspace-library-package") &&
    !kinds.has("workspace-node-packages")
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

function workspaceBoundaryForState(
  state: ProjectionCompositionState,
): ComponentOwner {
  return workspaceGlobBoundary(
    state.nodeWorkspace?.workspacePackageGlob ??
      state.package?.workspacePackageGlob ??
      "packages/*",
  );
}

function workspaceGlobBoundary(
  workspacePackageGlob: "apps/*" | "packages/*",
): ComponentOwner {
  return {
    kind: "package-boundary",
    path: workspacePackageGlob,
  };
}

function hasVuePackage(
  capability: WorkspaceNodePackagesCapabilityDeclaration,
): boolean {
  return capability.packages.some(
    (nodePackage) => nodePackage.kind === "vue-app",
  );
}

function sourceRootPreset(
  capability: WorkspaceNodePackagesCapabilityDeclaration,
): "hono-api" | "vue-app" | "vue-hono-app" {
  if (capability.packages.length === 1) {
    return capability.packages[0]!.kind;
  }

  return "vue-hono-app";
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

function packageCollection(
  workspacePackageGlob: "apps/*" | "packages/*",
): string {
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

function nodePackageDefinitions(
  context: GenerationContext,
  capability: WorkspaceNodePackagesCapabilityDeclaration,
) {
  return capability.packages
    .filter((nodePackage) => nodePackage.kind === "hono-api")
    .map((nodePackage) => ({
      name: nodePackageName(context, nodePackage),
      path: nodePackage.path,
      role: "runtime-service" as const,
      sourcePreset: "hono-api" as const,
    }));
}

function nodePackageName(
  context: GenerationContext,
  nodePackage: WorkspaceNodePackageDeclaration,
): string {
  const packageDefinition = context.blueprint.packages?.find(
    (pkg) => pkg.path === nodePackage.path,
  );

  if (packageDefinition !== undefined) {
    return packageDefinition.name;
  }

  const leaf = nodePackage.path.split("/").at(-1) ?? nodePackage.path;
  return `@${context.projectName.value}/${leaf}`;
}

function packageScopeFromNodeWorkspace(context: GenerationContext): string {
  const apiPackage = context.blueprint.packages?.find(
    (pkg) => pkg.path === "apps/api",
  );

  if (apiPackage?.name.startsWith("@") && apiPackage.name.endsWith("/api")) {
    return apiPackage.name.slice(1, -"/api".length);
  }

  return context.projectName.value;
}

function nodePackageLinkPlan(
  context: GenerationContext,
  capability: WorkspaceNodePackagesCapabilityDeclaration,
) {
  return planPackageLinks(
    nodePackageDefinitions(context, capability),
    capability.packageLinks ?? [],
  );
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

function honoApiPackageJson(
  context: GenerationContext,
  packageName: string,
  scripts: Record<string, string>,
  exposureFields: ReturnType<typeof packageManifestExposureFields> | undefined,
): Record<string, unknown> {
  return {
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    ...(exposureFields === undefined
      ? {
          imports: {
            "#/*": {
              default: "./dist/*.js",
              types: "./src/*.ts",
            },
          },
        }
      : {
          types: exposureFields.types,
          exports: exposureFields.exports,
          imports: exposureFields.imports,
        }),
    scripts,
    dependencies: {
      "@hono/node-server": "catalog:",
      hono: "catalog:",
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      ...(scripts.dev === undefined ? {} : { tsx: "catalog:" }),
      typescript: "catalog:",
      vitest: "catalog:",
    },
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
  };
}

function vuePackageJson(
  context: GenerationContext,
  packageName: string,
  scripts: Record<string, string>,
  packageLinkDependencies: Readonly<Record<string, "workspace:*">> = {},
): Record<string, unknown> {
  return {
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    imports: {
      "#/*": {
        default: "./src/*.ts",
        types: "./src/*.ts",
      },
    },
    scripts,
    dependencies: {
      ...packageLinkDependencies,
      "@vueuse/core": "catalog:",
      ...(Object.keys(packageLinkDependencies).length === 0
        ? {}
        : { hono: "catalog:" }),
      pinia: "catalog:",
      vue: "catalog:",
    },
    devDependencies: {
      "@playwright/test": "catalog:",
      "@tailwindcss/vite": "catalog:",
      "@types/node": "catalog:",
      "@types/web-bluetooth": "catalog:",
      "@vitejs/plugin-vue": "catalog:",
      "@vue/tsconfig": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      tailwindcss: "catalog:",
      typescript: "catalog:",
      vite: "catalog:",
      vitest: "catalog:",
      "vue-tsc": "catalog:",
    },
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

function workspaceNodePackagesOperations({
  context,
  state,
  packageScripts,
}: {
  readonly context: GenerationContext;
  readonly state: ProjectionCompositionState;
  readonly packageScripts: Record<string, string>;
}): RenderOperation[] {
  if (state.nodeWorkspace === undefined) {
    throw new Error("workspace-node-packages capability state is missing");
  }

  const capability = state.nodeWorkspace;
  const packageLinkPlan = nodePackageLinkPlan(context, capability);
  const packageManifests = capability.packages.map((nodePackage) => {
    const scripts = nodePackageScripts(nodePackage, capability);
    const packageName = nodePackageName(context, nodePackage);

    if (nodePackage.kind === "hono-api") {
      const exposure = packageLinkPlan.exposuresByPackagePath.get(
        nodePackage.path,
      );
      return honoApiPackageJson(
        context,
        packageName,
        scripts,
        exposure === undefined
          ? undefined
          : packageManifestExposureFields(exposure),
      );
    }

    return vuePackageJson(
      context,
      packageName,
      scripts,
      packageLinkPlan.manifestDependenciesByPackagePath.get(nodePackage.path),
    );
  });
  const rootManifest = rootPackageJson(context, packageScripts, state);

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
        dependencies:
          capability.packageLinks === undefined
            ? collectGeneratedManifestCatalogDependencies([
                rootManifest,
                ...packageManifests,
              ])
            : collectGeneratedManifestCatalogReferences([
                rootManifest,
                ...packageManifests,
              ]),
        ...(hasVuePackage(capability)
          ? {
              allowBuilds: {
                esbuild: true,
              },
            }
          : {}),
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
          ...(hasVuePackage(capability)
            ? {
                dev: {
                  cache: false,
                  persistent: true,
                },
              }
            : {}),
          fix: {
            cache: false,
          },
        },
      },
    },
    {
      kind: "writeText",
      to: ".gitignore",
      text: gitignoreForNodeWorkspace(capability),
    },
    ...capability.packages.flatMap((nodePackage, index) => [
      {
        kind: "writeJson" as const,
        to: `${nodePackage.path}/package.json`,
        value: packageManifests[index],
      },
      ...nodePackageTsconfigOperations(nodePackage, capability),
      ...nodePackage.sourceFiles.map((sourceFile) => ({
        kind: "copyFile" as const,
        from: sourceFile,
        to: `${nodePackage.path}/${sourcePathWithinNodePackage(sourceFile, capability)}`,
      })),
    ]),
    ...fullStackApiAnchorOperations(context, capability),
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

function nodePackageScripts(
  nodePackage: WorkspaceNodePackageDeclaration,
  workspace: WorkspaceNodePackagesCapabilityDeclaration,
): Record<string, string> {
  const oxcScripts = {
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts . --deny-warnings",
    "lint:fix":
      "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings",
  };

  if (nodePackage.kind === "hono-api") {
    const checks: CheckPlan = {
      components: [
        { kind: "oxc-format-check", owner: workspacePackageBoundary },
        { kind: "oxc-lint", owner: workspacePackageBoundary },
        { kind: "typescript-typecheck", owner: workspacePackageBoundary },
        { kind: "build", owner: workspacePackageBoundary },
        { kind: "unit-test", owner: workspacePackageBoundary },
      ],
      environmentNeeds: [],
    };
    const fixes: FixPlan = {
      components: [
        { kind: "oxc-format-write", owner: workspacePackageBoundary },
        { kind: "oxc-lint-fix", owner: workspacePackageBoundary },
      ],
    };

    return {
      build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
      check: renderRootCheckCommand(checks),
      ...(workspace.packages.length > 1
        ? { dev: "tsx watch src/server.ts" }
        : {}),
      fix: renderFixCommand(fixes),
      ...oxcScripts,
      start: "node dist/server.js",
      test: "vitest run",
      typecheck: "tsc -p tsconfig.json --noEmit",
    };
  }

  const checks: CheckPlan = {
    components: [
      { kind: "oxc-format-check", owner: workspacePackageBoundary },
      { kind: "oxc-lint", owner: workspacePackageBoundary },
      { kind: "typescript-typecheck", owner: workspacePackageBoundary },
      { kind: "build", owner: workspacePackageBoundary },
      { kind: "unit-test", owner: workspacePackageBoundary },
      { kind: "e2e-test", owner: workspacePackageBoundary },
    ],
    environmentNeeds: [],
  };
  const fixes: FixPlan = {
    components: [
      { kind: "oxc-format-write", owner: workspacePackageBoundary },
      { kind: "oxc-lint-fix", owner: workspacePackageBoundary },
    ],
  };

  return {
    build: "vite build",
    check: renderRootCheckCommand(checks),
    dev: "vite",
    fix: renderFixCommand(fixes),
    ...oxcScripts,
    preview: "vite preview",
    test: "vitest run",
    "test:e2e": "pnpm run build && playwright test",
    typecheck:
      workspace.packages.length > 1
        ? "vue-tsc --build"
        : "vue-tsc --build --noEmit",
  };
}

function nodePackageTsconfigOperations(
  nodePackage: WorkspaceNodePackageDeclaration,
  workspace: WorkspaceNodePackagesCapabilityDeclaration,
): RenderOperation[] {
  if (nodePackage.kind === "hono-api") {
    return [
      {
        kind: "writeJson",
        to: `${nodePackage.path}/tsconfig.json`,
        value: {
          compilerOptions: {
            composite: true,
            ...(workspace.packages.length > 1
              ? { declaration: true, declarationMap: true }
              : {}),
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmitOnError: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2022",
            types: ["node", "vitest/globals"],
          },
          include: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
        },
      },
      {
        kind: "writeJson",
        to: `${nodePackage.path}/tsconfig.build.json`,
        value: {
          extends: "./tsconfig.json",
          compilerOptions: {
            outDir: "dist",
            rootDir: "src",
            types: ["node"],
          },
          include: ["src/**/*.ts"],
        },
      },
    ];
  }

  return [
    {
      kind: "writeJson",
      to: `${nodePackage.path}/tsconfig.json`,
      value: {
        files: [],
        references: [
          { path: "./tsconfig.app.json" },
          { path: "./tsconfig.test.json" },
          { path: "./tsconfig.node.json" },
        ],
      },
    },
    {
      kind: "writeJson",
      to: `${nodePackage.path}/tsconfig.app.json`,
      value: {
        extends: "@vue/tsconfig/tsconfig.dom.json",
        compilerOptions: {
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
          types: ["web-bluetooth"],
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue"],
      },
    },
    {
      kind: "writeJson",
      to: `${nodePackage.path}/tsconfig.test.json`,
      value: {
        extends: "./tsconfig.app.json",
        compilerOptions: {
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.test.tsbuildinfo",
          types: ["node", "vitest/globals", "web-bluetooth"],
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue", "test/**/*.ts"],
      },
    },
    {
      kind: "writeJson",
      to: `${nodePackage.path}/tsconfig.node.json`,
      value: {
        compilerOptions: {
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          ...(workspace.packages.length > 1
            ? { outDir: "./node_modules/.tmp/tsconfig.node" }
            : {}),
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
          types: ["node"],
        },
        include: ["playwright.config.ts", "vite.config.ts", "vitest.config.ts"],
      },
    },
  ];
}

function sourcePathWithinNodePackage(
  sourceFile: string,
  workspace: WorkspaceNodePackagesCapabilityDeclaration,
): string {
  if (workspace.packages.length === 1) {
    return sourceFile;
  }

  return sourceFile.replace(/^(api|web)\//, "");
}

function gitignoreForNodeWorkspace(
  workspace: WorkspaceNodePackagesCapabilityDeclaration,
): string {
  return [
    "node_modules",
    "dist",
    ...(hasVuePackage(workspace) ? ["playwright-report", "test-results"] : []),
    ".env",
    ".template/",
    ".pnpm-store/",
    "",
  ].join("\n");
}

function fullStackApiAnchorOperations(
  context: GenerationContext,
  workspace: WorkspaceNodePackagesCapabilityDeclaration,
): RenderOperation[] {
  if (
    workspace.packageLinks?.some(
      (link) =>
        link.consumerPackagePath === "apps/web" &&
        link.providerPackagePath === "apps/api",
    ) !== true
  ) {
    return [];
  }

  const packageScope = packageScopeFromNodeWorkspace(context);
  return [
    {
      kind: "replaceAnchors",
      path: "apps/web/src/api.ts",
      language: "typescript",
      replacements: {
        "api-type-import-start": `import type { AppType } from "@${packageScope}/api";\nimport { hc } from "hono/client";\n/*`,
        "api-type-import-end": "*/",
      },
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
  if (state.package === undefined && state.nodeWorkspace === undefined) {
    throw new Error(
      "strict-typescript-root requires a workspace package layout",
    );
  }

  if (state.nodeWorkspace !== undefined) {
    return [
      {
        kind: "writeJson",
        to: "tsconfig.json",
        value: {
          files: [],
          references: rootTsconfigReferences(state.nodeWorkspace),
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
    ];
  }

  const libraryPackage = state.package!;

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
      to: `${workspacePackagePath(context, libraryPackage)}/tsconfig.json`,
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

function rootTsconfigReferences(
  workspace: WorkspaceNodePackagesCapabilityDeclaration,
): Array<{ path: string }> {
  return workspace.packages.flatMap((nodePackage) => {
    if (nodePackage.kind === "hono-api") {
      return hasVuePackage(workspace)
        ? []
        : [{ path: `./${nodePackage.path}/tsconfig.json` }];
    }

    return [
      { path: `./${nodePackage.path}/tsconfig.app.json` },
      { path: `./${nodePackage.path}/tsconfig.test.json` },
      { path: `./${nodePackage.path}/tsconfig.node.json` },
    ];
  });
}

function oxcFormatLintOperations({
  state,
}: {
  readonly state: ProjectionCompositionState;
}): RenderOperation[] {
  const editorCustomization = editorCustomizationForCapabilities(
    state.editorCustomizationCapabilities,
  );

  return [
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from:
        state.nodeWorkspace && hasVuePackage(state.nodeWorkspace)
          ? "vue/oxlint.config.ts"
          : "node/oxlint.config.ts",
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
    additionalLayers:
      state.nodeWorkspace && hasVuePackage(state.nodeWorkspace)
        ? [browserTestToolLayer()]
        : [],
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
      ...developmentContainer.dockerfileOperation!,
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

function templateSourceRoot(
  sourcePreset: "hono-api" | "ts-lib" | "vue-app" | "vue-hono-app",
): string {
  return templateSourceRootForPreset(sourcePreset);
}

function templateSourceRootForPreset(
  sourcePreset: "hono-api" | "ts-lib" | "vue-app" | "vue-hono-app",
): string {
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
