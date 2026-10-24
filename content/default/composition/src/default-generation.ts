import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import type { DefaultPresetRootContributionOwner } from "@ykdz/default-content-authoring/preset-root-contribution";
import { workspaceRootIdentity } from "@ykdz/reference-workspace-root/template";
import type { CompositionPackage } from "@ykdz/template-core/composition";
import {
  contentIdentityKey,
  contentIdentityLabel,
  createContentIndex,
  type ContentIdentity,
  type ContentSelector,
} from "@ykdz/template-core/content-identity";
import type { GenerationRecordSelection } from "@ykdz/template-core/generation-record";
import type { JsonValue } from "@ykdz/template-core/json";
import { ProjectBlueprintValidationError } from "@ykdz/template-core/project-blueprint";
import type { CurrentProjectProjectionEntry } from "@ykdz/template-core/project-projection";
import type {
  GeneratorAdditionSelection,
  GeneratorRestoredProject,
} from "@ykdz/template-generator";
import { createGenerator } from "@ykdz/template-generator";

import {
  createDefaultComposition,
  prepareDefaultInitOperationFacts,
  prepareDefaultRootAttachmentDependencies,
  prepareDefaultRootDeclarations,
  type PreparedDefaultPresetRootContribution,
  type DefaultContentMember,
  type DefaultOperationFacts,
} from "./default-composition.ts";
import {
  PackageLinkValidationError,
  RootToolchainDeclarationError,
  type PackageLinkValidationIssue,
  type RootToolchainDeclarationIssue,
} from "./project-requirements.ts";
import { prepareRootRustToolchainTarget } from "./rust-toolchain-facts.ts";

const nodeDeclarationPattern = /^([0-9]+)(?:\.([0-9]+)\.([0-9]+))?$/u;
const pnpmPinPattern = /^pnpm@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PreparedContentNode = {
  readonly content: { readonly identity: ContentIdentity };
  readonly dependencies: readonly {
    readonly package: PreparedContentNode;
  }[];
};

/** 只遍历正式准备后的图，不在外围重新解释 direct 或 preset 输入。 */
function preparedSelectionsContainOwner(
  selections: readonly {
    readonly roots: readonly PreparedContentNode[];
  }[],
  ownerIdentities: ReadonlySet<string>,
): boolean {
  const containsOwner = (node: PreparedContentNode): boolean =>
    ownerIdentities.has(contentIdentityKey(node.content.identity)) ||
    node.dependencies.some(({ package: dependency }) =>
      containsOwner(dependency),
    );
  return selections.some((selection) => selection.roots.some(containsOwner));
}

