import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  type BuiltInPresetDefinition,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import {
  materializeProjectProjection,
  readProjectedMirrorSlotScalar,
  type ProjectProjectionMirrorSlot,
  type MaterializeProjectProjectionOptions,
} from "@ykdz/template-core/project-projection";
import {
  renderNewProject,
  type RenderOperation,
} from "@ykdz/template-core/renderer";
import {
  loadTemplateDependencyCatalog,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-workspace/dependency-catalog";
import {
  planExplicitProjectLinks,
  canConsumeNodePackageNameImport,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImport,
} from "@ykdz/template-workspace/project-linking";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { readRustToolchainChannelFromToml } from "@ykdz/template-workspace/rust-toolchain-facts";
import { parse as parseYaml } from "yaml";

/** A real registry Definition and optional Package Addition planner scenario. */
export type GeneratedScenario = {
  readonly id: string;
  readonly label: string;
  readonly base: BuiltInPresetDefinition;
  readonly addition?: BuiltInPresetDefinition;
  readonly linkFrom?: readonly string[];
};

function scenarioId(...parts: readonly string[]): string {
  return parts.join("--");
}

function initializationScenario(
  base: BuiltInPresetDefinition,
): GeneratedScenario {
  return {
    id: scenarioId("init", base.metadata.name),
    label: `initialize ${base.metadata.name}`,
    base,
  };
}

/** One production-equivalent initialization per complete registered Definition. */
export function deriveInitializationScenarios(): readonly GeneratedScenario[] {
  return builtInPresetRegistry.all().map(initializationScenario);
}

/**
 * Every initialization plus every registered Package Addition planner applied
 * to every base Definition. No Preset identity list is maintained here.
 */
export function deriveFixtureMatrix(
  definitions: readonly BuiltInPresetDefinition[] = builtInPresetRegistry.all(),
): readonly GeneratedScenario[] {
  const addable = definitions.filter(
    (definition) => definition.planPackageAddition !== undefined,
  );

  return definitions.flatMap((base) => [
    initializationScenario(base),
    ...addable.map((addition) => ({
      id: scenarioId(
        "fixture",
        base.metadata.name,
        "add",
        addition.metadata.name,
      ),
      label: `initialize ${base.metadata.name}, then add ${addition.metadata.name}`,
      base,
      addition,
    })),
  ]);
}

/**
 * Focused link cases use the first real owned Package Boundary from each base
 * Definition; the provider remains an optional Package Addition Definition.
 * There is deliberately no hand-maintained Preset compatibility table.
 */
export function deriveFocusedProjectLinkScenarios(): readonly GeneratedScenario[] {
  const definitions = builtInPresetRegistry.all();
  const addable = definitions.filter(
    (definition) => definition.planPackageAddition !== undefined,
  );
  return definitions.flatMap((base) => {
    // Some Definitions derive their package path from the project name. Plan
    // the consumer using the exact target-directory basename that the focused
    // runner will use, rather than a discovery-only placeholder.
    const scenarioContext = (addition: BuiltInPresetDefinition) => {
      const id = scenarioId(
        "focused-link",
        base.metadata.name,
        addition.metadata.name,
      );
      return {
        id,
        context: createGenerationContext({
          targetDir: path.join("generated-repository", id),
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        }),
      };
    };
    return addable.flatMap((addition) => {
      const { id, context } = scenarioContext(addition);
      const contribution = planGeneratedRepositoryInitialization({
        definition: base,
        context,
      }).packageContributions[0];
      if (
        contribution === undefined ||
        !canConsumeNodePackageNameImport(contribution)
      ) {
        return [];
      }
      const packageLeafName = `focused-${addition.metadata.name}`;
      const packagePath = addition.defaultPackagePath?.({
        context,
        packageLeafName,
      });
      if (packagePath === undefined) return [];
      const provider = addition.planPackageAddition?.({
        context,
        packageLeafName,
        packagePath,
      });
      if (
        provider === undefined ||
        !canProvideSourceConditionPackageNameImport(provider) ||
        !canLinkNodePackageRoles(
          contribution.definition.role,
          provider.definition.role,
        )
      ) {
        return [];
      }
      return [
        {
          id,
          label: `link ${contribution.definition.path} to added ${addition.metadata.name}`,
          base,
          addition,
          linkFrom: [contribution.definition.path],
        },
      ];
    });
  });
}

type SourceBackedOperation = Extract<
  RenderOperation,
  {
    kind:
      | "copyFile"
      | "writeText"
      | "writeTextTemplate"
      | "writeTextFromFragments";
  }
>;

export type PlanSourceReference = {
  readonly definitionName: string;
  readonly plannerSourceFile: string;
  readonly generatedPath: string;
  readonly sourceFile: string;
};

function operationReferences(
  operation: SourceBackedOperation,
  resolveSource: typeof resolveBuiltInTemplateSource,
): readonly { readonly generatedPath: string; readonly sourceFile: string }[] {
  if (operation.kind === "writeTextFromFragments") {
    return operation.fragments.map((fragment) => ({
      generatedPath: operation.to,
      sourceFile: resolveSource(fragment.source, fragment.from),
    }));
  }
  if (operation.kind === "writeText") {
    return operation.templateSource === undefined
      ? []
      : [
          {
            generatedPath: operation.to,
            sourceFile: resolveSource(
              operation.templateSource.handle,
              operation.templateSource.path,
            ),
          },
        ];
  }
  return [
    {
      generatedPath: operation.to,
      sourceFile: resolveSource(operation.source, operation.from),
    },
  ];
}

/** Extracts referenced Template Source exclusively from the rendered plan. */
export function planSourceReferences(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
  readonly resolveSource?: typeof resolveBuiltInTemplateSource;
}): readonly PlanSourceReference[] {
  return options.plan.operations.flatMap((operation) => {
    if (
      operation.kind !== "copyFile" &&
      operation.kind !== "writeText" &&
      operation.kind !== "writeTextTemplate" &&
      operation.kind !== "writeTextFromFragments"
    ) {
      return [];
    }
    try {
      return operationReferences(
        operation,
        options.resolveSource ?? resolveBuiltInTemplateSource,
      ).map((reference) => ({
        definitionName: options.definition.metadata.name,
        plannerSourceFile: options.definition.plannerSourceFile,
        ...reference,
      }));
    } catch (error) {
      throw new Error(
        `generated ${operation.to}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
}

/**
 * Fails before rendering when a real plan references missing or escaping
 * Template Source. Diagnostics retain Definition, planner, and generated path.
 */
export async function validatePlanSources(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
}): Promise<readonly PlanSourceReference[]> {
  let references: readonly PlanSourceReference[];
  try {
    references = planSourceReferences(options);
  } catch (error) {
    throw new Error(
      `${options.definition.metadata.name}: ${options.definition.plannerSourceFile} references undeclared or escaping Template Source for a generated output: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  for (const reference of references) {
    try {
      await access(reference.sourceFile);
    } catch {
      throw new Error(
        `${reference.definitionName}: ${reference.plannerSourceFile} references missing Template Source ${reference.sourceFile} for generated ${reference.generatedPath}`,
      );
    }
  }
  return references;
}

function isStructuredRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the materialized Development Container against the final Tool Layer
 * plan before Fixture Verification Evidence can stand in for execution.
 */
export async function validateGeneratedDevelopmentContainerProjection(options: {
  readonly plan: GeneratedRepositoryPlan;
  readonly projectDir: string;
}): Promise<void> {
  const dockerfilePath = path.join(
    options.projectDir,
    ".devcontainer",
    "Dockerfile",
  );
  const expectedDockerfile =
    (
      await Promise.all(
        options.plan.developmentContainer.toolLayers.map(
          async (layer) =>
            await readFile(
              resolveBuiltInTemplateSource(
                layer.dockerfile.source,
                layer.dockerfile.from,
              ),
              "utf8",
            ),
        ),
      )
    )
      .map((source) => source.trimEnd())
      .join("\n\n") + "\n";
  const generatedDockerfile = await readFile(dockerfilePath, "utf8");
  if (generatedDockerfile !== expectedDockerfile) {
    throw new Error(
      `Generated Development Container projection ${dockerfilePath} does not match the final Tool Layer plan`,
    );
  }

  const configPath = path.join(
    options.projectDir,
    ".devcontainer",
    "devcontainer.json",
  );
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    readonly build?: { readonly args?: unknown };
    readonly mounts?: unknown;
  };
  const expectedBuildArguments = Object.fromEntries(
    options.plan.developmentContainer.buildArguments.map((argument) => [
      argument.name,
      argument.value,
    ]),
  );
  const generatedBuildArguments = config.build?.args;
  if (
    !isStructuredRecord(generatedBuildArguments) ||
    Object.entries(expectedBuildArguments).some(
      ([name, value]) => generatedBuildArguments[name] !== value,
    )
  ) {
    throw new Error(
      `Generated Development Container projection ${configPath} build arguments do not match the final Tool Layer plan`,
    );
  }
  if (!Array.isArray(config.mounts)) {
    throw new Error(
      `Generated Development Container projection ${configPath} mounts do not match the final Tool Layer plan`,
    );
  }
  for (const { identity, ...expectedMount } of options.plan.developmentContainer
    .mounts) {
    const matchingMounts = config.mounts.filter(
      (mount) =>
        isStructuredRecord(mount) && mount.target === expectedMount.target,
    );
    if (
      matchingMounts.length !== 1 ||
      Object.entries(expectedMount).some(
        ([field, value]) => matchingMounts[0]?.[field] !== value,
      )
    ) {
      throw new Error(
        `Generated Development Container projection ${configPath} mount ${identity} does not match the final Tool Layer plan`,
      );
    }
  }
}

/** 检查真实模板规划的最终清单，不审计消费者工作树。 */
export async function validatePlanDependencyCatalog(
  plan: GeneratedRepositoryPlan & {
    readonly projectProjections?: {
      readonly after: MaterializeProjectProjectionOptions;
    };
  },
  projectDir?: string,
): Promise<void> {
  const projection =
    projectDir === undefined
      ? await materializeProjectProjection(
          plan.projectProjections?.after ?? {
            operations: plan.operations,
          },
        )
      : {
          entries: await Promise.all(
            [
              "package.json",
              "pnpm-workspace.yaml",
              ...plan.blueprint.packages.map(
                (item) => `${item.path}/package.json`,
              ),
            ].map(async (file) => ({
              path: file,
              content: await readFile(path.join(projectDir, file)),
            })),
          ),
        };
  const decoder = new TextDecoder();
  const manifests = new Map(
    projection.entries
      .filter(
        (entry) =>
          entry.path === "package.json" || entry.path.endsWith("/package.json"),
      )
      .map((entry) => [
        entry.path,
        JSON.parse(decoder.decode(entry.content)) as Record<string, unknown>,
      ]),
  );
  const workspace = projection.entries.find(
    (entry) => entry.path === "pnpm-workspace.yaml",
  );
  const workspaceValue: unknown =
    workspace === undefined
      ? undefined
      : parseYaml(decoder.decode(workspace.content));
  const catalog =
    isStructuredRecord(workspaceValue) &&
    isStructuredRecord(workspaceValue.catalog)
      ? workspaceValue.catalog
      : {};
  const links = planExplicitProjectLinks({
    blueprint: plan.blueprint,
    contributions: plan.packageContributions,
  });
  const templateCatalog = loadTemplateDependencyCatalog();
  const references = new Set<string>();
  for (const [manifestPath, manifest] of manifests) {
    const packagePath = path.posix.dirname(manifestPath);
    const contribution = plan.packageContributions.find(
      (item) =>
        item.definition.path === packagePath &&
        item.definition.name === manifest.name,
    );
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const dependencies = manifest[field];
      if (!isStructuredRecord(dependencies)) continue;
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        const provider = plan.blueprint.packages.find(
          (definition) =>
            definition.name === dependency &&
            manifests.get(`${definition.path}/package.json`)?.name ===
              dependency,
        );
        const explicitLink =
          field === "dependencies" &&
          links.manifestPatchesByPackagePath.get(packagePath)?.dependencies[
            dependency
          ] === "workspace:*";
        const referenceBinding = Object.values(
          contribution?.referenceBindings ?? {},
        ).some(
          (binding) =>
            binding.name === dependency && binding.path === provider?.path,
        );
        // 根协调工具直接消费 Blueprint 中的共享包；根本身不属于叶包贡献。
        const rootToolingDependency =
          manifestPath === "package.json" && field === "devDependencies";
        const internalWorkspace =
          specifier === "workspace:*" &&
          provider !== undefined &&
          (explicitLink || referenceBinding || rootToolingDependency);
        const internalConfiguration =
          referenceBinding &&
          provider !== undefined &&
          field === "devDependencies" &&
          specifier ===
            `link:${path.posix.relative(packagePath, provider.path)}`;
        if (internalWorkspace || internalConfiguration) continue;
        const entry = catalog[dependency];
        if (
          specifier !== "catalog:" ||
          typeof entry !== "string" ||
          templateCatalog[dependency] !== entry ||
          entry.trim().length === 0 ||
          /^(?:catalog|workspace|link):/.test(entry)
        ) {
          throw new Error(
            `${plan.definitionName}: ${manifestPath} ${field} ${dependency} ${JSON.stringify(specifier)} 违反依赖目录归属：外部依赖必须引用有效的默认 catalog 条目`,
          );
        }
        references.add(dependency);
      }
    }
  }
  const expected = selectTemplateDependencyCatalogEntries(
    [...references],
    templateCatalog,
  );
  if (
    JSON.stringify(expected) !== JSON.stringify(plan.dependencyCatalog) ||
    Object.entries(expected).some(([name, value]) => catalog[name] !== value)
  ) {
    throw new Error(
      `${plan.definitionName}: 最终投影的默认依赖目录与模板声明不一致`,
    );
  }
}

function operationOutputPath(operation: RenderOperation): string | undefined {
  if (operation.kind === "setExecutable") {
    return operation.path;
  }
  return "to" in operation ? operation.to : undefined;
}

function escapeLocationName(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** 真实投影里根 package.json 的 engines.node 原文——镜像槽位唯一 Expected 真源。 */
function readProjectedRootNodeDeclaration(
  content: Uint8Array | undefined,
): string | undefined {
  if (content === undefined) return undefined;
  try {
    const manifest = JSON.parse(new TextDecoder("utf8").decode(content)) as {
      engines?: { node?: unknown };
    };
    return typeof manifest.engines?.node === "string"
      ? manifest.engines.node
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks 层认识当前 Node 根源拥有的 ARG 承载行形状：区域内那一行必须恰是
 * `ARG <name>="<value>"`；Core 只交出被拥有的一行，这里不解析整份 Dockerfile。
 */
function readArgCarrierValue(
  carrierLine: string,
  name: string,
): string | undefined {
  const match = new RegExp(
    String.raw`^ARG\s+${escapeLocationName(name)}\s*=\s*"([^"\r\n]*)"\s*$`,
    "u",
  ).exec(carrierLine);
  return match?.[1];
}

/** 根 rust-toolchain.toml 拥有 Rust 静态镜像，槽位末段 token 用它绑定该真源。 */
const rustChannelSourcePath = "rust-toolchain.toml";
const rustMirrorSlotToken = "RUST_TOOLCHAIN";

/**
 * 槽位所属根的 token：json-pointer 取末段、text-anchor 取名称。
 * Core 只交出位置，Checks 层用该 token 把槽位绑定到唯一根真源，不维护消费者文件名表。
 */
function mirrorSlotRootToken(slot: ProjectProjectionMirrorSlot): string {
  return slot.location.kind === "json-pointer"
    ? (slot.location.pointer.split("/").at(-1) ?? "")
    : slot.location.name;
}

/**
 * V-8/T25-6/T28-1 模板作者门：从真实 plan 的 reconciliation 消费镜像位置声明，物化真实投影，
 * 核对每个被本 plan 投影的声明位置可解释、有合法标量，并等于该槽位所属根的真值。
 * Node 槽位绑定根 engines.node，Rust 槽位绑定根 rust-toolchain.toml [toolchain].channel；
 * 期望值只来自真实根 manifest，不抄发版快照常量。
 */
export async function validatePlanMirrorSlotProjections(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
}): Promise<void> {
  const { definition, plan } = options;
  const projectedPaths = new Set(
    plan.operations
      .map(operationOutputPath)
      .filter((outputPath): outputPath is string => outputPath !== undefined),
  );
  const slots = plan.reconciliation.flatMap((policy) => {
    // 纯协调路径由初始化投影拥有；canonical 或本 plan 未投影该路径时不自证。
    if (policy.driver === "canonical" || !projectedPaths.has(policy.path)) {
      return [];
    }
    return (policy.mirrorSlots ?? []).map((slot) => ({
      path: policy.path,
      slot,
    }));
  });
  if (slots.length === 0) return;

  const projection = await materializeProjectProjection({
    operations: plan.operations,
  });
  const entryByPath = new Map(
    projection.entries.map((entry) => [entry.path, entry]),
  );
  const rootNode = readProjectedRootNodeDeclaration(
    entryByPath.get("package.json")?.content,
  );
  if (rootNode === undefined) {
    throw new Error(
      `${definition.metadata.name}: ${plan.planningContribution} 声明了镜像槽位，但真实投影缺少可读的根 package.json engines.node 真源`,
    );
  }

  const owner = `${definition.metadata.name}: ${plan.planningContribution}`;
  // Rust 真源仅在确有 Rust 槽位时惰性读取，非 Rust 投影永不触碰 rust-toolchain.toml。
  let rustChannel: string | undefined;
  const resolveRustChannel = (): string => {
    if (rustChannel !== undefined) return rustChannel;
    const rustEntry = entryByPath.get(rustChannelSourcePath);
    if (rustEntry === undefined) {
      throw new Error(
        `${owner}: 声明了 ${rustMirrorSlotToken} 镜像槽位，但真实投影缺少根 ${rustChannelSourcePath} 真源`,
      );
    }
    const reading = readRustToolchainChannelFromToml(
      new TextDecoder("utf8").decode(rustEntry.content),
    );
    if (reading.status !== "explained") {
      throw new Error(
        `${owner}: 根 ${rustChannelSourcePath} 的 [toolchain].channel 不可解释——${reading.reason}`,
      );
    }
    rustChannel = reading.channel;

    return rustChannel;
  };
  for (const { path, slot } of slots) {
    const entry = entryByPath.get(path);
    if (entry === undefined) {
      throw new Error(
        `${owner} ${path}#${slot.id}: 声明的镜像路径未出现在真实投影中`,
      );
    }
    const observed = readProjectedMirrorSlotScalar(entry, slot.location);
    if (!observed.ok) {
      throw new Error(
        `${owner} ${path}#${slot.id}: 镜像槽位在真实投影中不可解释——${observed.reason}`,
      );
    }
    const projected =
      slot.location.kind === "json-pointer"
        ? observed.scalar
        : readArgCarrierValue(observed.scalar, slot.location.name);
    if (projected === undefined) {
      const reason =
        slot.location.kind === "text-anchor"
          ? `锚点区域正文不是协议定义的 ARG ${slot.location.name} 承载行`
          : "镜像槽位不是可解释的标量";
      throw new Error(`${owner} ${path}#${slot.id}: ${reason}`);
    }
    const isRustSlot = mirrorSlotRootToken(slot) === rustMirrorSlotToken;
    const expected = isRustSlot ? resolveRustChannel() : rootNode;
    const sourceLabel = isRustSlot
      ? `根 ${rustChannelSourcePath} [toolchain].channel`
      : "根派生 engines.node";
    if (projected !== expected) {
      throw new Error(
        `${owner} ${path}#${slot.id}: 投影值 ${JSON.stringify(projected)} 与${sourceLabel} ${JSON.stringify(expected)} 漂移`,
      );
    }
  }
}

/** 生成仓库工具链检查器读取的槽位清单路径。 */
const generatedToolchainMirrorManifestPath = "scripts/toolchain-mirrors.json";

/** 槽位身份的可比较形：路径、槽位 id 与位置形制三者共同决定集合成员。 */
type ComparableMirrorSlot = {
  readonly driver: "json-pointer" | "text-anchor";
  readonly id: string;
  readonly location: string;
  readonly path: string;
};

function mirrorSlotKey(slot: ComparableMirrorSlot): string {
  return [slot.path, slot.id, slot.driver, slot.location].join("\u0000");
}

function describeMirrorSlotKey(key: string): string {
  const [path, id, driver, location] = key.split("\u0000");

  return `${path}#${id} (${driver} ${location})`;
}

function planMirrorSlotKeys(plan: GeneratedRepositoryPlan): readonly string[] {
  return plan.reconciliation
    .flatMap((policy) =>
      policy.driver === "canonical"
        ? []
        : (policy.mirrorSlots ?? []).map((slot): ComparableMirrorSlot => ({
            driver: slot.location.kind,
            id: slot.id,
            location:
              slot.location.kind === "json-pointer"
                ? slot.location.pointer
                : slot.location.name,
            path: policy.path,
          })),
    )
    .map(mirrorSlotKey)
    .toSorted();
}

/** 读取同源检查器实际消费的结构化槽位清单。 */
function checkerMirrorSlotKeys(
  sourceText: string,
  owner: string,
): readonly string[] {
  const carried: unknown = JSON.parse(sourceText);
  if (!Array.isArray(carried)) {
    throw new Error(`${owner}: 生成检查器携带的槽位清单不是数组`);
  }

  return carried
    .map((entry, index): ComparableMirrorSlot => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(
          `${owner}: 生成检查器携带的槽位清单第 ${index + 1} 项不是对象`,
        );
      }
      const slot = entry as Record<string, unknown>;
      const location = slot.location;
      if (
        typeof slot.id !== "string" ||
        typeof slot.path !== "string" ||
        typeof location !== "object" ||
        location === null
      ) {
        throw new Error(
          `${owner}: 生成检查器携带的槽位清单第 ${index + 1} 项缺少 id/path/location`,
        );
      }
      const fields = location as Record<string, unknown>;
      if (
        fields.kind === "json-pointer" &&
        typeof fields.pointer === "string"
      ) {
        return {
          driver: "json-pointer",
          id: slot.id,
          location: fields.pointer,
          path: slot.path,
        };
      }
      if (fields.kind === "text-anchor" && typeof fields.name === "string") {
        return {
          driver: "text-anchor",
          id: slot.id,
          location: fields.name,
          path: slot.path,
        };
      }

      throw new Error(
        `${owner}: 生成检查器携带的槽位清单第 ${index + 1} 项的 location 形制非法`,
      );
    })
    .map(mirrorSlotKey)
    .toSorted();
}

/**
 * T26-3 清单单源门：生成检查器携带的槽位清单必须是同一 plan 声明集合的投影。
 * 期望值来自 plan.reconciliation，观测值来自真实投影里的 JSON 清单。
 */
export async function validatePlanCheckerMirrorSlotManifest(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
}): Promise<void> {
  const { definition, plan } = options;
  const owner = `${definition.metadata.name}: ${plan.planningContribution}`;
  const projection = await materializeProjectProjection({
    operations: plan.operations,
  });
  const checker = projection.entries.find(
    (entry) => entry.path === generatedToolchainMirrorManifestPath,
  );
  if (checker === undefined) {
    throw new Error(
      `${owner}: 真实投影缺少生成仓库工具链槽位清单 ${generatedToolchainMirrorManifestPath}`,
    );
  }
  const expected = planMirrorSlotKeys(plan);
  const carried = checkerMirrorSlotKeys(
    new TextDecoder("utf8").decode(checker.content),
    owner,
  );
  const missing = expected.filter((key) => !carried.includes(key));
  const unexpected = carried.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        `${owner}: 生成检查器携带的槽位清单与 plan 声明不一致`,
        ...missing.map(
          (key) => `  - 未携带 plan 声明的槽位：${describeMirrorSlotKey(key)}`,
        ),
        ...unexpected.map(
          (key) =>
            `  - 携带了 plan 未声明的槽位：${describeMirrorSlotKey(key)}`,
        ),
      ].join("\n"),
    );
  }
}

