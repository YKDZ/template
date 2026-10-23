import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Composition } from "@ykdz/template-core/composition";
import type {
  CompositionPackage,
  CompositionPackageEvaluation,
} from "@ykdz/template-core/composition";
import {
  assertContentIdentity,
  contentIdentityKey,
  contentIdentityLabel,
  createContentIndex,
  type ContentIdentity,
  type ContentSelector,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import {
  assertGenerationRecordMatchesBlueprint,
  type GenerationRecord,
  type GenerationRecordPackage,
  type GenerationRecordSelection,
} from "@ykdz/template-core/generation-record";
import {
  assertJsonValue,
  printCanonicalJson,
  type JsonValue,
} from "@ykdz/template-core/json";
import {
  projectPackageContributions,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import type {
  PackageDefinition,
  PackageDefinitionId,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import { assertProjectBlueprint } from "@ykdz/template-core/project-blueprint";
import type {
  ProjectProjection,
  ProjectProjectionEntry,
  ProjectProjectionReconciliation,
} from "@ykdz/template-core/project-projection";
import type {
  PreparedReference,
  PackageBinding,
  ReferencePackageDefinition,
  ReferenceSelectionRoot,
  PresetSelectionDefinition,
  PresetSelectionRequest,
} from "@ykdz/template-core/reference-package";

export type { GenerationRecord } from "@ykdz/template-core/generation-record";
export {
  generationRecordSchema,
  parseGenerationRecordStructure,
} from "@ykdz/template-core/generation-record";
export type {
  ReferencePackage,
  ReferencePackageDefinition,
} from "@ykdz/template-core/reference-package";
export type { Composition } from "@ykdz/template-core/composition";

type RuntimeReferenceDefinition = ReferencePackageDefinition<
  JsonValue,
  JsonValue,
  unknown,
  unknown,
  unknown,
  unknown
>;

type RuntimeReference = LoadedContentMember<
  RuntimeReferenceDefinition,
  "reference"
>;
type RuntimePreset = LoadedContentMember<PresetSelectionDefinition, "preset">;

type PreparedNode<CreationInput extends JsonValue = JsonValue> = {
  readonly content: RuntimeReference;
  readonly preparation: PreparedReference<unknown>;
  readonly definition: PackageDefinition;
  readonly creationInput: CreationInput | undefined;
  readonly layout: unknown;
  readonly nodeIdentity: string;
  readonly dependencies: readonly {
    readonly key: string;
    readonly package: PreparedNode<CreationInput>;
  }[];
};

type PreparedSelection<CreationInput extends JsonValue = JsonValue> = {
  readonly presetIdentity: ContentIdentity | null;
  readonly roots: readonly PreparedNode<CreationInput>[];
};

export type PreparedProject<
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  CompositionDefinition extends Composition = Composition,
> = {
  readonly conventions: Conventions;
  readonly composition: CompositionDefinition;
  readonly selections: readonly PreparedSelection<CreationInput>[];
};

export type ComputedPackage<ContributionFacts = unknown> = {
  readonly package: CompositionPackage;
  readonly bindings: ReadonlyMap<string, unknown>;
  readonly contribution: PackageContribution<ContributionFacts>;
};

export type ComputedProject<
  OwnerFacts = unknown,
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  ContributionFacts = unknown,
> = {
  readonly blueprint: ProjectBlueprint;
  readonly generationRecord: GenerationRecord<Conventions, CreationInput>;
  readonly projection: ProjectProjection;
  readonly packages: readonly ComputedPackage<ContributionFacts>[];
  readonly ownerFacts: OwnerFacts;
};

export type GeneratorSelection<CreationInput extends JsonValue = JsonValue> = {
  readonly roots?: readonly ReferenceSelectionRoot<CreationInput>[];
  readonly presets?: readonly PresetSelectionRequest<CreationInput>[];
};

export type Generator<
  OwnerFacts = unknown,
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  ContributionFacts = unknown,
  CompositionDefinition extends Composition = Composition,
> = {
  prepareProject(options: {
    readonly selection: GeneratorSelection<CreationInput>;
    readonly conventions: unknown;
  }): Promise<
    PreparedProject<Conventions, CreationInput, CompositionDefinition>
  >;
  computeProject(
    prepared: PreparedProject<
      Conventions,
      CreationInput,
      CompositionDefinition
    >,
  ): ComputedProject<OwnerFacts, Conventions, CreationInput, ContributionFacts>;
};

type PackageNode = {
  readonly id: PackageDefinitionId;
  readonly content: RuntimeReference;
  readonly definition: PersistedPackageDefinition;
  readonly createdBy: "initialization" | "shared-dependency";
  readonly creationInput: JsonValue | null;
  readonly preparation: PreparedReference<unknown>;
  readonly dependencies: Map<string, PackageNode>;
  contribution?: PackageContribution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageId(value: unknown): PackageDefinitionId {
  const digest = createHash("sha256")
    .update(printCanonicalJson(value as JsonValue))
    .digest("hex");
  return `package-${digest}` as PackageDefinitionId;
}

function selectionId(value: unknown): string {
  const digest = createHash("sha256")
    .update(printCanonicalJson(value as JsonValue))
    .digest("hex");
  return `selection-${digest}`;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalRelativeFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value !== "." &&
    value
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function isNestedDirectory(parent: string, child: string): boolean {
  return parent === "." ? child !== "." : child.startsWith(`${parent}/`);
}

function packageDefinition(value: PackageDefinition): PackageDefinition {
  assertProjectBlueprint({
    schemaVersion: 4,
    packages: [{ packageDefinitionId: `package-${"0".repeat(64)}`, ...value }],
    packageLinkIntents: [],
  });
  return { ...value };
}

function preparationSnapshot(
  value: PreparedReference<unknown>,
): PreparedReference<unknown> {
  if (!isRecord(value) || !Array.isArray(value.resources)) {
    throw new Error("参考包准备结果必须是资源快照");
  }
  const paths = new Set<string>();
  const resources = value.resources.map((resource) => {
    if (
      !isRecord(resource) ||
      typeof resource.path !== "string" ||
      !isCanonicalRelativeFilePath(resource.path) ||
      !(resource.content instanceof Uint8Array) ||
      !Number.isInteger(resource.mode) ||
      (resource.mode as number) < 0 ||
      ((resource.mode as number) & ~0o111) !== 0
    ) {
      throw new Error("参考包准备结果包含无效资源文件");
    }
    if (paths.has(resource.path)) {
      throw new Error(`参考包准备结果包含重复资源：${resource.path}`);
    }
    paths.add(resource.path);
    return {
      path: resource.path,
      content: resource.content.slice(),
      mode: resource.mode as number,
    };
  });
  return {
    resources,
    facts: structuredClone(value.facts),
  };
}

function clonePreparation(
  value: PreparedReference<unknown>,
): PreparedReference<unknown> {
  return {
    resources: value.resources.map((resource) => ({
      path: resource.path,
      content: resource.content.slice(),
      mode: resource.mode,
    })),
    facts: structuredClone(value.facts),
  };
}

function requireParsedCreationInput(
  content: RuntimeReference,
  value: unknown,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  const parsed = content.definition.parseCreationInput(value);
  assertJsonValue(parsed, "包创建输入");
  return parsed;
}

function mergeCreationInput(defaults: unknown, supplied: unknown): unknown {
  if (defaults === undefined) return supplied;
  if (supplied === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(supplied)) {
    throw new Error("预设创建输入只能通过对象进行补充");
  }
  return { ...defaults, ...supplied };
}

function excludedPackagePaths(
  definition: PackageDefinition,
  selectedPaths: readonly string[],
): string[] {
  return selectedPaths.filter((candidate) =>
    isNestedDirectory(definition.path, candidate),
  );
}

function preparedPackagePaths(roots: readonly PreparedNode[]): string[] {
  return roots.flatMap((root) => [
    root.definition.path,
    ...preparedPackagePaths(root.dependencies.map((item) => item.package)),
  ]);
}

function requireUniqueNodes(roots: readonly PreparedNode[]): void {
  const seen = new Set<string>();
  for (const root of roots) {
    if (!/^[a-z][a-z0-9-]*$/u.test(root.nodeIdentity)) {
      throw new Error(`选择节点标识无效：${root.nodeIdentity}`);
    }
    if (seen.has(root.nodeIdentity)) {
      throw new Error(`选择节点标识必须唯一：${root.nodeIdentity}`);
    }
    seen.add(root.nodeIdentity);
  }
}

/** 为显式内容集合创建通用纯计算引擎。 */
type CompositionConventions<Definition> = Definition extends {
  parseConventions(value: unknown): infer Conventions;
}
  ? Extract<Conventions, JsonValue>
  : JsonValue;
type CompositionOwnerFacts<Definition> =
  Definition extends Composition<
    JsonValue,
    unknown,
    unknown,
    unknown,
    infer OwnerFacts,
    JsonValue
  >
    ? OwnerFacts
    : unknown;
type CompositionContributionFacts<Definition> =
  Definition extends Composition<
    JsonValue,
    unknown,
    unknown,
    infer ContributionFacts,
    unknown,
    JsonValue
  >
    ? ContributionFacts
    : unknown;
type ReferenceCreationInput<Member> = Member extends {
  readonly kind: "reference";
  readonly definition: {
    parseCreationInput(value: unknown): infer CreationInput;
  };
}
  ? Extract<CreationInput, JsonValue>
  : never;
type ContentCreationInput<Members extends readonly LoadedContentMember[]> =
  Extract<Members[number], { readonly kind: "reference" }> extends infer Member
    ? [ReferenceCreationInput<Member>] extends [never]
      ? JsonValue
      : ReferenceCreationInput<Member>
    : JsonValue;

export function createGenerator<
  const Members extends readonly LoadedContentMember[],
  const CompositionDefinition extends Composition,
>(options: {
  readonly content: Members;
  readonly composition: CompositionDefinition;
}): Generator<
  CompositionOwnerFacts<CompositionDefinition>,
  CompositionConventions<CompositionDefinition>,
  ContentCreationInput<Members>,
  CompositionContributionFacts<CompositionDefinition>,
  CompositionDefinition
> {
  assertContentIdentity(options.composition.identity);
  const contentIndex = createContentIndex(options.content);
  const composition = options.composition as unknown as Composition;

  const resolveReference = (selector: ContentSelector): RuntimeReference =>
    contentIndex.resolve(selector, "reference") as RuntimeReference;

  const makePreparedNode = async (request: {
    readonly content: RuntimeReference;
    readonly nodeIdentity: string;
    readonly creationInput: JsonValue | undefined;
    readonly definition: PackageDefinition;
    readonly layout?: unknown;
    readonly conventions: JsonValue;
    readonly selectedPaths: readonly string[];
    readonly ancestry: readonly string[];
  }): Promise<PreparedNode> => {
    const identityKey = contentIdentityKey(request.content.identity);
    if (request.ancestry.includes(identityKey)) {
      throw new Error(
        `参考包依赖形成循环：${[...request.ancestry, identityKey].join(" → ")}`,
      );
    }
    const dependencies = request.content.definition.dependencies ?? [];
    const dependencyKeys = new Set<string>();
    const preparedDependencies: { key: string; package: PreparedNode }[] = [];
    for (const dependency of dependencies) {
      assertContentIdentity(dependency.contentIdentity);
      if (
        dependency.key.trim().length === 0 ||
        dependencyKeys.has(dependency.key)
      ) {
        throw new Error(`参考包依赖键不能为空且不能重复：${dependency.key}`);
      }
      dependencyKeys.add(dependency.key);
      const provider = resolveReference(dependency.contentIdentity);
      const providerCreationInput = requireParsedCreationInput(
        provider,
        dependency.creationInput,
      );
      const providerDefinition = packageDefinition(
        provider.definition.createDefinition({
          conventions: request.conventions,
          creationInput: providerCreationInput,
        }),
      );
      const providerNode = await makePreparedNode({
        content: provider,
        nodeIdentity: `${request.nodeIdentity}-${dependency.key}`,
        creationInput: providerCreationInput,
        definition: providerDefinition,
        layout: undefined,
        conventions: request.conventions,
        selectedPaths: [...request.selectedPaths, providerDefinition.path],
        ancestry: [...request.ancestry, identityKey],
      });
      preparedDependencies.push({ key: dependency.key, package: providerNode });
    }
    const prepared = preparationSnapshot(
      await request.content.definition.prepare({
        excludedPackagePaths: excludedPackagePaths(request.definition, [
          ...request.selectedPaths,
          ...preparedPackagePaths(
            preparedDependencies.map((item) => item.package),
          ),
        ]),
      }),
    );
    return {
      content: request.content,
      preparation: prepared,
      definition: request.definition,
      creationInput: request.creationInput,
      layout: request.layout,
      nodeIdentity: request.nodeIdentity,
      dependencies: preparedDependencies,
    };
  };

  async function prepareProject(prepareOptions: {
    readonly selection: GeneratorSelection;
    readonly conventions: unknown;
  }): Promise<PreparedProject> {
    const conventions = composition.parseConventions(
      prepareOptions.conventions,
    );
    assertJsonValue(conventions, "组合约定");
    const selections: {
      readonly presetIdentity: ContentIdentity | null;
      readonly roots: PreparedNode[];
    }[] = [];
    const directRoots = prepareOptions.selection.roots ?? [];
    if (directRoots.length > 0) {
      const selectedRoots = directRoots.map((root) => ({
        content: resolveReference(root.contentIdentity),
        nodeIdentity: root.nodeIdentity,
        rawCreationInput: root.creationInput,
        layout: root.layout,
      }));
      const preparedRoots = selectedRoots.map((root) => {
        const creationInput = requireParsedCreationInput(
          root.content,
          root.rawCreationInput,
        );
        return {
          ...root,
          creationInput,
          definition: packageDefinition(
            root.content.definition.createDefinition({
              conventions,
              creationInput,
              ...(root.layout === undefined ? {} : { layout: root.layout }),
            }),
          ),
        };
      });
      const group = { presetIdentity: null, roots: [] as PreparedNode[] };
      selections.push(group);
      const selectedPaths = preparedRoots.map((root) => root.definition.path);
      for (const root of preparedRoots) {
        group.roots.push(
          await makePreparedNode({
            ...root,
            conventions,
            selectedPaths,
            ancestry: [],
          }),
        );
      }
      requireUniqueNodes(group.roots);
    }

    for (const presetRequest of prepareOptions.selection.presets ?? []) {
      const presetMember = contentIndex.resolve(
        presetRequest.contentIdentity,
        "preset",
      ) as RuntimePreset;
      const preset = presetMember.definition;
      if (
        !isRecord(preset) ||
        preset.kind !== "preset" ||
        !isRecord(preset.nodes)
      ) {
        throw new Error(
          `预设定义无效：${contentIdentityLabel(presetMember.identity)}`,
        );
      }
      const definition = preset as unknown as PresetSelectionDefinition;
      if (!definition.operations.includes("init")) {
        throw new Error(
          `预设不支持初始化：${contentIdentityLabel(presetMember.identity)}`,
        );
      }
      const entries = Object.entries(definition.nodes);
      if (entries.length === 0)
        throw new Error("预设必须至少选择一个软件包节点");
      if (presetRequest.creationInput !== undefined && entries.length !== 1) {
        throw new Error("多节点预设不能接收单个软件包创建输入");
      }
      const group = {
        presetIdentity: presetMember.identity,
        roots: [] as PreparedNode[],
      };
      selections.push(group);
      const presetRoots: {
        readonly content: RuntimeReference;
        readonly nodeIdentity: string;
        readonly rawCreationInput: unknown;
        readonly layout?: unknown;
      }[] = [];
      for (const [nodeIdentity, node] of entries) {
        const selectedInput = mergeCreationInput(
          node.creationInput?.init,
          presetRequest.creationInput,
        );
        const content = resolveReference({
          alias: node.reference.alias,
          namespace: presetMember.identity.namespace,
        });
        presetRoots.push({
          content,
          nodeIdentity,
          rawCreationInput: selectedInput,
          ...(node.layout === undefined ? {} : { layout: node.layout }),
        });
      }
      const preparedRoots = presetRoots.map((root) => {
        const creationInput = requireParsedCreationInput(
          root.content,
          root.rawCreationInput,
        );
        return {
          ...root,
          creationInput,
          definition: packageDefinition(
            root.content.definition.createDefinition({
              conventions,
              creationInput,
              ...(root.layout === undefined ? {} : { layout: root.layout }),
            }),
          ),
        };
      });
      const selectedPaths = preparedRoots.map((root) => root.definition.path);
      for (const root of preparedRoots) {
        group.roots.push(
          await makePreparedNode({
            ...root,
            conventions,
            selectedPaths,
            ancestry: [],
          }),
        );
      }
      requireUniqueNodes(group.roots);
    }

    if (selections.length === 0) {
      throw new Error("初始化至少需要选择一个参考包或预设");
    }
    return {
      conventions,
      composition,
      selections,
    };
  }

  function computeProject(preparedProject: PreparedProject): ComputedProject {
    if (preparedProject.composition !== composition) {
      throw new Error("准备结果属于另一个组合定义");
    }
    const nodes: PackageNode[] = [];
    const sharedNodes = new Map<string, PackageNode>();
    const selectionRecords: GenerationRecordSelection[] = [];
    const explicitlySelectedSharedReferences = new Set(
      preparedProject.selections.flatMap((selection) =>
        selection.roots.flatMap((root) =>
          root.content.definition.instance === "shared"
            ? [contentIdentityKey(root.content.identity)]
            : [],
        ),
      ),
    );

    const makeNode = (
      prepared: PreparedNode,
      createdBy: PackageNode["createdBy"],
      discriminator: string,
    ): PackageNode => {
      const identityKey = contentIdentityKey(prepared.content.identity);
      const sharedKey =
        prepared.content.definition.instance === "shared"
          ? identityKey
          : undefined;
      if (sharedKey !== undefined) {
        const existing = sharedNodes.get(sharedKey);
        if (existing !== undefined) {
          if (
            !isDeepStrictEqual(existing.definition, prepared.definition) ||
            !isDeepStrictEqual(
              existing.creationInput,
              prepared.creationInput ?? null,
            ) ||
            !isDeepStrictEqual(existing.preparation, prepared.preparation)
          ) {
            throw new Error(
              `共享参考包的创建事实不一致：${contentIdentityLabel(prepared.content.identity)}`,
            );
          }
          return existing;
        }
      }
      const effectiveCreatedBy =
        sharedKey !== undefined &&
        explicitlySelectedSharedReferences.has(sharedKey)
          ? "initialization"
          : createdBy;
      const definition = {
        ...prepared.definition,
        packageDefinitionId: packageId({
          contentIdentity: prepared.content.identity,
          definition: prepared.definition,
          creationInput: prepared.creationInput ?? null,
          createdBy: effectiveCreatedBy,
          discriminator:
            sharedKey === undefined ? discriminator : "shared-reference",
        }),
      } as PersistedPackageDefinition;
      const node: PackageNode = {
        id: definition.packageDefinitionId,
        content: prepared.content,
        definition,
        createdBy: effectiveCreatedBy,
        creationInput: prepared.creationInput ?? null,
        preparation: prepared.preparation,
        dependencies: new Map(),
      };
      nodes.push(node);
      if (sharedKey !== undefined) sharedNodes.set(sharedKey, node);
      for (const dependency of prepared.dependencies) {
        const provider = makeNode(
          dependency.package,
          "shared-dependency",
          `${definition.packageDefinitionId}:${dependency.key}`,
        );
        node.dependencies.set(dependency.key, provider);
      }
      return node;
    };

    for (const selection of preparedProject.selections) {
      const id = selectionId({
        compositionIdentity: composition.identity,
        presetIdentity: selection.presetIdentity,
        roots: selection.roots.map((root) => ({
          nodeIdentity: root.nodeIdentity,
          contentIdentity: root.content.identity,
          creationInput: root.creationInput ?? null,
          definition: root.definition,
        })),
      });
      const nodeIds: Record<string, PackageDefinitionId> = {};
      for (const root of selection.roots) {
        const node = makeNode(
          root,
          "initialization",
          `${id}:${root.nodeIdentity}`,
        );
        nodeIds[root.nodeIdentity] = node.id;
      }
      selectionRecords.push({
        selectionId: id,
        presetIdentity: selection.presetIdentity,
        nodes: nodeIds,
      });
    }

    const packageRecords: GenerationRecordPackage<JsonValue>[] = nodes.map(
      (node) => ({
        packageDefinitionId: node.id,
        contentIdentity: node.content.identity,
        createdBy: node.createdBy,
        creationInput: node.creationInput,
        dependencyBindings: Object.fromEntries(
          [...node.dependencies.entries()].map(([key, provider]) => [
            key,
            provider.id,
          ]),
        ),
      }),
    );
    const packages = nodes.map((node) => ({
      packageDefinitionId: node.id,
      contentIdentity: node.content.identity,
      definition: node.definition,
      createdBy: node.createdBy,
      creationInput: node.creationInput,
      dependencyBindings: Object.fromEntries(
        [...node.dependencies.entries()].map(([key, provider]) => [
          key,
          provider.id,
        ]),
      ),
    })) satisfies CompositionPackage[];

    const bindingsFor = (
      node: PackageNode,
    ): ReadonlyMap<string, PackageBinding> => {
      const bindings = new Map<string, PackageBinding>();
      for (const [key, provider] of node.dependencies) {
        if (provider.contribution === undefined) {
          throw new Error(`依赖包尚未求值：${provider.id}`);
        }
        bindings.set(key, {
          packageDefinitionId: provider.id,
          contentIdentity: provider.content.identity,
          definition: provider.definition,
          facts: structuredClone(provider.contribution.facts),
        });
      }
      return bindings;
    };

    const provisionalBlueprint = assertProjectBlueprint({
      schemaVersion: 4,
      packages: nodes.map((node) => node.definition),
      packageLinkIntents: [],
    });
    const resolution = composition.resolve({
      conventions: preparedProject.conventions,
      blueprint: provisionalBlueprint,
      selections: selectionRecords,
      packages,
    });
    for (const id of resolution.packageInputs.keys()) {
      if (!nodes.some((node) => node.id === id)) {
        throw new Error(`组合输入引用了未知软件包实例：${id}`);
      }
    }
    const blueprint = assertProjectBlueprint({
      ...provisionalBlueprint,
      packageLinkIntents: resolution.packageLinkIntents ?? [],
    });

    const visiting = new Set<PackageDefinitionId>();
    const complete = new Set<PackageDefinitionId>();
    const evaluate = (node: PackageNode): PackageContribution => {
      if (node.contribution !== undefined) return node.contribution;
      if (visiting.has(node.id)) throw new Error("软件包依赖图包含循环");
      visiting.add(node.id);
      for (const provider of node.dependencies.values()) {
        evaluate(provider);
      }
      const contentPreparation = clonePreparation(node.preparation);
      const contribution = node.content.definition.evaluate({
        packageDefinitionId: node.id,
        definition: node.definition,
        createdBy: node.createdBy,
        creationInput: node.creationInput,
        prepared: contentPreparation,
        bindings: bindingsFor(node),
        conventions: structuredClone(preparedProject.conventions),
        stableCommon: structuredClone(resolution.stableCommon),
        packageInput: structuredClone(resolution.packageInputs.get(node.id)),
      });
      if (contribution.packageDefinitionId !== node.id) {
        throw new Error(`包贡献返回了错误的软件包实例标识：${node.id}`);
      }
      node.contribution = contribution;
      visiting.delete(node.id);
      complete.add(node.id);
      return contribution;
    };

    for (const node of nodes) evaluate(node);
    if (complete.size !== nodes.length)
      throw new Error("部分软件包贡献尚未求值");

    const compositionPackages: CompositionPackageEvaluation[] = nodes.map(
      (node) => ({
        package: packages.find((item) => item.packageDefinitionId === node.id)!,
        bindings: bindingsFor(node),
        contribution: node.contribution!,
      }),
    );
    const combined = composition.combine({
      conventions: preparedProject.conventions,
      stableCommon: structuredClone(resolution.stableCommon),
      blueprint,
      selections: selectionRecords,
      packages: compositionPackages,
    });

    const projection = projectPackageContributions({
      blueprint,
      contributions: nodes.map((node) => node.contribution!),
      ...(combined.files === undefined
        ? {}
        : { compositionFiles: combined.files }),
      ...(combined.reconciliation === undefined
        ? {}
        : { compositionReconciliation: combined.reconciliation }),
    });
    const generationRecord: GenerationRecord<JsonValue, JsonValue> = {
      schemaVersion: 6,
      composition: {
        identity: composition.identity,
        conventions: preparedProject.conventions,
      },
      packages: packageRecords,
      selections: selectionRecords,
    };
    assertGenerationRecordMatchesBlueprint(generationRecord, blueprint);

    const metadataEntries: ProjectProjectionEntry[] = [
      {
        path: ".template/blueprint.json",
        kind: "file",
        content: printCanonicalJson(blueprint),
        mode: 0,
      },
      {
        path: ".template/generation.json",
        kind: "file",
        content: printCanonicalJson(generationRecord),
        mode: 0,
      },
    ];
    const metadataReconciliation: ProjectProjectionReconciliation[] =
      metadataEntries.map((entry) => ({
        path: entry.path,
        driver: "canonical",
      }));
    const finalProjection: ProjectProjection = {
      entries: [...projection.entries, ...metadataEntries].toSorted(
        (left, right) => comparePaths(left.path, right.path),
      ),
      reconciliation: [
        ...projection.reconciliation,
        ...metadataReconciliation,
      ].toSorted((left, right) => comparePaths(left.path, right.path)),
    };
    return {
      blueprint,
      generationRecord,
      projection: finalProjection,
      packages: nodes.map((node) => ({
        package: packages.find((item) => item.packageDefinitionId === node.id)!,
        bindings: bindingsFor(node),
        contribution: node.contribution!,
      })),
      ownerFacts: combined.facts,
    };
  }

  return { prepareProject, computeProject } as unknown as Generator<
    CompositionOwnerFacts<CompositionDefinition>,
    CompositionConventions<CompositionDefinition>,
    ContentCreationInput<Members>,
    CompositionContributionFacts<CompositionDefinition>,
    CompositionDefinition
  >;
}
