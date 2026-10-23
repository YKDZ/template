import type {
  PackageDefinitionId,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "./project-blueprint.ts";
import type {
  ProjectProjection,
  ProjectProjectionEntry,
  ProjectProjectionReconciliation,
} from "./project-projection.ts";

export type PackageContributionFile = Omit<
  ProjectProjectionEntry,
  "path" | "kind"
> & {
  /** 相对所属包目录的规范路径。 */
  readonly path: string;
};

/** 一次生成实例求得的完整文件及其领域事实。 */
export type PackageContribution<Facts = unknown> = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly files: readonly PackageContributionFile[];
  /** 路径相对所属包目录。 */
  readonly reconciliation?: readonly ProjectProjectionReconciliation[];
  readonly facts: Facts;
};

export type CompositionFile = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly file: PackageContributionFile;
};

export type CompositionReconciliation = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly reconciliation: ProjectProjectionReconciliation;
};

function canonicalRelativeFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    value.split("/").every((part) => part.length > 0) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

function packageDirectoryContains(
  directory: string,
  filePath: string,
): boolean {
  return directory === "." || filePath.startsWith(`${directory}/`);
}

function directoryDepth(directory: string): number {
  return directory === "." ? 0 : directory.split("/").length;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fileOwner(
  packages: readonly PersistedPackageDefinition[],
  targetPath: string,
): PersistedPackageDefinition | undefined {
  return packages
    .filter((definition) =>
      packageDirectoryContains(definition.path, targetPath),
    )
    .toSorted(
      (left, right) => directoryDepth(right.path) - directoryDepth(left.path),
    )[0];
}

function targetPathFor(
  definition: PersistedPackageDefinition,
  relativePath: string,
): string {
  return definition.path === "."
    ? relativePath
    : `${definition.path}/${relativePath}`;
}

function requirePackage(
  packages: ReadonlyMap<PackageDefinitionId, PersistedPackageDefinition>,
  id: PackageDefinitionId,
): PersistedPackageDefinition {
  const definition = packages.get(id);
  if (definition === undefined) {
    throw new Error(`包贡献引用了未知实例：${id}`);
  }
  return definition;
}

function assertOwnedPath(options: {
  readonly blueprint: ProjectBlueprint;
  readonly definition: PersistedPackageDefinition;
  readonly relativePath: string;
  readonly reservedPaths: ReadonlySet<string>;
}): string {
  const targetPath = targetPathFor(options.definition, options.relativePath);
  if (!canonicalRelativeFilePath(options.relativePath)) {
    throw new Error(
      `包贡献输出路径必须是规范相对路径；${options.definition.name}尝试写入 ${options.relativePath}`,
    );
  }
  const conflictsWithReservedPath = [...options.reservedPaths].some(
    (reservedPath) =>
      targetPath === reservedPath ||
      targetPath.startsWith(`${reservedPath}/`) ||
      reservedPath.startsWith(`${targetPath}/`),
  );
  if (conflictsWithReservedPath) {
    throw new Error(
      `包贡献路径与生成器元数据路径冲突；${options.definition.name}尝试写入 ${targetPath}`,
    );
  }
  const owner = fileOwner(options.blueprint.packages, targetPath);
  if (owner === undefined) {
    throw new Error(`项目输出没有对应的软件包拥有者：${targetPath}`);
  }
  if (owner.packageDefinitionId !== options.definition.packageDefinitionId) {
    throw new Error(
      `包贡献越过所属目录边界：${options.definition.path}尝试写入 ${targetPath}，该路径归属于 ${owner.path}`,
    );
  }
  return targetPath;
}

/** 将包内相对文件汇总成一个经过全拓扑归属检查的项目投影。 */
export function projectPackageContributions(options: {
  readonly blueprint: ProjectBlueprint;
  readonly contributions: readonly PackageContribution[];
  readonly compositionFiles?: readonly CompositionFile[];
  readonly compositionReconciliation?: readonly CompositionReconciliation[];
}): ProjectProjection {
  const definitions = new Map(
    options.blueprint.packages.map((definition) => [
      definition.packageDefinitionId,
      definition,
    ]),
  );
  const entries: ProjectProjectionEntry[] = [];
  const reconciliation: ProjectProjectionReconciliation[] = [];
  const outputPaths = new Set<string>();
  const policyPaths = new Set<string>();
  const reservedPaths = new Set([
    ".template/blueprint.json",
    ".template/generation.json",
  ]);

  const addFile = (
    packageDefinitionId: PackageDefinitionId,
    file: PackageContributionFile,
  ): void => {
    const definition = requirePackage(definitions, packageDefinitionId);
    const path = assertOwnedPath({
      blueprint: options.blueprint,
      definition,
      relativePath: file.path,
      reservedPaths,
    });
    if (outputPaths.has(path)) {
      throw new Error(`项目文件树包含重复输出路径：${path}`);
    }
    if (!(file.content instanceof Uint8Array)) {
      throw new Error(`项目文件内容必须是字节：${path}`);
    }
    if (
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      (file.mode & ~0o111) !== 0
    ) {
      throw new Error(`项目文件权限模式无效：${path}`);
    }
    outputPaths.add(path);
    entries.push({
      ...file,
      path,
      kind: "file",
      content: file.content.slice(),
      mode: file.mode,
    });
  };

  for (const contribution of options.contributions) {
    for (const file of contribution.files) {
      addFile(contribution.packageDefinitionId, file);
    }
    const definition = requirePackage(
      definitions,
      contribution.packageDefinitionId,
    );
    for (const policy of contribution.reconciliation ?? []) {
      const path = assertOwnedPath({
        blueprint: options.blueprint,
        definition,
        relativePath: policy.path,
        reservedPaths,
      });
      if (policyPaths.has(path)) {
        throw new Error(`项目文件树包含重复协调路径：${path}`);
      }
      policyPaths.add(path);
      reconciliation.push({ ...policy, path });
    }
  }

  for (const item of options.compositionFiles ?? []) {
    addFile(item.packageDefinitionId, item.file);
  }
  for (const item of options.compositionReconciliation ?? []) {
    const definition = requirePackage(definitions, item.packageDefinitionId);
    const path = assertOwnedPath({
      blueprint: options.blueprint,
      definition,
      relativePath: item.reconciliation.path,
      reservedPaths,
    });
    if (policyPaths.has(path)) {
      throw new Error(`项目文件树包含重复协调路径：${path}`);
    }
    policyPaths.add(path);
    reconciliation.push({ ...item.reconciliation, path });
  }

  for (const entry of entries) {
    if (!policyPaths.has(entry.path)) {
      throw new Error(`项目文件缺少协调规则：${entry.path}`);
    }
  }
  for (const policyPath of policyPaths) {
    if (!outputPaths.has(policyPath)) {
      throw new Error(`项目协调规则引用了未知路径：${policyPath}`);
    }
  }
  const sortedPaths = entries.map((entry) => entry.path).toSorted();
  for (let index = 0; index < sortedPaths.length; index += 1) {
    const current = sortedPaths[index]!;
    const next = sortedPaths[index + 1];
    if (next !== undefined && next.startsWith(`${current}/`)) {
      throw new Error(`项目文件与目录路径冲突：${current} 和 ${next}`);
    }
  }

  return {
    entries: entries.toSorted((left, right) =>
      comparePaths(left.path, right.path),
    ),
    reconciliation: reconciliation.toSorted((left, right) =>
      comparePaths(left.path, right.path),
    ),
  };
}