/** 对真实 registry 的每个初始化与加包 plan 运行镜像槽位自检。 */
export async function validateRegistryMirrorSlotProjections(
  verificationPlans: readonly VerificationPlan[],
): Promise<void> {
  for (const { definition, plan } of verificationPlans) {
    await validatePlanMirrorSlotProjections({ definition, plan });
    await validatePlanCheckerMirrorSlotManifest({ definition, plan });
  }
}

export type VerificationPlan = {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
  /** Closed native diagnostic owners derived by the Foundation plan. */
  readonly diagnosticArtifactDeclarations: readonly unknown[];
};

/**
 * The plan set consumed by source, dependency, mirror, and publication
 * checks. Addition plans retain real base Contributions for link planning but
 * render only their own operations.
 */
export type VerificationRuntime = {
  readonly builtin: Pick<
    typeof import("@ykdz/template-builtin-presets"),
    | "builtInPresetRegistry"
    | "createGenerationContext"
    | "planGeneratedRepositoryInitialization"
    | "loadLocalTemplateMetadata"
    | "planGeneratedRepositoryPackageAddition"
  >;
  readonly renderNewProject: typeof renderNewProject;
};

export async function deriveVerificationPlans(
  runtime: VerificationRuntime = {
    builtin: {
      builtInPresetRegistry,
      createGenerationContext,
      planGeneratedRepositoryInitialization,
      loadLocalTemplateMetadata,
      planGeneratedRepositoryPackageAddition,
    },
    renderNewProject,
  },
): Promise<readonly VerificationPlan[]> {
  const plans: VerificationPlan[] = [];
  const builtin = runtime.builtin;
  for (const scenario of deriveFixtureMatrix(
    builtin.builtInPresetRegistry.all(),
  )) {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-verification-plan-"),
    );
    try {
      const context = builtin.createGenerationContext({
        targetDir: path.join(workspace, scenario.id),
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      });
      const initialization = builtin.planGeneratedRepositoryInitialization({
        definition: scenario.base,
        context,
      });
      plans.push({
        definition: scenario.base,
        plan: initialization,
        diagnosticArtifactDeclarations: initialization.ciDiagnosticArtifacts,
      });
      if (scenario.addition) {
        await runtime.renderNewProject({
          targetRoot: context.targetDir,
          operations: [...initialization.operations],
        });
        const packageLeafName = `verification-${scenario.addition.metadata.name}`;
        const packagePath = scenario.addition.defaultPackagePath?.({
          context,
          packageLeafName,
        });
        if (packagePath === undefined) {
          throw new Error(
            `Package Addition Definition ${scenario.addition.metadata.name} must own a default Package Path`,
          );
        }
        if (scenario.addition.planPackageAddition === undefined) {
          throw new Error(
            `Package Addition Definition ${scenario.addition.metadata.name} must provide a Package Addition planner`,
          );
        }
        const plan = builtin.planGeneratedRepositoryPackageAddition({
          definition: scenario.addition,
          localTemplateMetadata: builtin.loadLocalTemplateMetadata(
            context.targetDir,
          ),
          packageLeafName,
          packagePath,
        });
        plans.push({
          definition: scenario.addition,
          plan,
          diagnosticArtifactDeclarations: plan.ciDiagnosticArtifacts,
        });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  return plans;
}
