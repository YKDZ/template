import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  GithubMaintenanceCapabilityDeclaration,
  NodePnpmDevcontainerCapabilityDeclaration,
  ProjectBlueprint,
  ProjectionCapabilityDeclaration,
  ProjectionCapabilityKind,
  OxcFormatLintCapabilityDeclaration,
  PresetProjectionDeclaration,
  RustBinaryWorkspaceCapabilityDeclaration,
  StrictTypescriptRootCapabilityDeclaration,
  WorkspaceLibraryPackageCapabilityDeclaration,
  WorkspaceNodePackageDeclaration,
  WorkspaceNodePackageKind,
  WorkspaceNodePackagesCapabilityDeclaration,
  WorkspaceNodePackagePath,
} from "@ykdz/template-shared";
import type { PackageRole, PackageSourcePreset } from "@ykdz/template-shared";
import {
  normalizePresetProjectionDeclaration,
  projectionCapabilityIssues,
  validatePresetProjectionDeclaration as validateProjectionCapabilities,
} from "@ykdz/template-shared";

import {
  collectGeneratedManifestCatalogDependencies,
  collectGeneratedManifestCatalogReferences,
  renderGeneratedPnpmWorkspaceYaml,
} from "./dependency-catalog.js";
import {
  browserTestToolLayer,
  checkedDockerfileFirstNodePnpmDevcontainer,
  type DevelopmentContainerDockerfileFragments,
  dockerfileFirstRustPnpmDevcontainer,
  nodePnpmToolLayer,
  rustToolLayer,
} from "./devcontainer.js";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
  type EditorCustomizationCapability,
  type EditorCustomizationDeclarations,
} from "./editor-customization.js";
import type { GenerationContext } from "./generation-context.js";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  playwrightBrowserAssetsEnvironmentNeed,
  renderFixCommand,
  renderRootCheckCommand,
} from "./module-graph.js";
import {
  packageManifestExposureFields,
  planPackageLinks,
} from "./package-linking.js";
import type {
  PresetBlueprintOptions,
  PresetPackageAdditionOptions,
  PresetPackageAdditionPlan,
  PresetProjectionPlan,
} from "./preset-projection.js";
import type { PresetSourceManifestPreset } from "./preset-source.js";
import type { DependencyMaintenancePolicy } from "./project-github.js";
import type { RenderOperation } from "./renderer.js";

export {
  normalizePresetProjectionDeclaration,
  projectionCapabilityIssues,
  validateProjectionCapabilities,
};
export type {
  GithubMaintenanceCapabilityDeclaration,
  NodePnpmDevcontainerCapabilityDeclaration,
  OxcFormatLintCapabilityDeclaration,
  PresetProjectionDeclaration,
  ProjectionCapabilityDeclaration,
  ProjectionCapabilityKind,
  RustBinaryWorkspaceCapabilityDeclaration,
  StrictTypescriptRootCapabilityDeclaration,
  WorkspaceLibraryPackageCapabilityDeclaration,
  WorkspaceNodePackageDeclaration,
  WorkspaceNodePackageKind,
  WorkspaceNodePackagesCapabilityDeclaration,
  WorkspaceNodePackagePath,
};

export type ProjectionSourcePreset =
  | "hono-api"
  | "rust-bin"
  | "ts-lib"
  | "vue-app"
  | "vue-hono-app";

export type PresetProjectionSourceRoots = {
  readonly preset: (sourcePreset: ProjectionSourcePreset) => string;
  readonly sharedOxc: () => string;
  readonly sharedResource: (resourceId: string) => string | undefined;
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

type WriteJsonRenderOperation = Extract<RenderOperation, { kind: "writeJson" }>;

type ProjectionCompositionState = {
  projectionSourceRoots: PresetProjectionSourceRoots;
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
  rustWorkspace?: RustBinaryWorkspaceCapabilityDeclaration;
  devcontainerResource?: {
    readonly id: string;
    readonly root: string;
    readonly sourceRootKey: string;
  };
  editorCustomizationResource?: {
    readonly id: string;
    readonly root: string;
    readonly declarations: EditorCustomizationDeclarations;
  };
  editorCustomizationCapabilities: EditorCustomizationCapability[];
  operationFactories: ProjectionOperationFactory[];
  flags: Partial<Record<ProjectionPlanCapabilityFlag, true>>;
};

const strictTypescriptRootBoundary: ComponentOwner = {
  kind: "workspace-orchestration",
  path: ".",
};

const workspacePackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
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

const dependencyMaintenanceEcosystems: DependencyMaintenancePolicy["ecosystems"] =
  ["npm", "github-actions", "docker"];

function strictTypeScriptCompilerOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...options,
    erasableSyntaxOnly: true,
    exactOptionalPropertyTypes: true,
    forceConsistentCasingInFileNames: true,
    isolatedModules: true,
    noEmitOnError: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    noImplicitReturns: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    strict: true,
    target: "es2023",
    verbatimModuleSyntax: true,
  };
}

