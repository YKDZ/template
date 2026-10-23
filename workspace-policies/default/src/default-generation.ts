import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { contentIdentityKey } from "@ykdz/template-core/content-identity";
import type { JsonValue } from "@ykdz/template-core/json";
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
  type DefaultContentMember,
  type DefaultOperationFacts,
} from "./default-composition.ts";

const nodeDeclarationPattern = /^([0-9]+)(?:\.([0-9]+)\.([0-9]+))?$/u;
const pnpmPinPattern = /^pnpm@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultRootIdentity(content: readonly DefaultContentMember[]) {
  const roots = content.filter((member) => {
    if (member.kind !== "reference" || !isRecord(member.definition)) {
      return false;
    }
    return (
      member.definition.defaultPath === "." &&
      member.definition.role === "native-package"
    );
  });
  if (roots.length !== 1) {
    throw new Error("默认内容必须登记唯一的native-package根owner");
  }
  return roots[0]!.identity;
}

async function initOperationFacts(
  content: readonly DefaultContentMember[],
): Promise<DefaultOperationFacts> {
  return prepareDefaultInitOperationFacts({
    rootDeclarations: await prepareDefaultRootDeclarations(content),
    rootAttachmentDependencies:
      prepareDefaultRootAttachmentDependencies(content),
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
        `加包需要已连接包的package.json是普通文件：${packagePath}`,
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

  const linkedPackageIds = new Set<
    GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"]
  >();
  const linkedProviderIds = new Set(linkedPackageIds);
  for (const intent of options.restored.blueprint.packageLinkIntents) {
    linkedPackageIds.add(intent.consumerId);
    linkedPackageIds.add(intent.providerId);
    linkedProviderIds.add(intent.providerId);
  }
  const linkTo = isRecord(options.selection.creationInput)
    ? options.selection.creationInput.linkTo
    : undefined;
  if (isRecord(linkTo)) {
    if (typeof linkTo.packageDefinitionId === "string") {
      const providerId =
        linkTo.packageDefinitionId as GeneratorRestoredProject<JsonValue>["blueprint"]["packages"][number]["packageDefinitionId"];
      if (!currentById.has(providerId)) {
        throw new Error(`包连接实例ID不存在：${linkTo.packageDefinitionId}`);
      }
      linkedPackageIds.add(providerId);
      linkedProviderIds.add(providerId);
    } else if (typeof linkTo.nodeIdentity === "string") {
      const nodeIdentity = linkTo.nodeIdentity;
      const providerIds = new Set(
        options.restored.selections.flatMap((selection) =>
          Object.hasOwn(selection.nodes, nodeIdentity)
            ? [selection.nodes[nodeIdentity]!]
            : [],
        ),
      );
      if (providerIds.size > 1) {
        throw new Error(`包连接节点身份不唯一：${nodeIdentity}`);
      }
      const providerId = providerIds.values().next().value;
      if (providerId !== undefined && currentById.has(providerId)) {
        linkedPackageIds.add(providerId);
        linkedProviderIds.add(providerId);
      }
    }
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
  for (const packageId of linkedProviderIds) {
    const provider = currentById.get(packageId);
    const providerManifest = await readPackageManifest(packageId);
    const exports = isRecord(providerManifest.exports)
      ? providerManifest.exports
      : {};
    const rootExport = exports["."];
    if (typeof rootExport === "string") {
      await readPackageExportTarget(provider?.path ?? ".", rootExport);
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
      throw new Error(`加包linkFrom指向未知当前包：${packagePath}`);
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
    throw new Error(
      `加包需要根package.json的engines.node为单个Node大版本或精确版本，实际收到${JSON.stringify(nodeDeclaration ?? null)}`,
    );
  }
  const packageManagerPin = isRecord(manifest)
    ? manifest.packageManager
    : undefined;
  if (
    typeof packageManagerPin !== "string" ||
    !pnpmPinPattern.test(packageManagerPin)
  ) {
    throw new Error(
      `加包需要根package.json的packageManager为精确pnpm版本，实际收到${JSON.stringify(packageManagerPin ?? null)}`,
    );
  }
  const baseFacts = await initOperationFacts(content);
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
    readFacts: currentFacts,
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
      rootIdentity: defaultRootIdentity(options.content),
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

  async function prepareAddition(prepareOptions: PrepareAddOptions) {
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
    return {
      ...preparation,
      readFacts: [...preparation.readFacts, ...prepared.readFacts],
    };
  }

  async function planAddition(planOptions: PlanAddOptions) {
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
      return {
        status: "operation-failure" as const,
        phase: "preparation" as const,
        error: { message: errorMessage(error) },
      };
    }
    let before: ReturnType<typeof generator.computeProject>;
    let after: ReturnType<typeof generator.computeProject>;
    try {
      before = generator.computeProject(preparation.before);
      after = generator.computeProject(preparation.after);
    } catch (error) {
      return {
        status: "operation-failure" as const,
        phase: "calculation" as const,
        error: { message: errorMessage(error) },
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
      return generator.init({
        ...initOptions,
        operationFacts: await initOperationFacts(options.content),
      });
    },
    async planInit(planOptions: PlanInitOptions) {
      return generator.planInit({
        ...planOptions,
        operationFacts: await initOperationFacts(options.content),
      });
    },
    add,
    planAdd: planAddition,
    async prepareProject(prepareOptions: PrepareProjectOptions) {
      return generator.prepareProject({
        ...prepareOptions,
        operationFacts: await initOperationFacts(options.content),
      });
    },
    prepareAddProject: prepareAddition,
  };
}