async function initOperationFacts(
  content: readonly DefaultContentMember[],
  selectedPresets: readonly ContentSelector[] = [],
  ownerPrepareContext?: {
    readonly repositoryRoot?: string;
    readonly selections?: readonly GenerationRecordSelection[];
    readonly packages?: readonly CompositionPackage[];
  },
): Promise<DefaultOperationFacts> {
  const contentIndex = createContentIndex(content);
  const presetRootContributions: PreparedDefaultPresetRootContribution[] = [];
  const presetRootContributionReadFacts: CurrentProjectProjectionEntry[] = [];
  const preparedIdentities = new Set<string>();
  for (const selector of selectedPresets) {
    const member = contentIndex.resolve(selector, "preset");
    const identity = contentIdentityKey(member.identity);
    if (preparedIdentities.has(identity)) continue;
    const definition = member.definition;
    if (!isRecord(definition) || !isRecord(definition.rootContribution)) {
      continue;
    }
    const contribution = definition.rootContribution;
    if (
      typeof contribution.prepare !== "function" ||
      typeof contribution.compose !== "function"
    ) {
      continue;
    }
    const owner = contribution as unknown as DefaultPresetRootContributionOwner;
    const selection = ownerPrepareContext?.selections?.find(
      (candidate) =>
        candidate.presetIdentity !== null &&
        contentIdentityKey(candidate.presetIdentity) === identity,
    );
    let selectedPackages: Map<string, CompositionPackage> | undefined;
    if (
      selection !== undefined &&
      ownerPrepareContext?.packages !== undefined
    ) {
      const packagesById = new Map(
        ownerPrepareContext.packages.map((item) => [
          item.packageDefinitionId,
          item,
        ]),
      );
      selectedPackages = new Map();
      for (const [nodeIdentity, packageDefinitionId] of Object.entries(
        selection.nodes,
      )) {
        const selectedPackage = packagesById.get(packageDefinitionId);
        if (selectedPackage === undefined) {
          throw new Error(
            `预设prepare缺少持久节点实例：${contentIdentityLabel(member.identity)}/${nodeIdentity}`,
          );
        }
        selectedPackages.set(nodeIdentity, selectedPackage);
      }
    }
    const prepared = await owner.prepare({
      ownerIdentity: member.identity,
      ...(ownerPrepareContext?.repositoryRoot === undefined
        ? {}
        : { repositoryRoot: ownerPrepareContext.repositoryRoot }),
      ...(selection === undefined ? {} : { selection }),
      ...(selectedPackages === undefined ? {} : { selectedPackages }),
    });
    if (
      !isRecord(prepared) ||
      !Object.hasOwn(prepared, "ownerFacts") ||
      (prepared.readFacts !== undefined && !Array.isArray(prepared.readFacts))
    ) {
      throw new Error(
        `预设根贡献prepare结果无效：${member.identity.packageName}`,
      );
    }
    presetRootContributions.push(
      Object.freeze({
        ownerIdentity: member.identity,
        ownerFacts: prepared.ownerFacts,
      }),
    );
    presetRootContributionReadFacts.push(...(prepared.readFacts ?? []));
    preparedIdentities.add(identity);
  }
  return prepareDefaultInitOperationFacts({
    rootDeclarations: await prepareDefaultRootDeclarations(content),
    rootAttachmentDependencies:
      prepareDefaultRootAttachmentDependencies(content),
    presetRootContributions,
    presetRootContributionReadFacts,
  });
}