const capabilityInterpreters = {
  "workspace-library-package": {
    kind: "workspace-library-package",
    contribute({ capability, state }) {
      state.package = capability;
      state.sourceRoot = templateSourceRoot(
        state,
        capability.packageSourcePreset,
      );
      state.packageDependencies.add("valibot");
      state.operationFactories.push(workspaceLibraryPackageOperations);
    },
  },
  "workspace-node-packages": {
    kind: "workspace-node-packages",
    contribute({ capability, state }) {
      state.nodeWorkspace = capability;
      state.sourceRoot = templateSourceRootForPreset(
        state,
        sourceRootPreset(capability),
      );
      state.operationFactories.push(workspaceNodePackagesOperations);
      if (capability.packages.length > 1) {
        state.rootScriptFragments.dev = "turbo run dev --parallel";
      }
      const vuePackage = findVuePackage(capability);
      if (vuePackage !== undefined) {
        state.rootCheckEnvironmentNeeds.push(
          playwrightBrowserAssetsEnvironmentNeed({
            browser: "chromium",
            owner: { kind: "package-boundary", path: vuePackage.path },
          }),
        );
        state.editorCustomizationCapabilities.push("vue", "tailwind");
      }
      state.editorCustomizationCapabilities.push("vitest");
    },
  },
  "rust-binary-workspace": {
    kind: "rust-binary-workspace",
    contribute({ capability, state }) {
      state.rustWorkspace = capability;
      state.sourceRoot = templateSourceRootForPreset(state, "rust-bin");
      setDevelopmentContainerResource(
        state,
        capability.devcontainerResourceId,
        "rust-binary-workspace",
      );
      setEditorCustomizationResource(
        state,
        capability.editorCustomizationResourceId,
        "rust-binary-workspace",
      );
      state.rootCheckComponents.push({
        kind: "turbo-package-check",
        owner: workspaceGlobBoundary(capability.workspacePackageGlob),
      });
      state.rootFixComponents.push({
        kind: "turbo-package-fix",
        owner: workspaceGlobBoundary(capability.workspacePackageGlob),
      });
      state.packageCheckComponents.push(
        { kind: "rustfmt-check", owner: workspacePackageBoundary },
        { kind: "cargo-clippy", owner: workspacePackageBoundary },
        { kind: "cargo-test", owner: workspacePackageBoundary },
      );
      state.packageFixComponents.push({
        kind: "rustfmt-write",
        owner: workspacePackageBoundary,
      });
      state.dependencyMaintenanceEcosystems.push(
        "npm",
        "cargo",
        "github-actions",
        "docker",
        "rust-toolchain",
      );
      state.editorCustomizationCapabilities.push("rust-tooling");
      state.flags.rootCheck = true;
      state.flags.fixCommand = true;
      state.flags.githubActions = true;
      state.flags.dependabot = true;
      state.flags.devcontainer = true;
      state.operationFactories.push(rustBinaryWorkspaceOperations);
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
    contribute({ capability, state }) {
      state.sourceRoots.sharedOxc = state.projectionSourceRoots.sharedOxc();
      setEditorCustomizationResource(
        state,
        capability.editorCustomizationResourceId,
        "oxc-format-lint",
      );
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
        "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts";
      state.rootScriptFragments["lint:fix"] =
        "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts --fix";
      state.packageScriptFragments["format:check"] =
        "oxfmt --check --config ../../oxfmt.config.ts .";
      state.packageScriptFragments["format:write"] =
        "oxfmt --write --config ../../oxfmt.config.ts .";
      state.packageScriptFragments.lint =
        "oxlint --config ../../oxlint.config.ts .";
      state.packageScriptFragments["lint:fix"] =
        "oxlint --config ../../oxlint.config.ts . --fix";
      state.rootDevDependencies.add("oxfmt");
      state.rootDevDependencies.add("oxlint");
      state.rootDevDependencies.add("oxlint-tsgolint");
      state.packageDevDependencies.add("oxfmt");
      state.packageDevDependencies.add("oxlint");
      state.packageDevDependencies.add("oxlint-tsgolint");
      state.editorCustomizationCapabilities.push("oxc-format-lint");
      state.flags.fixCommand = true;
      state.operationFactories.push(oxcFormatLintOperations);
    },
  },
  "node-pnpm-devcontainer": {
    kind: "node-pnpm-devcontainer",
    contribute({ capability, state }) {
      setDevelopmentContainerResource(
        state,
        capability.devcontainerResourceId,
        "node-pnpm-devcontainer",
      );
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

function contributeProjectionCapability(
  capability: ProjectionCapabilityDeclaration,
  state: ProjectionCompositionState,
): void {
  switch (capability.kind) {
    case "workspace-library-package":
      capabilityInterpreters["workspace-library-package"].contribute({
        capability,
        state,
      });
      return;
    case "workspace-node-packages":
      capabilityInterpreters["workspace-node-packages"].contribute({
        capability,
        state,
      });
      return;
    case "rust-binary-workspace":
      capabilityInterpreters["rust-binary-workspace"].contribute({
        capability,
        state,
      });
      return;
    case "strict-typescript-root":
      capabilityInterpreters["strict-typescript-root"].contribute({
        capability,
        state,
      });
      return;
    case "oxc-format-lint":
      capabilityInterpreters["oxc-format-lint"].contribute({
        capability,
        state,
      });
      return;
    case "node-pnpm-devcontainer":
      capabilityInterpreters["node-pnpm-devcontainer"].contribute({
        capability,
        state,
      });
      return;
    case "github-maintenance":
      capabilityInterpreters["github-maintenance"].contribute({
        capability,
        state,
      });
      return;
  }
}

export function interpretPresetProjectionDeclaration(options: {
  readonly preset: PresetSourceManifestPreset;
  readonly declaration: PresetProjectionDeclaration;
  readonly context: GenerationContext;
  readonly sourceRoots: PresetProjectionSourceRoots;
}): PresetProjectionPlan {
  const validation = validateProjectionCapabilities(options.declaration);
  if (!validation.ok) {
    throw new Error(
      `Projection Declaration is invalid:\n${validation.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const state = createProjectionCompositionState(options.sourceRoots);
  for (const capability of validation.value.capabilities) {
    contributeProjectionCapability(capability, state);
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
    ...(state.rustWorkspace === undefined
      ? {}
      : {
          directories: {
            cargo: `/${rustWorkspacePackagePath(options.context)}`,
          },
        }),
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

export function blueprintForPresetSourcePreset(
  preset: PresetSourceManifestPreset,
  options: PresetBlueprintOptions = { targetDir: process.cwd() },
): ProjectBlueprint {
  const packageScope = options.scope ?? projectNameFromDir(options.targetDir);
  const projectName = projectNameFromDir(options.targetDir);
  const packageManager = preset.supportedPackageManagers[0];
  const blueprint: ProjectBlueprint = {
    schemaVersion: 1,
    preset: preset.name,
    ...(packageManager === undefined ? {} : { packageManager }),
    projectKind: preset.supportedProjectKinds[0] ?? "multi-package",
    features: [...preset.features],
  };

  if (preset.projection === undefined) {
    return blueprint;
  }

  const validation = validateProjectionCapabilities(preset.projection);
  if (!validation.ok) {
    throw new Error(
      `Projection Declaration is invalid:\n${validation.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const packages = blueprintPackagesForCapabilities(
    validation.value.capabilities,
    packageScope,
    projectName,
  );

  return packages.length === 0 ? blueprint : { ...blueprint, packages };
}

export function projectPresetSourcePreset(options: {
  readonly preset: PresetSourceManifestPreset;
  readonly context: GenerationContext;
  readonly sourceRoots: PresetProjectionSourceRoots;
}): PresetProjectionPlan {
  if (options.preset.projection === undefined) {
    throw new Error(
      `Preset ${options.preset.name} must declare a Projection Declaration`,
    );
  }

  return interpretPresetProjectionDeclaration({
    preset: options.preset,
    declaration: options.preset.projection,
    context: options.context,
    sourceRoots: options.sourceRoots,
  });
}

export async function planPresetSourcePackageAddition(options: {
  readonly preset: PresetSourceManifestPreset;
  readonly addition: PresetPackageAdditionOptions;
  readonly sourceRoots: PresetProjectionSourceRoots;
}): Promise<PresetPackageAdditionPlan> {
  if (options.preset.projection === undefined) {
    throw new Error(
      `Preset ${options.preset.name} declares Package Addition support but has no Projection Declaration`,
    );
  }

  const state = stateForProjectionDeclaration(
    options.preset.projection,
    options.sourceRoots,
  );
  const additionCapability = packageAdditionCapabilityForState(
    options.preset.name,
    state,
  );

  return {
    packagePath: options.addition.packagePath,
    workspacePackageGlob: additionCapability.workspacePackageGlob,
    workspaceMembershipGlob: `${packageCollectionFromPackagePath(
      options.addition.packagePath,
    )}/*`,
    packageRole: additionCapability.packageRole,
    packageSourcePreset: additionCapability.packageSourcePreset,
    sourceRoot: templateSourceRootForPreset(
      state,
      additionCapability.sourcePreset,
    ),
    sourceRoots: state.sourceRoots,
    operations: [
      ...packageAdditionOperationsForCapability({
        capability: additionCapability,
        packageName: options.addition.packageName,
        packagePath: options.addition.packagePath,
        nodeVersion: options.addition.nodeVersion,
      }),
      ...(additionCapability.packageSourcePreset === "vue-app"
        ? [
            {
              kind: "writeTextTemplate" as const,
              from: "playwright.package-addition.config.ts",
              to: `${options.addition.packagePath}/playwright.config.ts`,
              replacements: {
                VUE_PREVIEW_PORT: String(
                  await nextVuePreviewPort(
                    options.addition.root,
                    options.addition.blueprint,
                  ),
                ),
              },
            },
          ]
        : []),
    ],
  };
}

export function defaultPackagePathForPresetSourcePackageAddition(
  preset: PresetSourceManifestPreset,
  packageLeafName: string,
  sourceRoots: PresetProjectionSourceRoots,
): string {
  if (preset.projection === undefined) {
    throw new Error(
      `Preset ${preset.name} declares Package Addition support but has no Projection Declaration`,
    );
  }

  const state = stateForProjectionDeclaration(preset.projection, sourceRoots);
  const additionCapability = packageAdditionCapabilityForState(
    preset.name,
    state,
  );

  return `${packageCollection(additionCapability.workspacePackageGlob)}/${packageLeafName}`;
}

function createProjectionCompositionState(
  sourceRoots: PresetProjectionSourceRoots,
): ProjectionCompositionState {
  return {
    projectionSourceRoots: sourceRoots,
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

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function setDevelopmentContainerResource(
  state: ProjectionCompositionState,
  resourceId: string,
  capabilityKind: "node-pnpm-devcontainer" | "rust-binary-workspace",
): void {
  const root = state.projectionSourceRoots.sharedResource(resourceId);

  if (root === undefined) {
    throw new Error(
      `Projection Capability ${capabilityKind} references unresolved Development Container Shared Resource: ${resourceId}`,
    );
  }

  const sourceRootKey = developmentContainerResourceSourceRootKey(resourceId);

  state.devcontainerResource = { id: resourceId, root, sourceRootKey };
  state.sourceRoots[sourceRootKey] = root;
}

function setEditorCustomizationResource(
  state: ProjectionCompositionState,
  resourceId: string,
  capabilityKind: "oxc-format-lint" | "rust-binary-workspace",
): void {
  const root = state.projectionSourceRoots.sharedResource(resourceId);

  if (root === undefined) {
    throw new Error(
      `Projection Capability ${capabilityKind} references unresolved Editor Customization Shared Resource: ${resourceId}`,
    );
  }

  state.editorCustomizationResource = {
    id: resourceId,
    root,
    declarations: loadEditorCustomizationDeclarations(root),
  };
}

function developmentContainerResourceSourceRootKey(resourceId: string): string {
  return `devcontainer:${resourceId}`;
}

function editorCustomizationDeclarationsForState(
  state: ProjectionCompositionState,
): EditorCustomizationDeclarations {
  if (state.editorCustomizationResource === undefined) {
    throw new Error(
      "Projection Capability composition did not provide Editor Customization Shared Resource",
    );
  }

  return state.editorCustomizationResource.declarations;
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function blueprintPackagesForCapabilities(
  capabilities: readonly ProjectionCapabilityDeclaration[],
  packageScope: string,
  projectName: string,
): NonNullable<ProjectBlueprint["packages"]> {
  return capabilities.flatMap((capability) => {
    if (capability.kind === "workspace-library-package") {
      return [
        {
          name: `@${packageScope}/${projectName}`,
          path: `${packageCollection(capability.workspacePackageGlob)}/${projectName}`,
        },
      ];
    }

    if (capability.kind === "workspace-node-packages") {
      return capability.packages.map((nodePackage) => {
        const leaf = nodePackage.path.split("/").at(-1) ?? nodePackage.path;
        return {
          name: `@${packageScope}/${leaf}`,
          path: nodePackage.path,
        };
      });
    }

    if (capability.kind === "rust-binary-workspace") {
      const rustPackageName = cargoPackageNameFromProjectName(projectName);
      return [
        {
          name: `${rustPackageName}-native`,
          path: `packages/${rustPackageName}`,
        },
      ];
    }

    return [];
  });
}

function stateForProjectionDeclaration(
  declaration: PresetProjectionDeclaration,
  sourceRoots: PresetProjectionSourceRoots,
): ProjectionCompositionState {
  const validation = validateProjectionCapabilities(declaration);
  if (!validation.ok) {
    throw new Error(
      `Projection Declaration is invalid:\n${validation.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const state = createProjectionCompositionState(sourceRoots);
  for (const capability of validation.value.capabilities) {
    contributeProjectionCapability(capability, state);
  }

  return state;
}

type PackageAdditionProjectionCapability = {
  readonly sourcePreset: "hono-api" | "ts-lib" | "vue-app";
  readonly workspacePackageGlob: "apps/*" | "packages/*";
  readonly packageRole: PackageRole;
  readonly packageSourcePreset: PackageSourcePreset;
  readonly sourceFiles: readonly string[];
  readonly packageScripts: Record<string, string>;
  readonly nodePackage?: WorkspaceNodePackageDeclaration;
  readonly nodeWorkspace?: WorkspaceNodePackagesCapabilityDeclaration;
};

function packageAdditionCapabilityForState(
  presetName: string,
  state: ProjectionCompositionState,
): PackageAdditionProjectionCapability {
  if (state.package !== undefined) {
    const scripts = packageScriptsByWorkspacePath(state).get(
      state.package.workspacePackageGlob,
    );
    if (scripts === undefined) {
      throw new Error(
        `Missing package scripts for ${state.package.workspacePackageGlob}`,
      );
    }

    return {
      sourcePreset: state.package.packageSourcePreset,
      workspacePackageGlob: state.package.workspacePackageGlob,
      packageRole: state.package.packageRole,
      packageSourcePreset: state.package.packageSourcePreset,
      sourceFiles: state.package.sourceFiles,
      packageScripts: scripts,
    };
  }

  if (state.nodeWorkspace !== undefined) {
    if (state.nodeWorkspace.packages.length !== 1) {
      throw new Error(
        `Preset ${presetName} is an initialization-only workspace and cannot be used for Package Addition`,
      );
    }

    const nodePackage = state.nodeWorkspace.packages[0];
    if (nodePackage === undefined) {
      throw new Error(
        `Preset ${presetName} must declare one package for Package Addition`,
      );
    }

    return {
      sourcePreset: nodePackage.kind,
      workspacePackageGlob: state.nodeWorkspace.workspacePackageGlob,
      packageRole: "runtime-service",
      packageSourcePreset: nodePackage.kind,
      sourceFiles: nodePackage.sourceFiles,
      packageScripts: nodePackageScripts(nodePackage, state.nodeWorkspace),
      nodePackage,
      nodeWorkspace: state.nodeWorkspace,
    };
  }

  throw new Error(
    `Preset ${presetName} is an initialization-only workspace and cannot be used for Package Addition`,
  );
}

function packageCollectionFromPackagePath(packagePath: string): string {
  const [workspaceCollection] = packagePath.split("/");
  if (!workspaceCollection) {
    throw new Error(
      `Invalid Package Path for Package Addition: ${packagePath}`,
    );
  }

  return workspaceCollection;
}

function packageAdditionOperationsForCapability(options: {
  readonly capability: PackageAdditionProjectionCapability;
  readonly packageName: string;
  readonly packagePath: string;
  readonly nodeVersion: string;
}): RenderOperation[] {
  switch (options.capability.packageSourcePreset) {
    case "ts-lib":
      return libraryPackageAdditionOperations(options);
    case "hono-api":
      return honoApiPackageAdditionOperations(options);
    case "vue-app":
      return vueAppPackageAdditionOperations(options);
  }
}

function generationContextForPackageAddition(options: {
  readonly preset: string;
  readonly packageName: string;
  readonly packagePath: string;
  readonly nodeVersion: string;
}): GenerationContext {
  return {
    projectName: {
      kind: "ProjectName",
      value: options.packageName.split("/").at(0)?.replace(/^@/, "") ?? "app",
    },
    preset: options.preset,
    packageManager: { kind: "PackageManager", value: "pnpm" },
    blueprint: {
      schemaVersion: 1,
      preset: options.preset,
      packageManager: "pnpm",
      projectKind: "multi-package",
      features: [],
      packages: [{ name: options.packageName, path: options.packagePath }],
    },
    toolchain: {
      nodeLtsMajor: { kind: "NodeLtsMajor", value: options.nodeVersion },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.34.4" },
      source: "bundled-fallback",
      diagnostics: [],
    },
  };
}

function libraryPackageAdditionOperations(options: {
  readonly capability: PackageAdditionProjectionCapability;
  readonly packageName: string;
  readonly packagePath: string;
  readonly nodeVersion: string;
}): RenderOperation[] {
  const packageExposure = planPackageLinks([
    {
      name: options.packageName,
      path: options.packagePath,
      role: "shared-library",
      sourcePreset: "ts-lib",
    },
  ]).exposuresByPackagePath.get(options.packagePath);

  if (packageExposure === undefined) {
    throw new Error(`Missing Package Exposure for ${options.packagePath}`);
  }

  const exposureFields = packageManifestExposureFields(packageExposure);

  return [
    {
      kind: "writeJson",
      to: `${options.packagePath}/package.json`,
      value: {
        name: options.packageName,
        version: "0.0.0",
        private: true,
        type: "module",
        imports: exposureFields.imports,
        exports: exposureFields.exports,
        dependencies: {
          valibot: "catalog:",
        },
        scripts: options.capability.packageScripts,
        devDependencies: {
          "@types/node": "catalog:",
          oxfmt: "catalog:",
          oxlint: "catalog:",
          typescript: "catalog:",
        },
        engines: {
          node: options.nodeVersion,
        },
      },
      multilineArrays: ["files"],
    },
    {
      kind: "writeJson",
      to: `${options.packagePath}/tsconfig.json`,
      value: libraryTsconfigJson(),
    },
    ...options.capability.sourceFiles.map((sourceFile) => ({
      kind: "copyFile" as const,
      from: sourceFile,
      to: `${options.packagePath}/${sourceFile}`,
    })),
  ];
}

function libraryTsconfigJson(): Record<string, unknown> {
  return {
    compilerOptions: strictTypeScriptCompilerOptions({
      composite: true,
      declaration: true,
      declarationMap: true,
      module: "nodenext",
      moduleResolution: "nodenext",
      rootDir: "src",
      types: ["node"],
    }),
    include: ["src/**/*.ts"],
  };
}

function honoApiPackageAdditionOperations(options: {
  readonly capability: PackageAdditionProjectionCapability;
  readonly packageName: string;
  readonly packagePath: string;
  readonly nodeVersion: string;
}): RenderOperation[] {
  const packageExposure = planPackageLinks([
    {
      name: options.packageName,
      path: options.packagePath,
      role: "runtime-service",
      sourcePreset: "hono-api",
    },
  ]).exposuresByPackagePath.get(options.packagePath);

  if (packageExposure === undefined) {
    throw new Error(`Missing Package Exposure for ${options.packagePath}`);
  }

  return [
    {
      kind: "writeJson",
      to: `${options.packagePath}/package.json`,
      value: honoApiPackageJson(
        generationContextForPackageAddition({
          preset: "hono-api",
          packageName: options.packageName,
          packagePath: options.packagePath,
          nodeVersion: options.nodeVersion,
        }),
        options.packageName,
        options.capability.packageScripts,
        packageManifestExposureFields(packageExposure),
      ),
    },
    ...honoApiTsconfigOperations(options.packagePath),
    ...options.capability.sourceFiles.map((sourceFile) => ({
      kind: "copyFile" as const,
      from: sourceFile,
      to: `${options.packagePath}/${sourceFile}`,
    })),
  ];
}

function vueAppPackageAdditionOperations(options: {
  readonly capability: PackageAdditionProjectionCapability;
  readonly packageName: string;
  readonly packagePath: string;
  readonly nodeVersion: string;
}): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: `${options.packagePath}/package.json`,
      value: vuePackageJson(
        generationContextForPackageAddition({
          preset: "vue-app",
          packageName: options.packageName,
          packagePath: options.packagePath,
          nodeVersion: options.nodeVersion,
        }),
        options.packageName,
        options.capability.packageScripts,
      ),
    },
    ...vueAppTsconfigOperations(options.packagePath),
    ...options.capability.sourceFiles
      .filter(
        (sourceFile) => path.basename(sourceFile) !== "playwright.config.ts",
      )
      .map((sourceFile) => ({
        kind: "copyFile" as const,
        from: sourceFile,
        to: `${options.packagePath}/${sourceFile}`,
      })),
  ];
}

function localPortsFromText(text: string): number[] {
  return [
    ...text.matchAll(/--port\s+(\d+)/g),
    ...text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g),
  ].map((match) => Number(match[1]));
}

async function usedPlaywrightPorts(
  root: string,
  blueprint: ProjectBlueprint,
): Promise<Set<number>> {
  const ports = new Set<number>();

  for (const projectPackage of blueprint.packages ?? []) {
    try {
      const configText = await readFile(
        path.join(root, projectPackage.path, "playwright.config.ts"),
        "utf8",
      );

      for (const port of localPortsFromText(configText)) {
        ports.add(port);
      }
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return ports;
}

async function nextVuePreviewPort(
  root: string,
  blueprint: ProjectBlueprint,
): Promise<number> {
  const usedPorts = await usedPlaywrightPorts(root, blueprint);
  let port = 4173;

  while (usedPorts.has(port)) {
    port += 1;
  }

  return port;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
  if (state.package === undefined && state.rustWorkspace === undefined) {
    return new Map();
  }

  if (state.rustWorkspace !== undefined) {
    return new Map([
      [
        state.rustWorkspace.workspacePackageGlob,
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

  return new Map([
    [
      state.package!.workspacePackageGlob,
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
      state.rustWorkspace?.workspacePackageGlob ??
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
  return findVuePackage(capability) !== undefined;
}

function findVuePackage(
  capability: WorkspaceNodePackagesCapabilityDeclaration,
): WorkspaceNodePackageDeclaration | undefined {
  return capability.packages.find(
    (nodePackage) => nodePackage.kind === "vue-app",
  );
}

function sourceRootPreset(
  capability: WorkspaceNodePackagesCapabilityDeclaration,
): "hono-api" | "vue-app" | "vue-hono-app" {
  if (capability.packages.length === 1) {
    const nodePackage = capability.packages[0];
    if (nodePackage === undefined) {
      throw new Error("Node package workspace must contain one package");
    }

    return nodePackage.kind;
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

function cargoPackageNameFromProjectName(projectName: string): string {
  const slug = projectName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "rust-bin";
}

function rustProjectName(context: GenerationContext): string {
  return cargoPackageNameFromProjectName(context.projectName.value);
}

function rustWorkspacePackagePath(context: GenerationContext): string {
  return `packages/${rustProjectName(context)}`;
}

function rustWorkspacePackageName(context: GenerationContext): string {
  return `${rustProjectName(context)}-native`;
}

function packageLinkPlanFor(
  context: GenerationContext,
  capability: WorkspaceLibraryPackageCapabilityDeclaration,
) {
  return planPackageLinks([
    {
      name: workspacePackageName(context, capability),
      path: workspacePackagePath(context, capability),
      role: capability.packageRole,
      sourcePreset: capability.packageSourcePreset,
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
      "oxlint-tsgolint": "catalog:",
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
      "oxlint-tsgolint": "catalog:",
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
    [...dependencies].toSorted().map((dependency) => [dependency, "catalog:"]),
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

function rustCargoToml(projectName: string): string {
  return [
    "[package]",
    `name = "${projectName}"`,
    'version = "0.1.0"',
    'edition = "2024"',
    "",
    "[dependencies]",
    "",
    "[lints]",
    "workspace = true",
    "",
    "[workspace]",
    'members = ["."]',
    'resolver = "3"',
    "",
    "[workspace.lints.rust]",
    'unsafe_code = "forbid"',
    "",
    "[workspace.lints.clippy]",
    'all = "deny"',
    'pedantic = "deny"',
    'nursery = "deny"',
    "",
    "[profile.release]",
    'strip = "symbols"',
    'lto = "thin"',
    "codegen-units = 1",
    "",
  ].join("\n");
}

function rustCargoLock(projectName: string): string {
  return [
    "# This file is automatically @generated by Cargo.",
    "# It is not intended for manual editing.",
    "version = 4",
    "",
    "[[package]]",
    `name = "${projectName}"`,
    'version = "0.1.0"',
    "",
  ].join("\n");
}

function rustRootPackageJson(
  context: GenerationContext,
  packageScripts: Record<string, string>,
  state: ProjectionCompositionState,
): Record<string, unknown> {
  return {
    name: rustProjectName(context),
    version: "0.0.0",
    private: true,
    scripts: packageScripts,
    devDependencies: catalogDependencies(state.rootDevDependencies),
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
    packageManager: context.toolchain.packageManagerPin.value,
  };
}

function rustWorkspacePackageJson(
  context: GenerationContext,
  scripts: Record<string, string>,
): Record<string, unknown> {
  return {
    name: rustWorkspacePackageName(context),
    version: "0.0.0",
    private: true,
    scripts,
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
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

function rustBinaryWorkspaceOperations({
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
  if (state.rustWorkspace === undefined) {
    throw new Error("rust-binary-workspace capability state is missing");
  }

  const capability = state.rustWorkspace;
  const packagePath = rustWorkspacePackagePath(context);
  const workspacePackageScripts = packageScriptsByPath.get(
    capability.workspacePackageGlob,
  );

  if (workspacePackageScripts === undefined) {
    throw new Error(
      `Missing package scripts for ${capability.workspacePackageGlob}`,
    );
  }

  const rootManifest = rustRootPackageJson(context, packageScripts, state);
  const packageManifest = rustWorkspacePackageJson(
    context,
    workspacePackageScripts,
  );
  const rustLayer = rustToolLayer();
  const dockerfileFragments = readDevelopmentContainerDockerfileFragments(
    state,
    ["rust"],
  );
  const editorCustomization = editorCustomizationForCapabilities(
    state.editorCustomizationCapabilities,
    editorCustomizationDeclarationsForState(state),
  );
  const developmentContainer = dockerfileFirstRustPnpmDevcontainer({
    name: context.projectName.value,
    nodeLayer: nodePnpmToolLayer({
      nodeVersion: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
    }),
    rustLayer,
    dockerfileFragments,
    extensions: editorCustomization.extensions,
    settings: editorCustomization.settings,
  });

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
          check: {},
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
    },
    {
      kind: "writeText",
      to: `${packagePath}/Cargo.toml`,
      text: rustCargoToml(rustProjectName(context)),
    },
    {
      kind: "writeText",
      to: `${packagePath}/Cargo.lock`,
      text: rustCargoLock(rustProjectName(context)),
    },
    {
      kind: "copyFile",
      from: "rustfmt.toml",
      to: `${packagePath}/rustfmt.toml`,
    },
    {
      kind: "writeTextTemplate",
      from: "rust-toolchain.toml",
      to: "rust-toolchain.toml",
      replacements: {
        RUST_TOOLCHAIN: rustLayer.toolchain,
      },
    },
    {
      kind: "writeText",
      to: ".gitignore",
      text: [
        "target",
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
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: developmentContainer.devcontainer,
    },
    {
      ...developmentContainer.dockerfileOperation!,
    },
    {
      kind: "writeJson",
      to: ".vscode/extensions.json",
      value: {
        recommendations: editorCustomization.extensions,
      },
    },
    {
      kind: "writeJson",
      to: ".vscode/settings.json",
      value: editorCustomization.settings,
    },
    {
      kind: "copyFile",
      from: ".github/workflows/check.yml",
      to: ".github/workflows/check.yml",
    },
    {
      kind: "writeTextTemplate",
      from: ".github/dependabot.yml",
      to: ".github/dependabot.yml",
      replacements: {
        CARGO_PACKAGE_DIRECTORY: `/${packagePath}`,
      },
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
    lint: "oxlint --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --config ../../oxlint.config.ts . --fix",
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
    "test:e2e":
      "pnpm run build && node --experimental-strip-types scripts/run-playwright.ts",
    typecheck:
      workspace.packages.length > 1
        ? "vue-tsc --build"
        : "vue-tsc --build --noEmit",
  };
}

function nodePackageTsconfigOperations(
  nodePackage: WorkspaceNodePackageDeclaration,
  workspace: WorkspaceNodePackagesCapabilityDeclaration,
): WriteJsonRenderOperation[] {
  if (nodePackage.kind === "hono-api") {
    return [
      {
        kind: "writeJson",
        to: `${nodePackage.path}/tsconfig.json`,
        value: {
          compilerOptions: strictTypeScriptCompilerOptions({
            composite: true,
            ...(workspace.packages.length > 1
              ? { declaration: true, declarationMap: true }
              : {}),
            module: "nodenext",
            moduleResolution: "nodenext",
            types: ["node", "vitest/globals"],
          }),
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
        compilerOptions: strictTypeScriptCompilerOptions({
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
          types: ["web-bluetooth"],
        }),
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
      multilineArrays: ["include"],
      value: {
        compilerOptions: strictTypeScriptCompilerOptions({
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          ...(workspace.packages.length > 1
            ? { outDir: "./node_modules/.tmp/tsconfig.node" }
            : {}),
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
          types: ["node"],
        }),
        include: [
          "playwright.config.ts",
          "scripts/**/*.ts",
          "vite.config.ts",
          "vitest.config.ts",
        ],
      },
    },
  ];
}

function honoApiTsconfigOperations(packagePath: string): RenderOperation[] {
  const operations = nodePackageTsconfigOperations(
    {
      kind: "hono-api",
      path: "apps/api",
      sourceFiles: [],
    },
    {
      kind: "workspace-node-packages",
      workspacePackageGlob: "apps/*",
      packages: [
        {
          kind: "hono-api",
          path: "apps/api",
          sourceFiles: [],
        },
      ],
    },
  );

  return operations.map((operation) => ({
    ...operation,
    to: operation.to.replace(/^apps\/api/, packagePath),
  }));
}

function vueAppTsconfigOperations(packagePath: string): RenderOperation[] {
  const operations = nodePackageTsconfigOperations(
    {
      kind: "vue-app",
      path: "apps/web",
      sourceFiles: [],
    },
    {
      kind: "workspace-node-packages",
      workspacePackageGlob: "apps/*",
      packages: [
        {
          kind: "vue-app",
          path: "apps/web",
          sourceFiles: [],
        },
      ],
    },
  );

  return operations.map((operation) => ({
    ...operation,
    to: operation.to.replace(/^apps\/web/, packagePath),
  }));
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

  const rootConfigTsconfigOperation = (): RenderOperation => {
    if (state.sourceRoots.sharedOxc === undefined) {
      throw new Error(
        "strict-typescript-root requires shared OXC source when rendering tsconfig.config.json",
      );
    }

    return {
      kind: "copyFile",
      from: "tsconfig.config.json",
      to: "tsconfig.config.json",
      sourceRoot: "sharedOxc",
    };
  };

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
      rootConfigTsconfigOperation(),
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
    rootConfigTsconfigOperation(),
    {
      kind: "writeJson",
      to: `${workspacePackagePath(context, libraryPackage)}/tsconfig.json`,
      value: libraryTsconfigJson(),
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
    editorCustomizationDeclarationsForState(state),
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
  const additionalLayers =
    state.nodeWorkspace && hasVuePackage(state.nodeWorkspace)
      ? [browserTestToolLayer()]
      : [];
  const dockerfileFragments = readDevelopmentContainerDockerfileFragments(
    state,
    additionalLayers.length === 0 ? [] : ["browserTest"],
  );
  const editorCustomization = editorCustomizationForCapabilities(
    state.editorCustomizationCapabilities,
    editorCustomizationDeclarationsForState(state),
  );
  const developmentContainer = checkedDockerfileFirstNodePnpmDevcontainer({
    name: context.projectName.value,
    layer: nodePnpmToolLayer({
      nodeVersion: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
    }),
    dockerfileFragments,
    additionalLayers,
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

type DevelopmentContainerDockerfileOptionalFragmentName =
  | "browserTest"
  | "rust";

function readDevelopmentContainerDockerfileFragments(
  state: ProjectionCompositionState,
  optionalFragments: readonly DevelopmentContainerDockerfileOptionalFragmentName[],
): DevelopmentContainerDockerfileFragments {
  if (state.devcontainerResource === undefined) {
    throw new Error(
      "Projection Capability composition did not provide a Development Container Shared Resource",
    );
  }

  const fragmentNames = {
    nodePnpm: "node-pnpm.Dockerfile",
    browserTest: "browser-test.Dockerfile",
    rust: "rust.Dockerfile",
  } as const;

  const selected = new Set(optionalFragments);

  return {
    sourceRoot: state.devcontainerResource.sourceRootKey,
    nodePnpm: readDevelopmentContainerDockerfileFragment(
      state.devcontainerResource,
      fragmentNames.nodePnpm,
    ),
    ...(selected.has("browserTest")
      ? {
          browserTest: readDevelopmentContainerDockerfileFragment(
            state.devcontainerResource,
            fragmentNames.browserTest,
          ),
        }
      : {}),
    ...(selected.has("rust")
      ? {
          rust: readDevelopmentContainerDockerfileFragment(
            state.devcontainerResource,
            fragmentNames.rust,
          ),
        }
      : {}),
  };
}

function readDevelopmentContainerDockerfileFragment(
  resource: NonNullable<ProjectionCompositionState["devcontainerResource"]>,
  fragmentName: string,
): { readonly from: string; readonly text: string } {
  const filePath = path.join(resource.root, fragmentName);

  try {
    return {
      from: fragmentName,
      text: readFileSync(filePath, "utf8"),
    };
  } catch (error: unknown) {
    if (isMissingDevelopmentContainerFragmentError(error)) {
      throw new Error(
        `Development Container Shared Resource ${resource.id} is missing Dockerfile fragment: ${fragmentName}`,
        { cause: error },
      );
    }

    throw error;
  }
}

function isMissingDevelopmentContainerFragmentError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
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
  state: ProjectionCompositionState,
  sourcePreset: "hono-api" | "ts-lib" | "vue-app" | "vue-hono-app",
): string {
  return templateSourceRootForPreset(state, sourcePreset);
}

function templateSourceRootForPreset(
  state: ProjectionCompositionState,
  sourcePreset: ProjectionSourcePreset,
): string {
  return state.projectionSourceRoots.preset(sourcePreset);
}
