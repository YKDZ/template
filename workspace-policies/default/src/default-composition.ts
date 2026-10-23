import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type {
  Composition,
  CompositionPackage,
  CompositionPackageEvaluation,
} from "@ykdz/template-core/composition";
import {
  contentIdentityKey,
  contentIdentityLabel,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { GenerationRecordSelection } from "@ykdz/template-core/generation-record";
import type { JsonValue } from "@ykdz/template-core/json";
import type {
  CompositionFile,
  CompositionReconciliation,
} from "@ykdz/template-core/package-contribution";
import type {
  PackageLinkIntent,
  PackageDefinitionId,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import { parse as parseJsonc } from "jsonc-parser";
import { stringify as stringifyYaml } from "yaml";

import {
  projectDependencyMaintenancePolicy,
  type DependencyMaintenancePolicy,
} from "./application-requirements.ts";
import type { CiDiagnosticArtifactDeclaration } from "./ci-diagnostic-artifact.ts";
import { assertDefaultProjectBlueprint } from "./default-package-identity.ts";
import { isDefaultPackageRole } from "./default-package-role.ts";
import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "./dependency-catalog.ts";
import {
  prepareBuiltInDevelopmentContainerResources,
  prepareBuiltInEditorCustomizationDeclarations,
  projectBuiltInDevelopmentContainer,
  projectBuiltInEditorCustomization,
} from "./development-environment.ts";
import type { EditorCustomizationCapability } from "./editor-customization.ts";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
} from "./environment-needs.ts";
import {
  normalizeEnvironmentNeeds,
  type EnvironmentNeedsMetadata,
} from "./environment-needs.ts";
import {
  projectCheckWorkflow,
  prepareProjectGithubTemplates,
  projectDependabotConfig,
  projectNextStepsDocument,
} from "./project-github.ts";
import type {
  DefaultCompositionFile,
  DefaultNativeDocument,
  DefaultReferenceContributionFacts,
  DefaultRootDeclarationData,
  DefaultWorkspaceConventions,
} from "./reference-package.ts";
import { serializeNativeReferenceDocument } from "./reference-package.ts";
import { releaseToolchainSnapshot } from "./release-toolchain-snapshot.ts";
import {
  composeCheckWorkflow,
  type RootResourceOperation,
} from "./shared-root-files.ts";
import { vuePnpmDependencyOverrides } from "./vue-policy.ts";
import {
  dependencyCatalogSnapshot,
  workspaceInstallPolicySnapshot,
} from "./workspace-policy-snapshot.ts";

export type DefaultRootDeclaration = DefaultRootDeclarationData & {
  readonly sourceIdentity: ContentIdentity;
  readonly requiredTemplateDependency?: string;
};

export type DefaultCompositionFileResource = {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
};

export type DefaultCompositionResources = {
  readonly rootFiles: readonly DefaultCompositionFileResource[];
  readonly github: ReturnType<typeof prepareProjectGithubTemplates>;
  readonly developmentContainer: ReturnType<
    typeof prepareBuiltInDevelopmentContainerResources
  >;
  readonly editor: ReturnType<
    typeof prepareBuiltInEditorCustomizationDeclarations
  >;
  readonly nextSteps: readonly { readonly display: string }[];
};

export type DefaultOperationFacts = {
  /** 从本次release快照或当前root manifest读到的实际Node声明。 */
  readonly nodeDeclaration: string;
  /** init使用release pin；add使用当前root packageManager。 */
  readonly packageManagerPin: string;
  readonly resources: DefaultCompositionResources;
  readonly rootDeclarations: readonly DefaultRootDeclaration[];
  /** 本次add明确连接端点读取到的当前manifest；键为恢复后的实例ID。 */
  readonly targetManifests: ReadonlyMap<
    PackageDefinitionId,
    Readonly<Record<string, unknown>>
  >;
};

export type DefaultStableCommon = {
  readonly nodeDeclaration: string;
  readonly packageManagerPin: string;
  readonly resources: DefaultCompositionResources;
  readonly rootDeclarations: readonly DefaultRootDeclaration[];
  readonly targetManifests: ReadonlyMap<
    PackageDefinitionId,
    Readonly<Record<string, unknown>>
  >;
};

export type DefaultPackageInput = undefined;

export type DefaultCompositionOwnerFacts = {
  readonly rootPackageDefinitionId: PackageDefinitionId;
  readonly packagePaths: readonly string[];
  readonly nativeDocuments: readonly {
    readonly identity: ContentIdentity;
    readonly packageDefinitionId: PackageDefinitionId;
    readonly path: string;
    readonly sourcePath: string;
  }[];
  readonly dependencyCatalog: Readonly<Record<string, string>>;
  readonly environmentNeeds: EnvironmentNeedsMetadata;
  readonly ciDiagnosticArtifacts: readonly CiDiagnosticArtifactDeclaration[];
};

type DefaultContribution = DefaultReferenceContributionFacts<unknown>;
type DefaultEvaluation = CompositionPackageEvaluation<DefaultContribution>;
type DefaultContentMember = LoadedContentMember<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConventions(value: unknown): DefaultWorkspaceConventions {
  if (!isRecord(value)) {
    throw new Error("默认工作区约定必须是对象");
  }
  if (
    typeof value.repositoryName !== "string" ||
    value.repositoryName.trim().length === 0
  ) {
    throw new Error("默认工作区约定缺少repositoryName");
  }
  if (
    typeof value.defaultPackageScope !== "string" ||
    value.defaultPackageScope.trim().length === 0
  ) {
    throw new Error("默认工作区约定缺少defaultPackageScope");
  }
  if (value.todo !== undefined && typeof value.todo !== "boolean") {
    throw new Error("默认工作区约定todo必须是boolean");
  }
  return Object.freeze({
    repositoryName: value.repositoryName,
    defaultPackageScope: value.defaultPackageScope,
    todo: value.todo === true,
  });
}

function readAsset(resourcePath: string): Uint8Array {
  return readFileSync(
    fileURLToPath(new URL(`../assets/${resourcePath}`, import.meta.url)),
  );
}

/** 外层默认准备拥有者读取的默认环境资源；Composition只接收这份快照。 */
export function prepareDefaultCompositionResources(): DefaultCompositionResources {
  return Object.freeze({
    rootFiles: Object.freeze([
      {
        path: ".gitignore",
        content: readAsset("gitignore"),
        mode: 0,
      },
      {
        path: "AGENTS.md",
        content: readAsset("agent-instructions.md"),
        mode: 0,
      },
    ]),
    github: prepareProjectGithubTemplates(),
    developmentContainer: prepareBuiltInDevelopmentContainerResources(),
    editor: prepareBuiltInEditorCustomizationDeclarations(),
    nextSteps: Object.freeze([
      { display: "pnpm install" },
      { display: "pnpm run fix" },
      { display: "pnpm run check" },
    ]),
  });
}

export function prepareDefaultInitOperationFacts(
  options: {
    readonly rootDeclarations?: readonly DefaultRootDeclaration[];
    readonly resources?: DefaultCompositionResources;
  } = {},
): DefaultOperationFacts {
  return Object.freeze({
    nodeDeclaration: releaseToolchainSnapshot.nodeVersion,
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    resources: options.resources ?? prepareDefaultCompositionResources(),
    rootDeclarations: options.rootDeclarations ?? [],
    targetManifests: new Map(),
  });
}

/** 读取声明了根附件的owner快照；调用者负责在每次正式操作前执行。 */
export async function prepareDefaultRootDeclarations(
  content: readonly DefaultContentMember[],
): Promise<readonly DefaultRootDeclaration[]> {
  const declarations: DefaultRootDeclaration[] = [];
  for (const member of content) {
    if (member.kind !== "reference" || !isRecord(member.definition)) continue;
    if (member.definition.rootDeclarationAvailable !== true) continue;
    const prepare = member.definition.prepare;
    const project = member.definition.prepareRootDeclaration;
    const manifest = member.definition.manifest;
    if (
      typeof prepare !== "function" ||
      typeof project !== "function" ||
      !isRecord(manifest) ||
      typeof manifest.name !== "string"
    ) {
      throw new Error(
        `根附件owner声明不完整：${contentIdentityLabel(member.identity)}`,
      );
    }
    const prepared = await prepare({ excludedPackagePaths: [] });
    if (!isRecord(prepared) || !isRecord(prepared.facts)) {
      throw new Error(
        `根附件owner prepare未返回事实：${contentIdentityLabel(member.identity)}`,
      );
    }
    const data = project(prepared.facts.ownerFacts);
    if (data === undefined) continue;
    if (!isRecord(data)) {
      throw new Error(
        `根附件owner投影必须是对象：${contentIdentityLabel(member.identity)}`,
      );
    }
    declarations.push({
      ...data,
      sourceIdentity: member.identity,
      requiredTemplateDependency: manifest.name,
    } as DefaultRootDeclaration);
  }
  return Object.freeze(declarations);
}

function sourceLabel(identity: ContentIdentity): string {
  return contentIdentityLabel(identity);
}

function validateDefaultFacts(
  value: unknown,
): asserts value is DefaultOperationFacts {
  if (
    !isRecord(value) ||
    typeof value.nodeDeclaration !== "string" ||
    value.nodeDeclaration.trim().length === 0 ||
    typeof value.packageManagerPin !== "string" ||
    value.packageManagerPin.trim().length === 0 ||
    !Array.isArray(value.rootDeclarations) ||
    !isRecord(value.resources)
  ) {
    throw new Error("默认工作区本次operationFacts无效");
  }
}

function packageLinks(options: {
  readonly packages: readonly CompositionPackage<JsonValue>[];
  readonly content: readonly DefaultContentMember[];
  readonly selections: readonly GenerationRecordSelection[];
}): readonly PackageLinkIntent[] {
  const seen = new Set<string>();
  const links: PackageLinkIntent[] = [];
  const packagesById = new Map(
    options.packages.map((item) => [item.packageDefinitionId, item]),
  );
  const contentByIdentity = new Map(
    options.content
      .filter((member) => member.kind === "reference")
      .map((member) => [contentIdentityKey(member.identity), member]),
  );
  const packagesByNodeIdentity = new Map<string, Set<PackageDefinitionId>>();
  for (const selection of options.selections) {
    for (const [nodeIdentity, packageId] of Object.entries(selection.nodes)) {
      const packageIds = packagesByNodeIdentity.get(nodeIdentity) ?? new Set();
      packageIds.add(packageId);
      packagesByNodeIdentity.set(nodeIdentity, packageIds);
    }
  }
  const add = (
    consumerId: PackageDefinitionId,
    providerId: PackageDefinitionId,
  ): void => {
    if (consumerId === providerId) return;
    const identity = `${consumerId}\u0000${providerId}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    links.push({ consumerId, providerId });
  };

  for (const consumer of options.packages) {
    const consumerMember = contentByIdentity.get(
      contentIdentityKey(consumer.contentIdentity),
    );
    if (consumerMember !== undefined && isRecord(consumerMember.definition)) {
      const targetDependencyKeys = new Set(
        Array.isArray(consumerMember.definition.targetDependencyKeys)
          ? consumerMember.definition.targetDependencyKeys.filter(
              (key): key is string => typeof key === "string",
            )
          : [],
      );
      for (const [key, providerId] of Object.entries(
        consumer.dependencyBindings,
      )) {
        if (!targetDependencyKeys.has(key)) continue;
        const provider = packagesById.get(providerId);
        const providerMember =
          provider === undefined
            ? undefined
            : contentByIdentity.get(
                contentIdentityKey(provider.contentIdentity),
              );
        if (
          providerMember === undefined ||
          !isRecord(providerMember.definition) ||
          !isRecord(providerMember.definition.targetExports) ||
          !Object.hasOwn(providerMember.definition.targetExports, ".")
        ) {
          continue;
        }
        add(consumer.packageDefinitionId, providerId);
      }
    }

    const creationInput = consumer.creationInput;
    if (isRecord(creationInput)) {
      const linkToNodeIdentity = creationInput.linkToNodeIdentity;
      if (linkToNodeIdentity !== undefined) {
        if (
          typeof linkToNodeIdentity !== "string" ||
          linkToNodeIdentity.length === 0
        ) {
          throw new Error("包连接请求需要非空节点身份");
        }
        const candidates = packagesByNodeIdentity.get(linkToNodeIdentity);
        if (candidates === undefined || candidates.size === 0) {
          throw new Error(`包连接节点身份不存在：${linkToNodeIdentity}`);
        }
        if (candidates.size > 1) {
          throw new Error(`包连接节点身份不唯一：${linkToNodeIdentity}`);
        }
        const providerId = candidates.values().next().value as
          | PackageDefinitionId
          | undefined;
        if (providerId === undefined || !packagesById.has(providerId)) {
          throw new Error(`包连接节点身份没有当前实例：${linkToNodeIdentity}`);
        }
        if (providerId === consumer.packageDefinitionId) {
          throw new Error("包连接请求不能连接自身");
        }
        add(consumer.packageDefinitionId, providerId);
      }
    }
    if (!isRecord(creationInput) || creationInput.linkFrom === undefined) {
      continue;
    }
    if (
      !Array.isArray(creationInput.linkFrom) ||
      creationInput.linkFrom.some(
        (packagePath) => typeof packagePath !== "string",
      )
    ) {
      throw new Error(
        `包连接请求必须是路径字符串列表：${contentIdentityLabel(consumer.contentIdentity)}`,
      );
    }
    for (const packagePath of creationInput.linkFrom as string[]) {
      const linkedConsumer = options.packages.find(
        (item) => item.definition.path === packagePath,
      );
      if (linkedConsumer === undefined) {
        throw new Error(`包连接目标不存在：${packagePath}`);
      }
      add(linkedConsumer.packageDefinitionId, consumer.packageDefinitionId);
    }
  }
  return Object.freeze(links);
}

function packageManifestExports(
  manifest: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return isRecord(manifest.exports) ? manifest.exports : {};
}

function packageRelativeTarget(
  value: unknown,
  extension: RegExp,
): value is string {
  if (typeof value !== "string" || !value.startsWith("./")) return false;
  const segments = value.slice(2).split("/");
  return (
    !value.includes("\\") &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    ) &&
    extension.test(value)
  );
}

function exposesSourceConditions(
  manifest: Readonly<Record<string, unknown>>,
): boolean {
  const rootExport = packageManifestExports(manifest)["."];
  if (
    !isRecord(rootExport) ||
    Object.keys(rootExport).join("\u0000") !== "source\u0000types\u0000default"
  ) {
    return false;
  }
  return (
    packageRelativeTarget(rootExport.source, /(?<!\.d)\.(?:[cm]?ts|tsx)$/u) &&
    packageRelativeTarget(rootExport.types, /\.d\.[cm]?ts$/u) &&
    packageRelativeTarget(rootExport.default, /\.[cm]?js$/u)
  );
}

function exposesPackageRoot(
  manifest: Readonly<Record<string, unknown>>,
): boolean {
  const rootExport = packageManifestExports(manifest)["."];
  if (packageRelativeTarget(rootExport, /\.[cm]?[jt]sx?$/u)) return true;
  return (
    isRecord(rootExport) &&
    packageRelativeTarget(rootExport.default, /\.[cm]?[jt]sx?$/u)
  );
}

function requestsInjectedProvider(
  manifest: Readonly<Record<string, unknown>>,
  providerName: string,
): boolean {
  if (!isRecord(manifest.dependenciesMeta)) return false;
  const metadata = manifest.dependenciesMeta[providerName];
  return isRecord(metadata) && metadata.injected === true;
}

/** 在已计算的贡献中应用新模型的ID连接，并只改完整原生manifest值。 */
function linkedManifestOverrides(options: {
  readonly packages: readonly DefaultEvaluation[];
  readonly intents: readonly PackageLinkIntent[];
  readonly targetManifests: DefaultStableCommon["targetManifests"];
}): ReadonlyMap<PackageDefinitionId, Readonly<Record<string, unknown>>> {
  const byId = new Map(
    options.packages.map((item) => [item.package.packageDefinitionId, item]),
  );
  const overrides = new Map<PackageDefinitionId, Record<string, unknown>>();
  const linkedNames = new Map<string, PackageDefinitionId>();
  const getOverride = (item: DefaultEvaluation): Record<string, unknown> => {
    const existing = overrides.get(item.package.packageDefinitionId);
    if (existing !== undefined) return existing;
    const next = structuredClone(item.contribution.facts.manifest) as Record<
      string,
      unknown
    >;
    overrides.set(item.package.packageDefinitionId, next);
    return next;
  };

  for (const intent of options.intents) {
    const consumer = byId.get(intent.consumerId);
    const provider = byId.get(intent.providerId);
    if (consumer === undefined || provider === undefined) {
      throw new Error("包连接引用了不存在的计算实例");
    }
    const consumerSource = consumer.contribution.facts.manifest;
    const providerSource = provider.contribution.facts.manifest;
    const consumerCurrent =
      options.targetManifests.get(intent.consumerId) ?? consumerSource;
    const providerCurrent =
      options.targetManifests.get(intent.providerId) ?? providerSource;
    for (const [item, manifest] of [
      [consumer, consumerCurrent],
      [provider, providerCurrent],
    ] as const) {
      if (manifest.name !== item.package.definition.name) {
        throw new Error(
          `包连接manifest名称与实例不符：${item.package.definition.path} 应为 ${item.package.definition.name}`,
        );
      }
    }
    const consumerRole = consumer.package.definition.role;
    const providerRole = provider.package.definition.role;
    if (
      !isDefaultPackageRole(consumerRole) ||
      consumerRole === "native-package" ||
      consumerCurrent.type !== "module"
    ) {
      throw new Error(
        `包连接consumer不能使用Node包名导入：${consumer.package.definition.path}`,
      );
    }
    if (
      !isDefaultPackageRole(providerRole) ||
      providerRole === "native-package" ||
      (consumerRole === "shared-library" && providerRole !== "shared-library")
    ) {
      throw new Error(
        `包连接违反默认Package Role边界：${consumer.package.definition.path} (${consumerRole}) -> ${provider.package.definition.path} (${providerRole})`,
      );
    }
    if (!exposesPackageRoot(providerCurrent)) {
      throw new Error(
        `包连接provider没有公开可导入包根：${provider.package.definition.path}`,
      );
    }
    const providerName = provider.package.definition.name;
    const linkKey = `${intent.consumerId}\u0000${providerName}`;
    const previousProvider = linkedNames.get(linkKey);
    if (
      previousProvider !== undefined &&
      previousProvider !== intent.providerId
    ) {
      throw new Error(
        `包连接名称冲突：${consumer.package.definition.path}/${providerName} 同时绑定 ${previousProvider} 与 ${intent.providerId}`,
      );
    }
    linkedNames.set(linkKey, intent.providerId);

    const injected =
      !exposesSourceConditions(providerCurrent) ||
      requestsInjectedProvider(consumerCurrent, providerName);
    const consumerManifest = getOverride(consumer);
    const dependencies = isRecord(consumerManifest.dependencies)
      ? { ...consumerManifest.dependencies }
      : {};
    dependencies[providerName] = "workspace:*";
    consumerManifest.dependencies = dependencies;
    if (injected) {
      const metadata = isRecord(consumerManifest.dependenciesMeta)
        ? { ...consumerManifest.dependenciesMeta }
        : {};
      metadata[providerName] = { injected: true };
      consumerManifest.dependenciesMeta = metadata;

      const providerManifest = getOverride(provider);
      const devDependencies = isRecord(providerManifest.devDependencies)
        ? { ...providerManifest.devDependencies }
        : {};
      const runtimeDependencies = isRecord(providerManifest.dependencies)
        ? { ...providerManifest.dependencies }
        : {};
      for (const [key, dependencyId] of Object.entries(
        provider.package.dependencyBindings,
      )) {
        const binding = provider.contribution.facts.referenceBindings[key];
        if (
          dependencyId === undefined ||
          !isRecord(binding) ||
          typeof binding.name !== "string" ||
          !Object.hasOwn(devDependencies, binding.name)
        ) {
          continue;
        }
        runtimeDependencies[binding.name] = devDependencies[binding.name];
        delete devDependencies[binding.name];
      }
      providerManifest.devDependencies = devDependencies;
      providerManifest.dependencies = runtimeDependencies;
    }
  }
  return overrides;
}

function assertUniqueWorkspaceBinaryNames(options: {
  readonly packages: readonly DefaultEvaluation[];
  readonly manifestOverrides: ReadonlyMap<
    PackageDefinitionId,
    Readonly<Record<string, unknown>>
  >;
}): void {
  const owners = new Map<string, string>();
  for (const { package: item, contribution } of options.packages) {
    const manifest =
      options.manifestOverrides.get(item.packageDefinitionId) ??
      contribution.facts.manifest;
    if (!isRecord(manifest.bin)) continue;
    for (const commandName of Object.keys(manifest.bin)) {
      const previousOwner = owners.get(commandName);
      if (previousOwner !== undefined) {
        throw new Error(
          `CLI命令名称 ${JSON.stringify(commandName)} 重复：${previousOwner} 与 ${item.definition.name}`,
        );
      }
      owners.set(commandName, item.definition.name);
    }
  }
}

function mergeEntries<T>(options: {
  readonly location: string;
  readonly baseSource: string;
  readonly base: Readonly<Record<string, T>>;
  readonly declarations: readonly {
    readonly source: string;
    readonly values: Readonly<Record<string, T>>;
  }[];
}): Record<string, T> {
  const result: Record<string, T> = { ...options.base };
  const owners = new Map(
    Object.keys(options.base).map((key) => [key, options.baseSource]),
  );
  for (const declaration of options.declarations) {
    for (const [key, value] of Object.entries(declaration.values)) {
      const owner = owners.get(key);
      if (owner !== undefined && !isDeepStrictEqual(result[key], value)) {
        throw new Error(
          `共享根声明冲突：${options.location}/${key}；来源 ${owner} 与 ${declaration.source}`,
        );
      }
      if (owner === undefined) {
        result[key] = value;
        owners.set(key, declaration.source);
      }
    }
  }
  return result;
}

function packageGlobs(blueprint: ProjectBlueprint): readonly string[] {
  const globs = new Set(["apps/*", "packages/*"]);
  for (const definition of blueprint.packages) {
    if (definition.path === ".") continue;
    const firstSegment = definition.path.split("/", 1)[0]!;
    globs.add(`${firstSegment}/*`);
  }
  return [...globs];
}

function packageRoles(blueprint: ProjectBlueprint): readonly string[] {
  return [...new Set(blueprint.packages.map(({ role }) => role))];
}

function boundariesFor(blueprint: ProjectBlueprint) {
  const roles = packageRoles(blueprint);
  const tags: Record<string, unknown> = {};
  if (roles.some((role) => role === "cli-tool" || role === "runtime-service")) {
    tags.app = { dependencies: { allow: ["app", "library"] } };
  }
  if (
    roles.some(
      (role) =>
        role === "shared-library" ||
        role === "native-package" ||
        role === "cli-tool" ||
        role === "runtime-service",
    )
  ) {
    tags.library = { dependencies: { allow: ["library"] } };
  }
  return { tags };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function rootFile(options: {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode?: number;
  readonly reconciliation?: CompositionReconciliation["reconciliation"];
  readonly packageDefinitionId: PackageDefinitionId;
}): {
  readonly file: CompositionFile;
  readonly reconciliation: CompositionReconciliation;
} {
  const reconciliation = options.reconciliation ?? {
    path: options.path,
    driver: "text" as const,
  };
  return {
    file: {
      packageDefinitionId: options.packageDefinitionId,
      file: {
        path: options.path,
        content: options.content,
        mode: options.mode ?? 0,
      },
    },
    reconciliation: {
      packageDefinitionId: options.packageDefinitionId,
      reconciliation,
    },
  };
}

function filePath(value: string): string {
  const normalized = value;
  if (
    normalized.length === 0 ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`默认组合根资源路径无效：${value}`);
  }
  return normalized;
}

function compositionFilesForRoot(options: {
  readonly rootId: PackageDefinitionId;
  readonly declarations: readonly DefaultRootDeclaration[];
  readonly contributionFiles: readonly {
    readonly identity: ContentIdentity;
    readonly file: DefaultCompositionFile;
  }[];
}) {
  const owners = new Map<string, string>();
  const files: CompositionFile[] = [];
  const reconciliation: CompositionReconciliation[] = [];
  const add = (
    file: DefaultCompositionFile,
    identity: ContentIdentity,
  ): void => {
    const target = filePath(file.path);
    const source = sourceLabel(identity);
    const owner = owners.get(target);
    if (owner !== undefined) {
      throw new Error(
        `默认组合根资源冲突：${target}；来源 ${owner} 与 ${source}`,
      );
    }
    owners.set(target, source);
    files.push({
      packageDefinitionId: options.rootId,
      file: {
        path: target,
        content: file.content,
        mode: file.mode,
      },
    });
    reconciliation.push({
      packageDefinitionId: options.rootId,
      reconciliation: {
        path: target,
        driver: /\.(?:json|jsonc)$/u.test(target) ? "structured" : "text",
      },
    });
  };
  for (const item of options.contributionFiles) add(item.file, item.identity);
  for (const declaration of options.declarations) {
    for (const file of declaration.files ?? []) {
      add(file, declaration.sourceIdentity);
    }
  }
  return { files, reconciliation, owners };
}

function manifestContributions(
  declarations: readonly DefaultRootDeclaration[],
  field: "scripts" | "imports" | "devDependencies",
): readonly {
  readonly source: string;
  readonly values: Readonly<Record<string, string>>;
}[] {
  return declarations.flatMap((declaration) => {
    const values = declaration.manifest?.[field];
    return values === undefined
      ? []
      : [{ source: sourceLabel(declaration.sourceIdentity), values }];
  });
}

function nativeDocumentsForPackage(options: {
  readonly contribution: DefaultContribution;
  readonly identity: ContentIdentity;
  readonly packageDefinitionId: PackageDefinitionId;
}): readonly {
  readonly document: DefaultNativeDocument;
  readonly identity: ContentIdentity;
  readonly packageDefinitionId: PackageDefinitionId;
}[] {
  return options.contribution.nativeDocuments.map((document) => ({
    document,
    identity: options.identity,
    packageDefinitionId: options.packageDefinitionId,
  }));
}

function renderNativeDocument(document: DefaultNativeDocument): Uint8Array {
  return serializeNativeReferenceDocument(document);
}

function ownerDependencies(facts: readonly DefaultContribution[]) {
  const policies = facts.flatMap((fact) => {
    const dependencyMaintenance = fact.foundation.dependencyMaintenance;
    return isRecord(dependencyMaintenance)
      ? [
          {
            foundation: {
              dependencyMaintenance:
                dependencyMaintenance as DependencyMaintenancePolicy,
            },
          },
        ]
      : [];
  });
  return projectDependencyMaintenancePolicy({
    contributions: policies,
    rootContributions: [],
  });
}

type DefaultComposer = Composition<
  DefaultWorkspaceConventions,
  DefaultStableCommon,
  DefaultPackageInput,
  DefaultContribution,
  DefaultCompositionOwnerFacts,
  JsonValue,
  DefaultOperationFacts
>;

/** 默认共同组合只消费显式实例、已经求得的原生贡献和本次准备快照。 */
export function createDefaultComposition(options: {
  readonly rootIdentity: ContentIdentity;
  readonly content: readonly DefaultContentMember[];
  readonly catalog?: Readonly<Record<string, string>>;
  readonly installPolicy?: Readonly<Record<string, unknown>>;
}): DefaultComposer {
  const rootKey = contentIdentityKey(options.rootIdentity);
  const catalog = options.catalog ?? dependencyCatalogSnapshot;
  const installPolicy = options.installPolicy ?? workspaceInstallPolicySnapshot;

  const composition: DefaultComposer = {
    identity: Object.freeze({
      ...options.rootIdentity,
      exportPath: "./default-composition",
    }),
    parseConventions(value) {
      return parseConventions(value);
    },
    resolve(resolveOptions) {
      validateDefaultFacts(resolveOptions.operationFacts);
      assertDefaultProjectBlueprint(resolveOptions.blueprint);
      const roots = resolveOptions.packages.filter(
        (item) => contentIdentityKey(item.contentIdentity) === rootKey,
      );
      if (roots.length !== 1 || roots[0]?.definition.path !== ".") {
        throw new Error("默认组合必须包含唯一的原生基础根实例");
      }
      if (
        resolveOptions.blueprint.packages.filter(
          ({ path: packagePath }) => packagePath === ".",
        ).length !== 1
      ) {
        throw new Error("默认组合只能有一个根包");
      }
      return {
        stableCommon: Object.freeze({
          nodeDeclaration: resolveOptions.operationFacts.nodeDeclaration,
          packageManagerPin: resolveOptions.operationFacts.packageManagerPin,
          resources: resolveOptions.operationFacts.resources,
          rootDeclarations: resolveOptions.operationFacts.rootDeclarations,
          targetManifests: resolveOptions.operationFacts.targetManifests,
        }),
        packageInputs: new Map(),
        packageLinkIntents: packageLinks({
          packages: resolveOptions.packages,
          content: options.content,
          selections: resolveOptions.selections,
        }),
      };
    },
    combine(combineOptions) {
      const rootPackages = combineOptions.packages.filter(
        ({ package: item }) =>
          contentIdentityKey(item.contentIdentity) === rootKey,
      );
      if (rootPackages.length !== 1) {
        throw new Error("默认组合只能合成一个基础根贡献");
      }
      const rootPackage = rootPackages[0]!;
      if (rootPackage.package.definition.path !== ".") {
        throw new Error("基础根内容必须拥有目标目录 .");
      }
      const allFacts = combineOptions.packages.map(
        ({ contribution }) => contribution.facts,
      );
      const manifestOverrides = linkedManifestOverrides({
        packages: combineOptions.packages,
        intents: combineOptions.blueprint.packageLinkIntents,
        targetManifests: combineOptions.stableCommon.targetManifests,
      });
      assertUniqueWorkspaceBinaryNames({
        packages: combineOptions.packages,
        manifestOverrides,
      });
      const requiredTemplateDependencies = new Set(
        allFacts.flatMap((facts) =>
          facts.templateDependencies
            .filter(({ purpose }) => purpose === "template-execution")
            .map(({ name }) => name),
        ),
      );
      const declarations: DefaultRootDeclaration[] = [
        ...combineOptions.packages.flatMap(({ package: item, contribution }) =>
          contribution.facts.rootDeclaration === undefined
            ? []
            : [
                {
                  ...contribution.facts.rootDeclaration,
                  sourceIdentity: item.contentIdentity,
                },
              ],
        ),
        ...combineOptions.stableCommon.rootDeclarations.filter(
          (declaration) =>
            declaration.requiredTemplateDependency === undefined ||
            requiredTemplateDependencies.has(
              declaration.requiredTemplateDependency,
            ),
        ),
      ];
      const rootIdentity = rootPackage.package.contentIdentity;
      const rootSource = sourceLabel(rootIdentity);
      const documents = combineOptions.packages.flatMap(
        ({ package: item, contribution }) =>
          nativeDocumentsForPackage({
            contribution: contribution.facts,
            identity: item.contentIdentity,
            packageDefinitionId: item.packageDefinitionId,
          }),
      );
      const rootManifestFact = documents.find(
        ({ identity, document }) =>
          contentIdentityKey(identity) === rootKey &&
          document.path === "package.json" &&
          document.scope === "package",
      );
      const rootTurboFact = documents.find(
        ({ identity, document }) =>
          contentIdentityKey(identity) === rootKey &&
          document.path === "turbo.json" &&
          document.scope === "package",
      );
      if (rootManifestFact === undefined || rootTurboFact === undefined) {
        throw new Error("基础根原生贡献必须包含package.json与turbo.json");
      }
      const manifest = structuredClone(
        rootManifestFact.document.value,
      ) as Record<string, unknown>;
      for (const field of ["scripts", "imports", "devDependencies"] as const) {
        const base = isRecord(manifest[field])
          ? (manifest[field] as Readonly<Record<string, string>>)
          : {};
        const merged = mergeEntries({
          location: `package.json#/${field}`,
          baseSource: rootSource,
          base,
          declarations: manifestContributions(declarations, field),
        });
        if (Object.keys(merged).length > 0) manifest[field] = merged;
      }
      const rootTurbo = structuredClone(rootTurboFact.document.value) as Record<
        string,
        unknown
      >;
      const baseTasks = isRecord(rootTurbo.tasks)
        ? (rootTurbo.tasks as Readonly<Record<string, unknown>>)
        : {};
      const tasks = mergeEntries({
        location: "turbo.json#/tasks",
        baseSource: rootSource,
        base: baseTasks,
        declarations: declarations.flatMap((declaration) =>
          declaration.turboTasks === undefined
            ? []
            : [
                {
                  source: sourceLabel(declaration.sourceIdentity),
                  values: declaration.turboTasks,
                },
              ],
        ),
      });
      const toolingConfigurations = combineOptions.packages.filter(
        ({ contribution }) =>
          contribution.facts.workspaceConfiguration?.kind ===
          "typescript-workspace-configuration",
      );
      const packageGlobalDependencies = toolingConfigurations.flatMap(
        ({ package: item }) =>
          ["oxfmt.config.ts", "oxlint.config.ts"].map((file) =>
            item.definition.path === "."
              ? file
              : `${item.definition.path}/${file}`,
          ),
      );
      const globalDependencies = [
        ...new Set([
          ...(Array.isArray(rootTurbo.globalDependencies)
            ? rootTurbo.globalDependencies.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : []),
          ...packageGlobalDependencies,
        ]),
      ];
      const turbo = {
        ...rootTurbo,
        boundaries: boundariesFor(combineOptions.blueprint),
        globalDependencies,
        tasks,
      };

      const generatedManifests = combineOptions.packages.map(
        ({ package: item, contribution }) =>
          manifestOverrides.get(item.packageDefinitionId) ??
          contribution.facts.manifest,
      );
      generatedManifests[
        generatedManifests.indexOf(rootPackage.contribution.facts.manifest)
      ] = manifest;
      const dependencyCatalog = selectTemplateDependencyCatalogEntries(
        collectGeneratedManifestCatalogReferences(generatedManifests),
        catalog as Record<string, string>,
      );
      const packagePaths = combineOptions.blueprint.packages
        .filter(({ path: packagePath }) => packagePath !== ".")
        .map(({ path: packagePath }) => packagePath);
      const packages = packageGlobs(combineOptions.blueprint);
      const overrides =
        Object.hasOwn(dependencyCatalog, "vue") ||
        Object.hasOwn(dependencyCatalog, "pinia")
          ? vuePnpmDependencyOverrides
          : {};
      const installConfiguration = { ...installPolicy } as Record<
        string,
        unknown
      >;
      delete installConfiguration.minimumReleaseAgeExclude;
      const workspace = stringifyYaml({
        ...installConfiguration,
        packages,
        catalog: dependencyCatalog,
        overrides,
      });

      const baseDeclarations = declarations
        .map((declaration) => declaration.gitignoreFragments ?? [])
        .flat();
      const nativeGitignore =
        rootPackage.contribution.facts.nativeDocuments.find(
          ({ path: documentPath }) => documentPath === ".gitignore",
        );
      if (nativeGitignore !== undefined) {
        throw new Error("基础根.gitignore必须由外层环境拥有者提供");
      }
      const files = compositionFilesForRoot({
        rootId: rootPackage.package.packageDefinitionId,
        declarations,
        contributionFiles: combineOptions.packages.flatMap(
          ({ package: item, contribution }) =>
            contribution.facts.compositionFiles.map((file) => ({
              identity: item.contentIdentity,
              file,
            })),
        ),
      });
      const rootResources: DefaultCompositionFile[] = [
        ...combineOptions.stableCommon.resources.rootFiles.map((resource) => ({
          path: resource.path,
          content: resource.content,
          mode: resource.mode,
          sourcePath: resource.path,
        })),
      ];
      const ownerPackagePaths = packagePaths;
      const editor = projectBuiltInEditorCustomization(
        allFacts.flatMap((facts) => {
          const capabilities = facts.foundation.editorCapabilities;
          return Array.isArray(capabilities)
            ? (capabilities.filter(
                (value): value is EditorCustomizationCapability =>
                  typeof value === "string",
              ) as EditorCustomizationCapability[])
            : [];
        }),
        combineOptions.stableCommon.resources.editor,
      );
      const developmentContainer = projectBuiltInDevelopmentContainer({
        nodeVersion: combineOptions.stableCommon.nodeDeclaration,
        resources: combineOptions.stableCommon.resources.developmentContainer,
      });
      const dependencyMaintenance = ownerDependencies(allFacts);
      const checkWorkflow = composeCheckWorkflow(
        projectCheckWorkflow(
          {
            packagePaths: ownerPackagePaths,
            diagnosticArtifacts: allFacts.flatMap(
              (facts) => facts.ciDiagnosticArtifacts,
            ),
          },
          combineOptions.stableCommon.resources.github.checkWorkflow,
        ),
        sourceLabel(
          combineOptions.stableCommon.rootDeclarations[0]?.sourceIdentity ??
            rootIdentity,
        ),
        [],
      );
      const dependabot = projectDependabotConfig(
        dependencyMaintenance,
        combineOptions.stableCommon.resources.github.dependabot,
      );
      const baseRootFiles = [...rootResources];
      baseRootFiles.push(
        {
          path: ".github/workflows/check.yml",
          content: new TextEncoder().encode(checkWorkflow),
          mode: 0,
          sourcePath: "github/check.yml",
        },
        {
          path: ".github/dependabot.yml",
          content: new TextEncoder().encode(dependabot),
          mode: 0,
          sourcePath: "github/dependabot.yml",
        },
        {
          path: ".vscode/extensions.json",
          content: json({ recommendations: editor.extensions }),
          mode: 0,
          sourcePath: "editor/extensions.json",
        },
        {
          path: ".vscode/settings.json",
          content: json(editor.settings),
          mode: 0,
          sourcePath: "editor/settings.json",
        },
        {
          path: ".devcontainer/devcontainer.json",
          content: json({
            ...developmentContainer.configuration,
            name: combineOptions.conventions.repositoryName,
          }),
          mode: 0,
          sourcePath: "devcontainer/workspace-template.json",
        },
      );
      const dockerfile = developmentContainer.dockerfileOperation;
      if (dockerfile.kind === "writeText") {
        baseRootFiles.push({
          path: dockerfile.to,
          content: new TextEncoder().encode(dockerfile.text),
          mode: dockerfile.mode ?? 0,
          sourcePath: "devcontainer/Dockerfile",
        });
      }
      if (combineOptions.conventions.todo === true) {
        baseRootFiles.push({
          path: "TODO.md",
          content: new TextEncoder().encode(
            projectNextStepsDocument(
              combineOptions.stableCommon.resources.nextSteps,
              combineOptions.stableCommon.resources.github.nextSteps,
            ),
          ),
          mode: 0,
          sourcePath: "github/next-steps.md",
        });
      }
      const allRootFiles = baseRootFiles;
      const seenRootPaths = new Map<string, string>();
      const rootFiles = allRootFiles.map((file) => {
        const previous = seenRootPaths.get(file.path);
        if (previous !== undefined) {
          throw new Error(
            `默认组合根资源冲突：${file.path}；来源 ${previous} 与 ${file.sourcePath}`,
          );
        }
        seenRootPaths.set(file.path, file.sourcePath);
        return rootFile({
          path: file.path,
          content: file.content,
          mode: file.mode,
          packageDefinitionId: rootPackage.package.packageDefinitionId,
        });
      });

      const processedDocuments: CompositionFile[] = [];
      const nativeDocumentFacts: DefaultCompositionOwnerFacts["nativeDocuments"][number][] =
        [];
      for (const item of documents) {
        nativeDocumentFacts.push({
          identity: item.identity,
          packageDefinitionId: item.packageDefinitionId,
          path: item.document.path,
          sourcePath: item.document.sourcePath,
        });
        if (item.document.scope === "composition") continue;
        const isRootDocument =
          contentIdentityKey(item.identity) === rootKey &&
          item.document.path === "package.json";
        const isRootTurbo =
          contentIdentityKey(item.identity) === rootKey &&
          item.document.path === "turbo.json";
        const linkedManifest =
          item.document.path === "package.json"
            ? manifestOverrides.get(item.packageDefinitionId)
            : undefined;
        const document = isRootDocument
          ? { ...item.document, value: manifest }
          : isRootTurbo
            ? { ...item.document, value: turbo }
            : linkedManifest === undefined
              ? item.document
              : { ...item.document, value: linkedManifest };
        processedDocuments.push({
          packageDefinitionId: item.packageDefinitionId,
          file: {
            path: document.path,
            content: renderNativeDocument(document),
            mode: document.mode,
          },
        });
      }

      const workspaceFile = rootFile({
        path: "pnpm-workspace.yaml",
        content: new TextEncoder().encode(workspace),
        packageDefinitionId: rootPackage.package.packageDefinitionId,
        reconciliation: {
          path: "pnpm-workspace.yaml",
          driver: "text",
        },
      });
      const sharedRootFiles = rootFiles.map(({ file }) => file);
      const rootFileComposition = [
        ...sharedRootFiles,
        ...files.files,
        ...processedDocuments.filter(
          ({ packageDefinitionId }) =>
            packageDefinitionId === rootPackage.package.packageDefinitionId,
        ),
        workspaceFile.file,
      ];
      const rootReconciliation = [
        ...rootFiles.flatMap(({ reconciliation }) =>
          reconciliation === undefined ? [] : [reconciliation],
        ),
        ...files.reconciliation,
        ...(workspaceFile.reconciliation === undefined
          ? []
          : [workspaceFile.reconciliation]),
      ];
      const nonRootDocuments = processedDocuments.filter(
        ({ packageDefinitionId }) =>
          packageDefinitionId !== rootPackage.package.packageDefinitionId,
      );
      const gitignore = baseRootFiles.find(({ path }) => path === ".gitignore");
      if (gitignore !== undefined && baseDeclarations.length > 0) {
        const fragment = baseDeclarations.join("\n");
        const previous = new TextDecoder().decode(gitignore.content);
        const updated = `${previous.trimEnd()}\n${fragment}\n`;
        const target = rootFileComposition.findIndex(
          (item) => item.file.path === ".gitignore",
        );
        if (target !== -1) {
          rootFileComposition[target] = {
            ...rootFileComposition[target]!,
            file: {
              ...rootFileComposition[target]!.file,
              content: new TextEncoder().encode(updated),
            },
          };
        }
      }

      const checkNeeds: CheckEnvironmentNeed[] = [];
      const deploymentNeeds: DeploymentEnvironmentNeed[] = [];
      for (const need of allFacts.flatMap((facts) => facts.environmentNeeds)) {
        if (need.kind === "docker-engine") deploymentNeeds.push(need);
        else checkNeeds.push(need);
      }
      const environmentNeeds = normalizeEnvironmentNeeds({
        check: checkNeeds,
        deployment: deploymentNeeds,
      });
      const ciDiagnosticArtifacts = allFacts.flatMap(
        (facts) => facts.ciDiagnosticArtifacts,
      );

      return {
        files: [...rootFileComposition, ...nonRootDocuments],
        reconciliation: rootReconciliation,
        facts: {
          rootPackageDefinitionId: rootPackage.package.packageDefinitionId,
          packagePaths,
          nativeDocuments: nativeDocumentFacts,
          dependencyCatalog,
          environmentNeeds,
          ciDiagnosticArtifacts,
        },
      };
    },
  };
  return composition;
}

export type { DefaultContentMember };
