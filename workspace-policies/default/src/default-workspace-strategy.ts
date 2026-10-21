import path from "node:path";

import type { ContentIdentity } from "@ykdz/template-core/content-identity";
import {
  contentIdentityKey,
  contentIdentityLabel,
  isContentIdentity,
} from "@ykdz/template-core/content-identity";
import type {
  PackageLinkIntent,
  PackageDefinition,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import type { ProjectProjectionReconciliation } from "@ykdz/template-core/project-projection";
import type {
  CopyFileOperation,
  RenderOperation,
} from "@ykdz/template-core/renderer";
import type {
  GeneratorContent,
  GeneratorPackageState,
  PackageCreationInput,
  GeneratorSelectionRoot,
  WorkspaceProjection,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";

import { projectDependencyMaintenancePolicy } from "./application-requirements.ts";
import { composeCiDiagnosticArtifacts } from "./ci-diagnostic-artifact.ts";
import type { CiDiagnosticArtifactDeclaration } from "./ci-diagnostic-artifact.ts";
import {
  prepareCliPublicationResources,
  projectCliPublication,
} from "./cli-publication-projection.ts";
import {
  assertDefaultPackageDefinition,
  assertDefaultProjectBlueprint,
  validateDefaultPackagePath,
} from "./default-package-identity.ts";
import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "./dependency-catalog.ts";
import { browserTestDevelopmentContainerToolLayer } from "./development-container.ts";
import {
  prepareBuiltInDevelopmentContainerResources,
  prepareBuiltInEditorCustomizationDeclarations,
  projectBuiltInDevelopmentContainer,
  projectBuiltInEditorCustomization,
  shellCheckDevelopmentContainerToolLayer,
} from "./development-environment.ts";
import {
  normalizeEnvironmentNeeds,
  type CheckEnvironmentNeed,
} from "./environment-needs.ts";
import type { GenerationContext } from "./generation-context.ts";
import {
  assertReusablePackageExposure,
  readPackageAdditionVersionFacts,
  WorkspacePackageAdditionFailure,
} from "./package-addition-facts.ts";
import type { PackageContribution } from "./package-contribution.ts";
import {
  prepareProjectGithubTemplates,
  projectCheckWorkflow,
  projectDependabotConfig,
  projectNextStepsDocument,
  type PreparedProjectGithubTemplates,
} from "./project-github.ts";
import {
  planExplicitProjectLinks,
  promoteInjectedProviderRuntimeDependencies,
  canConsumeNodePackageNameImportForRole,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImportForRole,
  readProjectLinkManifestTruth,
} from "./project-linking.ts";
import type {
  DependencyMaintenancePolicy,
  ProjectRequirement,
} from "./project-requirements.ts";
import type { ReferencePackage } from "./reference-package.ts";
import {
  assertExclusiveRootResources,
  composeSharedRootFiles,
  composeCheckWorkflow,
  type SharedRootContribution,
} from "./shared-root-files.ts";

/** 预设负责校验项目事实；共享根声明由外层策略统一协调。 */
export type DefaultWorkspaceProjectContribution =
  | ProjectRequirement
  | SharedRootContribution;

import { releaseToolchainSnapshot } from "./release-toolchain-snapshot.ts";
import {
  createWorkspaceRootManifest,
  packageConditionKeyOrder,
  packageManifestKeyOrder,
  projectPreparedWorkspaceRoot,
} from "./root-projection.ts";
import {
  initialRustVersion,
  prepareRustTargetAddition,
  projectRustTarget,
} from "./rust-target-projection.ts";
import { vuePnpmDependencyOverrides } from "./vue-policy.ts";
import {
  copyPreparedWorkspaceResource,
  prepareWorkspaceResources,
  prepareWorkspaceRootTemplates,
  type PreparedWorkspaceResources,
  type PreparedWorkspaceRootTemplates,
} from "./workspace-resources.ts";

export type DefaultWorkspaceInput = {
  readonly repositoryName?: string;
  readonly defaultPackageScope?: string;
  /** 是否在同次初始化投影中生成后续步骤文档；默认 SDK 保持关闭。 */
  readonly todo?: boolean;
};

type DefaultReferenceContent<CreationInput extends PackageCreationInput> =
  GeneratorContent<
    DefaultWorkspaceContext,
    PackageContribution,
    CreationInput
  > & {
    readonly definition: ReferencePackage<CreationInput>;
  };

/** 默认策略拥有的有限加包输入；生成器只透传其中的创建语义。 */
export type DefaultWorkspaceCreationInput<
  CreationInput extends PackageCreationInput = PackageCreationInput,
> = CreationInput & {
  /** 现有工作区消费者应依赖本次新增的 provider。 */
  readonly linkFrom?: readonly string[];
};

export type DefaultWorkspaceState = {
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly todo: boolean;
  readonly toolchain: {
    readonly nodeLtsMajor: string;
    readonly nodeVersion?: string;
    readonly packageManagerPin: string;
    readonly rustVersion?: string;
  };
};

type DefaultWorkspaceContext = GenerationContext & {
  readonly existingRustDeclaration?: string;
};

export type DefaultWorkspaceOwnerFacts = {
  readonly environmentNeeds: ReturnType<typeof normalizeEnvironmentNeeds>;
  readonly diagnosticArtifacts: readonly CiDiagnosticArtifactDeclaration[];
  readonly checkWorkflowJob: {
    readonly name: string;
    readonly timeoutMinutes: number;
  };
  readonly container: {
    readonly dockerfileText: string;
    readonly buildArguments: ReturnType<
      typeof projectBuiltInDevelopmentContainer
    >["buildArguments"];
    readonly mounts: ReturnType<
      typeof projectBuiltInDevelopmentContainer
    >["mounts"];
    readonly probes: ReturnType<
      typeof projectBuiltInDevelopmentContainer
    >["probes"];
  };
  readonly dependencyMaintenance: DependencyMaintenancePolicy;
  readonly publication: {
    readonly candidate: { readonly name: string; readonly path: string } | null;
    readonly setup: { readonly command: string } | null;
  };
  readonly nextSteps: readonly NextStepInstruction[];
};

export type DefaultWorkspaceMissingLinkConflict = {
  readonly code: "MISSING_LINK";
  readonly facts: {
    readonly existing: Pick<PackageDefinition, "name" | "path" | "role">;
    readonly requested: Pick<PackageDefinition, "name" | "path" | "role">;
    readonly missingLink: PackageLinkIntent;
  };
};

export type NextStepInstruction = { readonly display: string };

/** 默认策略把单个包节点放入指定目录，并按参考包名派生其默认叶名。 */
export type DefaultWorkspaceNodeLayout = {
  readonly packageDirectory: string;
};

const nextSteps: readonly NextStepInstruction[] = [
  { display: "pnpm install" },
  { display: "pnpm run fix" },
  { display: "pnpm run check" },
];

const defaultWorkspaceResourceOwner =
  "默认工作区能力 @ykdz/template-workspace#./default-strategy";
const defaultWorkspaceFiles = [
  "assets/gitignore",
  "assets/agent-instructions.md",
  "scripts/task-gates.ts",
] as const;

type DefaultWorkspacePreparedResources = {
  readonly rootTemplates: PreparedWorkspaceRootTemplates;
  readonly githubTemplates: PreparedProjectGithubTemplates;
  readonly editorCustomizationDeclarations: ReturnType<
    typeof prepareBuiltInEditorCustomizationDeclarations
  >;
  readonly developmentContainer: ReturnType<
    typeof prepareBuiltInDevelopmentContainerResources
  >;
  readonly cliPublication: PreparedWorkspaceResources;
  readonly workspaceFiles: PreparedWorkspaceResources;
  readonly projectLinkManifestTruth: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
};

const preparedResourcesByContext = new WeakMap<
  DefaultWorkspaceContext,
  DefaultWorkspacePreparedResources
>();

function prepareDefaultWorkspaceResources(
  context: DefaultWorkspaceContext,
  packagePaths: readonly string[],
): void {
  preparedResourcesByContext.set(context, {
    rootTemplates: prepareWorkspaceRootTemplates(),
    githubTemplates: prepareProjectGithubTemplates(),
    editorCustomizationDeclarations:
      prepareBuiltInEditorCustomizationDeclarations(),
    developmentContainer: prepareBuiltInDevelopmentContainerResources(),
    cliPublication: prepareCliPublicationResources(),
    workspaceFiles: prepareWorkspaceResources(
      defaultWorkspaceFiles,
      defaultWorkspaceResourceOwner,
      defaultWorkspaceFiles,
    ),
    projectLinkManifestTruth: readProjectLinkManifestTruth({
      repositoryRoot: context.targetDir,
      packagePaths,
    }),
  });
}

function preparedResourcesForContext(
  context: DefaultWorkspaceContext,
): DefaultWorkspacePreparedResources {
  const prepared = preparedResourcesByContext.get(context);
  if (prepared === undefined) {
    throw new Error("默认工作区策略缺少 initialize/prepareAddition 资源事实");
  }
  return prepared;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 识别默认工作区 owner 返回的既有包补链冲突。 */
export function isDefaultWorkspaceMissingLinkConflict(
  value: unknown,
): value is DefaultWorkspaceMissingLinkConflict {
  if (
    !isRecord(value) ||
    value.code !== "MISSING_LINK" ||
    !isRecord(value.facts)
  ) {
    return false;
  }
  const { existing, requested, missingLink } = value.facts;
  const isPackageIdentity = (candidate: unknown): boolean =>
    isRecord(candidate) &&
    typeof candidate.name === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.role === "string";
  return (
    isPackageIdentity(existing) &&
    isPackageIdentity(requested) &&
    isRecord(missingLink) &&
    typeof missingLink.consumerPackagePath === "string" &&
    typeof missingLink.providerPackagePath === "string"
  );
}

function requestedLinkFrom(value: unknown): readonly string[] {
  if (!isRecord(value) || value.linkFrom === undefined) return [];
  if (
    !Array.isArray(value.linkFrom) ||
    !value.linkFrom.every(
      (packagePath): packagePath is string => typeof packagePath === "string",
    )
  ) {
    throw new Error("默认工作区的 linkFrom 必须是非空包路径数组");
  }
  return [...new Set(value.linkFrom)];
}

function includeRequestedLinkFromIntents(
  blueprint: ProjectBlueprint,
  packages: readonly GeneratorPackageState[],
): ProjectBlueprint {
  const requested = packages.flatMap((packageRecord) =>
    packageRecord.createdBy === "addition"
      ? requestedLinkFrom(packageRecord.creationInput).map(
          (consumerPackagePath) => ({
            consumerPackagePath,
            providerPackagePath: packageRecord.definition.path,
          }),
        )
      : [],
  );
  if (requested.length === 0) return blueprint;
  const identities = new Set<string>();
  const packageLinkIntents = [
    ...(blueprint.packageLinkIntents ?? []),
    ...requested,
  ].filter((intent) => {
    const identity = `${intent.consumerPackagePath}\u0000${intent.providerPackagePath}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  return assertDefaultProjectBlueprint({ ...blueprint, packageLinkIntents });
}

const supportedProjectRequirementKinds = new Set(["package-link"]);

function assertSupportedProjectRequirementKinds(
  requirements: readonly unknown[],
): void {
  for (const requirement of requirements) {
    const kind = isRecord(requirement) ? requirement.kind : undefined;
    if (
      typeof kind !== "string" ||
      !supportedProjectRequirementKinds.has(kind)
    ) {
      throw new Error(
        `默认工作区策略不支持项目要求：${typeof kind === "string" ? kind : "未命名"}`,
      );
    }
  }
}

function workspaceResource(
  resources: PreparedWorkspaceResources,
  from: string,
  to: string,
): CopyFileOperation {
  return copyPreparedWorkspaceResource(
    resources,
    `assets/${from}`,
    to,
    defaultWorkspaceResourceOwner,
  );
}

function workspaceFile(
  resources: PreparedWorkspaceResources,
  from: string,
  to: string,
): RenderOperation {
  return copyPreparedWorkspaceResource(
    resources,
    from,
    to,
    defaultWorkspaceResourceOwner,
  );
}

function defaultContext(
  targetRoot: string,
  state: DefaultWorkspaceState,
  options: { readonly existingRustDeclaration?: string } = {},
): DefaultWorkspaceContext {
  return {
    targetDir: path.resolve(targetRoot),
    repositoryName: state.repositoryName,
    defaultPackageScope: state.defaultPackageScope,
    ...(options.existingRustDeclaration === undefined
      ? {}
      : { existingRustDeclaration: options.existingRustDeclaration }),
    toolchain: {
      nodeLtsMajor: state.toolchain.nodeLtsMajor,
      ...(state.toolchain.nodeVersion === undefined
        ? {}
        : { nodeVersion: state.toolchain.nodeVersion }),
      packageManagerPin: state.toolchain.packageManagerPin,
      ...(state.toolchain.rustVersion === undefined
        ? {}
        : { rustVersion: state.toolchain.rustVersion }),
    },
  };
}

function nativeDependencyNames(
  content: DefaultReferenceContent<PackageCreationInput>,
): readonly string[] {
  const reference = content.definition;
  const targetDependencies = new Set(
    reference.dependencyUses
      .filter((dependency) => dependency.purposes.includes("target"))
      .map((dependency) => dependency.name),
  );
  return [
    ...new Set(
      [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ].flatMap((field) => {
        const dependencies = reference.manifest[field];
        if (!isRecord(dependencies)) return [];
        return Object.entries(dependencies)
          .filter(
            ([name, specifier]) =>
              targetDependencies.has(name) &&
              typeof specifier === "string" &&
              (specifier.startsWith("workspace:") ||
                specifier.startsWith("link:")),
          )
          .map(([name]) => name);
      }),
    ),
  ];
}

function nativeDependencyIdentities(
  content: DefaultReferenceContent<PackageCreationInput>,
  contentByIdentity: ReadonlyMap<
    string,
    DefaultReferenceContent<PackageCreationInput>
  >,
): readonly ContentIdentity[] {
  const reference = content.definition;
  return nativeDependencyNames(content).map((nativeName) => {
    let resolved: string;
    try {
      resolved = new URL(reference.resolve(`${nativeName}/template`)).href;
    } catch (error) {
      throw new Error(
        `内容${contentIdentityLabel(content.identity)}无法解析必要模板依赖${nativeName}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const matchingSources = [...contentByIdentity.values()].filter(
      (candidate) => candidate.source.moduleURL === resolved,
    );
    const sameNamespace = matchingSources.filter(
      (candidate) =>
        candidate.identity.namespace === content.identity.namespace,
    );
    const providers =
      sameNamespace.length > 0 ? sameNamespace : matchingSources;
    if (providers.length === 0) {
      throw new Error(
        `内容${contentIdentityLabel(content.identity)}的必要模板依赖未登记：${nativeName}`,
      );
    }
    if (providers.length > 1) {
      throw new Error(
        `内容${contentIdentityLabel(content.identity)}的必要模板依赖来源歧义：${nativeName}`,
      );
    }
    return providers[0]!.identity;
  });
}

/** 从实际选择与策略依赖解释中读取配置拥有者提供的默认身份。 */
export function selectedWorkspaceConfigurationIdentity(options: {
  readonly selection: readonly GeneratorSelectionRoot[];
  readonly contentByIdentity: ReadonlyMap<
    string,
    DefaultReferenceContent<PackageCreationInput>
  >;
  readonly scope: string;
}):
  | ReturnType<
      DefaultReferenceContent<PackageCreationInput>["definition"]["defaultIdentity"]
    >
  | undefined {
  const visited = new Set<string>();
  const configurations = new Map<
    string,
    DefaultReferenceContent<PackageCreationInput>["definition"]
  >();
  const visit = (
    content: DefaultReferenceContent<PackageCreationInput> | undefined,
  ): void => {
    if (content === undefined) return;
    const key = contentIdentityKey(content.identity);
    if (visited.has(key)) return;
    visited.add(key);
    if (content.definition.workspaceConfiguration !== undefined) {
      configurations.set(key, content.definition);
    }
    for (const identity of nativeDependencyIdentities(
      content,
      options.contentByIdentity,
    )) {
      visit(options.contentByIdentity.get(contentIdentityKey(identity)));
    }
  };
  for (const root of options.selection) {
    if (isContentIdentity(root.contentIdentity)) {
      visit(
        options.contentByIdentity.get(contentIdentityKey(root.contentIdentity)),
      );
    }
  }
  if (configurations.size !== 1) return undefined;
  return [...configurations.values()][0]!.defaultIdentity(options.scope);
}

function nativeBindings(
  contentByIdentity: ReadonlyMap<
    string,
    DefaultReferenceContent<PackageCreationInput>
  >,
  providers: ReadonlyMap<string, PackageDefinition>,
): ReadonlyMap<string, PackageDefinition> {
  return new Map(
    [...providers].map(([identity, definition]) => {
      const provider = contentByIdentity.get(identity);
      if (provider === undefined) {
        throw new Error("工作区策略无法解释内容绑定：" + identity);
      }
      return [provider.definition.manifest.name, definition];
    }),
  );
}

function siblingPackagePath(defaultPath: string, leafName: string): string {
  const parentPath = path.posix.dirname(defaultPath);
  return path.posix.join(
    parentPath === "." ? "packages" : parentPath,
    leafName,
  );
}

function boundaryTags(
  contributions: readonly PackageContribution[],
): readonly ("app" | "library")[] {
  const selected = new Set<"app" | "library">();
  for (const contribution of contributions) {
    if (
      contribution.definition.role === "cli-tool" ||
      contribution.definition.role === "runtime-service"
    )
      selected.add("app");
    else if (contribution.definition.role === "shared-library") {
      selected.add("library");
    }
  }
  return [...selected];
}

function samePackageDefinition(
  left: PackageDefinition,
  right: PackageDefinition,
): boolean {
  const leftId =
    "packageDefinitionId" in left ? left.packageDefinitionId : undefined;
  const rightId =
    "packageDefinitionId" in right ? right.packageDefinitionId : undefined;
  return (
    left.name === right.name &&
    left.path === right.path &&
    left.role === right.role &&
    leftId === rightId
  );
}

function requireProjectPackage(
  blueprint: ProjectBlueprint,
  definition: PackageDefinition,
  capability: string,
): PackageDefinition {
  const actual = blueprint.packages.find((candidate) =>
    samePackageDefinition(candidate, definition),
  );
  if (actual === undefined) {
    throw new Error(
      `${capability} 引用了当前蓝图之外的包实例：${definition.path}`,
    );
  }
  return actual;
}

function projectRequirements(
  blueprint: ProjectBlueprint,
  contributions: readonly PackageContribution[],
  presetProjectContributions: readonly (readonly DefaultWorkspaceProjectContribution[])[],
): ProjectBlueprint {
  const declarations = contributions.flatMap(
    (contribution) => contribution.projectRequirements ?? [],
  );
  declarations.push(
    ...presetProjectContributions
      .flat()
      .filter(
        (declaration): declaration is ProjectRequirement =>
          declaration.kind !== "shared-root-files",
      ),
  );
  assertSupportedProjectRequirementKinds(declarations);
  const links: PackageLinkIntent[] = [];
  for (const requirement of declarations) {
    if (requirement.kind !== "package-link") continue;
    const consumer = requireProjectPackage(
      blueprint,
      requirement.consumer,
      requirement.kind,
    );
    const provider = requireProjectPackage(
      blueprint,
      requirement.provider,
      requirement.kind,
    );
    links.push({
      consumerPackagePath: consumer.path,
      providerPackagePath: provider.path,
    });
  }
  const seenLinks = new Set<string>();
  const packageLinkIntents = [
    ...(blueprint.packageLinkIntents ?? []),
    ...links,
  ].filter((link) => {
    const identity = `${link.consumerPackagePath}\u0000${link.providerPackagePath}`;
    if (seenLinks.has(identity)) return false;
    seenLinks.add(identity);
    return true;
  });
  return assertDefaultProjectBlueprint(
    packageLinkIntents.length === 0 &&
      blueprint.packageLinkIntents === undefined
      ? {
          schemaVersion: blueprint.schemaVersion,
          packages: blueprint.packages,
        }
      : { ...blueprint, packageLinkIntents },
  );
}

function projectOperations(options: {
  readonly context: DefaultWorkspaceContext;
  readonly state: DefaultWorkspaceState;
  readonly blueprint: ProjectBlueprint;
  readonly packages: readonly GeneratorPackageState[];
  readonly contributions: readonly PackageContribution[];
  /** 默认 CLI 内容集合显式装配的共享发布参考包。 */
  readonly cliPublicationReference: ReferencePackage | undefined;
  readonly presetProjectContributions: readonly (readonly DefaultWorkspaceProjectContribution[])[];
  readonly sharedRootContributions: readonly SharedRootContribution[];
}): WorkspaceProjection<DefaultWorkspaceOwnerFacts> {
  const { context } = options;
  const prepared = preparedResourcesForContext(context);
  const blueprint = projectRequirements(
    includeRequestedLinkFromIntents(
      assertDefaultProjectBlueprint(options.blueprint),
      options.packages,
    ),
    options.contributions,
    options.presetProjectContributions,
  );
  const linkPlan = planExplicitProjectLinks({
    blueprint,
    contributions: options.contributions,
    manifestTruthByPackagePath: prepared.projectLinkManifestTruth,
  });
  const contributions = promoteInjectedProviderRuntimeDependencies({
    contributions: options.contributions,
    linkPlan,
  });
  const cliPublication = projectCliPublication({
    contributions,
    resources: prepared.cliPublication,
    referencePackage: options.cliPublicationReference,
  });
  const rustProjection = projectRustTarget({
    context,
    packages: options.packages,
    contributions,
  });
  const rust = rustProjection.toolchain;
  const configurations = contributions.filter(
    (contribution) =>
      contribution.foundation.workspaceConfiguration?.kind ===
      "typescript-workspace-configuration",
  );
  if (configurations.length > 1) {
    throw new Error(
      `默认策略只能有一个共享 TypeScript 配置贡献，实际为 ${configurations.length}`,
    );
  }
  const configuration = configurations[0];
  const ownerSharedRootContributions = [
    ...options.presetProjectContributions
      .flat()
      .filter(
        (declaration): declaration is SharedRootContribution =>
          declaration.kind === "shared-root-files",
      ),
    ...options.sharedRootContributions,
  ];
  const rootAutomationPaths = [
    "*.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "*.config.ts",
    ".gitignore",
    ".dockerignore",
    "Dockerfile",
    "TODO.md",
    "rust-toolchain.toml",
    ".vscode",
    ".github",
    ".devcontainer",
    "scripts",
    "test",
  ].join(" ");
  const baseManifest = createWorkspaceRootManifest({
    name: context.repositoryName,
    ...(configuration === undefined
      ? {}
      : { toolingConfigPackageName: configuration.definition.name }),
    nodeDeclaration:
      context.toolchain.nodeVersion ?? context.toolchain.nodeLtsMajor,
    packageManagerPin: context.toolchain.packageManagerPin,
  });
  // 基础检查命令由默认政策按实际根检查范围构造，再参与来源合成。
  const baseScripts = baseManifest.scripts as Record<string, string>;
  const checkEnvironmentNeedsFromOwners = ownerSharedRootContributions.flatMap(
    (declaration) => declaration.environmentNeeds?.check ?? [],
  );
  const rootShellCheckRequested = checkEnvironmentNeedsFromOwners.some(
    (need) => need.kind === "shellcheck-command",
  );
  const needsShellCheck =
    rootShellCheckRequested ||
    contributions.some((contribution) =>
      contribution.environmentNeeds.some(
        (need) => need.kind === "shellcheck-command",
      ),
    );
  const shellResourcePaths = ownerSharedRootContributions.flatMap(
    (declaration) =>
      (declaration.resources ?? []).flatMap(({ operation }) =>
        "to" in operation && operation.to.endsWith(".sh") ? [operation.to] : [],
      ),
  );
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const rootShellcheckCommand =
    rootShellCheckRequested && shellResourcePaths.length > 0
      ? `shellcheck ${shellResourcePaths.map(shellQuote).join(" ")} && `
      : "";
  baseScripts["format:check"] =
    `oxfmt --list-different --no-error-on-unmatched-pattern ${rootAutomationPaths}`;
  baseScripts["format:write"] =
    `oxfmt --write --no-error-on-unmatched-pattern ${rootAutomationPaths}`;
  baseScripts.lint =
    "oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts scripts test";
  baseScripts["lint:fix"] =
    "oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts scripts test --fix";
  if (needsShellCheck) {
    baseScripts.lint = `${rootShellcheckCommand}oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts scripts test`;
    baseScripts["lint:fix"] =
      "oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts scripts test --fix";
  }
  const shared = composeSharedRootFiles({
    source: "@ykdz/template-workspace/default-workspace-strategy",
    manifest: baseManifest,
    turboTasks: prepared.rootTemplates.turbo.tasks as Readonly<
      Record<string, unknown>
    >,
    typescript: {
      compilerOptions: {
        ...(prepared.rootTemplates.tsconfig.compilerOptions as Readonly<
          Record<string, unknown>
        >),
        rewriteRelativeImportExtensions: false,
        allowImportingTsExtensions: true,
      },
      include: ["*.config.ts", "scripts/**/*.ts"],
    },
    packagePaths: blueprint.packages.map((definition) => definition.path),

    declarations: [
      {
        kind: "shared-root-files",
        source: "@ykdz/template-workspace/rust-target-projection",
        manifest: {
          scripts:
            rust === undefined
              ? {}
              : { "toolchain:prepare": "cargo --version" },
        },
      },
      {
        kind: "shared-root-files",
        source: "@ykdz/template-workspace/cli-publication-projection",
        manifest: {
          ...(cliPublication.imports === undefined
            ? {}
            : { imports: cliPublication.imports }),
          scripts: cliPublication.scripts,
          devDependencies: cliPublication.devDependencies,
        },
        typescript: {
          compilerOptions: cliPublication.tsconfigCompilerOptions,
          include: cliPublication.tsconfigInclude,
        },
        gitignoreFragments: cliPublication.gitignoreFragments,
        resources: cliPublication.operations
          .filter((operation) => operation.kind !== "setExecutable")
          .map((operation) => ({
            operation,
            ...(cliPublication.operations.some(
              (candidate) =>
                candidate.kind === "setExecutable" &&
                candidate.path === operation.to,
            )
              ? { executable: true }
              : {}),
          })),
      },
      ...ownerSharedRootContributions,
    ],
  });
  const rootManifest = shared.manifest;
  const dependencyCatalog = selectTemplateDependencyCatalogEntries(
    collectGeneratedManifestCatalogReferences([
      ...contributions.map((contribution) => contribution.manifest),
      rootManifest,
    ]),
  );
  const dependencyOverrides =
    Object.hasOwn(dependencyCatalog, "vue") ||
    Object.hasOwn(dependencyCatalog, "pinia")
      ? vuePnpmDependencyOverrides
      : {};
  const packages = ["apps/*", "packages/*"];
  for (const definition of blueprint.packages) {
    const glob = definition.path.split("/")[0] + "/*";
    if (!packages.includes(glob)) packages.push(glob);
  }
  const packagePaths = blueprint.packages.map((definition) => definition.path);
  const artifacts = composeCiDiagnosticArtifacts({
    packagePaths,
    declarations: [
      ...contributions.flatMap(
        (contribution) => contribution.ciDiagnosticArtifacts ?? [],
      ),
      ...ownerSharedRootContributions.flatMap(
        (declaration) => declaration.ciDiagnosticArtifacts ?? [],
      ),
    ],
  });
  const editor = projectBuiltInEditorCustomization(
    contributions.flatMap(
      (contribution) => contribution.foundation.editorCapabilities,
    ),
    prepared.editorCustomizationDeclarations,
  );
  const checkEnvironmentNeeds = [
    ...contributions.flatMap((contribution) => contribution.environmentNeeds),
    ...shared.environmentNeeds.check,
  ];
  const containerLayers = [
    ...(checkEnvironmentNeeds.some(
      (need) => need.kind === "playwright-browser-assets",
    )
      ? [browserTestDevelopmentContainerToolLayer()]
      : []),
    ...(needsShellCheck ? [shellCheckDevelopmentContainerToolLayer()] : []),
    ...contributions.flatMap(
      (contribution) =>
        contribution.foundation.developmentContainerToolLayers ?? [],
    ),
  ];
  const container = projectBuiltInDevelopmentContainer({
    nodeVersion:
      context.toolchain.nodeVersion ?? context.toolchain.nodeLtsMajor,
    layers: containerLayers,
    resources: prepared.developmentContainer,
  });
  const containerBase = container.configuration;
  const referenceNames = new Map(
    contributions.flatMap((contribution) =>
      contribution.referenceSource === undefined
        ? []
        : [
            [
              contribution.referenceSource,
              contribution.definition.name,
            ] as const,
          ],
    ),
  );
  const rootProjection = projectPreparedWorkspaceRoot({
    rootManifest,
    packageGlobs: packages,
    dependencyCatalog,
    dependencyOverrides,
    turboTemplate: {
      ...prepared.rootTemplates.turbo,
      tasks: shared.turboTasks,
    },
    referenceNames,
    ...(configuration === undefined
      ? {}
      : { toolingConfigPackagePath: configuration.definition.path }),
    turboBoundaryTags: boundaryTags(contributions),
    rootTsconfigTemplate: prepared.rootTemplates.tsconfig,
    rootTsconfigCompilerOptions: shared.typescript.compilerOptions,
    rootTsconfigInclude: shared.typescript.include,
    tsconfigConfigTemplate: prepared.rootTemplates.tsconfigConfig,
  });
  const editorExtensions = {
    kind: "writeJson" as const,
    to: ".vscode/extensions.json",
    value: { recommendations: editor.extensions },
    ...(editor.extensions.length > 2
      ? { multilineArrays: ["recommendations"] }
      : {}),
  };
  const environmentNeeds = normalizeEnvironmentNeeds({
    check: checkEnvironmentNeeds as CheckEnvironmentNeed[],
    deployment: shared.environmentNeeds.deployment,
  });
  const dependencyMaintenance = projectDependencyMaintenancePolicy({
    contributions,
    rootContributions: shared.dependencyMaintenance.map(
      (dependencyMaintenance) => ({ dependencyMaintenance }),
    ),
  });
  const reconciliation: readonly ProjectProjectionReconciliation[] = [
    ...shared.reconciliation,
    { path: "tsconfig.json", driver: "structured" },
    { path: "turbo.json", driver: "structured" },
    { path: ".vscode/settings.json", driver: "structured" },
    {
      path: ".devcontainer/devcontainer.json",
      driver: "structured",
      identitySets: [
        {
          location: "/mounts",
          identity: {
            kind: "projection",
            members: container.mounts.map(({ identity, target }) => ({
              identity,
              match: { target },
            })),
            fallback: { fields: ["target"] },
          },
        },
      ],
      mirrorSlots: [
        {
          id: "node-version-build-arg",
          location: {
            kind: "json-pointer",
            pointer: "/build/args/NODE_VERSION",
          },
        },
        ...(rust === undefined
          ? []
          : [
              {
                id: "rust-toolchain-build-arg",
                location: {
                  kind: "json-pointer" as const,
                  pointer: "/build/args/RUST_TOOLCHAIN",
                },
              },
            ]),
      ],
    },
    {
      path: ".vscode/extensions.json",
      driver: "structured",
      identitySets: [
        {
          location: "/recommendations",
          identity: { kind: "self" },
        },
      ],
    },
    { path: ".template/blueprint.json", driver: "canonical" },
    { path: ".template/environment-needs.json", driver: "canonical" },
    { path: ".template/generation.json", driver: "canonical" },
  ];
  const gitignore = workspaceResource(
    prepared.workspaceFiles,
    "gitignore",
    ".gitignore",
  );
  const defaultOperations: RenderOperation[] = [
    rootProjection.manifest,
    rootProjection.workspace,
    shared.gitignoreFragments.length === 0
      ? gitignore
      : {
          kind: "writeTextFromFragments",
          to: ".gitignore",
          fragments: [gitignore, ...shared.gitignoreFragments],
        },
    workspaceResource(
      prepared.workspaceFiles,
      "agent-instructions.md",
      "AGENTS.md",
    ),
    rootProjection.turbo,
    workspaceFile(
      prepared.workspaceFiles,
      "scripts/task-gates.ts",
      "scripts/task-gates.ts",
    ),
    rootProjection.tsconfig,
    rootProjection.tsconfigConfig,
    ...(configuration === undefined
      ? []
      : [
          {
            kind: "writeText" as const,
            to: "oxlint.config.ts",
            text:
              "import lintConfiguration from " +
              JSON.stringify(configuration.definition.name + "/oxlint") +
              ";\n" +
              'import { defineConfig } from "oxlint";\n\n' +
              "export default defineConfig({\n" +
              "  extends: [lintConfiguration],\n" +
              '  categories: { correctness: "error", suspicious: "warn" },\n' +
              "});\n",
          },
          {
            kind: "writeText" as const,
            to: "oxfmt.config.ts",
            text:
              "import formatterConfiguration from " +
              JSON.stringify(configuration.definition.name + "/oxfmt") +
              ";\n" +
              'import { defineConfig } from "oxfmt";\n\n' +
              "export default defineConfig({\n" +
              "  ...formatterConfiguration,\n" +
              "  sortImports: true,\n" +
              "});\n",
          },
        ]),
    editorExtensions,
    { kind: "writeJson", to: ".vscode/settings.json", value: editor.settings },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: { ...containerBase, name: context.repositoryName },
    },
    {
      kind: "mergeJson",
      to: ".devcontainer/devcontainer.json",
      value: {
        build: {
          args: Object.fromEntries(
            container.buildArguments.map((argument) => [
              argument.name,
              argument.value,
            ]),
          ),
        },
        ...(container.mounts.length === 0
          ? {}
          : {
              mounts: container.mounts.map(
                ({ identity: _identity, ...mount }) => mount,
              ),
            }),
      },
    },
    container.dockerfileOperation,
    ...(rustProjection.operation === undefined
      ? []
      : [rustProjection.operation]),
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: composeCheckWorkflow(
        projectCheckWorkflow(
          {
            packagePaths,
            ...(Object.keys(shared.ciJob).length === 0
              ? {}
              : { job: shared.ciJob }),
            diagnosticArtifacts: artifacts,
          },
          prepared.githubTemplates.checkWorkflow,
        ),
        "@ykdz/template-workspace/project-github",
        shared.ciSteps,
      ),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectDependabotConfig(
        dependencyMaintenance,
        prepared.githubTemplates.dependabot,
      ),
    },
    ...(options.state.todo
      ? [
          {
            kind: "writeText" as const,
            to: "TODO.md",
            text: projectNextStepsDocument(
              nextSteps,
              prepared.githubTemplates.nextSteps,
            ),
          },
        ]
      : []),
    {
      kind: "writeJson",
      to: ".template/environment-needs.json",
      value: environmentNeeds,
    },
  ];
  assertExclusiveRootResources(
    defaultOperations,
    "@ykdz/template-workspace/default-workspace-strategy",
    shared.resourceOwners,
  );
  const packageOperations = contributions.flatMap((contribution) =>
    contribution.operations.map((operation) =>
      operation.kind === "writeJson" &&
      operation.to === contribution.definition.path + "/package.json"
        ? {
            ...operation,
            value: (() => {
              const patch = linkPlan.manifestPatchesByPackagePath.get(
                contribution.definition.path,
              );
              if (patch === undefined) return contribution.manifest;
              return {
                ...contribution.manifest,
                dependencies: {
                  ...(isRecord(contribution.manifest.dependencies)
                    ? contribution.manifest.dependencies
                    : {}),
                  ...patch.dependencies,
                },
                ...(patch.dependenciesMeta === undefined
                  ? {}
                  : {
                      dependenciesMeta: {
                        ...(isRecord(contribution.manifest.dependenciesMeta)
                          ? contribution.manifest.dependenciesMeta
                          : {}),
                        ...patch.dependenciesMeta,
                      },
                    }),
              };
            })(),
            multilineArrays: ["files"],
            keyOrder: packageManifestKeyOrder,
            nestedKeyOrder: packageConditionKeyOrder,
          }
        : operation,
    ),
  );
  return {
    blueprint,
    operations: [
      ...packageOperations,
      ...defaultOperations,
      ...shared.operations,
      { kind: "writeJson", to: ".template/blueprint.json", value: blueprint },
    ],
    reconciliation,
    ownerFacts: {
      environmentNeeds,
      diagnosticArtifacts: artifacts,
      checkWorkflowJob: {
        name: shared.ciJob.name ?? "Root Check",
        timeoutMinutes: shared.ciJob.timeoutMinutes ?? 30,
      },
      container: {
        dockerfileText: container.dockerfileOperation.text,
        buildArguments: container.buildArguments,
        mounts: container.mounts,
        probes: container.probes,
      },
      dependencyMaintenance,
      publication: {
        candidate:
          cliPublication.candidate === undefined
            ? null
            : {
                name: cliPublication.candidate.definition.name,
                path: cliPublication.candidate.definition.path,
              },
        setup:
          cliPublication.candidate === undefined
            ? null
            : { command: "./scripts/npm-publication-setup/setup.sh" },
      },
      nextSteps,
    },
  };
}

/** 创建拥有 Node、pnpm、catalog、Turbo 与根任务政策的默认工作区策略。 */
export function createDefaultWorkspaceStrategy<
  CreationInput extends PackageCreationInput = DefaultWorkspaceCreationInput,
>(
  options: {
    /** 默认内容集合显式装配的共享发布参考包。 */
    readonly cliPublicationReference?: ReferencePackage;
    readonly project?: (options: {
      readonly context: DefaultWorkspaceContext;
      readonly blueprint: ProjectBlueprint;
      readonly contributions: readonly PackageContribution[];
      readonly packages: readonly GeneratorPackageState[];
    }) => readonly SharedRootContribution[];
  } = {},
): WorkspaceStrategy<
  DefaultWorkspaceContext,
  DefaultWorkspaceInput,
  DefaultWorkspaceState,
  PackageContribution,
  CreationInput,
  DefaultReferenceContent<CreationInput>,
  DefaultWorkspaceNodeLayout,
  readonly DefaultWorkspaceProjectContribution[],
  DefaultWorkspaceOwnerFacts
> {
  return {
    identity: "default",
    diagnoseFailure(error) {
      if (error instanceof WorkspacePackageAdditionFailure) {
        return { message: error.message, suggestion: error.suggestion };
      }
      return undefined;
    },
    initialize({ targetRoot, input, selection, contentByIdentity }) {
      const repositoryName =
        input.repositoryName ?? path.basename(path.resolve(targetRoot));
      const defaultPackageScope = input.defaultPackageScope ?? repositoryName;
      const nodeVersion = releaseToolchainSnapshot.nodeVersion;
      const rustVersion = initialRustVersion(selection, contentByIdentity);
      const state: DefaultWorkspaceState = {
        repositoryName,
        defaultPackageScope,
        todo: input.todo ?? false,
        toolchain: {
          nodeLtsMajor: nodeVersion.slice(0, nodeVersion.indexOf(".")),
          nodeVersion,
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
          ...(rustVersion === undefined ? {} : { rustVersion }),
        },
      };
      const context = defaultContext(targetRoot, state);
      prepareDefaultWorkspaceResources(context, []);
      return { state, context };
    },
    prepareAddition({
      targetRoot,
      state,
      content,
      contentByIdentity,
      packages,
      nodeInstances,
    }) {
      const current = readPackageAdditionVersionFacts(targetRoot);
      const rustFacts = prepareRustTargetAddition({
        targetRoot,
        packages,
        contentIdentity: content.identity,
        contentByIdentity,
      });
      const context = defaultContext(
        targetRoot,
        {
          ...state,
          toolchain: {
            ...current.toolchain,
            ...(rustFacts.rustVersion === undefined
              ? {}
              : { rustVersion: rustFacts.rustVersion }),
          },
        },
        rustFacts.existingDeclaration === undefined
          ? {}
          : { existingRustDeclaration: rustFacts.existingDeclaration },
      );
      prepareDefaultWorkspaceResources(
        context,
        packages.map((packageRecord) => packageRecord.definition.path),
      );
      const definitionsById = new Map<string, PackageDefinition>(
        packages.map((packageRecord) => [
          packageRecord.definition.packageDefinitionId,
          packageRecord.definition,
        ]),
      );
      const existingContributions = packages.map((packageRecord) => {
        const existingContent = contentByIdentity.get(
          contentIdentityKey(packageRecord.contentIdentity),
        );
        if (existingContent === undefined) {
          throw new Error(
            "生成记录引用了显式内容之外的身份：" +
              contentIdentityLabel(packageRecord.contentIdentity),
          );
        }
        const providerDefinitions = new Map<string, PackageDefinition>();
        for (const [providerIdentity, packageDefinitionId] of Object.entries(
          packageRecord.bindings,
        )) {
          const definition = definitionsById.get(packageDefinitionId);
          if (definition === undefined) {
            throw new Error(
              "生成记录包绑定引用了不存在的包实例：" + packageDefinitionId,
            );
          }
          providerDefinitions.set(providerIdentity, definition);
        }
        const contributionOptions = {
          context,
          definition: packageRecord.definition,
          bindings: nativeBindings(contentByIdentity, providerDefinitions),
          createdBy: packageRecord.createdBy,
          nodeInstances,
          ...(packageRecord.creationInput === null
            ? {}
            : { creationInput: packageRecord.creationInput }),
        };
        return existingContent.definition.contribute(contributionOptions);
      });
      const existingContributionByPackageId = new Map(
        packages.map((packageRecord, index) => [
          packageRecord.definition.packageDefinitionId,
          existingContributions[index]!,
        ]),
      );
      for (const identity of nativeDependencyIdentities(
        content,
        contentByIdentity,
      )) {
        const provider = contentByIdentity.get(contentIdentityKey(identity));
        const existing = packages.filter(
          (item) =>
            contentIdentityKey(item.contentIdentity) ===
            contentIdentityKey(identity),
        );
        if (provider === undefined || existing.length !== 1) continue;
        const providerRecord = existing[0]!;
        const baseline = existingContributionByPackageId.get(
          providerRecord.definition.packageDefinitionId,
        );
        if (baseline === undefined) {
          throw new Error(
            "生成记录缺少已选依赖的现行贡献：" + providerRecord.definition.path,
          );
        }
        assertReusablePackageExposure({
          repositoryRoot: targetRoot,
          packagePath: providerRecord.definition.path,
          expectedExports: baseline.exposure.exports,
        });
      }
      return context;
    },
    validateAddition({
      targetRoot,
      blueprint,
      content,
      definition,
      creationInput,
      packages,
      contributions,
      getAdditionContributions,
    }) {
      const requestedInput =
        creationInput === undefined ? undefined : creationInput;
      const linkFromValue = isRecord(requestedInput as unknown)
        ? (requestedInput as unknown as Record<string, unknown>).linkFrom
        : undefined;
      const linkIssues: { code: string }[] = [];
      if (linkFromValue !== undefined) {
        if (!Array.isArray(linkFromValue)) {
          linkIssues.push({ code: "INVALID_LINK_FROM" });
        } else {
          for (const packagePath of linkFromValue) {
            if (typeof packagePath !== "string" || packagePath.length === 0) {
              linkIssues.push({ code: "INVALID_LINK_FROM" });
              continue;
            }
            const validation = validateDefaultPackagePath(packagePath);
            if (!validation.hasValidShape) {
              linkIssues.push({ code: "INVALID_LINK_FROM" });
            }
            if (validation.reservedWorkspaceCollection !== undefined) {
              linkIssues.push({ code: "RESERVED_LINK_FROM" });
            }
          }
        }
      }
      if (linkIssues.length > 0) {
        return { status: "input-invalid", issues: linkIssues } as const;
      }
      const linkFrom = requestedLinkFrom(requestedInput);
      if (
        linkFrom.some(
          (packagePath) =>
            !blueprint.packages.some(
              (candidate) => candidate.path === packagePath,
            ),
        )
      ) {
        return {
          status: "input-invalid",
          issues: [{ code: "UNKNOWN_LINK_FROM" }],
        } as const;
      }
      if (linkFrom.length > 0) {
        const addition = getAdditionContributions().find(
          (contribution) => contribution.definition.path === definition.path,
        );
        if (addition === undefined) {
          throw new Error("默认工作区校验缺少本次加包贡献：" + definition.path);
        }
        const contributionByPath = new Map(
          contributions.map((contribution) => [
            contribution.definition.path,
            contribution,
          ]),
        );
        const requestedBlueprint: ProjectBlueprint = {
          ...blueprint,
          packageLinkIntents: [
            ...(blueprint.packageLinkIntents ?? []),
            ...linkFrom.map((consumerPackagePath): PackageLinkIntent => ({
              consumerPackagePath,
              providerPackagePath: definition.path,
            })),
          ],
        };
        const currentManifests = readProjectLinkManifestTruth({
          repositoryRoot: targetRoot,
          packagePaths: (requestedBlueprint.packageLinkIntents ?? []).flatMap(
            (intent) => [
              intent.consumerPackagePath,
              intent.providerPackagePath,
            ],
          ),
        });
        const unsupported =
          !canProvideSourceConditionPackageNameImportForRole(
            definition.role,
            addition.manifest,
          ) ||
          linkFrom.some((consumerPackagePath) => {
            const consumer = contributionByPath.get(consumerPackagePath);
            if (consumer === undefined) return true;
            const manifest =
              currentManifests.get(consumerPackagePath) ?? consumer.manifest;
            if (manifest.name !== consumer.definition.name) {
              throw new Error(
                `Project Linking Manifest Truth for ${consumer.definition.path} must have package name ${consumer.definition.name}`,
              );
            }
            return (
              !canConsumeNodePackageNameImportForRole(
                consumer.definition.role,
                manifest,
              ) ||
              !canLinkNodePackageRoles(
                consumer.definition.role,
                definition.role,
              )
            );
          });
        if (unsupported) {
          return {
            status: "input-invalid",
            issues: [{ code: "UNSUPPORTED_LINK" }],
          } as const;
        }
        const occupiedDefinition = blueprint.packages.find(
          (candidate) =>
            candidate.name === definition.name ||
            candidate.path === definition.path,
        );
        const prior = packages.find(
          (item) =>
            item.definition.packageDefinitionId ===
            occupiedDefinition?.packageDefinitionId,
        );
        const samePackageIdentity =
          occupiedDefinition !== undefined &&
          prior !== undefined &&
          contentIdentityKey(prior.contentIdentity) ===
            contentIdentityKey(content.identity) &&
          prior.definition.name === definition.name &&
          prior.definition.path === definition.path;
        if (
          samePackageIdentity &&
          occupiedDefinition !== undefined &&
          prior !== undefined
        ) {
          const existingLinks = blueprint.packageLinkIntents ?? [];
          const missingConsumer = linkFrom.find(
            (consumerPackagePath) =>
              !existingLinks.some(
                (intent) =>
                  intent.consumerPackagePath === consumerPackagePath &&
                  intent.providerPackagePath === definition.path,
              ),
          );
          if (missingConsumer !== undefined) {
            return {
              status: "conflict",
              conflict: {
                code: "MISSING_LINK",
                facts: {
                  existing: {
                    name: occupiedDefinition.name,
                    path: occupiedDefinition.path,
                    role: occupiedDefinition.role,
                  },
                  requested: {
                    name: definition.name,
                    path: definition.path,
                    role: definition.role,
                  },
                  missingLink: {
                    consumerPackagePath: missingConsumer,
                    providerPackagePath: definition.path,
                  },
                },
              },
            } as const;
          }
        }
      }
      return;
    },
    parseState(value) {
      if (!isRecord(value) || !isRecord(value.toolchain)) {
        throw new Error("默认工作区策略记录无效");
      }
      if (
        typeof value.repositoryName !== "string" ||
        typeof value.defaultPackageScope !== "string" ||
        typeof value.todo !== "boolean" ||
        typeof value.toolchain.nodeLtsMajor !== "string" ||
        typeof value.toolchain.nodeVersion !== "string" ||
        typeof value.toolchain.packageManagerPin !== "string" ||
        (value.toolchain.rustVersion !== undefined &&
          typeof value.toolchain.rustVersion !== "string")
      ) {
        throw new Error("默认工作区策略记录缺少必要事实");
      }
      return value as DefaultWorkspaceState;
    },
    dependencies({ content, contentByIdentity }) {
      return nativeDependencyIdentities(content, contentByIdentity);
    },
    bindings({ contentByIdentity, providers }) {
      return nativeBindings(contentByIdentity, providers);
    },
    createDefinition({ context, content, creationInput, layout }) {
      const reference = content.definition;
      const selectedLeaf = creationInput?.leafName ?? reference.defaultLeafName;
      const defaultPath =
        layout === undefined
          ? reference.defaultPath
          : path.posix.join(layout.packageDirectory, reference.defaultLeafName);
      return assertDefaultPackageDefinition({
        name: "@" + context.defaultPackageScope + "/" + selectedLeaf,
        path:
          creationInput?.packagePath ??
          (creationInput?.leafName === undefined
            ? defaultPath
            : siblingPackagePath(defaultPath, selectedLeaf)),
        role: reference.role,
      });
    },
    project(projectOptions) {
      return projectOperations({
        ...projectOptions,
        cliPublicationReference: options.cliPublicationReference,
        sharedRootContributions: options.project?.(projectOptions) ?? [],
      });
    },
  };
}
