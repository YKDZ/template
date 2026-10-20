import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ContentIdentity } from "@ykdz/template-core/content-identity";
import {
  contentIdentityKey,
  contentIdentityLabel,
} from "@ykdz/template-core/content-identity";
import type {
  PackageLinkIntent,
  PackageDefinition,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import type { ProjectProjectionReconciliation } from "@ykdz/template-core/project-projection";
import {
  createTemplateSourceHandle,
  type RenderOperation,
} from "@ykdz/template-core/renderer";
import type {
  GeneratorContent,
  GeneratorPackageState,
  PackageCreationInput,
  WorkspaceProjection,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";
import { composeCiDiagnosticArtifacts } from "@ykdz/template-environment/ci-diagnostic-artifact";
import type { CiDiagnosticArtifactDeclaration } from "@ykdz/template-environment/ci-diagnostic-artifact";
import {
  builtInEditorCustomization,
  planBuiltInDevelopmentContainer,
  shellCheckDevelopmentContainerToolLayer,
} from "@ykdz/template-environment/development-environment";
import {
  normalizeEnvironmentNeeds,
  type CheckEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@ykdz/template-environment/module-graph";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type {
  DatabasePreparationRequirement,
  DependencyMaintenancePolicy,
  DeploymentCheckRequirement,
  ProjectRequirement,
  VueHonoJointE2eRequirement,
} from "@ykdz/template-workspace-authoring/project-requirements";
import type { ReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

import {
  assertDatabasePreparationManifestTruth,
  applicationCiDiagnosticArtifacts,
  readDatabasePreparationManifestTruth,
  projectDependencyMaintenancePolicy,
  applicationRootTsconfigIncludes,
  type DatabasePreparationManifestRequirement,
  type WorkspaceProjectRequirements,
} from "./application-requirements.ts";
import { projectCliPublication } from "./cli-publication-projection.ts";
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
  assertReusablePackageExposure,
  readPackageAdditionVersionFacts,
  WorkspacePackageAdditionFailure,
} from "./package-addition-facts.ts";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
  projectNextStepsDocument,
} from "./project-github.ts";
import {
  planExplicitProjectLinks,
  promoteInjectedProviderRuntimeDependencies,
  canConsumeNodePackageNameImportForRole,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImportForRole,
  readProjectLinkManifestTruth,
} from "./project-linking.ts";
import { releaseToolchainSnapshot } from "./release-toolchain-snapshot.ts";
import {
  createWorkspaceRootManifest,
  packageConditionKeyOrder,
  packageManifestKeyOrder,
  projectToolchainMirrorManifest,
  projectPreparedWorkspaceRoot,
  type WorkspaceRootInsertion,
} from "./root-projection.ts";
import {
  initialRustVersion,
  prepareRustTargetAddition,
  projectRustTarget,
} from "./rust-target-projection.ts";
import { vuePnpmDependencyOverrides } from "./vue-policy.ts";
import { prepareWorkspaceProjectResources } from "./workspace-project-resources.ts";
import { readWorkspaceJson } from "./workspace-resources.ts";

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
  readonly requirements: WorkspaceProjectRequirements;
  readonly environmentNeeds: ReturnType<typeof normalizeEnvironmentNeeds>;
  readonly diagnosticArtifacts: readonly CiDiagnosticArtifactDeclaration[];
  readonly container: {
    readonly dockerfileText: string;
    readonly buildArguments: ReturnType<
      typeof planBuiltInDevelopmentContainer
    >["buildArguments"];
    readonly mounts: ReturnType<
      typeof planBuiltInDevelopmentContainer
    >["mounts"];
    readonly probes: ReturnType<
      typeof planBuiltInDevelopmentContainer
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

const workspaceSource = createTemplateSourceHandle(
  fileURLToPath(new URL("../", import.meta.url)),
);
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

const supportedProjectRequirementKinds = new Set([
  "package-link",
  "vue-hono-joint-e2e",
  "sqlite-database-preparation",
  "application-container-with-database-migrations",
]);

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

function workspaceResource(from: string, to: string): RenderOperation {
  return {
    kind: "copyFile",
    source: workspaceSource,
    from: "assets/" + from,
    to,
  };
}

function workspaceFile(from: string, to: string): RenderOperation {
  return {
    kind: "copyFile",
    source: workspaceSource,
    from,
    to,
  };
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

function oneRequirement<T extends ProjectRequirement["kind"]>(
  requirements: readonly ProjectRequirement[],
  kind: T,
): Extract<ProjectRequirement, { readonly kind: T }> | undefined {
  const matches = requirements.filter(
    (requirement): requirement is Extract<ProjectRequirement, { kind: T }> =>
      requirement.kind === kind,
  );
  if (matches.length > 1) {
    throw new Error(`工作区项目能力只能声明一次：${kind}`);
  }
  return matches[0];
}

function projectRequirements(
  blueprint: ProjectBlueprint,
  contributions: readonly PackageContribution[],
  presetProjectContributions: readonly (readonly ProjectRequirement[])[],
): {
  readonly blueprint: ProjectBlueprint;
  readonly requirements: WorkspaceProjectRequirements;
} {
  const declarations = contributions.flatMap(
    (contribution) => contribution.projectRequirements ?? [],
  );
  declarations.push(...presetProjectContributions.flat());
  assertSupportedProjectRequirementKinds(declarations);
  const joint = oneRequirement(declarations, "vue-hono-joint-e2e");
  const database = oneRequirement(declarations, "sqlite-database-preparation");
  const deployment = oneRequirement(
    declarations,
    "application-container-with-database-migrations",
  );
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
  const actualJoint =
    joint === undefined
      ? undefined
      : ({
          kind: joint.kind,
          web: requireProjectPackage(blueprint, joint.web, joint.kind),
          api: requireProjectPackage(blueprint, joint.api, joint.kind),
        } satisfies VueHonoJointE2eRequirement);
  if (actualJoint !== undefined) {
    if (
      actualJoint.web.role !== "runtime-service" ||
      actualJoint.api.role !== "runtime-service"
    ) {
      throw new Error("Vue-Hono 联合验收需要 web 与 API 服务实例");
    }
    links.push({
      consumerPackagePath: actualJoint.web.path,
      providerPackagePath: actualJoint.api.path,
    });
  }
  const actualDatabase =
    database === undefined
      ? undefined
      : ({
          kind: database.kind,
          web: requireProjectPackage(blueprint, database.web, database.kind),
          database: requireProjectPackage(
            blueprint,
            database.database,
            database.kind,
          ),
          migrations: requireProjectPackage(
            blueprint,
            database.migrations,
            database.kind,
          ),
        } satisfies DatabasePreparationRequirement);
  const actualDeployment =
    deployment === undefined
      ? undefined
      : ({
          kind: deployment.kind,
          application: requireProjectPackage(
            blueprint,
            deployment.application,
            deployment.kind,
          ),
          database: requireProjectPackage(
            blueprint,
            deployment.database,
            deployment.kind,
          ),
          migrations: requireProjectPackage(
            blueprint,
            deployment.migrations,
            deployment.kind,
          ),
          environmentNeeds: deployment.environmentNeeds,
        } satisfies DeploymentCheckRequirement);
  for (const requirement of [actualDatabase, actualDeployment]) {
    if (requirement === undefined) continue;
    const application =
      requirement.kind === "sqlite-database-preparation"
        ? requirement.web
        : requirement.application;
    if (
      application.role !== "runtime-service" ||
      requirement.database.role !== "shared-library" ||
      requirement.migrations.role !== "shared-library"
    ) {
      throw new Error(
        `${requirement.kind} 需要应用、数据库和迁移包的实际角色匹配`,
      );
    }
    links.push(
      {
        consumerPackagePath: application.path,
        providerPackagePath: requirement.database.path,
      },
      {
        consumerPackagePath: requirement.migrations.path,
        providerPackagePath: requirement.database.path,
      },
    );
  }
  if (
    actualDatabase !== undefined &&
    actualDeployment !== undefined &&
    (!samePackageDefinition(actualDatabase.web, actualDeployment.application) ||
      !samePackageDefinition(
        actualDatabase.database,
        actualDeployment.database,
      ) ||
      !samePackageDefinition(
        actualDatabase.migrations,
        actualDeployment.migrations,
      ))
  ) {
    throw new Error("数据库准备与部署能力必须引用同一组实际包实例");
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
  return {
    blueprint: assertDefaultProjectBlueprint(
      packageLinkIntents.length === 0 &&
        blueprint.packageLinkIntents === undefined
        ? {
            schemaVersion: blueprint.schemaVersion,
            packages: blueprint.packages,
          }
        : { ...blueprint, packageLinkIntents },
    ),
    requirements: {
      ...(actualJoint === undefined ? {} : { vueHonoJointE2e: actualJoint }),
      ...(actualDatabase === undefined
        ? {}
        : { databasePreparation: actualDatabase }),
      ...(actualDeployment === undefined
        ? {}
        : { deploymentCheck: actualDeployment }),
    },
  };
}

function databasePreparationScripts(
  preparation: DatabasePreparationRequirement,
): Readonly<Record<string, string>> {
  const run = (
    profile: "dev" | "test" | "e2e",
    definition: PackageDefinition,
    task: string,
  ) =>
    `DATABASE_PROFILE=${profile} pnpm --filter ${definition.name} run ${task}`;
  return {
    "database:prepare:dev": [
      run("dev", preparation.migrations, "db:push"),
      run("dev", preparation.database, "db:seed:example"),
    ].join(" && "),
    "database:prepare:test": [
      run("test", preparation.database, "db:reset"),
      run("test", preparation.migrations, "db:push"),
      run("test", preparation.database, "db:seed:example"),
    ].join(" && "),
    "database:prepare:e2e": [
      run("e2e", preparation.database, "db:reset"),
      run("e2e", preparation.migrations, "db:push"),
      run("e2e", preparation.database, "db:seed:example"),
    ].join(" && "),
  };
}

function projectRootScriptInsertions(
  requirements: WorkspaceProjectRequirements,
): WorkspaceRootInsertion[] {
  const insertions: WorkspaceRootInsertion[] = [];
  const database = requirements.databasePreparation;
  if (database !== undefined) {
    insertions.push({
      before: "fix",
      values: databasePreparationScripts(database),
    });
  }
  if (requirements.deploymentCheck !== undefined) {
    insertions.push({
      before: "fix",
      values: {
        deployment:
          "node --conditions=source scripts/check-standalone-deployment.ts",
      },
    });
  }
  if (database !== undefined) {
    insertions.push({
      before: "fix",
      values: {
        dev: `pnpm run database:prepare:dev && turbo watch dev --filter=${database.web.name}`,
      },
    });
  }
  if (requirements.vueHonoJointE2e !== undefined) {
    insertions.push({
      before: "typecheck",
      values: { "test:e2e": "playwright test" },
    });
  }
  return insertions;
}

function projectOperations(options: {
  readonly context: DefaultWorkspaceContext;
  readonly state: DefaultWorkspaceState;
  readonly blueprint: ProjectBlueprint;
  readonly packages: readonly GeneratorPackageState[];
  readonly contributions: readonly PackageContribution[];
  readonly presetProjectContributions: readonly (readonly ProjectRequirement[])[];
}): WorkspaceProjection<DefaultWorkspaceOwnerFacts> {
  const { context } = options;
  const projectState = projectRequirements(
    includeRequestedLinkFromIntents(
      assertDefaultProjectBlueprint(options.blueprint),
      options.packages,
    ),
    options.contributions,
    options.presetProjectContributions,
  );
  const { blueprint, requirements } = projectState;
  const linkPlan = planExplicitProjectLinks({
    blueprint,
    contributions: options.contributions,
    manifestTruthByPackagePath: readProjectLinkManifestTruth({
      repositoryRoot: context.targetDir,
      blueprint,
      contributions: options.contributions,
    }),
  });
  const contributions = promoteInjectedProviderRuntimeDependencies({
    contributions: options.contributions,
    linkPlan,
  });
  const cliPublication = projectCliPublication({
    packages: options.packages,
    contributions,
  });
  const rustProjection = projectRustTarget({
    context,
    packages: options.packages,
    contributions,
  });
  const rust = rustProjection.toolchain;
  const hasDeployment = requirements.deploymentCheck !== undefined;
  const hasJointE2e = requirements.vueHonoJointE2e !== undefined;
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
  const rootAutomationPaths = [
    "*.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "*.config.ts",
    ".pnpmfile.mjs",
    ".gitignore",
    ".dockerignore",
    "Dockerfile",
    "TODO.md",
    "rust-toolchain.toml",
    ".vscode",
    ".github",
    ".devcontainer",
    "scripts",
    ...(hasJointE2e ? ["test"] : []),
  ].join(" ");
  const rootManifest = createWorkspaceRootManifest({
    name: context.repositoryName,
    ...(configuration === undefined
      ? {}
      : { typescriptConfigurationPackageName: configuration.definition.name }),
    nodeDeclaration:
      context.toolchain.nodeVersion ?? context.toolchain.nodeLtsMajor,
    packageManagerPin: context.toolchain.packageManagerPin,
    ...(cliPublication.imports === undefined
      ? {}
      : { imports: cliPublication.imports }),
    scriptInsertions: [
      ...(rust === undefined
        ? []
        : [
            {
              before: "boundaries",
              values: { "toolchain:prepare": "cargo --version" },
            },
          ]),
      ...cliPublication.scriptInsertions,
      ...projectRootScriptInsertions(requirements),
    ],
    ...(hasJointE2e || cliPublication.candidate !== undefined
      ? {
          dependencyInsertions: [
            ...(hasJointE2e
              ? [
                  {
                    before: "@types/node",
                    values: { "@playwright/test": "catalog:" },
                  },
                ]
              : []),
            ...cliPublication.dependencyInsertions,
          ],
        }
      : {}),
    ...(hasDeployment || hasJointE2e
      ? {
          scriptOverrides: {
            "format:check": `oxfmt --list-different --no-error-on-unmatched-pattern ${rootAutomationPaths}`,
            "format:write": `oxfmt --write --no-error-on-unmatched-pattern ${rootAutomationPaths}`,
            lint: `${hasDeployment ? "shellcheck scripts/container-entrypoint.sh && " : ""}oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts${hasJointE2e ? " test" : ""}`,
            "lint:fix": `oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts${hasJointE2e ? " test" : ""} --fix`,
          },
        }
      : {}),
  });
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
      ...applicationCiDiagnosticArtifacts(requirements),
    ],
  });
  const editor = builtInEditorCustomization(
    contributions.flatMap(
      (contribution) => contribution.foundation.editorCapabilities,
    ),
  );
  const deploymentEnvironmentNeeds =
    requirements.deploymentCheck?.environmentNeeds ?? [];
  const checkEnvironmentNeeds = [
    ...contributions.flatMap((contribution) => contribution.environmentNeeds),
    ...(hasJointE2e
      ? [
          playwrightBrowserAssetsEnvironmentNeed({
            browser: "chromium",
            owner: { kind: "workspace-orchestration", path: "." },
          }),
        ]
      : []),
    ...(hasDeployment
      ? [
          shellCheckEnvironmentNeed({
            kind: "workspace-orchestration",
            path: ".",
          }),
        ]
      : []),
  ];
  const containerLayers = [
    ...(checkEnvironmentNeeds.some(
      (need) => need.kind === "playwright-browser-assets",
    )
      ? [browserTestDevelopmentContainerToolLayer()]
      : []),
    ...(hasDeployment ? [shellCheckDevelopmentContainerToolLayer()] : []),
    ...contributions.flatMap(
      (contribution) =>
        contribution.foundation.developmentContainerToolLayers ?? [],
    ),
  ];
  const container = planBuiltInDevelopmentContainer({
    nodeVersion:
      context.toolchain.nodeVersion ?? context.toolchain.nodeLtsMajor,
    layers: containerLayers,
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
    turboTemplate: readWorkspaceJson("turbo.json"),
    referenceNames,
    turboBoundaryTags: boundaryTags(contributions),
    rootTsconfigTemplate: readWorkspaceJson("tsconfig.json"),
    rootTsconfigCompilerOptions: {
      ...cliPublication.tsconfigCompilerOptions,
      rewriteRelativeImportExtensions: false,
      allowImportingTsExtensions: true,
    },
    rootTsconfigInclude: [
      "*.config.ts",
      "scripts/**/*.ts",
      ...cliPublication.tsconfigInclude,
      ...applicationRootTsconfigIncludes(requirements),
    ],
    tsconfigConfigTemplate: readWorkspaceJson("tsconfig.config.json"),
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
    deployment: deploymentEnvironmentNeeds,
  });
  const dependencyMaintenance = projectDependencyMaintenancePolicy({
    contributions,
    hasDeployment,
  });
  const reconciliation: readonly ProjectProjectionReconciliation[] = [
    { path: "tsconfig.json", driver: "structured" },
    { path: "turbo.json", driver: "structured" },
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
  const defaultOperations: RenderOperation[] = [
    rootProjection.manifest,
    rootProjection.workspace,
    workspaceResource("gitignore", ".gitignore"),
    workspaceResource("agent-instructions.md", "AGENTS.md"),
    rootProjection.turbo,
    workspaceFile(
      "scripts/check-toolchain-versions.ts",
      "scripts/check-toolchain-versions.ts",
    ),
    projectToolchainMirrorManifest(reconciliation),
    workspaceFile("scripts/task-gates.ts", "scripts/task-gates.ts"),
    workspaceFile(
      "scripts/run-turbo-boundaries.ts",
      "scripts/run-turbo-boundaries.ts",
    ),
    rootProjection.tsconfig,
    rootProjection.tsconfigConfig,
    ...cliPublication.operations,
    ...(configuration === undefined
      ? []
      : [
          {
            kind: "writeText" as const,
            to: "oxlint.config.ts",
            text:
              "export { default } from " +
              JSON.stringify(configuration.definition.name + "/oxlint") +
              ";\n",
          },
          {
            kind: "writeText" as const,
            to: "oxfmt.config.ts",
            text:
              "export { default } from " +
              JSON.stringify(configuration.definition.name + "/oxfmt") +
              ";\n",
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
      text: projectCheckWorkflow({
        packagePaths,
        ...(requirements.deploymentCheck === undefined
          ? {}
          : { deploymentCheck: requirements.deploymentCheck }),
        diagnosticArtifacts: artifacts,
      }),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectDependabotConfig(dependencyMaintenance),
    },
    ...(options.state.todo
      ? [
          {
            kind: "writeText" as const,
            to: "TODO.md",
            text: projectNextStepsDocument(nextSteps),
          },
        ]
      : []),
    {
      kind: "writeJson",
      to: ".template/environment-needs.json",
      value: environmentNeeds,
    },
  ];
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
      ...prepareWorkspaceProjectResources(requirements),
      { kind: "writeJson", to: ".template/blueprint.json", value: blueprint },
    ],
    reconciliation,
    ownerFacts: {
      requirements,
      environmentNeeds,
      diagnosticArtifacts: artifacts,
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
>(): WorkspaceStrategy<
  DefaultWorkspaceContext,
  DefaultWorkspaceInput,
  DefaultWorkspaceState,
  PackageContribution,
  CreationInput,
  DefaultReferenceContent<CreationInput>,
  DefaultWorkspaceNodeLayout,
  readonly ProjectRequirement[],
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
      return { state, context: defaultContext(targetRoot, state) };
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
      presetProjectContributions,
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
          blueprint: requestedBlueprint,
          contributions,
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
      const packageByName = new Map(
        contributions.map((contribution) => [
          contribution.definition.name,
          contribution,
        ]),
      );
      const requirements = [
        ...contributions.flatMap(
          (contribution) => contribution.projectRequirements ?? [],
        ),
        ...presetProjectContributions.flat(),
      ];
      const databasePreparations = requirements.filter(
        (requirement): requirement is DatabasePreparationRequirement =>
          requirement.kind === "sqlite-database-preparation",
      );
      if (databasePreparations.length > 1) {
        throw new Error(
          "工作区项目能力只能声明一次：sqlite-database-preparation",
        );
      }
      const databasePreparation = databasePreparations[0];
      const manifestRequirement:
        | DatabasePreparationManifestRequirement
        | undefined =
        databasePreparation === undefined
          ? undefined
          : {
              databasePackageName: databasePreparation.database.name,
              migrationPackageName: databasePreparation.migrations.name,
              consumers: {
                "application-dev": databasePreparation.web.name,
                "application-e2e": databasePreparation.web.name,
              },
            };
      const manifestTruthByPackagePath = readDatabasePreparationManifestTruth({
        repositoryRoot: targetRoot,
        preparation: manifestRequirement,
        packageByName,
      });
      assertDatabasePreparationManifestTruth({
        preparation: manifestRequirement,
        packageByName,
        manifestTruthByPackagePath,
      });
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
    project(options) {
      return projectOperations(options);
    },
  };
}