async function additionFacts(
  repositoryRoot: string,
  content: readonly DefaultContentMember[],
  options: {
    readonly restored: GeneratorRestoredProject<JsonValue>;
    readonly selection: GeneratorAdditionSelection<JsonValue>;
  },
): Promise<{
  readonly operationFacts: DefaultOperationFacts;
  readonly readFacts: readonly CurrentProjectProjectionEntry[];
  readonly readPreparedLinkFacts: (
    creationInputs: readonly unknown[],
  ) => Promise<{
    readonly targetManifests: DefaultOperationFacts["targetManifests"];
    readonly readFacts: readonly CurrentProjectProjectionEntry[];
  }>;
}> {
  const targetManifests = new Map<
    GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"],
    Readonly<Record<string, unknown>>
  >();
  const readTargetManifest = async (packagePath: string) => {
    const manifestPath = path.join(repositoryRoot, packagePath, "package.json");
    const stat = await lstat(manifestPath);
    if (!stat.isFile()) {
      throw new Error(
        `加包需要参与验证的当前包package.json是普通文件：${packagePath}`,
      );
    }
    const bytes = new Uint8Array(await readFile(manifestPath));
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      throw new Error(`加包需要有效JSON：${packagePath}/package.json`, {
        cause: error,
      });
    }
    if (!isRecord(value)) {
      throw new Error(`包manifest必须是对象：${packagePath}/package.json`);
    }
    return {
      value,
      fact: {
        path: path.posix.join(
          packagePath === "." ? "" : packagePath,
          "package.json",
        ),
        kind: "file" as const,
        content: bytes,
        mode: stat.mode & 0o111,
      } satisfies CurrentProjectProjectionEntry,
    };
  };
  const rootManifestFact = await readTargetManifest(".");
  const manifest = rootManifestFact.value;
  const rootPackage = options.restored.blueprint.packages.find(
    ({ path: packagePath }) => packagePath === ".",
  );
  if (rootPackage === undefined) {
    throw new Error("加包恢复记录缺少基础根实例");
  }
  targetManifests.set(rootPackage.packageDefinitionId, manifest);
  const currentFacts: CurrentProjectProjectionEntry[] = [rootManifestFact.fact];
  const currentFactPaths = new Set([rootManifestFact.fact.path]);
  const currentById = new Map(
    options.restored.blueprint.packages.map((pkg) => [
      pkg.packageDefinitionId,
      pkg,
    ]),
  );
  const restoredById = new Map(
    options.restored.packages.map((pkg) => [pkg.packageDefinitionId, pkg]),
  );
  const contentByIdentity = new Map(
    content
      .filter((member) => member.kind === "reference")
      .map((member) => [contentIdentityKey(member.identity), member]),
  );
  const addCurrentFact = (fact: CurrentProjectProjectionEntry): void => {
    if (currentFactPaths.has(fact.path)) return;
    currentFacts.push(fact);
    currentFactPaths.add(fact.path);
  };
  const readPackageManifest = async (
    packageId: GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"],
  ): Promise<Readonly<Record<string, unknown>>> => {
    const existing = targetManifests.get(packageId);
    if (existing !== undefined) return existing;
    const currentPackage = currentById.get(packageId);
    if (currentPackage === undefined) {
      throw new Error(`包连接引用了未知当前实例：${packageId}`);
    }
    const current = await readTargetManifest(currentPackage.path);
    targetManifests.set(packageId, current.value);
    addCurrentFact(current.fact);
    return current.value;
  };
  const readPackageExportTarget = async (
    packagePath: string,
    targetValue: string,
  ): Promise<void> => {
    if (
      !targetValue.startsWith("./") ||
      targetValue.includes("\\") ||
      targetValue
        .slice(2)
        .split("/")
        .some(
          (segment) =>
            segment.length === 0 || segment === "." || segment === "..",
        )
    ) {
      throw new Error(
        `复用包 ${packagePath} 的公开入口路径无效：${targetValue}`,
      );
    }
    const target = path.posix.join(
      packagePath === "." ? "" : packagePath,
      targetValue.slice(2),
    );
    if (currentFactPaths.has(target)) return;
    const targetAbsolutePath = path.join(repositoryRoot, ...target.split("/"));
    const targetStat = await lstat(targetAbsolutePath);
    if (!targetStat.isFile()) {
      throw new Error(
        `复用包 ${packagePath} 的公开文件不可读取：${targetValue}`,
      );
    }
    const targetBytes = new Uint8Array(await readFile(targetAbsolutePath));
    addCurrentFact({
      path: target,
      kind: "file",
      content: targetBytes,
      mode: targetStat.mode & 0o111,
    });
  };
  const packageExportSourceTargetValues = (
    value: unknown,
  ): readonly string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) {
      return value.flatMap(packageExportSourceTargetValues);
    }
    if (isRecord(value)) {
      const sourceTarget =
        typeof value.source === "string" ? [value.source] : [];
      return [
        ...sourceTarget,
        ...Object.entries(value)
          .filter(
            ([key]) => key !== "source" && key !== "types" && key !== "default",
          )
          .flatMap(([, nested]) => packageExportSourceTargetValues(nested)),
      ];
    }
    return [];
  };

  const linkedPackageIds = new Set<
    GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"]
  >();
  const linkedProviderIds = new Set(linkedPackageIds);
  for (const intent of options.restored.blueprint.packageLinkIntents) {
    linkedPackageIds.add(intent.consumerId);
    linkedPackageIds.add(intent.providerId);
    linkedProviderIds.add(intent.providerId);
  }
  const selectionRecord: unknown = options.selection;
  const requestedBindings = isRecord(selectionRecord)
    ? selectionRecord.dependencyBindings
    : undefined;
  if (isRecord(requestedBindings)) {
    for (const binding of Object.values(requestedBindings)) {
      if (
        !isRecord(binding) ||
        typeof binding.packageDefinitionId !== "string"
      ) {
        continue;
      }
      const providerId =
        binding.packageDefinitionId as GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"];
      if (!currentById.has(providerId)) {
        throw new Error(`依赖绑定实例ID不存在：${binding.packageDefinitionId}`);
      }
      linkedPackageIds.add(providerId);
      linkedProviderIds.add(providerId);
    }
  }
  for (const packageId of linkedPackageIds) {
    await readPackageManifest(packageId);
  }
  for (const currentPackage of options.restored.blueprint.packages) {
    const restoredPackage = restoredById.get(
      currentPackage.packageDefinitionId,
    );
    const member =
      restoredPackage === undefined
        ? undefined
        : contentByIdentity.get(
            contentIdentityKey(restoredPackage.contentIdentity),
          );
    const nativeManifest =
      member !== undefined && isRecord(member.definition)
        ? member.definition.manifest
        : undefined;
    const declaresNativeBinary =
      isRecord(nativeManifest) && isRecord(nativeManifest.bin);
    if (currentPackage.role !== "cli-tool" && !declaresNativeBinary) continue;
    await readPackageManifest(currentPackage.packageDefinitionId);
  }
  for (const packageId of linkedProviderIds) {
    const provider = currentById.get(packageId);
    const providerManifest = await readPackageManifest(packageId);
    const exports = isRecord(providerManifest.exports)
      ? providerManifest.exports
      : {};
    const rootExport = exports["."];
    for (const target of packageExportSourceTargetValues(rootExport)) {
      await readPackageExportTarget(provider?.path ?? ".", target);
    }
  }

  const linkFromPaths: string[] = [];
  const addLinkFrom = (value: unknown): void => {
    if (value === undefined) return;
    if (
      !Array.isArray(value) ||
      value.some((packagePath) => typeof packagePath !== "string")
    ) {
      throw new Error("加包linkFrom必须是当前包路径字符串列表");
    }
    linkFromPaths.push(...(value as string[]));
  };
  addLinkFrom(
    isRecord(options.selection.creationInput)
      ? options.selection.creationInput.linkFrom
      : undefined,
  );
  for (const pkg of options.restored.packages) {
    addLinkFrom(
      isRecord(pkg.creationInput) ? pkg.creationInput.linkFrom : undefined,
    );
  }
  for (const packagePath of new Set(linkFromPaths)) {
    const consumer = options.restored.blueprint.packages.find(
      ({ path: currentPath }) => currentPath === packagePath,
    );
    if (consumer === undefined) {
      throw new PackageLinkValidationError(
        { kind: "unknown-consumer", path: packagePath },
        `加包linkFrom指向未知当前包：${packagePath}`,
      );
    }
    if (
      packagePath === "." ||
      targetManifests.has(consumer.packageDefinitionId)
    ) {
      continue;
    }
    const current = await readTargetManifest(packagePath);
    targetManifests.set(consumer.packageDefinitionId, current.value);
    addCurrentFact(current.fact);
  }

  for (const consumer of options.restored.packages) {
    const member = contentByIdentity.get(
      contentIdentityKey(consumer.contentIdentity),
    );
    if (
      member === undefined ||
      !isRecord(member.definition) ||
      !Array.isArray(member.definition.targetDependencyKeys)
    ) {
      continue;
    }
    for (const key of member.definition.targetDependencyKeys) {
      if (typeof key !== "string") continue;
      const providerId = consumer.dependencyBindings[key];
      const provider =
        providerId === undefined ? undefined : currentById.get(providerId);
      if (provider === undefined) continue;
      let providerManifest = targetManifests.get(provider.packageDefinitionId);
      if (providerManifest === undefined) {
        const current = await readTargetManifest(provider.path);
        providerManifest = current.value;
        targetManifests.set(provider.packageDefinitionId, providerManifest);
        addCurrentFact(current.fact);
      }
      if (providerManifest.name !== provider.name) {
        throw new Error(
          `原生依赖提供者名称不匹配：${provider.path} 应为 ${provider.name}`,
        );
      }
      const providerRecord = restoredById.get(provider.packageDefinitionId);
      const expectedExports =
        providerRecord === undefined
          ? undefined
          : contentByIdentity.get(
              contentIdentityKey(providerRecord.contentIdentity),
            );
      if (
        expectedExports === undefined ||
        !isRecord(expectedExports.definition)
      ) {
        continue;
      }
      const targetExports = expectedExports.definition.targetExports;
      if (!isRecord(targetExports)) continue;
      const actualExports = isRecord(providerManifest.exports)
        ? providerManifest.exports
        : {};
      for (const exportName of Object.keys(targetExports)) {
        const actual = actualExports[exportName];
        if (
          typeof actual !== "string" &&
          !isRecord(actual) &&
          !Array.isArray(actual)
        ) {
          throw new Error(`复用包 ${provider.path} 缺少公开入口 ${exportName}`);
        }
        if (typeof actual !== "string") continue;
        if (
          !actual.startsWith("./") ||
          actual.includes("\\") ||
          actual
            .slice(2)
            .split("/")
            .some((segment) => segment === "..")
        ) {
          throw new Error(
            `复用包 ${provider.path} 的公开入口路径无效：${actual}`,
          );
        }
        await readPackageExportTarget(provider.path, actual);
      }
    }
  }
  const engines =
    isRecord(manifest) && isRecord(manifest.engines)
      ? manifest.engines
      : undefined;
  const nodeDeclaration = engines?.node;
  if (
    typeof nodeDeclaration !== "string" ||
    !nodeDeclarationPattern.test(nodeDeclaration)
  ) {
    throw new RootToolchainDeclarationError(
      { kind: "invalid-node-declaration" },
      `加包需要根package.json的engines.node为单个Node大版本或精确版本，实际收到 ${JSON.stringify(nodeDeclaration ?? null)}`,
    );
  }
  const packageManagerPin = isRecord(manifest)
    ? manifest.packageManager
    : undefined;
  if (
    typeof packageManagerPin !== "string" ||
    !pnpmPinPattern.test(packageManagerPin)
  ) {
    throw new RootToolchainDeclarationError(
      { kind: "invalid-package-manager-pin" },
      `加包需要根package.json的packageManager为精确pnpm版本，实际收到 ${JSON.stringify(packageManagerPin ?? null)}`,
    );
  }
  const selectedPresetSelectors: ContentSelector[] = [
    ...options.restored.selections.flatMap(({ presetIdentity }) =>
      presetIdentity === null ? [] : [presetIdentity],
    ),
    ...("preset" in options.selection ? [options.selection.preset] : []),
  ];
  const baseFacts = await initOperationFacts(content, selectedPresetSelectors, {
    repositoryRoot,
    selections: options.restored.selections,
    packages: options.restored.packages,
  });
  const readPreparedLinkFacts = async (creationInputs: readonly unknown[]) => {
    const factCount = currentFacts.length;
    const selectedProviderIds = new Set<
      GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"]
    >();
    for (const creationInput of creationInputs) {
      if (!isRecord(creationInput) || !isRecord(creationInput.linkTo)) {
        continue;
      }
      const linkTo = creationInput.linkTo;
      const keys = Object.keys(linkTo);
      if (
        keys.length !== 1 ||
        !["nodeIdentity", "packageDefinitionId"].includes(keys[0]!)
      ) {
        continue;
      }
      if (typeof linkTo.packageDefinitionId === "string") {
        const providerId =
          linkTo.packageDefinitionId as GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"];
        if (currentById.has(providerId)) selectedProviderIds.add(providerId);
        continue;
      }
      if (typeof linkTo.nodeIdentity !== "string") continue;
      const nodeIdentity = linkTo.nodeIdentity;
      const providerIds = new Set(
        options.restored.selections.flatMap((selection) =>
          Object.hasOwn(selection.nodes, nodeIdentity)
            ? [selection.nodes[nodeIdentity]!]
            : [],
        ),
      );
      if (providerIds.size === 1) {
        const providerId = providerIds.values().next().value;
        if (providerId !== undefined && currentById.has(providerId)) {
          selectedProviderIds.add(providerId);
        }
      }
    }
    for (const providerId of selectedProviderIds) {
      const provider = currentById.get(providerId)!;
      const providerManifest = await readPackageManifest(providerId);
      const exports = isRecord(providerManifest.exports)
        ? providerManifest.exports
        : {};
      for (const target of packageExportSourceTargetValues(exports["."])) {
        await readPackageExportTarget(provider.path, target);
      }
    }
    return {
      targetManifests: new Map(targetManifests),
      readFacts: currentFacts.slice(factCount),
    };
  };
  return {
    operationFacts: {
      ...baseFacts,
      nodeDeclaration,
      packageManagerPin,
      targetManifests,
      existingPackageDefinitionIds: new Set(
        options.restored.blueprint.packages.map(
          ({ packageDefinitionId }) => packageDefinitionId,
        ),
      ),
      existingPackageLinkIntents: options.restored.blueprint.packageLinkIntents,
    },
    readFacts: [...currentFacts, ...baseFacts.presetRootContributionReadFacts],
    readPreparedLinkFacts,
  };
}

