import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isPublicationEnabled } from "@ykdz/reference-npm-publication/template";
import {
  readProjectedMirrorSlotScalar,
  type ProjectProjectionEntry,
  type ProjectProjectionMirrorSlot,
} from "@ykdz/template-core/project-projection";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import {
  loadTemplateDependencyCatalog,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-workspace/dependency-catalog";
import { readRustToolchainChannelFromToml } from "@ykdz/template-workspace/rust-toolchain-facts";
import { parse as parseYaml } from "yaml";

import type {
  GeneratedScenarioReceipt,
  GeneratedScenarioRuntime,
  SuccessfulScenarioResult,
} from "./generated-content.ts";

type SourceBackedOperation = Extract<
  RenderOperation,
  {
    readonly kind:
      | "copyFile"
      | "writeText"
      | "writeTextTemplate"
      | "writeTextFromFragments";
  }
>;

export type PlanSourceReference = {
  readonly scenarioId: string;
  readonly generatedPath: string;
  readonly sourceFile: string;
};

function outputPath(operation: RenderOperation): string | undefined {
  if (operation.kind === "setExecutable") return operation.path;
  return "to" in operation ? operation.to : undefined;
}

function operationReferences(
  operation: SourceBackedOperation,
  runtime: GeneratedScenarioRuntime,
): readonly { readonly generatedPath: string; readonly sourceFile: string }[] {
  if (operation.kind === "writeTextFromFragments") {
    return operation.fragments.map((fragment) => ({
      generatedPath: operation.to,
      sourceFile: runtime.resolveTemplateSource(fragment.source, fragment.from),
    }));
  }
  if (operation.kind === "writeText") {
    return operation.templateSource === undefined
      ? []
      : [
          {
            generatedPath: operation.to,
            sourceFile: runtime.resolveTemplateSource(
              operation.templateSource.handle,
              operation.templateSource.path,
            ),
          },
        ];
  }
  return [
    {
      generatedPath: operation.to,
      sourceFile: runtime.resolveTemplateSource(
        operation.source,
        operation.from,
      ),
    },
  ];
}

/** 检查正式投影操作中实际携带的来源句柄，不重新准备或渲染投影。 */
export function planSourceReferences(options: {
  readonly receipt: GeneratedScenarioReceipt;
  readonly runtime: GeneratedScenarioRuntime;
}): readonly PlanSourceReference[] {
  const projection = requireProjection(options.receipt.result);
  return projection.operations.flatMap((operation) => {
    if (
      operation.kind !== "copyFile" &&
      operation.kind !== "writeText" &&
      operation.kind !== "writeTextTemplate" &&
      operation.kind !== "writeTextFromFragments"
    ) {
      return [];
    }
    try {
      return operationReferences(operation, options.runtime).map(
        (reference) => ({
          scenarioId: options.receipt.scenario.id,
          ...reference,
        }),
      );
    } catch (error) {
      throw new Error(
        `${options.receipt.scenario.id}: generated ${operation.to} has an invalid template source: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
}

export async function validatePlanSources(options: {
  readonly receipt: GeneratedScenarioReceipt;
  readonly runtime: GeneratedScenarioRuntime;
}): Promise<readonly PlanSourceReference[]> {
  const references = planSourceReferences(options);
  for (const reference of references) {
    try {
      await access(reference.sourceFile);
    } catch {
      throw new Error(
        `${reference.scenarioId}: actual projection references missing template source ${reference.sourceFile} for generated ${reference.generatedPath}`,
      );
    }
  }
  return references;
}

function requireProjection(result: SuccessfulScenarioResult) {
  if (result.projection === null) {
    throw new Error("Generated scenario result has no new projection");
  }
  return result.projection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateGeneratedDevelopmentContainerProjection(options: {
  readonly receipt: GeneratedScenarioReceipt;
}): Promise<void> {
  const projection = requireProjection(options.receipt.result);
  const container = projection.ownerFacts?.container;
  if (container === undefined) {
    throw new Error(
      `${options.receipt.scenario.id}: default workspace owner omitted container facts`,
    );
  }
  const dockerfilePath = path.join(
    options.receipt.projectDir,
    ".devcontainer",
    "Dockerfile",
  );
  const generatedDockerfile = await readFile(dockerfilePath, "utf8");
  if (generatedDockerfile !== container.dockerfileText) {
    throw new Error(
      `Generated Development Container projection ${dockerfilePath} does not match the default workspace owner facts`,
    );
  }

  const configPath = path.join(
    options.receipt.projectDir,
    ".devcontainer",
    "devcontainer.json",
  );
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    readonly build?: { readonly args?: unknown };
    readonly mounts?: unknown;
  };
  const expectedBuildArguments = Object.fromEntries(
    container.buildArguments.map((argument) => [argument.name, argument.value]),
  );
  const generatedBuildArguments = config.build?.args;
  if (
    !isRecord(generatedBuildArguments) ||
    Object.entries(expectedBuildArguments).some(
      ([name, value]) => generatedBuildArguments[name] !== value,
    )
  ) {
    throw new Error(
      `Generated Development Container projection ${configPath} build arguments do not match the default workspace owner facts`,
    );
  }
  if (!Array.isArray(config.mounts)) {
    throw new Error(
      `Generated Development Container projection ${configPath} mounts do not match the default workspace owner facts`,
    );
  }
  for (const { identity, ...expectedMount } of container.mounts) {
    const matchingMounts = config.mounts.filter(
      (mount) => isRecord(mount) && mount.target === expectedMount.target,
    );
    if (
      matchingMounts.length !== 1 ||
      Object.entries(expectedMount).some(
        ([field, value]) => matchingMounts[0]?.[field] !== value,
      )
    ) {
      throw new Error(
        `Generated Development Container projection ${configPath} mount ${identity} does not match the default workspace owner facts`,
      );
    }
  }
}

function recordByPackageId(result: SuccessfulScenarioResult) {
  return new Map(
    result.generationRecord.packages.map((record) => [
      record.packageDefinitionId,
      record,
    ]),
  );
}

/** 只读生成目标中的真实 manifest、workspace YAML、record 与 blueprint。 */
export async function validatePlanDependencyCatalog(
  result: SuccessfulScenarioResult,
  projectDir: string,
  scenarioId: string,
): Promise<void> {
  const rootManifest = JSON.parse(
    await readFile(path.join(projectDir, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const workspaceValue: unknown = parseYaml(
    await readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8"),
  );
  const catalog =
    isRecord(workspaceValue) && isRecord(workspaceValue.catalog)
      ? workspaceValue.catalog
      : {};
  const manifests = new Map<string, Record<string, unknown>>([
    ["package.json", rootManifest],
  ]);
  for (const definition of result.blueprint.packages) {
    const file = `${definition.path}/package.json`;
    const manifest = JSON.parse(
      await readFile(path.join(projectDir, file), "utf8"),
    ) as Record<string, unknown>;
    if (manifest.name !== definition.name) {
      throw new Error(
        `${scenarioId}: ${file} package name does not match the actual blueprint`,
      );
    }
    manifests.set(file, manifest);
  }

  const packageRecordById = recordByPackageId(result);
  const packageRecordByPath = new Map(
    result.blueprint.packages.flatMap((definition) => {
      const record = packageRecordById.get(definition.packageDefinitionId);
      return record === undefined ? [] : [[definition.path, record] as const];
    }),
  );
  const templateCatalog = loadTemplateDependencyCatalog();
  const references = new Set<string>();
  for (const [manifestPath, manifest] of manifests) {
    const packagePath =
      manifestPath === "package.json" ? "." : path.posix.dirname(manifestPath);
    const packageRecord = packageRecordByPath.get(packagePath);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const dependencies = manifest[field];
      if (!isRecord(dependencies)) continue;
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== "string") {
          throw new Error(
            `${scenarioId}: ${manifestPath} ${field} ${dependency} must use a string specifier`,
          );
        }
        const provider = result.blueprint.packages.find(
          (definition) => definition.name === dependency,
        );
        const providerRecord =
          provider === undefined
            ? undefined
            : packageRecordById.get(provider.packageDefinitionId);
        const isBoundReference =
          providerRecord !== undefined &&
          packageRecord !== undefined &&
          Object.values(packageRecord.bindings).includes(
            providerRecord.packageDefinitionId,
          );
        const isLinkIntent =
          field === "dependencies" &&
          (result.blueprint.packageLinkIntents ?? []).some(
            (intent) =>
              intent.consumerPackagePath === packagePath &&
              intent.providerPackagePath === provider?.path,
          );
        const rootToolingDependency =
          manifestPath === "package.json" && field === "devDependencies";
        const internalWorkspace =
          specifier === "workspace:*" &&
          provider !== undefined &&
          (isBoundReference || isLinkIntent || rootToolingDependency);
        const internalConfiguration =
          isBoundReference &&
          provider !== undefined &&
          field === "devDependencies" &&
          specifier ===
            `link:${path.posix.relative(packagePath, provider.path)}`;
        if (internalWorkspace || internalConfiguration) continue;

        const expectedVersion = templateCatalog[dependency];
        const actualVersion = catalog[dependency];
        if (
          specifier !== "catalog:" ||
          typeof expectedVersion !== "string" ||
          expectedVersion.trim().length === 0 ||
          /^(?:catalog|workspace|link):/u.test(expectedVersion) ||
          actualVersion !== expectedVersion
        ) {
          throw new Error(
            `${scenarioId}: ${manifestPath} ${field} ${dependency} ${JSON.stringify(specifier)} violates the default dependency catalog contract`,
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
    Object.entries(expected).some(
      ([name, version]) => catalog[name] !== version,
    )
  ) {
    throw new Error(
      `${scenarioId}: generated dependency catalog does not match actual manifest references`,
    );
  }
}

export async function assertGeneratedManifestPublicationPolicy(options: {
  readonly result: SuccessfulScenarioResult;
  readonly projectDir: string;
  readonly scenarioId: string;
}): Promise<void> {
  const enabled = new Set(
    options.result.generationRecord.packages
      .filter((record) => isPublicationEnabled(record.configuration))
      .map((record) => record.packageDefinitionId),
  );
  const rootManifest = JSON.parse(
    await readFile(path.join(options.projectDir, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  if (rootManifest.private !== true) {
    throw new Error(
      `${options.scenarioId}：生成工作区根 package.json 必须保持 private:true`,
    );
  }
  for (const definition of options.result.blueprint.packages) {
    const manifestPath = `${definition.path}/package.json`;
    const manifest = JSON.parse(
      await readFile(path.join(options.projectDir, manifestPath), "utf8"),
    ) as Record<string, unknown>;
    const isPublicCandidate = enabled.has(definition.packageDefinitionId);
    if (
      isPublicCandidate ? manifest.private === true : manifest.private !== true
    ) {
      throw new Error(
        isPublicCandidate
          ? `${options.scenarioId}：公开候选 ${manifestPath} 必须允许发布`
          : `${options.scenarioId}：非候选包 ${manifestPath} 必须保持 private:true`,
      );
    }
  }
}

function operationOutputPath(operation: RenderOperation): string | undefined {
  return outputPath(operation);
}

function escapeLocationName(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function readArgCarrierValue(
  carrierLine: string,
  name: string,
): string | undefined {
  return new RegExp(
    String.raw`^ARG\s+${escapeLocationName(name)}\s*=\s*"([^"\r\n]*)"\s*$`,
    "u",
  ).exec(carrierLine)?.[1];
}

function mirrorSlotRootToken(slot: ProjectProjectionMirrorSlot): string {
  return slot.location.kind === "json-pointer"
    ? (slot.location.pointer.split("/").at(-1) ?? "")
    : slot.location.name;
}

function plannedMirrorSlots(result: SuccessfulScenarioResult): readonly {
  readonly path: string;
  readonly slot: ProjectProjectionMirrorSlot;
}[] {
  const projection = requireProjection(result);
  const projectedPaths = new Set(
    projection.operations
      .map(operationOutputPath)
      .filter((value): value is string => value !== undefined),
  );
  return projection.reconciliation.flatMap((policy) => {
    if (policy.driver === "canonical" || !projectedPaths.has(policy.path)) {
      return [];
    }
    return (policy.mirrorSlots ?? []).map((slot) => ({
      path: policy.path,
      slot,
    }));
  });
}

const rustChannelSourcePath = "rust-toolchain.toml";
const rustMirrorSlotToken = "RUST_TOOLCHAIN";

export async function validatePlanMirrorSlotProjections(options: {
  readonly receipt: GeneratedScenarioReceipt;
}): Promise<void> {
  const slots = plannedMirrorSlots(options.receipt.result);
  if (slots.length === 0) return;
  const owner = options.receipt.scenario.id;
  const rootManifest = JSON.parse(
    await readFile(
      path.join(options.receipt.projectDir, "package.json"),
      "utf8",
    ),
  ) as unknown;
  const rootNode =
    isRecord(rootManifest) && isRecord(rootManifest.engines)
      ? rootManifest.engines.node
      : undefined;
  if (typeof rootNode !== "string") {
    throw new Error(
      `${owner}: mirror slots require actual root package.json engines.node`,
    );
  }
  let rustChannel: string | undefined;
  const expectedRustChannel = async (): Promise<string> => {
    if (rustChannel !== undefined) return rustChannel;
    const text = await readFile(
      path.join(options.receipt.projectDir, rustChannelSourcePath),
      "utf8",
    );
    const reading = readRustToolchainChannelFromToml(text);
    if (reading.status !== "explained") {
      throw new Error(
        `${owner}: root Rust toolchain source is not explainable: ${reading.reason}`,
      );
    }
    rustChannel = reading.channel;
    return rustChannel;
  };
  for (const { path: filePath, slot } of slots) {
    const fullPath = path.join(options.receipt.projectDir, filePath);
    const content = await readFile(fullPath);
    const metadata = await stat(fullPath);
    const entry: ProjectProjectionEntry = {
      path: filePath,
      kind: "file",
      content,
      mode: metadata.mode & 0o777,
    };
    const observed = readProjectedMirrorSlotScalar(entry, slot.location);
    if (!observed.ok) {
      throw new Error(
        `${owner} ${filePath}#${slot.id}: actual mirror slot is not explainable: ${observed.reason}`,
      );
    }
    const projected =
      slot.location.kind === "json-pointer"
        ? observed.scalar
        : readArgCarrierValue(observed.scalar, slot.location.name);
    if (projected === undefined) {
      throw new Error(
        `${owner} ${filePath}#${slot.id}: actual mirror slot has no scalar value`,
      );
    }
    const isRustSlot = mirrorSlotRootToken(slot) === rustMirrorSlotToken;
    const expected = isRustSlot ? await expectedRustChannel() : rootNode;
    if (projected !== expected) {
      throw new Error(
        `${owner} ${filePath}#${slot.id}: actual value ${JSON.stringify(projected)} differs from ${isRustSlot ? "root Rust channel" : "root engines.node"} ${JSON.stringify(expected)}`,
      );
    }
  }
}

export async function validateRegistryMirrorSlotProjections(
  receipt: GeneratedScenarioReceipt,
): Promise<void> {
  await validatePlanMirrorSlotProjections({ receipt });
}

export async function validateGeneratedScenarioReceipt(options: {
  readonly receipt: GeneratedScenarioReceipt;
  readonly runtime: GeneratedScenarioRuntime;
}): Promise<void> {
  await validatePlanSources(options);
  await validatePlanDependencyCatalog(
    options.receipt.result,
    options.receipt.projectDir,
    options.receipt.scenario.id,
  );
  await assertGeneratedManifestPublicationPolicy({
    result: options.receipt.result,
    projectDir: options.receipt.projectDir,
    scenarioId: options.receipt.scenario.id,
  });
  await validateGeneratedDevelopmentContainerProjection({
    receipt: options.receipt,
  });
  await validateRegistryMirrorSlotProjections(options.receipt);
}
