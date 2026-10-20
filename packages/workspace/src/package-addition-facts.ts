import { readFileSync } from "node:fs";
import path from "node:path";

const nodeMajorOrExactVersionPattern = /^([0-9]+)(?:\.([0-9]+)\.([0-9]+))?$/u;
const exactPnpmPinPattern =
  /^pnpm@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

export class WorkspacePackageAdditionFailure extends Error {
  readonly suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.suggestion = suggestion;
  }
}

export type PackageAdditionVersionFacts = {
  readonly toolchain: {
    readonly nodeLtsMajor: string;
    readonly nodeVersion?: string;
    readonly packageManagerPin: string;
  };
  readonly rootNodeDeclaration: string;
};

const sharedPackageContractSuggestion =
  "请先显式修正或迁移生成记录及共同包接口；新增操作不会推测身份或覆盖已有定制。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 加包按目标根当前的合法 Node 与 pnpm 声明解释版本，不回退初始化快照。 */
export function readPackageAdditionVersionFacts(
  repositoryRoot: string,
): PackageAdditionVersionFacts {
  const manifestPath = path.join(repositoryRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Package Addition requires root Manifest in package.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      "Package Addition requires root Manifest in package.json to be an object",
    );
  }

  const nodeDeclaration = isRecord(parsed.engines)
    ? parsed.engines.node
    : undefined;
  const nodeDeclarationMatch =
    typeof nodeDeclaration === "string"
      ? nodeMajorOrExactVersionPattern.exec(nodeDeclaration)
      : undefined;
  const nodeLtsMajor = nodeDeclarationMatch?.[1];
  if (nodeLtsMajor === undefined || typeof nodeDeclaration !== "string") {
    throw new WorkspacePackageAdditionFailure(
      `加包需要目标仓库根 package.json 的 engines.node 声明单个 Node 大版本（"24"）或精确 Node 版本（"24.16.0"），实际收到 ${JSON.stringify(nodeDeclaration ?? null)}。请先修改根 package.json 的 engines.node 声明再加包。`,
      "请先修改根 package.json 的 engines.node 声明再加包。",
    );
  }

  const packageManagerDeclaration = parsed.packageManager;
  if (
    typeof packageManagerDeclaration !== "string" ||
    !exactPnpmPinPattern.test(packageManagerDeclaration)
  ) {
    throw new WorkspacePackageAdditionFailure(
      `加包需要目标仓库根 package.json 的 packageManager 声明精确 pnpm 版本（"pnpm@11.21.0"），实际收到 ${JSON.stringify(packageManagerDeclaration ?? null)}。请先修改根 package.json 的 packageManager 声明再加包。`,
      "请先修改根 package.json 的 packageManager 声明再加包。",
    );
  }

  return {
    toolchain: {
      nodeLtsMajor,
      packageManagerPin: packageManagerDeclaration,
      ...(nodeDeclarationMatch?.[2] === undefined
        ? {}
        : { nodeVersion: nodeDeclaration }),
    },
    rootNodeDeclaration: nodeDeclaration,
  };
}

/** 核对已有依赖包仍提供原生声明的公开接口，并允许其指向本地定制文件。 */
export function assertReusablePackageExposure(options: {
  readonly repositoryRoot: string;
  readonly packagePath: string;
  readonly expectedExports: Readonly<Record<string, unknown>>;
  readonly actualManifest?: Readonly<Record<string, unknown>>;
}): void {
  let actualManifest = options.actualManifest;
  if (actualManifest === undefined) {
    try {
      const parsed = JSON.parse(
        readFileSync(
          path.join(
            options.repositoryRoot,
            options.packagePath,
            "package.json",
          ),
          "utf8",
        ),
      ) as unknown;
      if (!isRecord(parsed)) throw new Error("manifest 必须是对象");
      actualManifest = parsed;
    } catch {
      throw new WorkspacePackageAdditionFailure(
        `共同包 ${options.packagePath} 缺少有效 manifest，不能复用。`,
        sharedPackageContractSuggestion,
      );
    }
  }

  for (const exportName of Object.keys(options.expectedExports)) {
    const target = isRecord(actualManifest.exports)
      ? actualManifest.exports[exportName]
      : undefined;
    // 条件与回退数组由 Node 解释；这里只拦截明确不可用的接口声明。
    if (
      typeof target !== "string" &&
      !isRecord(target) &&
      !Array.isArray(target)
    ) {
      throw new WorkspacePackageAdditionFailure(
        `共同包 ${options.packagePath} 缺少可用的公开接口 ${exportName}。`,
        sharedPackageContractSuggestion,
      );
    }
    if (typeof target === "string") {
      try {
        if (!target.startsWith("./")) throw new Error("公开资源必须属于该包");
        readFileSync(
          path.join(options.repositoryRoot, options.packagePath, target),
        );
      } catch {
        throw new WorkspacePackageAdditionFailure(
          `共同包 ${options.packagePath} 的公开接口 ${exportName} 不可读取。`,
          sharedPackageContractSuggestion,
        );
      }
    }
  }
}