/** 默认SDK在正式generator链外准备真实默认owner和当前目标事实。 */
export function createDefaultGenerator<
  const Content extends readonly DefaultContentMember[],
>(options: {
  readonly content: Content;
  readonly catalog?: Readonly<Record<string, string>>;
  readonly installPolicy?: Readonly<Record<string, unknown>>;
}) {
  const generator = createGenerator({
    content: options.content,
    composition: createDefaultComposition({
      rootIdentity: workspaceRootIdentity,
      content: options.content,
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      ...(options.installPolicy === undefined
        ? {}
        : { installPolicy: options.installPolicy }),
    }),
  });
  type InitOptions = Omit<
    Parameters<typeof generator.init>[0],
    "operationFacts"
  >;
  type PlanInitOptions = Omit<
    Parameters<typeof generator.planInit>[0],
    "operationFacts"
  >;
  type PlanAddOptions = Parameters<
    typeof generator.prepareAddProject
  >[0]["selection"] & {
    readonly repositoryRoot: string;
    readonly readFacts?: readonly CurrentProjectProjectionEntry[];
  };
  type AddOptions = PlanAddOptions & { readonly dryRun?: boolean };
  type PrepareProjectOptions = Omit<
    Parameters<typeof generator.prepareProject>[0],
    "operationFacts"
  >;
  type PrepareAddOptions = Omit<
    Parameters<typeof generator.prepareAddProject>[0],
    "operationFacts"
  >;
  type AddPlanResult = Awaited<ReturnType<typeof generator.planAdd>>;
  type AddPlanFailure = Extract<
    AddPlanResult,
    { readonly status: "operation-failure" }
  >;
  type DefaultAddPlanResult =
    | Exclude<AddPlanResult, { readonly status: "operation-failure" }>
    | (Omit<AddPlanFailure, "error"> & {
        readonly error: AddPlanFailure["error"] & {
          readonly packageLinkIssue?: PackageLinkValidationIssue;
          readonly rootToolchainIssue?: RootToolchainDeclarationIssue;
        };
      });
  type PreparedInitializationFacts =
    | {
        readonly kind: "ready";
        readonly operationFacts: DefaultOperationFacts;
      }
    | {
        readonly kind: "failure";
        readonly failure: Extract<
          Awaited<ReturnType<typeof generator.planInit>>,
          { readonly status: "operation-failure" }
        >;
      };

  async function prepareInitializationFacts(
    selectedPresets: readonly ContentSelector[] | undefined,
  ): Promise<PreparedInitializationFacts> {
    try {
      return {
        kind: "ready" as const,
        operationFacts: await initOperationFacts(
          options.content,
          selectedPresets,
        ),
      };
    } catch (error) {
      return {
        kind: "failure" as const,
        failure: {
          status: "operation-failure" as const,
          phase: "preparation" as const,
          error: { message: errorMessage(error) },
        },
      };
    }
  }

  async function prepareAddition(
    prepareOptions: PrepareAddOptions,
  ): Promise<Awaited<ReturnType<typeof generator.prepareAddProject>>> {
    const prepared = await additionFacts(
      prepareOptions.restored.targetRoot,
      options.content,
      {
        restored: prepareOptions.restored,
        selection: prepareOptions.selection,
      },
    );
    const preparation = await generator.prepareAddProject({
      ...prepareOptions,
      operationFacts: prepared.operationFacts,
    });
    const rustOwnerIdentities = new Set(
      prepared.operationFacts.rootDeclarations
        .filter(
          (declaration) =>
            declaration.applicationRequirements?.rustToolchain !== undefined,
        )
        .map((declaration) => contentIdentityKey(declaration.sourceIdentity)),
    );
    const existingRustPackage = preparedSelectionsContainOwner(
      preparation.before.selections,
      rustOwnerIdentities,
    );
    const resultingRustPackage = preparedSelectionsContainOwner(
      preparation.after.selections,
      rustOwnerIdentities,
    );
    const rustToolchainTarget = resultingRustPackage
      ? await prepareRootRustToolchainTarget({
          repositoryRoot: prepareOptions.restored.targetRoot,
          required: existingRustPackage,
        })
      : undefined;
    const previousSelectionIds = new Set(
      preparation.before.selections.flatMap((selection) =>
        selection.selectionId === undefined ? [] : [selection.selectionId],
      ),
    );
    const addedCreationInputs = preparation.after.selections
      .filter(
        (selection) =>
          selection.selectionId === undefined ||
          !previousSelectionIds.has(selection.selectionId),
      )
      .flatMap((selection) =>
        selection.roots.map((root) => root.creationInput),
      );
    const linkedFacts =
      await prepared.readPreparedLinkFacts(addedCreationInputs);
    const operationFacts = {
      ...prepared.operationFacts,
      ...(rustToolchainTarget?.target === undefined
        ? {}
        : { rustToolchainTarget: rustToolchainTarget.target }),
      targetManifests: linkedFacts.targetManifests,
    };
    const readFacts = [
      ...preparation.readFacts,
      ...prepared.readFacts,
      ...linkedFacts.readFacts,
    ];
    if (
      rustToolchainTarget !== undefined &&
      !readFacts.some(
        ({ path: factPath }) => factPath === rustToolchainTarget.readFact.path,
      )
    ) {
      readFacts.push(rustToolchainTarget.readFact);
    }
    return {
      ...preparation,
      before: { ...preparation.before, operationFacts },
      after: { ...preparation.after, operationFacts },
      readFacts,
    };
  }

  async function planAddition(
    planOptions: PlanAddOptions,
  ): Promise<DefaultAddPlanResult> {
    const {
      repositoryRoot,
      readFacts: additionalReadFacts,
      ...selection
    } = planOptions;
    const creationInput =
      selection.creationInput === undefined
        ? {}
        : { creationInput: selection.creationInput };
    const additionSelection =
      "preset" in selection
        ? { preset: selection.preset, ...creationInput }
        : {
            contentIdentity: selection.contentIdentity,
            ...(selection.nodeIdentity === undefined
              ? {}
              : { nodeIdentity: selection.nodeIdentity }),
            ...(selection.layout === undefined
              ? {}
              : { layout: selection.layout }),
            ...(selection.dependencyBindings === undefined
              ? {}
              : { dependencyBindings: selection.dependencyBindings }),
            ...creationInput,
          };
    let restored: Awaited<ReturnType<typeof generator.restoreProject>>;
    try {
      restored = await generator.restoreProject({
        repositoryRoot,
      });
    } catch (error) {
      return {
        status: "operation-failure" as const,
        phase: "metadata" as const,
        error: { message: errorMessage(error) },
      };
    }
    let preparation: Awaited<ReturnType<typeof prepareAddition>>;
    try {
      preparation = await prepareAddition({
        restored,
        selection: additionSelection,
      });
      if (additionalReadFacts !== undefined) {
        preparation = {
          ...preparation,
          readFacts: [...preparation.readFacts, ...additionalReadFacts],
        };
      }
    } catch (error) {
      const packageLinkIssue =
        error instanceof PackageLinkValidationError ? error.issue : undefined;
      const rootToolchainIssue =
        error instanceof RootToolchainDeclarationError
          ? error.issue
          : undefined;
      return {
        status: "operation-failure" as const,
        phase: "preparation" as const,
        error: {
          message: errorMessage(error),
          ...(packageLinkIssue === undefined ? {} : { packageLinkIssue }),
          ...(rootToolchainIssue === undefined ? {} : { rootToolchainIssue }),
        },
      };
    }
    let before: ReturnType<typeof generator.computeProject>;
    let after: ReturnType<typeof generator.computeProject>;
    try {
      before = generator.computeProject(preparation.before);
      after = generator.computeProject(preparation.after);
    } catch (error) {
      const packageIdentityIssues =
        error instanceof ProjectBlueprintValidationError
          ? error.packageIdentityIssues
          : [];
      const packageLinkIssue =
        error instanceof PackageLinkValidationError ? error.issue : undefined;
      return {
        status: "operation-failure" as const,
        phase: "calculation" as const,
        error: {
          message: errorMessage(error),
          ...(packageIdentityIssues.length === 0
            ? {}
            : { packageIdentityIssues }),
          ...(packageLinkIssue === undefined ? {} : { packageLinkIssue }),
        },
      };
    }
    return generator.planComputedAdd({ preparation, before, after });
  }

  async function add(addOptions: AddOptions) {
    const { dryRun = false, ...planOptions } = addOptions;
    const planned = await planAddition(planOptions);
    if (planned.status === "operation-failure") return planned;
    if (planned.status === "conflict") {
      return { ...planned, dryRun, actions: [] as const };
    }
    if (!dryRun) return generator.commitPlan(planned.plan);
    return {
      status: "success" as const,
      dryRun: true,
      blueprint: planned.blueprint,
      generationRecord: planned.generationRecord,
      projection: planned.projection,
      ownerFacts: planned.ownerFacts,
      actions: planned.actions,
    };
  }

  return {
    ...generator,
    async init(initOptions: InitOptions) {
      const prepared = await prepareInitializationFacts(
        initOptions.selection.presets?.map(
          ({ contentIdentity }) => contentIdentity,
        ),
      );
      if (prepared.kind === "failure") return prepared.failure;
      return generator.init({
        ...initOptions,
        operationFacts: prepared.operationFacts,
      });
    },
    async planInit(planOptions: PlanInitOptions) {
      const prepared = await prepareInitializationFacts(
        planOptions.selection.presets?.map(
          ({ contentIdentity }) => contentIdentity,
        ),
      );
      if (prepared.kind === "failure") return prepared.failure;
      return generator.planInit({
        ...planOptions,
        operationFacts: prepared.operationFacts,
      });
    },
    add,
    planAdd: planAddition,
    async prepareProject(prepareOptions: PrepareProjectOptions) {
      return generator.prepareProject({
        ...prepareOptions,
        operationFacts: await initOperationFacts(
          options.content,
          prepareOptions.selection.presets?.map(
            ({ contentIdentity }) => contentIdentity,
          ),
        ),
      });
    },
    prepareAddProject: prepareAddition,
  };
}
