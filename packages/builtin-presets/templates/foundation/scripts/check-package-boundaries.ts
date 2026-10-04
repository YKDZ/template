import {
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isWorkspaceProjectDir } from "@pnpm/workspace.package-patterns";
import { parse } from "shell-quote";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

/** 成员真源基准：仓库根以 realpath 为准，仓库整体位于链接之下时同一判定。 */
const repositoryRoot = realpathSync.native(process.cwd());

const fileSystemModules = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
]);

/** 有限静态求值认识的 node:path 与 node:url 入口；其他模块的函数不求值。 */
const pathModules = new Set(["path", "node:path"]);
const urlModules = new Set(["url", "node:url"]);
const pathFunctions = new Set(["dirname", "join", "resolve"]);
const urlFunctions = new Set(["fileURLToPath"]);

/** 已知 node:fs 入口的路径参数位置；其余参数（编码、data、options）不是路径。 */
const fileSystemPathArguments: Readonly<Record<string, readonly number[]>> = {
  access: [0],
  accessSync: [0],
  appendFile: [0],
  appendFileSync: [0],
  copyFile: [0, 1],
  copyFileSync: [0, 1],
  createReadStream: [0],
  createWriteStream: [0],
  existsSync: [0],
  lstat: [0],
  lstatSync: [0],
  mkdir: [0],
  mkdirSync: [0],
  mkdtemp: [0],
  mkdtempSync: [0],
  open: [0],
  openSync: [0],
  readFile: [0],
  readFileSync: [0],
  readdir: [0],
  readdirSync: [0],
  realpath: [0],
  realpathSync: [0],
  rename: [0, 1],
  renameSync: [0, 1],
  rm: [0],
  rmdir: [0],
  rmdirSync: [0],
  rmSync: [0],
  stat: [0],
  statSync: [0],
  unwatchFile: [0],
  watch: [0],
  watchFile: [0],
  writeFile: [0],
  writeFileSync: [0],
};

/** 官方 workspace 遍历忽略的依赖投影目录。 */
const dependencyDirectories = new Set(["bower_components", "node_modules"]);
const derivedDirectories = new Set([
  ".turbo",
  "coverage",
  "dist",
  "playwright-report",
  "target",
  "test-results",
]);
const authoredExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);

/** 语言门扫描的普通持久维护自动化扩展名；`.sh` 只依封闭角色放行。 */
const maintenanceExtensions = new Set([".cjs", ".js", ".mjs", ".sh"]);
/** 生成仓库 gitignore 标记为运行数据的目录，不是 authored 维护源码。 */
const runtimeDirectories = new Set(["data"]);
/** gitignore 中的生成与缓存目录加版本库元数据；authored 点目录（如 .github、.devcontainer 与作者自建隐藏目录）不在此列。 */
const nonAuthoredDirectories = new Set([".git", ".pnpm-store", ".template"]);
/** 成员发现与全部扫描面共用的封闭角色名集：依赖、缓存/派生、VCS 与运行数据。 */
const nonAuthoredDirectoryNames = new Set([
  ...dependencyDirectories,
  ...derivedDirectories,
  ...runtimeDirectories,
  ...nonAuthoredDirectories,
]);
/** 封闭的根维护角色；位置本身不构成豁免，只有这些精确角色路径可用。 */
const rootAutomationScriptPaths = new Set([
  "scripts/container-entrypoint.sh",
  "scripts/npm-publication-setup/setup.sh",
]);
const rootPackingHookPath = ".pnpmfile.mjs";

/** 公开资源分支的窄授权只覆盖被请求的 package subpath 与其有效 runtime target。 */
type PublicGrant = {
  readonly provider: PackageBoundary;
  readonly subpath: string;
  readonly targetPath: string;
};

type PackageBoundary = {
  readonly dependencies: ReadonlySet<string>;
  readonly directory: string;
  readonly exports: unknown;
  readonly isRepositoryRoot: boolean;
  readonly name: string;
  /** 该边界的全部词法拼写：成员根的真实目录拼写与发现期间跟随链接得到的别名路径。 */
  readonly ownerDirectories: readonly string[];
  readonly relativePath: string;
  readonly rootRealPath: string;
};

/** 一次发现 workspace 的结果；语言门、路径归属与公开 provider 扫描面共用同一布局。 */
type WorkspaceLayout = {
  readonly memberDirectories: ReadonlySet<string>;
  readonly ownersByDirectory: ReadonlyMap<string, PackageBoundary>;
  readonly packages: readonly PackageBoundary[];
  readonly patterns: readonly string[];
};

/** 发现遍历里的单个成员候选：词法路径、真实身份与所跟随的链接段数。 */
type DiscoveredMember = {
  readonly directory: string;
  readonly identity: string;
  readonly linkDepth: number;
  readonly manifestBasename: string;
  readonly relativePath: string;
  readonly rootRealPath: string;
};

/** 目录条目的真实身份与真实路径；linkDepth 记录该词法路径上被跟随的链接段数。 */
type DirectoryFacts = {
  readonly directory: string;
  readonly identity: string;
  readonly linkDepth: number;
  readonly realPath: string;
};

type BoundaryDiagnostic = {
  readonly column: number;
  /** 交给文件系统的原值与词法归一结果不同时的原值，说明物理判定依据的输入形态。 */
  readonly input: string | undefined;
  readonly line: number;
  readonly owner: PackageBoundary;
  readonly realPath: string | undefined;
  readonly sourceFile: string;
  readonly target: PackageBoundary;
  readonly targetPath: string;
};

/** native realpath 或存在性前缀真实失败时的原因；不猜目标包，也不回退非 native 解析。 */
type UnverifiablePhysicalDiagnostic = {
  readonly column: number;
  readonly input: string;
  readonly line: number;
  readonly owner: PackageBoundary;
  readonly reason: string;
  readonly sourceFile: string;
};

/** 真实位置落在仓库根之外：如实标注工作区外目标，不伪造 owner。 */
type OutsideRepositoryDiagnostic = {
  readonly column: number;
  readonly input: string;
  readonly line: number;
  readonly owner: PackageBoundary;
  readonly realPath: string;
  readonly sourceFile: string;
};

/** 已确认 fs API 路径参数或独立路径构造无法静态求值；不虚构目标，只报告源位置与所属包。 */
type UnverifiableDiagnostic = {
  readonly column: number;
  readonly context: "path-construction" | "system-argument";
  readonly line: number;
  readonly owner: PackageBoundary;
  readonly sourceFile: string;
};

/** 公开契约可被静态判定却违反时的失败原因；无法可靠解释的形态不算失败。 */
type PublicContractReason =
  | "directory-target"
  | "invalid-target"
  | "missing-dependency"
  | "subpath-not-public"
  | "types-only";

/** 已确认 fs API 路径参数中带 import.meta.resolve 的公开契约失败。 */
type PublicContractViolation = {
  readonly packageName: string;
  readonly reason: PublicContractReason;
  readonly specifier: string;
  readonly subpath: string;
};

type PublicContractDiagnostic = {
  readonly column: number;
  readonly line: number;
  readonly owner: PackageBoundary;
  readonly packageName: string;
  readonly reason: PublicContractReason;
  readonly sourceFile: string;
  readonly specifier: string;
  readonly subpath: string;
};

/**
 * 有限求值的值域：路径字符串（绝对，或相对包目录锚点）与 file URL；grant 只标注被请求的公开资源本身。
 * `raw` 表示该值就是程序交给 fs API 的原值（字面量或顶层常量指向的同一字面量），
 * 内核会先跟随链接再在同一目录消费 `..`；没有该标记的值已由 `path.join`/`resolve`/`URL` 归一。
 */
type StaticValue =
  | {
      readonly grant?: PublicGrant;
      readonly kind: "path";
      readonly raw?: true;
      readonly value: string;
    }
  | {
      readonly grant?: PublicGrant;
      readonly kind: "url";
      readonly value: string;
    };

/** 已定位的 fs 路径参数；公开分支授予的资源本身不进入 containment 结论。 */
type LocatedTarget = {
  /** 词法折叠后的绝对位置，沿用 06/12A 已验收的祖先链归属与仓库内判定。 */
  readonly path: string;
  /** 程序实际交给 fs 的绝对原值：未归一 literal 保留 `link/..` 与 `/.`、`/./` 形态，已归一构造值与 path 相同。 */
  readonly physicalInput: string;
  readonly publicGrant?: PublicGrant;
};

/** workspace 成员发现的输入无法按官方协议解释，或成员 manifest 损坏时的明确失败；不回退目录树发现，也不吞掉读取错误。 */
class WorkspaceDiscoveryFailure extends Error {}

const defaultWorkspacePatterns = [".", "**"];
/** 官方成员协议的 manifest 名；只有 package.json 提供身份名，其余成员形态用相对路径标签。 */
const memberManifestBasenames = [
  "package.json",
  "package.json5",
  "package.yaml",
] as const;

function isNotFound(error: unknown): boolean {
  return fileSystemErrorCode(error) === "ENOENT";
}

function fileSystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return String(error.code);
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 相对仓库根的展示路径；`/` 分隔，仓库根本身呈现为 `.`。 */
function relativePathOf(directory: string): string {
  const relative = path.relative(repositoryRoot, directory);

  return (relative === "" ? "." : relative).split(path.sep).join("/");
}

function directoryIdentity(directory: string): string {
  try {
    const stats = statSync(directory);

    return `${String(stats.dev)}:${String(stats.ino)}`;
  } catch (error) {
    throw new WorkspaceDiscoveryFailure(
      `无法取得 ${relativePathOf(directory)} 的真实身份：${failureReason(error)}`,
    );
  }
}

/**
 * 只消费根 pnpm-workspace.yaml 的 packages 字段：缺失或空 YAML 走默认 ['.', '**']，显式空序列只有根。
 * 正/负模式语义交给官方模块，这里只做允许输入校验与明确失败。
 */
function readWorkspacePatterns(): string[] {
  const manifestPath = path.join(repositoryRoot, "pnpm-workspace.yaml");
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return defaultWorkspacePatterns;
    throw new WorkspaceDiscoveryFailure(
      `无法读取 pnpm-workspace.yaml：${failureReason(error)}`,
    );
  }
  if (text.trim().length === 0) return defaultWorkspacePatterns;

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new WorkspaceDiscoveryFailure(
      `pnpm-workspace.yaml 不是合法 YAML：${failureReason(error)}`,
    );
  }
  if (document === null || document === undefined) {
    return defaultWorkspacePatterns;
  }
  if (!isPlainObject(document)) {
    throw new WorkspaceDiscoveryFailure(
      "pnpm-workspace.yaml 顶层不是映射，无法读取 packages。",
    );
  }
  if (!Object.hasOwn(document, "packages")) return defaultWorkspacePatterns;

  const declared = document["packages"];
  if (!Array.isArray(declared)) {
    throw new WorkspaceDiscoveryFailure(
      "pnpm-workspace.yaml 的 packages 必须是字符串序列。",
    );
  }
  const patterns: string[] = [];
  for (const pattern of declared) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new WorkspaceDiscoveryFailure(
        `pnpm-workspace.yaml 的 packages 含空项或非字符串项：${JSON.stringify(pattern)}`,
      );
    }
    const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (body.startsWith("/")) {
      throw new WorkspaceDiscoveryFailure(
        `pnpm-workspace.yaml 的 packages 含绝对模式 ${pattern}，超出检查器允许输入。`,
      );
    }
    patterns.push(pattern);
  }

  return patterns;
}

/** 目录条目的真实身份与真实路径；断链与非目录条目按官方 NotFound/ENOTDIR 吸收为“不是目录”。 */
function directoryEntryFacts(
  entry: Dirent,
  entryPath: string,
  parent: DirectoryFacts,
): DirectoryFacts | undefined {
  const isSymbolicLink = entry.isSymbolicLink();
  if (!isSymbolicLink && !entry.isDirectory()) return undefined;

  let stats;
  try {
    // 链接条目按目标形态判定，与官方 entry_is_directory 的 is_dir()/metadata(path).is_dir() 同一形态。
    stats = statSync(entryPath);
  } catch (error) {
    if (
      isNotFound(error) ||
      fileSystemErrorCode(error) === "ENOTDIR" ||
      fileSystemErrorCode(error) === "ELOOP"
    ) {
      return undefined;
    }
    throw new WorkspaceDiscoveryFailure(
      `无法判定 ${relativePathOf(entryPath)}：${failureReason(error)}`,
    );
  }
  if (!stats.isDirectory()) return undefined;

  let realPath: string;
  if (isSymbolicLink) {
    try {
      realPath = realpathSync.native(entryPath);
    } catch (error) {
      if (
        isNotFound(error) ||
        fileSystemErrorCode(error) === "ENOTDIR" ||
        fileSystemErrorCode(error) === "ELOOP"
      ) {
        return undefined;
      }
      throw new WorkspaceDiscoveryFailure(
        `无法解析链接目录 ${relativePathOf(entryPath)}：${failureReason(error)}`,
      );
    }
  } else {
    realPath = path.join(parent.realPath, entry.name);
  }

  return {
    directory: entryPath,
    identity: `${String(stats.dev)}:${String(stats.ino)}`,
    linkDepth: parent.linkDepth + (isSymbolicLink ? 1 : 0),
    realPath,
  };
}

/** 命中模式的目录必须有 manifest 才是成员；manifest 名只按官方三个 basename 判定。 */
function memberManifestBasename(directory: string): string | undefined {
  for (const basename of memberManifestBasenames) {
    const manifestPath = path.join(directory, basename);
    try {
      if (statSync(manifestPath).isFile()) return basename;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw new WorkspaceDiscoveryFailure(
        `无法读取成员 manifest ${relativePathOf(manifestPath)}：${failureReason(error)}`,
      );
    }
  }

  return undefined;
}

/** 成员契约只为已判定为成员的目录解析 package.json；损坏 JSON 与非 ENOENT 读取错误明确失败，非成员 manifest 从不解析。 */
function readMemberContract(
  directory: string,
  manifestBasename: string | undefined,
): {
  readonly dependencies: ReadonlySet<string>;
  readonly exports: unknown;
  readonly name: string | undefined;
} {
  const empty = {
    dependencies: new Set<string>(),
    exports: undefined,
    name: undefined,
  };
  if (manifestBasename !== "package.json") return empty;

  const manifestPath = path.join(directory, manifestBasename);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return empty;
    throw new WorkspaceDiscoveryFailure(
      `成员 manifest ${relativePathOf(manifestPath)} 无法解析：${failureReason(error)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new WorkspaceDiscoveryFailure(
      `成员 manifest ${relativePathOf(manifestPath)} 不是映射。`,
    );
  }
  const manifest = parsed as {
    dependencies?: unknown;
    devDependencies?: unknown;
    exports?: unknown;
    name?: unknown;
    optionalDependencies?: unknown;
    peerDependencies?: unknown;
  };
  const dependencies = new Set<string>();
  for (const field of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (!isPlainObject(field)) continue;
    for (const name of Object.keys(field)) dependencies.add(name);
  }

  return {
    dependencies,
    exports: manifest.exports,
    name:
      typeof manifest.name === "string" && manifest.name.length > 0
        ? manifest.name
        : undefined,
  };
}

/**
 * 一次发现：从 realpath 化的仓库根出发，跟随目录链接询问每个候选目录，只按三类剪枝——
 * 封闭角色名集、当前分支祖先链上的真实身份重复（环）与真实身份在仓库根之外。
 * 成员目录继续下钻，因此嵌套成员与只能经链接词法路径命中的后代都会被询问到。
 */
function discoverWorkspaceMembers(patterns: string[]): DiscoveredMember[] {
  const members: DiscoveredMember[] = [];
  const visit = (
    frame: DirectoryFacts,
    ancestorIdentities: ReadonlySet<string>,
  ): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(frame.directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw new WorkspaceDiscoveryFailure(
        `无法读取目录 ${relativePathOf(frame.directory)}：${failureReason(error)}`,
      );
    }

    for (const entry of entries.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (nonAuthoredDirectoryNames.has(entry.name)) continue;
      const entryPath = path.join(frame.directory, entry.name);
      const child = directoryEntryFacts(entry, entryPath, frame);
      if (child === undefined) continue;
      // 环检测只作用于当前分支；同一真实目录经其它非环词法路径仍会被询问。
      if (ancestorIdentities.has(child.identity)) continue;
      // 真实身份落在仓库根之外的链接树不进入扫描面，也不建立成员身份。
      if (!isInsideDirectory(child.realPath, repositoryRoot)) continue;
      if (
        isWorkspaceProjectDir({
          dir: entryPath,
          patterns,
          workspaceDir: repositoryRoot,
        })
      ) {
        const manifestBasename = memberManifestBasename(entryPath);
        if (manifestBasename !== undefined) {
          members.push({
            directory: entryPath,
            identity: child.identity,
            linkDepth: child.linkDepth,
            manifestBasename,
            relativePath: relativePathOf(entryPath),
            rootRealPath: child.realPath,
          });
        }
      }
      visit(child, new Set([...ancestorIdentities, child.identity]));
    }
  };

  const root: DirectoryFacts = {
    directory: repositoryRoot,
    identity: directoryIdentity(repositoryRoot),
    linkDepth: 0,
    realPath: repositoryRoot,
  };
  visit(root, new Set([root.identity]));

  return members;
}

/** 同一真实目录的 owner 优先取不含被跟随链接段的词法路径，其次路径最短，再字典序最小。 */
function preferMemberRecord(
  left: DiscoveredMember,
  right: DiscoveredMember,
): number {
  return (
    Number(left.linkDepth !== 0) - Number(right.linkDepth !== 0) ||
    left.relativePath.length - right.relativePath.length ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

/** 真实身份折叠只在发现完成后进行：链接别名不形成第二个 Package Boundary，也不决定发现与否。 */
function foldDiscoveredMembers(members: readonly DiscoveredMember[]): {
  readonly identity: string;
  readonly records: readonly DiscoveredMember[];
}[] {
  const grouped = new Map<string, DiscoveredMember[]>();
  for (const member of members.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    const group = grouped.get(member.identity);
    if (group === undefined) grouped.set(member.identity, [member]);
    else group.push(member);
  }

  return [...grouped.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([identity, records]) => ({ identity, records }));
}

/** 一次发现 workspace 成员与扫描面；根恒为成员，是 Workspace Orchestration Package，不受普通包规则约束。 */
function discoverWorkspaceLayout(): WorkspaceLayout {
  const patterns = readWorkspacePatterns();
  const rootContract = readMemberContract(
    repositoryRoot,
    memberManifestBasename(repositoryRoot),
  );
  const packages: PackageBoundary[] = [
    {
      dependencies: rootContract.dependencies,
      directory: repositoryRoot,
      exports: rootContract.exports,
      isRepositoryRoot: true,
      name: rootContract.name ?? path.basename(repositoryRoot),
      ownerDirectories: [repositoryRoot],
      relativePath: ".",
      rootRealPath: repositoryRoot,
    },
  ];

  for (const { records } of foldDiscoveredMembers(
    discoverWorkspaceMembers(patterns),
  )) {
    const canonical = records.toSorted(preferMemberRecord)[0]!;
    const contract = readMemberContract(
      canonical.directory,
      canonical.manifestBasename,
    );
    const ownerDirectories = [
      ...new Set([
        canonical.directory,
        canonical.rootRealPath,
        ...records.map((record) => record.directory),
      ]),
    ];
    packages.push({
      dependencies: contract.dependencies,
      directory: canonical.directory,
      exports: contract.exports,
      isRepositoryRoot: false,
      name: contract.name ?? canonical.relativePath,
      ownerDirectories,
      relativePath: canonical.relativePath,
      rootRealPath: canonical.rootRealPath,
    });
  }

  const ordered = packages.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const memberDirectories = new Set<string>();
  const ownersByDirectory = new Map<string, PackageBoundary>();
  for (const boundary of ordered) {
    for (const directory of boundary.ownerDirectories) {
      memberDirectories.add(directory);
      if (!ownersByDirectory.has(directory))
        ownersByDirectory.set(directory, boundary);
    }
  }

  return { memberDirectories, ownersByDirectory, packages: ordered, patterns };
}

/** 扫描面内的子目录：封闭角色名集与其它成员根不进入本边界的扫描面。 */
function isScannableChildDirectory(
  layout: WorkspaceLayout,
  entryPath: string,
  name: string,
): boolean {
  return (
    !nonAuthoredDirectoryNames.has(name) &&
    !layout.memberDirectories.has(entryPath)
  );
}

function authoredSourceFiles(
  layout: WorkspaceLayout,
  boundary: PackageBoundary,
): string[] {
  const files: string[] = [];
  const pending = [boundary.directory];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (!entry.isDirectory()) {
        if (authoredExtensions.has(path.extname(entry.name)))
          files.push(entryPath);
        continue;
      }
      if (!isScannableChildDirectory(layout, entryPath, entry.name)) {
        continue;
      }
      pending.push(entryPath);
    }
  }

  return files.toSorted();
}

function maintenanceFiles(
  layout: WorkspaceLayout,
  boundary: PackageBoundary,
): string[] {
  const files: string[] = [];
  const pending = [boundary.directory];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (!entry.isDirectory()) {
        if (maintenanceExtensions.has(path.extname(entry.name))) {
          files.push(entryPath);
        }
        continue;
      }
      if (isScannableChildDirectory(layout, entryPath, entry.name)) {
        pending.push(entryPath);
      }
    }
  }

  return files.toSorted();
}

/** 根 hook 的 checkJs 归属只经 TypeScript 配置 API 核实一次，不解析代码内容。 */
let rootPackingHookChecked: boolean | undefined;

function isInCheckJsProject(targetPath: string): boolean {
  rootPackingHookChecked ??= (() => {
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    };
    // 显式 files 登记决定 .mjs 成员归属；include glob 只匹配 TS 扩展，多余的
    // extraFileExtensions 不能把普通 JS 变成项目成员。
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path.join(repositoryRoot, "tsconfig.json"),
      undefined,
      host,
    );
    if (parsed === undefined || parsed.options.checkJs !== true) return false;
    const realTarget = ts.sys.realpath?.(targetPath) ?? targetPath;

    return parsed.fileNames.some(
      (fileName) => ts.sys.realpath?.(fileName) === realTarget,
    );
  })();

  return rootPackingHookChecked;
}

type MaintenanceDiagnostic = {
  readonly file: string;
  readonly kind: "packing-hook" | "plain-script";
};

function maintenanceDiagnostics(
  layout: WorkspaceLayout,
  boundary: PackageBoundary,
): MaintenanceDiagnostic[] {
  const found: MaintenanceDiagnostic[] = [];
  for (const filePath of maintenanceFiles(layout, boundary)) {
    const relative = path
      .relative(repositoryRoot, filePath)
      .split(path.sep)
      .join("/");
    const extension = path.extname(filePath);
    if (
      boundary.isRepositoryRoot &&
      relative === rootPackingHookPath &&
      extension === ".mjs"
    ) {
      if (!isInCheckJsProject(filePath)) {
        found.push({ file: relative, kind: "packing-hook" });
      }
      continue;
    }
    if (
      boundary.isRepositoryRoot &&
      extension === ".sh" &&
      rootAutomationScriptPaths.has(relative)
    ) {
      continue;
    }
    found.push({ file: relative, kind: "plain-script" });
  }

  return found;
}

function renderMaintenanceDiagnostic(
  diagnostic: MaintenanceDiagnostic,
): string {
  const { file, kind } = diagnostic;
  const isShell = file.endsWith(".sh");
  const repair =
    kind === "packing-hook"
      ? "pnpm 打包 hook 必须由根 tsconfig.json 以 allowJs/checkJs 的 files 登记为真实项目成员后才作为封闭角色存在。"
      : `把维护自动化迁移为 scripts/**/*.ts 下可擦除的 TypeScript${isShell ? "，或改用根 package.json/turbo.json 等工具原生配置表达" : " 表达"}；封闭角色只有根 .pnpmfile.mjs、scripts/container-entrypoint.sh 与 scripts/npm-publication-setup/setup.sh。`;

  return [
    `${file} 维护脚本语言门：普通持久维护自动化不允许使用${isShell ? " Shell 脚本" : " JavaScript"}。`,
    `  修正方向：${repair}`,
  ].join("\n");
}

/**
 * 目标路径的所属包：沿词法祖先链取第一个登记的成员根，因此嵌套成员比外层包更具体；
 * 链接别名与真实拼写都在同一映射中，任一拼写都折叠到同一个边界（M2/M3/M7）。
 */
function owningBoundary(
  layout: WorkspaceLayout,
  targetPath: string,
): PackageBoundary {
  for (let current = targetPath; ; current = path.dirname(current)) {
    const owner = layout.ownersByDirectory.get(current);
    if (owner !== undefined) return owner;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Path escapes the filesystem root: ${targetPath}`);
    }
  }
}

/** 已解析过的绝对值与前缀；只是内部可逆缓存，不改变判定次序。 */
const physicalResolutionCache = new Map<
  string,
  PhysicalTarget | UnresolvableTarget
>();
const prefixRealPathCache = new Map<string, string | UnresolvableTarget>();

type PhysicalTarget = {
  readonly kind: "real";
  readonly real: string;
};

type UnresolvableTarget = {
  readonly kind: "unresolvable";
  readonly reason: string;
};

/** 存在性前缀与 native realpath 的真实失败码：ENOENT、ELOOP、EACCES、ENOTDIR 等。 */
function resolutionFailureReason(error: unknown): string {
  const code = fileSystemErrorCode(error);

  return code === undefined ? failureReason(error) : code;
}

function unresolvable(reason: string): UnresolvableTarget {
  return { kind: "unresolvable", reason };
}

/**
 * 最长存在前缀：从原值起对逐级父目录做 lstat（只看条目存在，不跟随末段链接）。
 * 断裂链接的条目本身存在，因此前缀停在该处；仓库根必然存在，前缀总有定义。
 * `..` 作为中间段时其存在性由内核判定，与 `./link/..` 在 link 是目录链接时确实存在一致。
 */
function longestExistingPrefix(
  absolutePath: string,
): { readonly prefix: string } | UnresolvableTarget {
  let current = absolutePath;
  for (;;) {
    try {
      lstatSync(current);

      return { prefix: current };
    } catch (error) {
      const reason = resolutionFailureReason(error);
      if (reason !== "ENOENT") return unresolvable(reason);
      const parent = path.dirname(current);
      if (parent === current) return { prefix: current };
      current = parent;
    }
  }
}

/** 最长存在前缀已完全解析、不含链接；指向缺失处的断裂链接其解析失败按真实失败上报。 */
function existingPrefixRealPath(prefix: string): string | UnresolvableTarget {
  const cached = prefixRealPathCache.get(prefix);
  if (cached !== undefined) return cached;

  try {
    const realPath = realpathSync.native(prefix);
    prefixRealPathCache.set(prefix, realPath);

    return realPath;
  } catch (error) {
    const failure = unresolvable(resolutionFailureReason(error));
    prefixRealPathCache.set(prefix, failure);

    return failure;
  }
}

/**
 * 绝对值的真实位置：最长存在前缀 → `realpathSync.native` → 剩余段按文本接回。
 * 只用 native：JS `realpathSync` 先 `path.resolve`，会把 `link/..` 按词法折回本包，
 * 等于把刚丢掉的链接语义重新抹平；因此失败时不回退，也不因末段不存在而放行。
 */
function physicalTargetOf(
  absoluteInput: string,
): PhysicalTarget | UnresolvableTarget {
  const cached = physicalResolutionCache.get(absoluteInput);
  if (cached !== undefined) return cached;

  const resolution = resolvePhysicalTarget(absoluteInput);
  physicalResolutionCache.set(absoluteInput, resolution);

  return resolution;
}

function resolvePhysicalTarget(
  absoluteInput: string,
): PhysicalTarget | UnresolvableTarget {
  const found = longestExistingPrefix(absoluteInput);
  if ("reason" in found) return found;

  const prefix = found.prefix;
  const realPrefix = existingPrefixRealPath(prefix);
  if (typeof realPrefix !== "string") return realPrefix;

  // 剩余段按文本截取而不是 path.relative：`..` 已由内核一侧的前缀消费，接回不再二次折叠。
  const remainder =
    prefix === absoluteInput ? "" : absoluteInput.slice(prefix.length + 1);
  const real =
    remainder.length === 0
      ? realPrefix
      : path.join(realPrefix, remainder.replaceAll(/\/{2,}/gu, "/"));

  return { kind: "real", real };
}

/** 本地名到导入形态的记录；member 别名（`readFileSync as read`）保留被导入的 API 名。 */
type ModuleBinding =
  | { readonly apiName: string; readonly kind: "member" }
  | { readonly kind: "namespace" };

function importedModuleBindings(
  sourceFile: ts.SourceFile,
  modules: ReadonlySet<string>,
  isUsedApi: (apiName: string) => boolean,
): Map<string, ModuleBinding> {
  const bindings = new Map<string, ModuleBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !modules.has(specifier.text)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined)
      bindings.set(clause.name.text, { kind: "namespace" });
    const namedBindings = clause.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      bindings.set(namedBindings.name.text, { kind: "namespace" });
      continue;
    }
    for (const element of namedBindings.elements) {
      const imported = element.propertyName ?? element.name;
      if (ts.isStringLiteral(imported)) continue;
      if (isUsedApi(imported.text)) {
        bindings.set(element.name.text, {
          apiName: imported.text,
          kind: "member",
        });
      }
    }
  }

  return bindings;
}

/** 把调用目标归一为被导入的 API 名；别名标识符与命名空间属性访问都覆盖。 */
function calledApiName(
  callee: ts.Expression,
  bindings: ReadonlyMap<string, ModuleBinding>,
  isShadowed?: (name: string) => boolean,
): string | undefined {
  if (ts.isIdentifier(callee)) {
    // 导入名被词法可达的绑定遮蔽时调用目标不可静态确定，不求值。
    if (isShadowed?.(callee.text)) return undefined;
    const binding = bindings.get(callee.text);
    if (binding === undefined || binding.kind !== "member") return undefined;
    return binding.apiName;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const receiver = callee.expression;
  if (ts.isIdentifier(receiver) && isShadowed?.(receiver.text)) {
    return undefined;
  }
  const binding = ts.isIdentifier(receiver)
    ? bindings.get(receiver.text)
    : undefined;
  if (binding === undefined || binding.kind !== "namespace") return undefined;
  return callee.name.text;
}

/** 顶层 `const` 声明的初始化表达式才可作为同文件事实；嵌套或其他关键字都不算。 */
function isTopLevelConstant(
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
): boolean {
  const declarations = declaration.parent;
  if (!ts.isVariableDeclarationList(declarations)) return false;
  if ((declarations.flags & ts.NodeFlags.Const) === 0) return false;
  const statement = declarations.parent;
  return ts.isVariableStatement(statement) && statement.parent === sourceFile;
}

/** 任意作用域引入的本地名，用于识别对顶层 const 的遮蔽。 */
function boundName(node: ts.Node): string | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node)
  ) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  if (
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportSpecifier(node)
  ) {
    const { name } = node;
    return name === undefined || !ts.isIdentifier(name) ? undefined : name.text;
  }
  if (
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeParameterDeclaration(node)
  ) {
    const { name } = node;
    return name === undefined || !ts.isIdentifier(name) ? undefined : name.text;
  }
  return undefined;
}

function evaluatableConstants(sourceFile: ts.SourceFile): {
  readonly blockedNames: Set<string>;
  readonly constants: Map<string, ts.Expression>;
  readonly shadowNames: Set<string>;
} {
  const topLevel = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declarations = statement.declarationList;
    if ((declarations.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of declarations.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.initializer !== undefined) {
        topLevel.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  const blockedNames = new Set<string>();
  // 导入自身不是遮蔽；只有 import 之外的绑定（参数、局部 const/let、解构等）
  // 才让同名模块导入的调用不可静态确定。
  const shadowNames = new Set<string>();
  const isImportBinding = (node: ts.Node): boolean => {
    if (ts.isImportClause(node) || ts.isNamespaceImport(node)) return true;
    if (!ts.isBindingElement(node)) return false;
    const pattern = node.parent.parent;
    return (
      ts.isVariableDeclaration(pattern) &&
      pattern.parent !== undefined &&
      ts.isImportDeclaration(pattern.parent)
    );
  };
  const visit = (node: ts.Node): void => {
    const name = boundName(node);
    if (name !== undefined && !ts.isImportSpecifier(node)) {
      if (
        !(
          ts.isVariableDeclaration(node) && isTopLevelConstant(node, sourceFile)
        )
      ) {
        blockedNames.add(name);
      }
      if (!isImportBinding(node)) shadowNames.add(name);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  // 名称在文件任何位置被重新绑定时不求值，避免把嵌套作用域的事实当作模块事实。
  const constants = new Map<string, ts.Expression>();
  for (const [name, initializer] of topLevel) {
    if (!blockedNames.has(name)) constants.set(name, initializer);
  }

  return { blockedNames, constants, shadowNames };
}

/** 绑定名（含解构模式）只跟随值侧：`const { readFileSync: rf }` 仅绑定 rf。 */
function bindingNameBinds(node: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;

  return node.elements.some(
    (element) =>
      ts.isBindingElement(element) && bindingNameBinds(element.name, name),
  );
}

/** 该语句层的直接绑定是否引入目标名：变量声明与函数/类声明。 */
function statementsBindName(
  statements: readonly ts.Statement[],
  name: string,
): boolean {
  return statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        bindingNameBinds(declaration.name, name),
      );
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement)
    ) {
      return statement.name !== undefined && statement.name.text === name;
    }

    return false;
  });
}

/** var 声明提升到包裹函数作用域：扫描函数体内的 function-scoped var，嵌套函数与类 static 块边界不下沉。 */
function functionScopeBindsVar(
  functionNode: ts.FunctionLike,
  name: string,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // 嵌套函数与类 static 块各是一个 var 作用域边界，其绑定不得并入外层函数。
    if (
      (ts.isFunctionLike(node) && node !== functionNode) ||
      ts.isClassStaticBlockDeclaration(node)
    ) {
      return;
    }
    if (
      ts.isVariableDeclarationList(node) &&
      // 解析器只对 let/const 置位；两标志皆无即 function-scoped 的 var。
      (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0 &&
      node.declarations.some((declaration) =>
        bindingNameBinds(declaration.name, name),
      )
    ) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(functionNode);

  return found;
}

/** 调用点标识符是否被词法可达的局部绑定遮蔽：包裹函数的形参/函数作用域 var、catch/循环绑定与各层块内声明参与。 */
function enclosingScopeBindsName(node: ts.Node, name: string): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (ts.isSourceFile(current)) return false;
    if (ts.isFunctionLike(current)) {
      if (
        current.parameters.some((parameter) =>
          bindingNameBinds(parameter.name, name),
        )
      ) {
        return true;
      }
      if (functionScopeBindsVar(current, name)) return true;
    }
    if (
      ts.isCatchClause(current) &&
      current.variableDeclaration !== undefined &&
      bindingNameBinds(current.variableDeclaration.name, name)
    ) {
      return true;
    }
    if (
      (ts.isForStatement(current) ||
        ts.isForOfStatement(current) ||
        ts.isForInStatement(current)) &&
      current.initializer !== undefined &&
      ts.isVariableDeclarationList(current.initializer) &&
      current.initializer.declarations.some((declaration) =>
        bindingNameBinds(declaration.name, name),
      )
    ) {
      return true;
    }
    if (ts.isBlock(current) && statementsBindName(current.statements, name)) {
      return true;
    }
  }

  return false;
}

/** 单个 authored 文件的求值环境；只在同文件内成立，不跨模块共享。 */
type EvaluationContext = {
  readonly blockedNames: ReadonlySet<string>;
  readonly constants: ReadonlyMap<string, ts.Expression>;
  readonly consumer: PackageBoundary;
  readonly filePath: string;
  readonly packageDirectory: string;
  readonly pathBindings: ReadonlyMap<string, ModuleBinding>;
  readonly resolving: Set<string>;
  readonly shadowNames: ReadonlySet<string>;
  readonly urlBindings: ReadonlyMap<string, ModuleBinding>;
  readonly workspacePackages: readonly PackageBoundary[];
};

/** 只接受本地 file URL；其他协议或非法 URL 不求值，也不猜测语义。 */
function filePathFromUrl(
  href: string,
  grant?: PublicGrant,
): StaticValue | undefined {
  try {
    if (new URL(href).protocol !== "file:") return undefined;
    const filePath = fileURLToPath(href);

    return grant === undefined
      ? { kind: "path", value: filePath }
      : { grant, kind: "path", value: filePath };
  } catch {
    return undefined;
  }
}

/** 公开 exports 中被认可为 runtime 出口的有限条件键；`types` 只描述类型，`require` 只服务 CJS seam，都不证明 `import.meta.resolve` 走到的 runtime 出口。 */
const runtimeExportConditions = [
  "source",
  "default",
  "import",
  "node",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只解析明确的 package 与 package/subpath 文本；相对、绝对与 hash 入口不是包身份。 */
function parsePackageSpecifier(
  text: string,
): { packageName: string; subpath: string } | undefined {
  if (
    text.length === 0 ||
    text.startsWith(".") ||
    text.startsWith("/") ||
    text.startsWith("#")
  ) {
    return undefined;
  }
  const segments = text.split("/");
  const nameLength = text.startsWith("@") ? 2 : 1;
  if (
    segments.length < nameLength ||
    segments.slice(0, nameLength).some((segment) => segment.length === 0)
  ) {
    return undefined;
  }
  const rest = segments.slice(nameLength);
  if (rest.some((segment) => segment.length === 0)) return undefined;

  return {
    packageName: segments.slice(0, nameLength).join("/"),
    subpath: rest.length === 0 ? "." : `./${rest.join("/")}`,
  };
}

type ExportTargetSelection =
  | { readonly kind: "invalid-target" }
  | { readonly kind: "not-understood" }
  | { readonly kind: "target"; readonly value: string }
  | { readonly kind: "types-only" };

/** target 文本必须是包内单个资源：Node 要求以 `./` 起始、`./` 后的段不得为 `.` 或 `..`，尾斜杠是目录形态而非资源。 */
function isPublicExportTargetText(value: string): boolean {
  return (
    value.startsWith("./") &&
    !value.endsWith("/") &&
    !value
      .slice(2)
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  );
}

/** 在有限条件键里取一个 runtime target，不实现一般 Node exports 解析。 */
function selectRuntimeExportTarget(value: unknown): ExportTargetSelection {
  if (typeof value === "string") {
    return isPublicExportTargetText(value)
      ? { kind: "target", value }
      : { kind: "invalid-target" };
  }
  if (!isPlainObject(value)) return { kind: "not-understood" };
  for (const condition of runtimeExportConditions) {
    if (Object.hasOwn(value, condition)) {
      return selectRuntimeExportTarget(value[condition]);
    }
  }
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "types")) {
    return { kind: "types-only" };
  }

  return { kind: "not-understood" };
}

type ExportEntryLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "entry"; readonly value: unknown }
  | { readonly kind: "not-understood" };

/** 明确 subpath 键或根级条件对象；通配与混合键不在最窄支持内。 */
function exportEntry(exports: unknown, subpath: string): ExportEntryLookup {
  if (exports === undefined) return { kind: "absent" };
  if (typeof exports === "string") {
    return subpath === "."
      ? { kind: "entry", value: exports }
      : { kind: "absent" };
  }
  if (!isPlainObject(exports)) return { kind: "not-understood" };
  const keys = Object.keys(exports);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return subpath === "."
      ? { kind: "entry", value: exports }
      : { kind: "absent" };
  }
  if (subpathKeys.length !== keys.length) return { kind: "not-understood" };
  if (Object.hasOwn(exports, subpath)) {
    return { kind: "entry", value: exports[subpath] };
  }
  // 顶层 pattern 键在 Node 里可以合法放行该 subpath；没有一般 resolver 就不判定为未公开。
  return subpathKeys.some((key) => key.includes("*"))
    ? { kind: "not-understood" }
    : { kind: "absent" };
}

function isInsideDirectory(targetPath: string, directory: string): boolean {
  const relative = path.relative(directory, targetPath);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** 目录形态只按可证明事实判定：已存在的 target 是目录就不是单个公开资源；缺失 target 仍可有效。 */
function isDirectoryTargetPath(targetPath: string): boolean {
  return (
    statSync(targetPath, { throwIfNoEntry: false })?.isDirectory() === true
  );
}

type PublicResolveAssessment =
  | {
      readonly kind: "failed";
      readonly packageName: string;
      readonly reason: PublicContractReason;
      readonly subpath: string;
    }
  | { readonly kind: "granted"; readonly grant: PublicGrant }
  | { readonly kind: "not-applicable" };

/**
 * 公开资源分支：核对 consumer 已声明的 workspace 依赖与已发现 provider 的公开 exports。
 * 不执行 provider、不安装、不要求 dist 存在；不能可靠解释的形态交给不可验证结论。
 */
function assessPublicResourceResolve(
  context: EvaluationContext,
  specifier: string,
): PublicResolveAssessment {
  const parsed = parsePackageSpecifier(specifier);
  if (parsed === undefined) return { kind: "not-applicable" };
  if (!context.consumer.dependencies.has(parsed.packageName)) {
    return {
      kind: "failed",
      packageName: parsed.packageName,
      reason: "missing-dependency",
      subpath: parsed.subpath,
    };
  }
  const provider = context.workspacePackages.find(
    (candidate) =>
      !candidate.isRepositoryRoot && candidate.name === parsed.packageName,
  );
  if (provider === undefined) return { kind: "not-applicable" };

  const entry = exportEntry(provider.exports, parsed.subpath);
  if (entry.kind === "absent") {
    return {
      kind: "failed",
      packageName: parsed.packageName,
      reason: "subpath-not-public",
      subpath: parsed.subpath,
    };
  }
  if (entry.kind === "not-understood") return { kind: "not-applicable" };

  const selection = selectRuntimeExportTarget(entry.value);
  if (selection.kind === "invalid-target") {
    return {
      kind: "failed",
      packageName: parsed.packageName,
      reason: "invalid-target",
      subpath: parsed.subpath,
    };
  }
  if (selection.kind === "not-understood") return { kind: "not-applicable" };
  if (selection.kind === "types-only") {
    return {
      kind: "failed",
      packageName: parsed.packageName,
      reason: "types-only",
      subpath: parsed.subpath,
    };
  }
  const targetPath = path.resolve(provider.directory, selection.value);
  if (!isInsideDirectory(targetPath, provider.directory)) {
    return {
      kind: "failed",
      packageName: parsed.packageName,
      reason: "invalid-target",
      subpath: parsed.subpath,
    };
  }
  if (isDirectoryTargetPath(targetPath)) {
    return {
      kind: "failed",
      packageName: parsed.packageName,
      reason: "directory-target",
      subpath: parsed.subpath,
    };
  }

  return {
    kind: "granted",
    grant: { provider, subpath: parsed.subpath, targetPath },
  };
}

/** `import.meta.resolve(...)` 的封闭 AST 形状；`import.meta` 无法被局部绑定遮蔽。 */
function isImportMetaResolveCallee(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    callee.name.text === "resolve"
  );
}

/** resolve 实参必须先静态确定为 package 文本，否则不进入公开资源分支。 */
function staticPackageSpecifier(
  call: ts.CallExpression,
  context: EvaluationContext,
): string | undefined {
  const [specifier] = call.arguments;
  if (specifier === undefined || call.arguments.length !== 1) {
    return undefined;
  }
  const value = staticValue(specifier, context);
  if (value === undefined || value.kind !== "path") return undefined;

  return value.value;
}

function collectPublicContractViolation(
  node: ts.Node,
  context: EvaluationContext,
  resolving: ReadonlySet<string>,
  found: PublicContractViolation[],
): void {
  if (found.length > 0) return;
  if (ts.isIdentifier(node)) {
    if (resolving.has(node.text)) return;
    const initializer = context.constants.get(node.text);
    if (initializer === undefined) return;
    const nextResolving = new Set(resolving);
    nextResolving.add(node.text);
    collectPublicContractViolation(initializer, context, nextResolving, found);

    return;
  }
  if (ts.isCallExpression(node) && isImportMetaResolveCallee(node.expression)) {
    const specifier = staticPackageSpecifier(node, context);
    if (specifier === undefined) return;
    const assessment = assessPublicResourceResolve(context, specifier);
    if (assessment.kind !== "failed") return;
    found.push({
      packageName: assessment.packageName,
      reason: assessment.reason,
      specifier,
      subpath: assessment.subpath,
    });

    return;
  }
  node.forEachChild((child) => {
    collectPublicContractViolation(child, context, resolving, found);
  });
}

/** 求值失败的 fs 路径参数里是否有违反公开契约的 resolve；公开契约失败优先于不可验证。 */
function publicContractViolation(
  node: ts.Node,
  context: EvaluationContext,
): PublicContractViolation | undefined {
  const found: PublicContractViolation[] = [];
  collectPublicContractViolation(node, context, new Set<string>(), found);

  return found[0];
}

function staticValue(
  node: ts.Node,
  context: EvaluationContext,
): StaticValue | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "path", raw: true, value: node.text };
  }

  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const part = staticValue(span.expression, context);
      if (part === undefined || part.kind !== "path") return undefined;
      text += part.value + span.literal.text;
    }

    return { kind: "path", raw: true, value: text };
  }

  if (ts.isIdentifier(node)) {
    const initializer = context.constants.get(node.text);
    if (initializer === undefined || context.resolving.has(node.text)) {
      return undefined;
    }
    context.resolving.add(node.text);
    const value = staticValue(initializer, context);
    context.resolving.delete(node.text);

    return value;
  }

  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression)
  ) {
    if (
      node.expression.keywordToken !== ts.SyntaxKind.ImportKeyword ||
      node.name.text !== "url"
    ) {
      return undefined;
    }

    return { kind: "url", value: pathToFileURL(context.filePath).href };
  }

  if (ts.isCallExpression(node)) return staticCallValue(node, context);

  if (ts.isNewExpression(node)) {
    const callee = node.expression;
    if (
      !ts.isIdentifier(callee) ||
      callee.text !== "URL" ||
      context.blockedNames.has("URL")
    ) {
      return undefined;
    }
    const args = node.arguments;
    if (args === undefined || args.length !== 2) return undefined;
    const spec = staticValue(args[0]!, context);
    const base = staticValue(args[1]!, context);
    if (
      spec === undefined ||
      spec.kind !== "path" ||
      base === undefined ||
      base.kind !== "url"
    ) {
      return undefined;
    }
    try {
      return { kind: "url", value: new URL(spec.value, base.value).href };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function staticCallValue(
  call: ts.CallExpression,
  context: EvaluationContext,
): StaticValue | undefined {
  // 公开资源分支只在 import.meta.resolve 的封闭形状上成立，不启用一般 Node resolver。
  if (isImportMetaResolveCallee(call.expression)) {
    const specifier = staticPackageSpecifier(call, context);
    if (specifier === undefined) return undefined;
    const assessment = assessPublicResourceResolve(context, specifier);
    if (assessment.kind !== "granted") return undefined;

    return {
      grant: assessment.grant,
      kind: "url",
      value: pathToFileURL(assessment.grant.targetPath).href,
    };
  }

  const pathApi = calledApiName(call.expression, context.pathBindings, (name) =>
    context.shadowNames.has(name),
  );
  if (pathApi !== undefined && pathFunctions.has(pathApi)) {
    const parts: string[] = [];
    // dirname 只剥掉末段，中间的上跳片段按内核语义保留；join 与 resolve 在到达 fs 前已归一。
    let keepsLiteralForm = true;
    for (const argument of call.arguments) {
      const value = staticValue(argument, context);
      if (value === undefined || value.kind !== "path") return undefined;
      parts.push(value.value);
      keepsLiteralForm &&= value.raw === true;
    }
    if (parts.length === 0) return undefined;
    if (pathApi === "dirname" && parts.length === 1) {
      const folded = path.dirname(parts[0]!);

      return keepsLiteralForm
        ? { kind: "path", raw: true, value: folded }
        : { kind: "path", value: folded };
    }
    if (pathApi === "join") return { kind: "path", value: path.join(...parts) };
    if (pathApi !== "resolve") return undefined;
    // `path.resolve` 的相对链沿用 06 号的包目录锚点：包脚本的运行时 cwd 由所属包决定。
    return {
      kind: "path",
      value: path.resolve(context.packageDirectory, ...parts),
    };
  }

  const urlApi = calledApiName(call.expression, context.urlBindings, (name) =>
    context.shadowNames.has(name),
  );
  if (urlApi !== "fileURLToPath" || call.arguments.length !== 1) {
    return undefined;
  }
  const value = staticValue(call.arguments[0]!, context);
  if (value === undefined || value.kind !== "url") return undefined;

  return filePathFromUrl(value.value, value.grant);
}

/**
 * 绝对路径与 file URL 保持自身语义；相对目标沿用 06 号已验收的包目录锚点。
 * 词法折叠值用于祖先链归属，交给内核的值按输入形态保留：未归一原字面量不折叠，已归一构造值原样使用。
 */
function anchoredPath(
  value: StaticValue | undefined,
  boundary: PackageBoundary,
): LocatedTarget | undefined {
  if (value === undefined) return undefined;
  const resolved =
    value.kind === "url" ? filePathFromUrl(value.value, value.grant) : value;
  if (resolved === undefined) return undefined;
  const isAbsolute = resolved.value.startsWith("/");
  const base = isAbsolute ? repositoryRoot : boundary.directory;
  const raw = resolved.kind === "path" && resolved.raw === true;
  const folded = path.resolve(base, resolved.value);
  const located = {
    // 折叠值与 12A 之前的判定基准一致：祖先链查表与仓库内判定都按词法位置进行。
    path: folded,
    // 内核看到的形态：`path.resolve` 会按词法消费 `..` 与 `.` 段，因此未归一原值只补锚点拼接。
    physicalInput: raw ? absoluteLiteralForm(base, resolved.value) : folded,
  };

  return resolved.grant === undefined
    ? located
    : { ...located, publicGrant: resolved.grant };
}

/**
 * 拼出程序实际交给 fs API 的绝对原值：只补包目录锚点并合并重复分隔符。
 * `..`、`/.`、`/./` 都原样保留：这些段是否存在、能否穿过由内核逐段判定，提前消去会把真实的
 * `ENOTDIR` 伪装成可验证的同包目标。开头的 `./` 就是锚点目录本身，去掉它与内核解析同一结果。
 */
function absoluteLiteralForm(baseDirectory: string, literal: string): string {
  const relative = literal.startsWith("./") ? literal.slice(1) : literal;
  const joined = literal.startsWith("/")
    ? literal
    : `${baseDirectory}/${relative}`;

  return joined.replaceAll(/\/{2,}/gu, "/");
}

/** 仓库定位线索之一：上跳相对路径片段。可列举的语法文本，不凭变量名猜测。 */
function hasUpwardPathFragment(text: string): boolean {
  return (
    text === ".." ||
    text.startsWith("../") ||
    text.includes("/../") ||
    text.endsWith("/..")
  );
}

/** 无法求值的 fs 路径参数是否带仓库定位线索：上跳相对片段、import.meta.url 或 import.meta.resolve 锚点。 */
function hasRepositoryHint(
  node: ts.Node,
  context: EvaluationContext,
  resolving: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(node)) {
    if (resolving.has(node.text)) return false;
    const initializer = context.constants.get(node.text);
    if (initializer === undefined) return false;
    const nextResolving = new Set(resolving);
    nextResolving.add(node.text);

    return hasRepositoryHint(initializer, context, nextResolving);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return hasUpwardPathFragment(node.text);
  }
  if (ts.isTemplateExpression(node)) {
    if (hasUpwardPathFragment(node.head.text)) return true;
    if (
      node.templateSpans.some((span) =>
        hasUpwardPathFragment(span.literal.text),
      )
    )
      return true;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    (node.name.text === "url" || node.name.text === "resolve")
  ) {
    return true;
  }
  let found = false;
  node.forEachChild((child) => {
    if (!found) found = hasRepositoryHint(child, context, resolving);
  });

  return found;
}

type PublicContractArgument = {
  readonly argument: ts.Node;
  readonly violation: PublicContractViolation;
};

/** 已识别 fs 入口的路径参数结果：已确定目标、公开契约失败与无法静态验证三种；未知不当作安全结论。 */
function staticPathArguments(
  call: ts.CallExpression,
  fileSystem: ReadonlyMap<string, ModuleBinding>,
  context: EvaluationContext,
  boundary: PackageBoundary,
): {
  readonly publicContractFailures: readonly PublicContractArgument[];
  readonly targets: readonly LocatedTarget[];
  readonly unverifiable: readonly ts.Node[];
} {
  const functionName = calledApiName(
    call.expression,
    fileSystem,
    // fs 入口身份只用词法可达遮蔽判定；其他作用域的同名绑定不得全局屏蔽真实导入。
    (name) => enclosingScopeBindsName(call.expression, name),
  );
  if (
    functionName === undefined ||
    !Object.hasOwn(fileSystemPathArguments, functionName)
  ) {
    return { publicContractFailures: [], targets: [], unverifiable: [] };
  }

  const publicContractFailures: PublicContractArgument[] = [];
  const targets: LocatedTarget[] = [];
  const unverifiable: ts.Node[] = [];
  for (const argumentIndex of fileSystemPathArguments[functionName]!) {
    const argument = call.arguments[argumentIndex];
    if (argument === undefined) continue;
    const located = anchoredPath(staticValue(argument, context), boundary);
    if (located !== undefined) {
      targets.push(located);
      continue;
    }
    const violation = publicContractViolation(argument, context);
    if (violation !== undefined) {
      publicContractFailures.push({ argument, violation });
      continue;
    }
    if (hasRepositoryHint(argument, context, new Set<string>())) {
      unverifiable.push(argument);
    }
  }

  return { publicContractFailures, targets, unverifiable };
}

/** 已支持路径构造：识别身份的 `new URL(spec, base)` 与 path/url 导入调用；求值规则在 `staticValue`/`staticCallValue`。 */
function isRecognizedPathConstruction(
  node: ts.Node,
  context: EvaluationContext,
): node is ts.Expression {
  if (ts.isNewExpression(node)) {
    return (
      node.expression !== undefined &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      !context.blockedNames.has("URL")
    );
  }
  if (!ts.isCallExpression(node)) return false;
  const pathApi = calledApiName(node.expression, context.pathBindings, (name) =>
    context.shadowNames.has(name),
  );
  if (pathApi !== undefined && pathFunctions.has(pathApi)) return true;
  const urlApi = calledApiName(node.expression, context.urlBindings, (name) =>
    context.shadowNames.has(name),
  );

  return urlApi !== undefined && urlFunctions.has(urlApi);
}

/** 父表达式是已识别 fs 调用且该实参位于路径参数位：路径归属判定已由 `staticPathArguments` 在调用点完成。 */
function isConsumedFileSystemArgument(
  node: ts.Expression,
  fileSystem: ReadonlyMap<string, ModuleBinding>,
): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call)) return false;
  const functionName = calledApiName(call.expression, fileSystem, (name) =>
    enclosingScopeBindsName(call.expression, name),
  );
  if (
    functionName === undefined ||
    !Object.hasOwn(fileSystemPathArguments, functionName)
  ) {
    return false;
  }

  return fileSystemPathArguments[functionName]!.some(
    (argumentIndex) => call.arguments[argumentIndex] === node,
  );
}

/** 独立构造观察的三类结果；来源是构造节点自身位置，与 fs 调用点区分。 */
type ConstructionObservation =
  | { readonly kind: "boundary"; readonly target: LocatedTarget }
  | {
      readonly kind: "public-contract";
      readonly violation: PublicContractViolation;
    }
  | { readonly kind: "unverifiable" }
  | undefined;

function constructionObservation(
  construction: ts.Expression,
  context: EvaluationContext,
  boundary: PackageBoundary,
): ConstructionObservation {
  const located = anchoredPath(staticValue(construction, context), boundary);
  if (located !== undefined) {
    return { kind: "boundary", target: located };
  }
  const violation = publicContractViolation(construction, context);
  if (violation !== undefined) {
    return { kind: "public-contract", violation };
  }
  if (hasRepositoryHint(construction, context, new Set<string>())) {
    return { kind: "unverifiable" };
  }

  return undefined;
}

/** 构造已被外层求值消费时归属判定归外层：被识别且可完整求值的构造调用的实参、被识别 fs 调用路径参数位的实参；同一来源不重复观察。被遮蔽、未知或不可完整求值的外层不消费内层构造，内层已确定的边界与 public-contract 证据保留原位置。 */
function consumedByEnclosingEvaluation(
  node: ts.Expression,
  context: EvaluationContext,
  fileSystem: ReadonlyMap<string, ModuleBinding>,
): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isNewExpression(parent)) {
    return (
      parent.arguments !== undefined &&
      parent.arguments.some((argument) => argument === node) &&
      isRecognizedPathConstruction(parent, context) &&
      staticValue(parent, context) !== undefined
    );
  }
  if (ts.isCallExpression(parent)) {
    if (
      parent.arguments.some((argument) => argument === node) &&
      isRecognizedPathConstruction(parent, context) &&
      staticValue(parent, context) !== undefined
    ) {
      return true;
    }

    return isConsumedFileSystemArgument(node, fileSystem);
  }

  return false;
}

function diagnosticsInFile(
  boundary: PackageBoundary,
  layout: WorkspaceLayout,
  filePath: string,
): {
  readonly boundaryDiagnostics: BoundaryDiagnostic[];
  readonly outsideRepositoryDiagnostics: OutsideRepositoryDiagnostic[];
  readonly publicContractDiagnostics: PublicContractDiagnostic[];
  readonly unresolvablePathDiagnostics: UnverifiablePhysicalDiagnostic[];
  readonly unverifiableDiagnostics: UnverifiableDiagnostic[];
} {
  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const { blockedNames, constants, shadowNames } =
    evaluatableConstants(sourceFile);
  const context: EvaluationContext = {
    blockedNames,
    constants,
    consumer: boundary,
    filePath,
    packageDirectory: boundary.directory,
    pathBindings: importedModuleBindings(sourceFile, pathModules, (apiName) =>
      pathFunctions.has(apiName),
    ),
    resolving: new Set<string>(),
    shadowNames,
    urlBindings: importedModuleBindings(sourceFile, urlModules, (apiName) =>
      urlFunctions.has(apiName),
    ),
    workspacePackages: layout.packages,
  };
  const fileSystem = importedModuleBindings(
    sourceFile,
    fileSystemModules,
    (apiName) => Object.hasOwn(fileSystemPathArguments, apiName),
  );
  const found: BoundaryDiagnostic[] = [];
  const outsideRepositoryFound: OutsideRepositoryDiagnostic[] = [];
  const publicContractFound: PublicContractDiagnostic[] = [];
  const unresolvableFound: UnverifiablePhysicalDiagnostic[] = [];
  const unverifiableFound: UnverifiableDiagnostic[] = [];
  const relativeFile = path
    .relative(repositoryRoot, filePath)
    .split(path.sep)
    .join("/");

  // 闭合目标的同一物理判定被 fs 路径参数与独立路径构造共同消费：授权资源与仓库外词法目标
  // 沿用 containment 规则；内核可见值经最近存在前缀/native realpath 取真实位置；词法 containment
  // 与真实归属各自独立判定，任一失败即诊断，真实位置可确定时一并呈现。
  const recordLocatedTarget = (
    located: LocatedTarget,
    line: number,
    column: number,
  ): void => {
    // 公开契约授予的被请求资源本身不越界；dirname、父目录回退与追加路径不携带授权。
    if (located.publicGrant !== undefined) return;
    // 词法已出仓库根的目标沿用既有 containment 规则，不在真实路径接缝上伪造 owner。
    if (!isInsideRepository(located.path)) return;
    const physical = physicalTargetOf(located.physicalInput);
    if ("reason" in physical) {
      unresolvableFound.push({
        column,
        input: relativeLiteralForm(located.physicalInput),
        line,
        owner: boundary,
        reason: physical.reason,
        sourceFile: relativeFile,
      });
      return;
    }
    // 真实位置落在仓库根外：如实标注工作区外目标，不为其伪造包身份。
    if (!isInsideRepository(physical.real)) {
      outsideRepositoryFound.push({
        column,
        input: relativeLiteralForm(located.physicalInput),
        line,
        owner: boundary,
        realPath: physical.real,
        sourceFile: relativeFile,
      });
      return;
    }
    const lexicalTarget = owningBoundary(layout, located.path);
    const realTarget = owningBoundary(layout, physical.real);
    const escaped =
      realTarget.directory === boundary.directory
        ? lexicalTarget.directory === boundary.directory
          ? undefined
          : lexicalTarget
        : realTarget;
    if (escaped === undefined) return;
    found.push({
      column,
      input:
        located.physicalInput === located.path
          ? undefined
          : relativeLiteralForm(located.physicalInput),
      line,
      owner: boundary,
      realPath:
        physical.real === located.path
          ? undefined
          : relativeToRepositoryRoot(physical.real),
      sourceFile: relativeFile,
      target: escaped,
      targetPath: relativeToRepositoryRoot(located.path),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const { publicContractFailures, targets, unverifiable } =
        staticPathArguments(node, fileSystem, context, boundary);
      for (const located of targets) {
        const position = ts.getLineAndCharacterOfPosition(
          sourceFile,
          node.getStart(sourceFile),
        );
        recordLocatedTarget(located, position.line + 1, position.character + 1);
      }
      for (const { argument, violation } of publicContractFailures) {
        const position = ts.getLineAndCharacterOfPosition(
          sourceFile,
          argument.getStart(sourceFile),
        );
        publicContractFound.push({
          column: position.character + 1,
          line: position.line + 1,
          owner: boundary,
          packageName: violation.packageName,
          reason: violation.reason,
          sourceFile: relativeFile,
          specifier: violation.specifier,
          subpath: violation.subpath,
        });
      }
      for (const argument of unverifiable) {
        const position = ts.getLineAndCharacterOfPosition(
          sourceFile,
          argument.getStart(sourceFile),
        );
        unverifiableFound.push({
          column: position.character + 1,
          context: "system-argument",
          line: position.line + 1,
          owner: boundary,
          sourceFile: relativeFile,
        });
      }
    }
    // 独立路径构造：initializer、return、export、对象字段等不依赖 fs sink 的来源按同一身份与求值观察。
    if (
      isRecognizedPathConstruction(node, context) &&
      !consumedByEnclosingEvaluation(node, context, fileSystem)
    ) {
      const observation = constructionObservation(node, context, boundary);
      if (observation !== undefined) {
        const position = ts.getLineAndCharacterOfPosition(
          sourceFile,
          node.getStart(sourceFile),
        );
        if (observation.kind === "boundary") {
          // 与 fs 路径参数同一闭合目标判定：构造值虽经 API 归一，其真实归属仍按
          // 最近存在前缀/native realpath 独立判定，经链接物理落到兄弟包或仓库根时
          // 不被词法同包提前放行；同包且真实一致的授权、仓库外目标与越界呈现沿用同一规则。
          recordLocatedTarget(
            observation.target,
            position.line + 1,
            position.character + 1,
          );
        } else if (observation.kind === "public-contract") {
          publicContractFound.push({
            column: position.character + 1,
            line: position.line + 1,
            owner: boundary,
            packageName: observation.violation.packageName,
            reason: observation.violation.reason,
            sourceFile: relativeFile,
            specifier: observation.violation.specifier,
            subpath: observation.violation.subpath,
          });
        } else {
          unverifiableFound.push({
            column: position.character + 1,
            context: "path-construction",
            line: position.line + 1,
            owner: boundary,
            sourceFile: relativeFile,
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  return {
    boundaryDiagnostics: found,
    outsideRepositoryDiagnostics: outsideRepositoryFound,
    publicContractDiagnostics: publicContractFound,
    unresolvablePathDiagnostics: unresolvableFound,
    unverifiableDiagnostics: unverifiableFound,
  };
}

function isInsideRepository(targetPath: string): boolean {
  const relative = path.relative(repositoryRoot, targetPath);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** 仓库根目标的 path.relative 为空串，诊断展示为 `.`。 */
function relativeToRepositoryRoot(targetPath: string): string {
  const relative = path.relative(repositoryRoot, targetPath);

  return (relative === "" ? "." : relative).split(path.sep).join("/");
}

/**
 * 呈现交给内核的原值时只按文本去掉仓库根前缀。
 * `path.relative` 会词法折叠 `..`，用它展示会把"内核看到的原值"改写成另一个值。
 */
function relativeLiteralForm(targetPath: string): string {
  if (targetPath === repositoryRoot) return ".";

  return targetPath.startsWith(`${repositoryRoot}/`)
    ? targetPath.slice(repositoryRoot.length + 1)
    : relativeToRepositoryRoot(targetPath);
}

function describe(boundary: PackageBoundary): string {
  return boundary.isRepositoryRoot
    ? "生成仓库根 Workspace Orchestration Package"
    : `包 ${boundary.name} (${boundary.relativePath})`;
}

/** 全部诊断按源位置排序后呈现。 */
function compareByPosition(
  left: {
    readonly column: number;
    readonly line: number;
    readonly sourceFile: string;
  },
  right: {
    readonly column: number;
    readonly line: number;
    readonly sourceFile: string;
  },
): number {
  return (
    left.sourceFile.localeCompare(right.sourceFile) ||
    left.line - right.line ||
    left.column - right.column
  );
}

function renderDiagnostic(diagnostic: BoundaryDiagnostic): string {
  const {
    column,
    input,
    line,
    owner,
    realPath,
    sourceFile,
    target,
    targetPath,
  } = diagnostic;
  const escapeTarget = target.isRepositoryRoot
    ? `生成仓库根的私有路径 ${targetPath}`
    : `兄弟包 ${target.name} (${target.relativePath}) 的私有路径 ${targetPath}`;
  const repair = target.isRepositoryRoot
    ? "把该仓库范围读取交给根 Workspace Orchestration Package 的任务，或改用本包内资源。"
    : `改用 ${target.name} 声明的公开 exports 并在 ${owner.name} 声明 workspace 依赖；跨包任务交给根 Workspace Orchestration Package。`;
  const physicalNotes = [
    ...(realPath === undefined ? [] : [`  真实位置：${realPath}。`]),
    ...(input === undefined ? [] : [`  交给文件系统的原值：${input}。`]),
  ];

  return [
    `${sourceFile}:${line}:${column} 包文件系统隔离：${describe(owner)} 通过本地文件系统路径访问 ${escapeTarget}。`,
    ...physicalNotes,
    `  修正方向：${repair}`,
  ].join("\n");
}

/** 真实路径无法验证：内核或 native realpath 给出了事实，检查器不猜目标包，也不回退非 native 解析。 */
function renderUnresolvableDiagnostic(
  diagnostic: UnverifiablePhysicalDiagnostic,
): string {
  const { column, input, line, owner, reason, sourceFile } = diagnostic;

  return [
    `${sourceFile}:${line}:${column} 包文件系统隔离：${describe(owner)} 交给文件系统的 ${input} 无法验证真实路径（${reason}），检查器不虚构目标包，也不因目标不存在而放行。`,
    "  修正方向：把该路径指向本包内确实存在或可静态确定的目标，并移除断裂或环状的符号链接；确需跨包资源时改用声明依赖与公开 exports。",
  ].join("\n");
}

/** 真实位置落在仓库根之外：按工作区外目标呈现，不伪造包身份。 */
function renderOutsideRepositoryDiagnostic(
  diagnostic: OutsideRepositoryDiagnostic,
): string {
  const { column, input, line, owner, realPath, sourceFile } = diagnostic;

  return [
    `${sourceFile}:${line}:${column} 包文件系统隔离：${describe(owner)} 通过本地文件系统路径访问工作区之外的 ${realPath}。`,
    `  交给文件系统的原值：${input}。`,
    "  修正方向：把所需资源放回本包或某个已声明 workspace 依赖的包内，仓库范围读取交给根 Workspace Orchestration Package；检查器不会为工作区外目标伪造包身份。",
  ].join("\n");
}

/** 公开契约诊断点名失败的公开声明，修正方向只沿声明依赖与公开 exports 收窄。 */
function renderPublicContractDiagnostic(
  diagnostic: PublicContractDiagnostic,
): string {
  const {
    column,
    line,
    owner,
    packageName,
    reason,
    sourceFile,
    specifier,
    subpath,
  } = diagnostic;
  const contract = `${packageName} 的 exports["${subpath}"]`;
  const failedContract =
    reason === "missing-dependency"
      ? `${packageName} 未声明为 ${owner.name} 的 workspace 依赖，检查器不会仅凭名称认证 subpath，也不会自动建立依赖。`
      : reason === "subpath-not-public"
        ? `${contract} 没有把该 subpath 公开为出口，物理读取 ${packageName} 的私有布局不受公开分支放行。`
        : reason === "types-only"
          ? `${contract} 只有 types 声明，类型不能单独证明 runtime 出口。`
          : reason === "directory-target"
            ? `${contract} 的 runtime target 是 ${packageName} 内的目录，公开出口只授权被请求的单个资源，不放行整目录布局。`
            : `${contract} 的 runtime target 不是包内单个文件：必须以 "./" 起始、"./" 后的段不得为 "." 或 ".."、不以 "/" 结束，且不得越出 ${packageName} 包目录。`;
  const repair =
    reason === "missing-dependency"
      ? `在 ${owner.name} 声明 ${packageName} 的 workspace 依赖，或由该 package 的所有者公开所需资源；仓库范围任务交给根 Workspace Orchestration Package。`
      : reason === "directory-target"
        ? `让 ${packageName} 的所有者将 ${subpath} 的 runtime target 声明为具体文件出口，或把所需资源移回 ${owner.name} 自己拥有。`
        : `让 ${packageName} 的所有者明确公开该 subpath 的 runtime 出口，或把所需资源移回 ${owner.name} 自己拥有。`;

  return [
    `${sourceFile}:${line}:${column} 公开资源分支：${describe(owner)} 通过 import.meta.resolve("${specifier}") 定位公开资源，但公开契约不成立。`,
    `  失败契约：${failedContract}`,
    `  修正方向：${repair}`,
  ].join("\n");
}

function renderUnverifiableDiagnostic(
  diagnostic: UnverifiableDiagnostic,
): string {
  const { column, context, line, owner, sourceFile } = diagnostic;
  const subject =
    context === "system-argument"
      ? "已支持的 node:fs API 路径参数"
      : "已支持的独立路径构造";

  return [
    `${sourceFile}:${line}:${column} 包文件系统隔离：${describe(owner)} 在${subject}中给出了带仓库定位线索但无法静态求值的表达式，检查器无法验证其目标，也不虚构目标。`,
    "  修正方向：把该路径改写为可静态确定的本包内目标；确需跨包资源时改用声明依赖与公开 exports，仓库范围任务交给根 Workspace Orchestration Package。",
  ].join("\n");
}

/** manifest 已知单段命令的有限 tokenizer：shell-quote 保留 `&&`、operator 与变量展开结构；未知 env 展开以不透明的 opaque 字符串标记内联进所在词，由 parser 自身保留真实词边界，绝不默认成空串，也不猜测展开值。 */
type CommandWord = {
  readonly nonStatic: boolean;
  readonly text: string;
};

/**
 * 为单条命令现选一个保证不与任何已合并字面词碰撞的 opaque 标记基底。官方 shell-quote 在解析阶段先把相邻引号
 * 片段合并成字面词（`'a'0'b → a0b`），所以"基底不出现在命令原文"并不充分——被引号拆开的字面路径合并后仍可能
 * 恰好等于 base+KEY+base 登记标记（证明 MF1-03/04）。这里改用同一次官方解析（不带 env 回调）观察所有已合并的
 * 字面词，据此选取一个不出现在任一字面词中的基底。由于 env 回调只替换 `$VAR`、不改变字面词的合并结果，任何
 * 字面词（含被引号拼接合并出来的）都不可能被注入该基底，也就无法伪造成完整标记；真实 env 展开才由回调显式注入基底而被识别。
 */
function freshEnvMarkerBase(command: string): string | null {
  let literalWords: string[];
  try {
    literalWords = parse(command).filter(
      (token): token is string => typeof token === "string",
    );
  } catch {
    // 官方 shell-quote 对未闭合 `${` 等构造在解析阶段主动抛错；交由调用方按「放弃分析该命令」处理，
    // 绝不让单条不可结构化命令的解析异常终止其它 script/包的检查。
    return null;
  }
  let nonce = 0;
  let base = "__BOUNDARY_ENV0__";
  while (literalWords.some((word) => word.includes(base))) {
    nonce += 1;
    base = `__BOUNDARY_ENV${nonce}__`;
  }
  return base;
}

/**
 * 用本轮登记的标记集合判定并还原单个词：含登记标记者记为真实未知 nonStatic，并把标记还原成 `$变量名` 展示形态
 * （绝不猜测运行时值）；未含登记标记者按字面文本原样解析，即便它字面上恰好长得像旧式标记也不误判为未知。
 */
function classifyCommandWord(
  token: string,
  markerToKey: ReadonlyMap<string, string>,
): CommandWord {
  let text = token;
  let nonStatic = false;
  for (const [marker, key] of markerToKey) {
    if (text.includes(marker)) {
      nonStatic = true;
      text = text.split(marker).join(`$${key}`);
    }
  }
  return { nonStatic, text };
}

/**
 * 用本轮 opaque env 标记解析一条命令。官方 shell-quote 对未闭合 `${` 等输入会主动抛错；此时没有任何 token
 * 结构可用，返回 null 让调用方按「放弃分析该命令」跳过，绝不终止同 manifest 其余 script 或其它包。
 */
function parseCommandWithEnvMarkers(
  command: string,
  expandEnv: (key: string) => string,
): ReturnType<typeof parse> | null {
  try {
    return parse(command, expandEnv);
  } catch {
    return null;
  }
}

/**
 * 一条命令的可判定段，以及本命令中出现过的不支持构造（用于 11 的相关性诊断）。
 * `followsUnsupportedOp` 标记该段是否由 `&&` 以外的控制符开启：这样的段首词不一定是 executable（重定向目标、
 * heredoc 定界符等都可能落在这里），因此只交同一 evaluator 的已知工具判定，不把它的首词当成 executable operand。
 */
type CommandSegment = {
  readonly followsUnsupportedOp: boolean;
  readonly words: CommandWord[];
};

type CommandAnalysis = {
  readonly constructOperands: CommandWord[];
  readonly segments: CommandSegment[];
  readonly unsupportedOps: string[];
};

/** 重定向类控制符：官方 token 流里紧随其后的第一个词就是该构造自身携带的目标，不是任何工具的普通参数。 */
const redirectOperandOps = new Set([
  "&>",
  "&>>",
  "<",
  "<<",
  "<<<",
  "<>",
  ">",
  ">>",
]);

/**
 * 把 token 流切成可判定段：`&&` 与管道、重定向、`;`、命令替换、subshell 都作为段边界，但只有 `&&` 表示
 * "已知顺序串联"；其余边界被记录下来，其后的词仍交给同一 evaluator 逐段判定，因此一条复杂命令不会吞掉其中
 * 可结构化 operand 的证据（T11-1/T11-4）。`constructOperands` 只收集不支持构造**自身**携带的 operand
 * （重定向目标、subshell/命令替换边界内的词），供相关性诊断使用；普通参数不在其中（RC11-A）。
 * 返回 null 只保留给官方 parser 抛错的命令：那时没有任何 token 结构可用，定位相关 operand 需要第二套分词器，
 * 按边界交回而不伪造。
 */
function commandSegments(command: string): CommandAnalysis | null {
  const markerBase = freshEnvMarkerBase(command);
  if (markerBase === null) {
    // 该命令的官方解析已抛错（如未闭合 `${`），按「放弃分析该命令」跳过，与其它不支持构造一致。
    return null;
  }
  const markerToKey = new Map<string, string>();
  const expandEnv = (key: string): string => {
    const marker = `${markerBase}${key}${markerBase}`;
    markerToKey.set(marker, key);
    return marker;
  };
  const tokens = parseCommandWithEnvMarkers(command, expandEnv);
  if (tokens === null) {
    return null;
  }
  const segments: CommandSegment[] = [];
  const unsupportedOps: string[] = [];
  const constructOperands: CommandWord[] = [];
  let words: CommandWord[] = [];
  let followsUnsupportedOp = false;
  let redirectTargetPending = false;
  let substitutionDepth = 0;
  const flushSegment = (): void => {
    segments.push({ followsUnsupportedOp, words });
    words = [];
  };
  const pushWord = (word: CommandWord): void => {
    // 「不支持构造自身携带」的 operand：重定向紧随的目标，以及 subshell/命令替换边界内的词。
    // 其余词（工具普通参数、Node 入口后的 argv、`--` 之后尾巴、pattern/配置取值、引号文本）一律不携带。
    if (
      substitutionDepth > 0 ||
      (redirectTargetPending && words.length === 0)
    ) {
      constructOperands.push(word);
    }
    redirectTargetPending = false;
    words.push(word);
  };
  for (const token of tokens) {
    if (typeof token === "string") {
      // 空字符串是真实参数（如 `""`），保留为独立词，绝不吞掉后续路径 operand。
      pushWord(classifyCommandWord(token, markerToKey));
      continue;
    }
    if ("comment" in token) {
      continue;
    }
    if ("op" in token) {
      if (token.op === "&&") {
        flushSegment();
        followsUnsupportedOp = false;
        redirectTargetPending = false;
        continue;
      }
      if (token.op === "glob") {
        pushWord({ nonStatic: true, text: token.pattern });
        continue;
      }
      // 其它控制符：本段的可判定部分到此结束，记录构造后另起一段，不猜测该构造的运行语义。
      unsupportedOps.push(token.op);
      if (redirectOperandOps.has(token.op)) {
        redirectTargetPending = true;
      }
      if (token.op === "(") {
        substitutionDepth += 1;
      }
      if (token.op === ")") {
        substitutionDepth = Math.max(substitutionDepth - 1, 0);
      }
      flushSegment();
      followsUnsupportedOp = true;
      continue;
    }
    unsupportedOps.push("unknown-token");
    flushSegment();
    followsUnsupportedOp = true;
  }
  flushSegment();
  return { constructOperands, segments, unsupportedOps };
}

/** 命令 operand 的仓库定位线索：上跳相对片段或任意 `../` 形态，只看 operand 自身字面文本。 */
function commandOperandHint(text: string): boolean {
  return (
    hasUpwardPathFragment(text) || text.includes("../") || text.includes("/..")
  );
}

function escapeCommandTarget(
  target: PackageBoundary,
  targetPath: string,
): string {
  return target.isRepositoryRoot
    ? `生成仓库根的私有路径 ${targetPath}`
    : `兄弟包 ${target.name} (${target.relativePath}) 的私有路径 ${targetPath}`;
}

function renderCommandEscape(
  position: string,
  script: string,
  kind: string,
  operand: string,
  owner: PackageBoundary,
  target: PackageBoundary,
  targetPath: string,
): string {
  const repair = target.isRepositoryRoot
    ? "把该仓库范围读取交给根 Workspace Orchestration Package 的任务，或改用本包内资源。"
    : `改用 ${target.name} 声明的公开 exports 并在 ${owner.name} 声明 workspace 依赖；跨包任务交给根 Workspace Orchestration Package。`;

  return [
    `${position} 包文件系统隔离：manifest script "${script}" 的 ${kind} ${operand} 通过本地文件系统路径访问 ${escapeCommandTarget(target, targetPath)}。`,
    `  修正方向：${repair}`,
  ].join("\n");
}

function renderCommandOrchestration(
  position: string,
  script: string,
  selector: string,
  target: PackageBoundary,
): string {
  return [
    `${position} 包文件系统隔离：manifest script "${script}" 的 selector operand ${selector} 指向兄弟包 ${target.name} (${target.relativePath})；普通包不得用它编排跨包任务，跨包任务编排归根 Workspace Orchestration Package。`,
    "  修正方向：把该跨包任务编排交给根 Workspace Orchestration Package，或改用本包内任务。",
  ].join("\n");
}

function renderCommandUnverifiable(
  position: string,
  script: string,
  kind: string,
  operand: string,
  owner: PackageBoundary,
): string {
  const described = operand.length > 0 ? `${kind} ${operand}` : kind;

  return [
    `${position} 包文件系统隔离：${describe(owner)} 在 manifest script "${script}" 的 ${described} 给出了带仓库定位线索但无法静态求值的表达式，检查器无法验证其目标，也不虚构目标。`,
    "  修正方向：把该路径改写为可静态确定的本包内目标；确需跨包资源时改用声明依赖与公开 exports，仓库范围任务交给根 Workspace Orchestration Package。",
  ].join("\n");
}

/** 已知静态 operand 的真实位置无法验证（断裂或环状链接）：与文件面同一类别语义，不虚构目标包，也不因目标不存在而放行。 */
function renderCommandPhysicalUnverifiable(
  position: string,
  script: string,
  kind: string,
  operand: string,
  owner: PackageBoundary,
  reason: string,
): string {
  return [
    `${position} 包文件系统隔离：${describe(owner)} 在 manifest script "${script}" 的 ${kind} ${operand} 无法验证真实路径（${reason}），检查器不虚构目标包，也不因目标不存在而放行。`,
    "  修正方向：把该路径指向本包内确实存在或可静态确定的目标，并移除断裂或环状的符号链接；确需跨包资源时改用声明依赖与公开 exports。",
  ].join("\n");
}

/** 已知静态 operand 的真实位置落在仓库根之外：与文件面同一语义，如实标注工作区外目标，不伪造包身份。 */
function renderCommandOutsideRepository(
  position: string,
  script: string,
  kind: string,
  operand: string,
  owner: PackageBoundary,
  realPath: string,
): string {
  return [
    `${position} 包文件系统隔离：${describe(owner)} 在 manifest script "${script}" 的 ${kind} ${operand} 通过本地文件系统路径访问工作区之外的 ${realPath}。`,
    "  修正方向：把所需资源放回本包或某个已声明 workspace 依赖的包内，仓库范围读取交给根 Workspace Orchestration Package；检查器不会为工作区外目标伪造包身份。",
  ].join("\n");
}

type CommandOperandVerdict =
  | {
      readonly kind: "escape";
      readonly target: PackageBoundary;
      readonly targetPath: string;
    }
  | { readonly kind: "outside"; readonly realPath: string }
  | { readonly kind: "unverifiable"; readonly reason: string }
  | undefined;

/**
 * 11：命令含不支持构造，且该构造**自身携带**的 operand 带仓库定位线索时给出"无法验证"诊断。
 * 只说明该 operand 因构造无法可靠结构化，不猜目标、不虚构 shell token 偏移；构造之外的普通参数不进入这里。
 */
function renderCommandUnsupportedConstruct(
  position: string,
  script: string,
  unsupportedOps: readonly string[],
  operand: string,
  owner: PackageBoundary,
): string {
  const ops = [...new Set(unsupportedOps)].join("、");

  return [
    `${position} 包文件系统隔离：${describe(owner)} 在 manifest script "${script}" 使用了检查器不支持的命令构造（${ops}），其中的 operand ${operand} 带仓库定位线索，无法可靠结构化判定目标；检查器不验证该目标，也不虚构目标。`,
    "  修正方向：把该 operand 改写为可静态确定的本包内目标，并改用简单顺序串联（&&）；确需跨包资源时改用声明依赖与公开 exports，仓库范围任务交给根 Workspace Orchestration Package。",
  ].join("\n");
}

/**
 * 把已知的静态路径 operand 解析到命令 cwd（owner 包目录）并判定归属。
 * operand 是原样交给进程的字面路径：与 fs 面同一物理接缝，词法在本包内不提前放行，
 * 经最近存在前缀/native realpath 判真实归属；只有落到另一个成员包才算越界，
 * 仓库内非包目录（如 `../shared/src`）不在 command 面阻断；真实位置落在仓库根外的 operand
 * 按工作区外目标失败（与文件面同一三类结果），只有词法本来就在根外的 operand 沿用跳过约定。
 */
function resolveCommandOperand(
  owner: PackageBoundary,
  layout: WorkspaceLayout,
  word: CommandWord,
): CommandOperandVerdict {
  if (word.nonStatic || word.text.length === 0) {
    return undefined;
  }
  const text = word.text;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(text)) {
    return undefined;
  }
  const resolved = path.resolve(owner.directory, text);
  // 词法落在仓库根之外时不伪造 owner：command 面只对已知成员做 containment，与 08 文件面一致跳过根外目标。
  if (!isInsideRepository(resolved)) {
    return undefined;
  }
  // 11+12 组合义务：根 Workspace Orchestration Package 不承受普通包 containment，因此静态 operand 在根侧
  // 既不判越界也不判工作区外目标（仓库内目标本就全部落在根目录内）。根的相关 unknown 仍由
  // reportPathOperand/reportSelectorOperand 的 nonStatic 分支与 commandDiagnostics 的构造 operand 出诊断，
  // 不依赖这里的归属结论。
  if (owner.isRepositoryRoot) {
    return undefined;
  }
  const physical = physicalTargetOf(absoluteLiteralForm(owner.directory, text));
  if ("reason" in physical) {
    return { kind: "unverifiable", reason: physical.reason };
  }
  // 真实位置落在仓库根外：与文件面同一处理，按工作区外目标失败，不为其伪造包身份，也不因落到根外而放行。
  if (!isInsideRepository(physical.real)) {
    return { kind: "outside", realPath: physical.real };
  }
  const lexicalTarget = owningBoundary(layout, resolved);
  const realTarget = owningBoundary(layout, physical.real);
  // 命令面与原 AST 面同一判定：普通包经仓库根私有路径（含 ../../scripts）逃逸即越界。
  const escaped =
    realTarget.directory === owner.directory
      ? lexicalTarget.directory === owner.directory
        ? undefined
        : lexicalTarget
      : realTarget;
  if (escaped === undefined) {
    return undefined;
  }
  return {
    kind: "escape",
    target: escaped,
    targetPath: relativeToRepositoryRoot(resolved),
  };
}

type CommandReporter = {
  readonly layout: WorkspaceLayout;
  readonly owner: PackageBoundary;
  readonly position: string;
  readonly script: string;
  readonly add: (diagnostic: string) => void;
};

function reportPathOperand(
  reporter: CommandReporter,
  kind: string,
  word: CommandWord,
): void {
  if (word.nonStatic) {
    if (commandOperandHint(word.text)) {
      reporter.add(
        renderCommandUnverifiable(
          reporter.position,
          reporter.script,
          kind,
          word.text,
          reporter.owner,
        ),
      );
    }
    return;
  }
  const verdict = resolveCommandOperand(reporter.owner, reporter.layout, word);
  if (verdict === undefined) {
    return;
  }
  if (verdict.kind === "unverifiable") {
    reporter.add(
      renderCommandPhysicalUnverifiable(
        reporter.position,
        reporter.script,
        kind,
        word.text,
        reporter.owner,
        verdict.reason,
      ),
    );
    return;
  }
  if (verdict.kind === "outside") {
    reporter.add(
      renderCommandOutsideRepository(
        reporter.position,
        reporter.script,
        kind,
        word.text,
        reporter.owner,
        verdict.realPath,
      ),
    );
    return;
  }
  reporter.add(
    renderCommandEscape(
      reporter.position,
      reporter.script,
      kind,
      word.text,
      reporter.owner,
      verdict.target,
      verdict.targetPath,
    ),
  );
}

/** 明确目录 selector 按 command cwd（owning 包目录）解释；精确 sibling 名称是跨包编排归根；glob/brace/未识别形态不猜测。 */
function reportSelectorOperand(
  reporter: CommandReporter,
  word: CommandWord,
): void {
  if (word.nonStatic) {
    const shown = word.text;
    if (commandOperandHint(word.text)) {
      reporter.add(
        renderCommandUnverifiable(
          reporter.position,
          reporter.script,
          "selector operand",
          shown,
          reporter.owner,
        ),
      );
    }
    return;
  }
  // 单一排除前缀不改变目录 selector 的 cwd 判定（U1）。
  const selector = word.text.startsWith("!") ? word.text.slice(1) : word.text;
  if (selector.length === 0 || selector === "." || selector === "./") {
    return;
  }
  // 明确目录形态（相对或绝对路径）：与路径 operand 同一判定——按 command cwd 词法归位后
  // 仍经真实位置独立判归属，经链接物理落到兄弟包的目录 selector 不再被词法同包提前放行。
  if (
    selector.startsWith("./") ||
    selector.startsWith("../") ||
    selector.startsWith("/")
  ) {
    const verdict = resolveCommandOperand(reporter.owner, reporter.layout, {
      nonStatic: false,
      text: selector,
    });
    if (verdict === undefined) {
      return;
    }
    if (verdict.kind === "unverifiable") {
      reporter.add(
        renderCommandPhysicalUnverifiable(
          reporter.position,
          reporter.script,
          "selector operand",
          selector,
          reporter.owner,
          verdict.reason,
        ),
      );
      return;
    }
    if (verdict.kind === "outside") {
      reporter.add(
        renderCommandOutsideRepository(
          reporter.position,
          reporter.script,
          "selector operand",
          selector,
          reporter.owner,
          verdict.realPath,
        ),
      );
      return;
    }
    if (verdict.target.isRepositoryRoot) {
      reporter.add(
        renderCommandEscape(
          reporter.position,
          reporter.script,
          "selector operand",
          selector,
          reporter.owner,
          verdict.target,
          verdict.targetPath,
        ),
      );
    } else {
      reporter.add(
        renderCommandOrchestration(
          reporter.position,
          reporter.script,
          selector,
          verdict.target,
        ),
      );
    }
    return;
  }
  // 名称 selector：精确 sibling 逻辑身份 → 跨包编排归根；未识别名或含 glob/brace 语法不猜测。
  // 编排跨包任务正是根 Workspace Orchestration Package 的职责，根侧继续豁免这一静态 containment 判定。
  const byName = reporter.owner.isRepositoryRoot
    ? undefined
    : reporter.layout.packages.find(
        (member) => !member.isRepositoryRoot && member.name === selector,
      );
  if (byName !== undefined && byName !== reporter.owner) {
    reporter.add(
      renderCommandOrchestration(
        reporter.position,
        reporter.script,
        selector,
        byName,
      ),
    );
  }
}

type CommandFlag = {
  readonly flag: string;
  readonly hasInlineValue: boolean;
  readonly value: CommandWord | undefined;
};

function readCommandFlag(
  word: CommandWord,
  next: CommandWord | undefined,
): CommandFlag {
  const equals = word.text.indexOf("=");
  if (equals >= 0) {
    return {
      flag: word.text.slice(0, equals),
      hasInlineValue: true,
      value: { nonStatic: word.nonStatic, text: word.text.slice(equals + 1) },
    };
  }
  return { flag: word.text, hasInlineValue: false, value: next };
}

function scanPackageManager(
  reporter: CommandReporter,
  words: CommandWord[],
): void {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    const token = word.text;
    if (token === "exec") {
      // `pnpm exec <cmd>`：把 exec 之后的单个已知段当作嵌套命令沿同一闭集求值，非任意递归。
      evaluateCommandSegment(reporter, words.slice(index + 1));
      return;
    }
    if (
      token === "--" ||
      token === "run" ||
      token === "dlx" ||
      token === "add" ||
      token === "unlink"
    ) {
      return;
    }
    if (token.startsWith("-")) {
      const { flag, hasInlineValue, value } = readCommandFlag(
        word,
        words[index + 1],
      );
      if (flag === "--dir" || flag === "-C") {
        if (value !== undefined) {
          reportPathOperand(reporter, "工作目录 operand", value);
        }
        index += hasInlineValue ? 1 : 2;
        continue;
      }
      if (flag === "--filter" || flag === "--f" || flag === "-F") {
        if (value !== undefined) {
          reportSelectorOperand(reporter, value);
        }
        index += hasInlineValue ? 1 : 2;
        continue;
      }
    }
    index += 1;
  }
}

function scanTurbo(reporter: CommandReporter, words: CommandWord[]): void {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (word.text === "--") {
      return;
    }
    if (word.text.startsWith("-")) {
      const { flag, hasInlineValue, value } = readCommandFlag(
        word,
        words[index + 1],
      );
      if (flag === "--filter" || flag === "--f" || flag === "-F") {
        if (value !== undefined) {
          reportSelectorOperand(reporter, value);
        }
        index += hasInlineValue ? 1 : 2;
        continue;
      }
    }
    index += 1;
  }
}

function scanConfigTool(reporter: CommandReporter, words: CommandWord[]): void {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (word.text === "--") {
      return;
    }
    if (word.text.startsWith("-")) {
      const { flag, hasInlineValue, value } = readCommandFlag(
        word,
        words[index + 1],
      );
      if (flag === "-p" || flag === "--project") {
        if (value !== undefined) {
          reportPathOperand(reporter, "config operand", value);
        }
        index += hasInlineValue ? 1 : 2;
        continue;
      }
    }
    index += 1;
  }
}

/** Node 已知带独立值的选项：其独立值不占 source-entry 位，避免真越界 operand 被当成入口后丢失。 */
const nodeValueFlags = new Set(["--conditions", "--require", "--import", "-r"]);

function scanNode(reporter: CommandReporter, words: CommandWord[]): void {
  let entrySeen = false;
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    const token = word.text;
    if (token === "-e" || token === "--eval" || token === "--print") {
      const program = readCommandFlag(word, words[index + 1]);
      const text = program.value?.text ?? "";
      if (commandOperandHint(text)) {
        reporter.add(
          renderCommandUnverifiable(
            reporter.position,
            reporter.script,
            "内联程序",
            "",
            reporter.owner,
          ),
        );
      }
      index += program.hasInlineValue ? 1 : 2;
      continue;
    }
    if (token.startsWith("-")) {
      const equals = token.indexOf("=");
      const flag = equals >= 0 ? token.slice(0, equals) : token;
      if (nodeValueFlags.has(flag) && equals < 0) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (!entrySeen) {
      // 第一个非选项才是 source-entry；其后位置参数属任意用户 argv，不在已知路径闭集内升级。
      reportPathOperand(reporter, "source-entry operand", word);
      entrySeen = true;
    }
    index += 1;
  }
}

/** 目录工具（oxlint/oxfmt）已知的非路径取值 flag：其独立值是模式/配置，不得成为目录 operand。 */
const dirValueFlags = new Set([
  "--ignore-pattern",
  "--ignore-path",
  "--config",
]);

function scanDirectoryTool(
  reporter: CommandReporter,
  words: CommandWord[],
): void {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    const token = word.text;
    if (token === "--") {
      return;
    }
    if (token.startsWith("-")) {
      const equals = token.indexOf("=");
      const flag = equals >= 0 ? token.slice(0, equals) : token;
      if (dirValueFlags.has(flag) && equals < 0) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    reportPathOperand(reporter, "目录 operand", word);
    index += 1;
  }
}

/** cargo 原窄类别：仅 `--manifest-path` 是已知 config operand；`--` 之后 passthrough 与子命令名不猜路径。 */
function scanCargo(reporter: CommandReporter, words: CommandWord[]): void {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (word.text === "--") {
      return;
    }
    if (word.text.startsWith("-")) {
      const { flag, hasInlineValue, value } = readCommandFlag(
        word,
        words[index + 1],
      );
      if (flag === "--manifest-path") {
        if (value !== undefined) {
          reportPathOperand(reporter, "config operand", value);
        }
        index += hasInlineValue ? 1 : 2;
        continue;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
}

/** cd 的原窄类别：第一个非选项 operand 按 command cwd 起算的工作目录判定。 */
function scanCd(reporter: CommandReporter, words: CommandWord[]): void {
  for (const word of words) {
    if (word.text.startsWith("-")) {
      continue;
    }
    reportPathOperand(reporter, "工作目录 operand", word);
    return;
  }
}

function scanVitest(reporter: CommandReporter, words: CommandWord[]): void {
  let started = false;
  for (const word of words) {
    if (!started) {
      if (word.text === "run") {
        started = true;
      }
      continue;
    }
    if (word.text === "--") {
      return;
    }
    if (word.text.startsWith("-")) {
      continue;
    }
    reportPathOperand(reporter, "工具 positional operand", word);
  }
}

/** 字面量 env 赋值前缀（`NAME=value`）：正常解析后跳过，其后已知 operand 仍须判定，绝不让前缀吞掉越界。 */
function isEnvAssignmentWord(word: CommandWord): boolean {
  return !word.nonStatic && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text);
}

function evaluateCommandSegment(
  reporter: CommandReporter,
  words: CommandWord[],
  // 由 `&&` 以外的控制符开启的段，其首词可能是重定向目标等而非 executable：该词不升格为 executable operand，
  // 仍交给同一 evaluator 的已知工具判定，其余部分照常出证据。
  treatLeadingWordAsExecutable = true,
): void {
  let start = 0;
  while (start < words.length && isEnvAssignmentWord(words[start]!)) {
    start += 1;
  }
  const executable = words[start];
  if (executable === undefined || executable.nonStatic) {
    return;
  }
  const name = executable.text;
  if (name.length === 0) {
    return;
  }
  const tail = words.slice(start + 1);
  if (name.includes("/")) {
    if (treatLeadingWordAsExecutable) {
      reportPathOperand(reporter, "executable operand", executable);
    }
    return;
  }
  switch (name) {
    case "pnpm": {
      scanPackageManager(reporter, tail);
      return;
    }
    case "turbo": {
      scanTurbo(reporter, tail);
      return;
    }
    case "tsc": {
      scanConfigTool(reporter, tail);
      return;
    }
    case "node": {
      scanNode(reporter, tail);
      return;
    }
    case "oxfmt":
    case "oxlint": {
      scanDirectoryTool(reporter, tail);
      return;
    }
    case "cargo": {
      scanCargo(reporter, tail);
      return;
    }
    case "cd": {
      scanCd(reporter, tail);
      return;
    }
    case "vitest": {
      scanVitest(reporter, tail);
      return;
    }
    default: {
      return;
    }
  }
}

function propertyAssignmentName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** 用 JSON 语法树取具体 `scripts.<name>` 值的准确来源位置；shell token 无原生偏移，位置只由 JSON 提供。 */
function scriptValuePositions(
  manifestText: string,
  relativeManifest: string,
): Map<string, string> {
  const positions = new Map<string, string>();
  const source = ts.createSourceFile(
    relativeManifest,
    manifestText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSON,
  );
  const statement = source.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) {
    return positions;
  }
  const root = statement.expression;
  if (!ts.isObjectLiteralExpression(root)) {
    return positions;
  }
  const scriptsProperty = root.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      propertyAssignmentName(property.name) === "scripts",
  );
  if (
    scriptsProperty === undefined ||
    !ts.isObjectLiteralExpression(scriptsProperty.initializer)
  ) {
    return positions;
  }
  for (const property of scriptsProperty.initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = propertyAssignmentName(property.name);
    if (name === undefined) {
      continue;
    }
    const { character, line } = source.getLineAndCharacterOfPosition(
      property.initializer.getStart(source),
    );
    positions.set(name, `${relativeManifest}:${line + 1}:${character + 1}`);
  }
  return positions;
}

/** 沿既有一次发现的成员集合读取各自 manifest scripts，逐已知单段命令判定越界；根豁免沿用。 */
function commandDiagnostics(layout: WorkspaceLayout): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const add = (diagnostic: string): void => {
    if (!seen.has(diagnostic)) {
      seen.add(diagnostic);
      diagnostics.push(diagnostic);
    }
  };
  for (const boundary of layout.packages) {
    // 11（主裁定）：根不再整条跳过。根只继续豁免静态跨包 containment（见 resolveCommandOperand 与
    // reportSelectorOperand）；带仓库定位线索的相关 unknown（已知内联程序、重定向目标、命令替换内的
    // operand）仍走同一诊断，不能仅因 owner 是根就被静默认证，无关的简单编排继续不阻断。
    const manifestPath = path.join(boundary.directory, "package.json");
    let manifestText: string;
    try {
      manifestText = readFileSync(manifestPath, "utf8");
    } catch {
      continue;
    }
    let scripts: Record<string, string>;
    try {
      const parsed = JSON.parse(manifestText) as {
        scripts?: Record<string, string>;
      };
      scripts = parsed.scripts ?? {};
    } catch {
      continue;
    }
    const relativeManifest = relativeToRepositoryRoot(manifestPath);
    const positions = scriptValuePositions(manifestText, relativeManifest);
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== "string") {
        continue;
      }
      const analysis = commandSegments(command);
      if (analysis === null) {
        continue;
      }
      const position = positions.get(name) ?? `${relativeManifest}:1:1`;
      const reporter: CommandReporter = {
        add,
        layout,
        owner: boundary,
        position,
        script: name,
      };
      const addedBefore = diagnostics.length;
      for (const segment of analysis.segments) {
        evaluateCommandSegment(
          reporter,
          segment.words,
          !segment.followsUnsupportedOp,
        );
      }
      // 11（RC11-A）：泛化"无法验证"只由不支持构造自身携带的 operand（重定向目标、subshell/命令替换边界内的词）
      // 逐个触发；逐段判定已给出更精确结论时不堆叠，不含线索的复杂命令继续不阻断（08 窄范围）。
      if (
        analysis.unsupportedOps.length > 0 &&
        diagnostics.length === addedBefore
      ) {
        for (const word of analysis.constructOperands) {
          if (!commandOperandHint(word.text)) {
            continue;
          }
          add(
            renderCommandUnsupportedConstruct(
              position,
              name,
              analysis.unsupportedOps,
              word.text,
              boundary,
            ),
          );
        }
      }
    }
  }
  return diagnostics;
}

/** workspace 输入或成员 manifest 无法按官方协议解释时明确失败：不退回目录树发现，也不吞掉读取错误。 */
function discoverWorkspaceLayoutOrExit(): WorkspaceLayout {
  try {
    return discoverWorkspaceLayout();
  } catch (error) {
    if (error instanceof WorkspaceDiscoveryFailure) {
      process.stderr.write(
        `包文件系统隔离：workspace 成员发现失败 —— ${error.message}\n  修正方向：把根 pnpm-workspace.yaml 的 packages 与成员 manifest 修正为官方成员协议可解释的形态；检查器不会退回目录树猜测成员。\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

const standardAutomationTaskNames = ["typecheck", "lint", "format:check"];
const vueToolAdapterEntryRelativePath = "scripts/run-vue-tsc.ts";
const browserProtocolToolingLeafName = "tsconfig.node.json";

/** TypeScript 官方 API 产出的执行项目事实；broken 表示无法静态判定，绝不以「未发现违规」代替判定。 */
type ProjectFacts = {
  readonly broken: readonly string[];
  readonly commandLine: ts.ParsedCommandLine | undefined;
  readonly configPath: string;
  readonly hasReferences: boolean;
  readonly members: ReadonlySet<string>;
  readonly nonEmitting: boolean;
  readonly references: readonly string[];
  /** 官方配置按 `.vue` 扩展真实纳入的 SFC 入口；与 TS 成员分开，SFC 永不进 Program 根。 */
  readonly sfcEntries: readonly string[];
};

function emptyProjectFacts(
  configPath: string,
  broken: readonly string[],
): ProjectFacts {
  return {
    broken,
    commandLine: undefined,
    configPath,
    hasReferences: false,
    members: new Set<string>(),
    nonEmitting: false,
    references: [],
    sfcEntries: [],
  };
}

function toRealPath(targetPath: string): string {
  return ts.sys.realpath?.(targetPath) ?? targetPath;
}

const projectFactsCache = new Map<string, ProjectFacts>();

/** 原生 tsc 的 config 操作数可以是目录（其下的 tsconfig.json 才是实际配置）；先按该协议落到配置文件，成员事实与项目身份都以它为准。 */
function resolveConfigOperandTarget(configPath: string): string {
  const absolute = path.resolve(configPath);

  return statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true
    ? path.join(absolute, "tsconfig.json")
    : absolute;
}

/** 用官方 API 原生解析 JSONC、extends 链与 files/include/exclude 的真实匹配产物；CLI `--noEmit` 按原生覆盖语义并入有效 options。 */
function readProjectFacts(
  configPath: string,
  cliNoEmit: boolean | undefined,
): ProjectFacts {
  const absolute = resolveConfigOperandTarget(configPath);
  const cacheKey = `${toRealPath(absolute)}|${
    cliNoEmit === undefined ? "-" : String(cliNoEmit)
  }`;
  const cached = projectFactsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const facts = parseProjectFacts(absolute, cliNoEmit);
  projectFactsCache.set(cacheKey, facts);
  return facts;
}

/** 官方配置展开承认 SFC 入口用的扩展声明（scriptKind Deferred 即「扩展由宿主决定」）：它只决定 `.vue` 算不算输入，不引入任何解析依赖，无 Vue 形态的展开结果不变。 */
const sfcExtraFileExtensions: readonly ts.FileExtensionInfo[] = [
  {
    extension: ".vue",
    isMixedContent: false,
    scriptKind: ts.ScriptKind.Deferred,
  },
];

/** 只纳入 SFC 的合法 leaf 项目在纯 TS 展开下会被官方判为「没有输入」；扩展声明让成员事实按语言分流，SFC 入口交给等长投影观察。 */
function parseProjectFacts(
  configPath: string,
  cliNoEmit: boolean | undefined,
): ProjectFacts {
  const shown = relativeToRepositoryRoot(configPath);
  if (statSync(configPath, { throwIfNoEntry: false }) === undefined) {
    return emptyProjectFacts(configPath, [`配置缺失：${shown} 不存在`]);
  }
  const broken: string[] = [];
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      broken.push(
        `坏配置：${shown}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      );
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    cliNoEmit === undefined ? undefined : { noEmit: cliNoEmit },
    host,
    undefined,
    undefined,
    sfcExtraFileExtensions,
  );
  if (parsed === undefined) {
    return emptyProjectFacts(configPath, broken);
  }
  for (const diagnostic of parsed.errors) {
    broken.push(
      `坏配置：${shown}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }
  const directory = path.dirname(configPath);
  const references = (parsed.projectReferences ?? []).map((reference) =>
    path.isAbsolute(reference.path)
      ? reference.path
      : path.resolve(directory, reference.path),
  );
  const fileNames = parsed.fileNames.map(toRealPath);

  return {
    broken,
    commandLine: parsed,
    configPath,
    hasReferences: references.length > 0,
    members: new Set(
      fileNames.filter((fileName) => path.extname(fileName) !== ".vue"),
    ),
    nonEmitting: parsed.options.noEmit === true,
    references,
    sfcEntries: fileNames.filter(
      (fileName) => path.extname(fileName) === ".vue",
    ),
  };
}

/** 单段的执行协议归约结果；not-reducible 只在含本地脚本的 boundary 的 typecheck/build 判定面内成为「无法验证」，不向无关任务扩展。 */
type SegmentClassification =
  | {
      readonly kind: "ts";
      readonly mode: "p" | "build";
      readonly configPath: string;
      readonly cliNoEmit: boolean | undefined;
    }
  | { readonly kind: "non-ts" }
  | { readonly kind: "not-reducible"; readonly reason: string };

function notReducible(reason: string): SegmentClassification {
  return { kind: "not-reducible", reason };
}

/** tsc 官方闭集形态：`-p <config>` 只执行目标自身；`--build` 才遍历 references；`--noEmit` 与 `--pretty <值>` 按原生形态消费。 */
function classifyTscInvocation(
  boundaryDirectory: string,
  words: readonly CommandWord[],
): SegmentClassification {
  let projectOption: string | undefined;
  let buildOption: string | undefined;
  let isBuild = false;
  let noEmitFlag: boolean | undefined;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const token = word.text;
    if (word.nonStatic) {
      return notReducible(`operand ${token} 非静态`);
    }
    if (token === "--build" || token === "-b") {
      isBuild = true;
      continue;
    }
    if (token === "--noEmit") {
      const next = words[index + 1];
      if (
        next !== undefined &&
        !next.nonStatic &&
        /^(true|false)$/.test(next.text)
      ) {
        noEmitFlag = next.text === "true";
        index += 1;
      } else {
        noEmitFlag = true;
      }
      continue;
    }
    if (token.startsWith("--noEmit=")) {
      noEmitFlag = token.slice("--noEmit=".length) === "true";
      continue;
    }
    if (token === "-p" || token === "--project") {
      const next = words[index + 1];
      if (projectOption !== undefined || next === undefined || next.nonStatic) {
        return notReducible(`tsc ${token} 缺少可静态判定的 config operand`);
      }
      projectOption = next.text;
      index += 1;
      continue;
    }
    if (token.startsWith("--project=")) {
      if (projectOption !== undefined) {
        return notReducible("tsc 出现多个 -p 目标");
      }
      projectOption = token.slice("--project=".length);
      continue;
    }
    if (token === "--pretty") {
      const next = words[index + 1];
      if (next !== undefined && !next.nonStatic && !next.text.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      return notReducible(`tsc 选项 ${token} 不属闭合执行协议`);
    }
    if (isBuild) {
      if (buildOption !== undefined) {
        return notReducible(`tsc --build 出现多余 positional ${token}`);
      }
      buildOption = token;
      continue;
    }
    return notReducible(`tsc 裸文件参数 ${token} 不属闭合执行协议`);
  }
  if (isBuild && projectOption !== undefined) {
    return notReducible("tsc --build 与 -p 不得混用");
  }
  if (isBuild) {
    return {
      kind: "ts",
      mode: "build",
      configPath: path.resolve(
        boundaryDirectory,
        buildOption ?? "tsconfig.json",
      ),
      cliNoEmit: noEmitFlag ?? undefined,
    };
  }
  if (projectOption !== undefined) {
    return {
      kind: "ts",
      mode: "p",
      configPath: path.resolve(boundaryDirectory, projectOption),
      cliNoEmit: noEmitFlag,
    };
  }
  return notReducible("tsc 必须以 -p <config> 或 --build 执行闭合协议形态");
}

/** Vue Tool Adapter 依其明确 `--build --noEmit` 编译协议观察（默认 solution tsconfig.json）；不调用 run()、不加载 vue-tsc，参数偏离协议即协议改变。 */
function classifyNodeInvocation(
  boundaryDirectory: string,
  words: readonly CommandWord[],
): SegmentClassification {
  let entry: string | undefined;
  let entryIndex = -1;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.nonStatic) {
      return notReducible("node operand 非静态");
    }
    const token = word.text;
    if (token.startsWith("-")) {
      if (nodeValueFlags.has(token)) index += 1;
      continue;
    }
    entry = token;
    entryIndex = index;
    break;
  }
  if (entry === undefined) return notReducible("node 命令缺少入口");
  if (
    toRealPath(path.resolve(boundaryDirectory, entry)) !==
    toRealPath(path.resolve(boundaryDirectory, vueToolAdapterEntryRelativePath))
  ) {
    return notReducible(
      `node 入口 ${entry} 属包装脚本或未知启动，不属闭合执行协议`,
    );
  }
  let sawBuild = false;
  let sawNoEmit = false;
  let configOperand: string | undefined;
  for (let index = entryIndex + 1; index < words.length; index += 1) {
    const word = words[index]!;
    const token = word.text;
    if (word.nonStatic) return notReducible("Vue adapter operand 非静态");
    if (token === "--build" || token === "-b") {
      sawBuild = true;
      continue;
    }
    if (token === "--noEmit") {
      sawNoEmit = true;
      continue;
    }
    if (token === "--pretty") {
      const next = words[index + 1];
      if (next !== undefined && !next.nonStatic && !next.text.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      return notReducible(
        `Vue adapter 参数 ${token} 偏离 --build --noEmit 协议`,
      );
    }
    if (configOperand !== undefined) {
      return notReducible("Vue adapter 出现多余 positional 参数");
    }
    configOperand = token;
  }
  if (!sawBuild || !sawNoEmit) {
    return notReducible(
      "Vue Tool Adapter 必须依其明确的 --build --noEmit 编译协议调用",
    );
  }

  return {
    kind: "ts",
    mode: "build",
    configPath: path.resolve(
      boundaryDirectory,
      configOperand ?? "tsconfig.json",
    ),
    cliNoEmit: true,
  };
}

function classifyCommandSegment(
  boundary: PackageBoundary,
  words: readonly CommandWord[],
): SegmentClassification {
  let start = 0;
  while (start < words.length && isEnvAssignmentWord(words[start]!)) start += 1;
  const executable = words[start];
  if (executable === undefined) return { kind: "non-ts" };
  if (executable.nonStatic) {
    return notReducible(`可执行名 ${executable.text} 非静态`);
  }
  const tail = words.slice(start + 1);
  switch (executable.text) {
    case "cargo": {
      return { kind: "non-ts" };
    }
    case "node": {
      return classifyNodeInvocation(boundary.directory, tail);
    }
    case "tsc": {
      return classifyTscInvocation(boundary.directory, tail);
    }
    case "vike":
    case "vite": {
      const positional = tail.find((word) => !word.text.startsWith("-"));
      if (positional !== undefined && positional.text === "build") {
        return { kind: "non-ts" };
      }
      return notReducible(`${executable.text} 子命令不属闭合 builder 形态`);
    }
    default: {
      return notReducible(`任务可执行文件 ${executable.text} 不属闭合执行协议`);
    }
  }
}

/** boundary 的一个任务（typecheck/build）执行面：被真实执行的项目集合按 `-p`/`--build` 官方协议区分计算；同一配置多路到达只计一次。 */
type BoundaryTaskFace = {
  readonly executed: readonly {
    readonly project: ProjectFacts;
    readonly mode: "p" | "build";
  }[];
  readonly kind: "absent" | "non-ts" | "protocol" | "unverifiable";
  readonly unverifiable: readonly string[];
};

function taskFaceFor(
  boundary: PackageBoundary,
  command: string | undefined,
): BoundaryTaskFace {
  if (command === undefined) {
    return { executed: [], kind: "absent", unverifiable: [] };
  }
  const analysis = commandSegments(command);
  if (analysis === null || analysis.unsupportedOps.length > 0) {
    return {
      executed: [],
      kind: "unverifiable",
      unverifiable: [`命令无法按官方 shell token 协议分词：${command}`],
    };
  }
  const classifications = analysis.segments.map((segment) =>
    classifyCommandSegment(boundary, segment.words),
  );
  const blockers = classifications.filter(
    (entry) => entry.kind === "not-reducible",
  );
  if (blockers.length > 0) {
    return {
      executed: [],
      kind: "unverifiable",
      unverifiable: blockers.map((blocker) => blocker.reason),
    };
  }
  const tsEntries = classifications.filter((entry) => entry.kind === "ts");
  if (tsEntries.length === 0) {
    return { executed: [], kind: "non-ts", unverifiable: [] };
  }
  const modes = new Set(tsEntries.map((entry) => entry.mode));
  if (modes.size > 1) {
    return {
      executed: [],
      kind: "unverifiable",
      unverifiable: ["typecheck 混用 -p 与 --build 执行面，协议形态不可归约"],
    };
  }
  const mode = tsEntries[0]!.mode;
  const executed: { project: ProjectFacts; mode: "p" | "build" }[] = [];
  const unverifiable: string[] = [];
  const seen = new Set<string>();
  if (mode === "p") {
    for (const entry of tsEntries) {
      const project = readProjectFacts(entry.configPath, entry.cliNoEmit);
      if (project.broken.length > 0) {
        unverifiable.push(...project.broken);
        continue;
      }
      const identity = toRealPath(project.configPath);
      if (seen.has(identity)) continue;
      seen.add(identity);
      executed.push({ project, mode });
    }
  } else {
    for (const entry of tsEntries) {
      collectBuildClosure(
        entry.configPath,
        entry.cliNoEmit,
        executed,
        unverifiable,
        seen,
        [],
      );
    }
  }
  return {
    executed,
    kind: unverifiable.length > 0 ? "unverifiable" : "protocol",
    unverifiable,
  };
}

function collectBuildClosure(
  configPath: string,
  cliNoEmit: boolean | undefined,
  executed: { project: ProjectFacts; mode: "p" | "build" }[],
  unverifiable: string[],
  seen: Set<string>,
  stack: readonly string[],
): void {
  const identity = toRealPath(configPath);
  if (stack.includes(identity)) {
    unverifiable.push(`references 环：${relativeToRepositoryRoot(configPath)}`);
    return;
  }
  const project = readProjectFacts(configPath, cliNoEmit);
  if (project.broken.length > 0) {
    unverifiable.push(...project.broken);
    return;
  }
  if (seen.has(identity)) return;
  seen.add(identity);
  executed.push({ project, mode: "build" });
  const nextStack = [...stack, identity];
  for (const reference of project.references) {
    collectBuildClosure(
      reference,
      cliNoEmit,
      executed,
      unverifiable,
      seen,
      nextStack,
    );
  }
}

const manifestScriptsCache = new Map<string, Record<string, string>>();

function boundaryManifestScripts(boundary: PackageBoundary) {
  const cached = manifestScriptsCache.get(boundary.directory);
  if (cached !== undefined) return cached;
  let scripts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(boundary.directory, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    scripts = Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    scripts = {};
  }
  manifestScriptsCache.set(boundary.directory, scripts);
  return scripts;
}

/** boundary 的开发自动化源码集合：scripts 目录下全部 .ts（含声明文件），按 realpath 文件身份去重；派生目录与真实 workspace 成员目录不进入，嵌套 manifest 本身不构成成员身份。 */
function automationScriptFiles(
  layout: WorkspaceLayout,
  boundary: PackageBoundary,
): string[] {
  const scriptsDirectory = path.join(boundary.directory, "scripts");
  if (
    statSync(scriptsDirectory, { throwIfNoEntry: false })?.isDirectory() !==
    true
  ) {
    return [];
  }
  const found: string[] = [];
  const pending = [scriptsDirectory];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (!entry.isDirectory()) {
        if (path.extname(entry.name) === ".ts") found.push(entryPath);
        continue;
      }
      if (
        entry.name.startsWith(".") ||
        derivedDirectories.has(entry.name) ||
        layout.memberDirectories.has(entryPath)
      ) {
        continue;
      }
      pending.push(entryPath);
    }
  }

  return found.toSorted();
}

type ScriptCapture = {
  readonly configPath: string;
  readonly face: "build" | "typecheck";
  readonly owner: PackageBoundary;
  readonly mode: "p" | "build";
  readonly project: ProjectFacts;
};

function renderOwnershipRepair(direction: string): string {
  return `  修正方向：${direction}`;
}

/**
 * 无本地脚本 consumer 的静态配置候选：除默认 tsconfig.json 外，还包括其任务命令里按闭合协议字面写出的 config 操作数
 * （-p/--project、--project=、--build 的 positional 或其默认名），且解析后仍落在本 boundary 目录内。
 * 候选只用于按官方 API 读取项目成员事实以核对跨包吸收，不参与 owner 资格、任务要求或 unknown 阻断面判定。
 */
function staticFaceConfigCandidates(
  boundary: PackageBoundary,
  scripts: Record<string, string>,
): string[] {
  const candidates = new Set<string>([
    path.join(boundary.directory, "tsconfig.json"),
  ]);
  for (const command of [scripts.typecheck, scripts.build]) {
    if (command === undefined) continue;
    const analysis = commandSegments(command);
    if (analysis === null || analysis.unsupportedOps.length > 0) continue;
    for (const { words } of analysis.segments) {
      const tscIndex = words.findIndex(
        (word) => !word.nonStatic && word.text === "tsc",
      );
      if (tscIndex === -1) continue;
      const reduced = classifyTscInvocation(
        boundary.directory,
        words.slice(tscIndex + 1),
      );
      if (reduced.kind !== "ts") continue;
      if (!isInsideDirectory(reduced.configPath, boundary.directory)) continue;
      candidates.add(reduced.configPath);
    }
  }

  return [...candidates];
}

/** 3.3 闭合形态的协议 owner 资格，只依 typecheck 真实执行的项目集计算；成员事实与 15B 闭包事实共用同一判定。 */
function protocolOwnerFacts(
  boundary: PackageBoundary,
  typecheckTask: BoundaryTaskFace,
  scriptIdentities: readonly string[],
): {
  readonly containerConfigs: {
    readonly capturesScripts: boolean;
    readonly project: ProjectFacts;
  }[];
  readonly eligibleOwners: ProjectFacts[];
  readonly missingNamedLeaf: boolean;
  readonly unexecutedContainers: ProjectFacts[];
} {
  const containerConfigs: {
    capturesScripts: boolean;
    project: ProjectFacts;
  }[] = [];
  const eligibleOwners: ProjectFacts[] = [];
  const unexecutedContainers: ProjectFacts[] = [];
  if (typecheckTask.kind !== "protocol") {
    return {
      containerConfigs,
      eligibleOwners,
      missingNamedLeaf: false,
      unexecutedContainers,
    };
  }
  if (typecheckTask.executed[0]?.mode === "build") {
    const namedLeaf = typecheckTask.executed.find(
      (executed) =>
        toRealPath(executed.project.configPath) ===
          toRealPath(
            path.join(boundary.directory, browserProtocolToolingLeafName),
          ) && !executed.project.hasReferences,
    );
    if (namedLeaf === undefined) {
      return {
        containerConfigs,
        eligibleOwners,
        missingNamedLeaf: true,
        unexecutedContainers,
      };
    }
    eligibleOwners.push(namedLeaf.project);
    return {
      containerConfigs,
      eligibleOwners,
      missingNamedLeaf: false,
      unexecutedContainers,
    };
  }
  for (const executed of typecheckTask.executed) {
    if (!executed.project.hasReferences) {
      eligibleOwners.push(executed.project);
      continue;
    }
    const capturesScripts = scriptIdentities.some((identity) =>
      executed.project.members.has(identity),
    );
    containerConfigs.push({ capturesScripts, project: executed.project });
    if (!capturesScripts) unexecutedContainers.push(executed.project);
  }

  return {
    containerConfigs,
    eligibleOwners,
    missingNamedLeaf: false,
    unexecutedContainers,
  };
}

/** ---- 15B：官方只读 Program 成员闭包与最小 SFC 源码投影（N2 import 拉入 / N6 产品闭包不得引用脚本）。
 * 观察面就是 15A 已成立的任务→配置执行项目集：用 ts.createProgram 加原生模块解析取闭包，
 * 不 emit、不做语义检查、不启动编译任务或目标命令、不加载配置 module 与插件、不写任何文件。
 * Vue 只依官方 @vue/compiler-sfc.parse 取 script/scriptSetup/script src 与其原始偏移，投影为同长度内存 SourceFile，
 * 身份与诊断位置都锚定真实 SFC；不接入 Vue 语言服务、插件、bundler 全图，也不解释 style 与 custom block。 */

/** @vue/compiler-sfc.parse 结果里闭包观察需要的窄结构；其余 descriptor 内容一律忽略。parser 用 null 表示「没有该块」。 */
type SfcScriptBlock = {
  readonly content: string;
  readonly loc: { readonly start: { readonly offset: number } };
  readonly src?: string | null;
};

type SfcParseResult = {
  readonly descriptor: {
    readonly script?: SfcScriptBlock | null;
    readonly scriptSetup?: SfcScriptBlock | null;
  };
  readonly errors: readonly { readonly message: string }[];
};

type SfcParser =
  | {
      readonly kind: "available";
      readonly parse: (source: string) => SfcParseResult;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** 原生 SFC 与 TS 闭包共用的源码扩展；未解析且带这些扩展的本机边是「闭包无法完成」，不是未发现违规。 */
const closureSourceExtensions = [".cts", ".mts", ".ts", ".tsx", ".vue"];
const closureFixpointRounds = 32;
/** 说明符以拼段形式给出：不产生静态 import 依赖，非 browser 形态的 typecheck/lint 因此不需要该包类型或存在性。 */
const sfcParserModuleName = ["@vue", "compiler-sfc"].join("/");

let cachedSfcParser: SfcParser | undefined;

/** parser 只在闭包真的落在 .vue 时按需同步载入：无 Vue 形态不接触该依赖，browser 形态由根 manifest 的显式声明保证入口可达。 */
function sfcParserForObservation(): SfcParser {
  if (cachedSfcParser !== undefined) return cachedSfcParser;
  try {
    const requireFromChecker = createRequire(import.meta.url);
    const loaded = requireFromChecker(sfcParserModuleName) as {
      parse: (source: string, options: Record<string, never>) => SfcParseResult;
    };
    cachedSfcParser = {
      kind: "available",
      parse: (source: string) => loaded.parse(source, {}),
    };
  } catch (error) {
    cachedSfcParser = {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return cachedSfcParser;
}

/** `<script src>` 是与 import 同等地位的静态源码依赖：位置取真实 SFC 开标签内的 src 字面量，target 仍要进闭包继续遍历。 */
type SfcSrcEdge = {
  readonly column: number;
  readonly line: number;
  readonly specifier: string;
  readonly target: string;
};

type SfcProjection = {
  readonly buffer: string;
  readonly broken: readonly string[];
  readonly srcEdges: readonly SfcSrcEdge[];
};

const sfcProjectionCache = new Map<string, SfcProjection>();

function blankPreservingLines(source: string): string {
  // 一个非 BMP 字符占两个 UTF-16 码元：按码点替换会让投影比真实 SFC 短，后续列偏移随之变小。
  return source.replaceAll(/[^\r\n]/gu, (unit) => " ".repeat(unit.length));
}

/** 偏移转真实行列按 UTF-16 码元计数，与投影文件上官方 getLineAndCharacterOfPosition 同一口径。 */
function sourcePositionOfOffset(
  text: string,
  offset: number,
): { readonly column: number; readonly line: number } {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;

  return {
    column: offset - lineStart + 1,
    line: text.slice(0, offset).split("\n").length,
  };
}

const htmlBlankCharacters = " \t\n\r\f";

/** charAt 越界返回空串，空串不是空白。 */
function isHtmlBlank(char: string): boolean {
  return char !== "" && htmlBlankCharacters.includes(char);
}

function skipHtmlBlanks(text: string, cursor: number, limit: number): number {
  while (cursor < limit && isHtmlBlank(text.charAt(cursor))) cursor += 1;

  return cursor;
}

/**
 * 在官方 loc 划出的开标签区间内按属性 token 逐个前进：属性名、可选等号、值，
 * 引号字面量整体跨过，因此前一个属性值内的 `src = '…'` 文本不会被当作属性；
 * 等号两侧空白、跨行书写与无引号值都是合法 HTML。
 * 命中第一个名为 src 的属性即返回值起始偏移，即说明符引号位置（无引号时为首字符）；
 * 该属性字面值与官方 descriptor 的 src 不一致时返回 undefined，绝不锚猜测位置。
 */
function sfcSrcValueOffset(
  text: string,
  cursorStart: number,
  tagEnd: number,
  src: string,
): number | undefined {
  let cursor = skipHtmlBlanks(text, cursorStart, tagEnd);
  for (;;) {
    const lead = text.charAt(cursor);
    if (cursor >= tagEnd || lead === ">" || lead === "/") return undefined;
    let nameEnd = cursor;
    while (
      nameEnd < tagEnd &&
      !isHtmlBlank(text.charAt(nameEnd)) &&
      text.charAt(nameEnd) !== "=" &&
      text.charAt(nameEnd) !== ">"
    ) {
      nameEnd += 1;
    }
    const name = text.slice(cursor, nameEnd);
    const afterName = skipHtmlBlanks(text, nameEnd, tagEnd);
    if (text.charAt(afterName) !== "=") {
      if (name === "src") return undefined;
      cursor = afterName;
      continue;
    }
    const value = skipHtmlBlanks(text, afterName + 1, tagEnd);
    const quote = text.charAt(value);
    let readValue: string;
    let afterValue: number;
    if (quote === '"' || quote === "'") {
      const closing = text.indexOf(quote, value + 1);
      if (closing === -1 || closing >= tagEnd) return undefined;
      readValue = text.slice(value + 1, closing);
      afterValue = closing + 1;
    } else {
      let unquotedEnd = value;
      while (
        unquotedEnd < tagEnd &&
        !isHtmlBlank(text.charAt(unquotedEnd)) &&
        text.charAt(unquotedEnd) !== ">"
      ) {
        unquotedEnd += 1;
      }
      readValue = text.slice(value, unquotedEnd);
      afterValue = unquotedEnd;
    }
    if (name === "src") return readValue === src ? value : undefined;
    cursor = skipHtmlBlanks(text, afterValue, tagEnd);
  }
}

/** descriptor 只给块内容起点与 src 值；说明符的原始行列在同一个 <script> 开标签区间内一次定位，不引入第二个解析器。 */
function sfcSrcAttributePosition(
  text: string,
  block: SfcScriptBlock,
  src: string,
): { readonly column: number; readonly line: number } | undefined {
  const tagStart = text.lastIndexOf("<script", block.loc.start.offset);
  if (tagStart === -1) return undefined;
  const valueAt = sfcSrcValueOffset(
    text,
    tagStart + "<script".length,
    block.loc.start.offset,
    src,
  );

  return valueAt === undefined
    ? undefined
    : sourcePositionOfOffset(text, valueAt);
}

/** 投影与真实 SFC 保持逐 UTF-16 码元相同长度与换行位置：非脚本正文替换为等长空白，脚本正文按原偏移落位，行/列即真实 .vue 的位置。 */
function projectSfcFile(fileName: string): SfcProjection {
  const identity = toRealPath(fileName);
  const cached = sfcProjectionCache.get(identity);
  if (cached !== undefined) return cached;
  const shown = relativeToRepositoryRoot(identity);
  const broken: string[] = [];
  const srcEdges: SfcSrcEdge[] = [];
  let text: string | undefined;
  try {
    text = readFileSync(identity, "utf8");
  } catch {
    broken.push(`坏 SFC：${shown} 无法读取`);
  }
  let blocks: { block: SfcScriptBlock; isSetup: boolean }[] = [];
  if (text !== undefined) {
    const parser = sfcParserForObservation();
    if (parser.kind === "unavailable") {
      broken.push(`闭包无法完成：${shown}: ${parser.reason}`);
    } else {
      try {
        const parsed = parser.parse(text);
        for (const diagnostic of parsed.errors) {
          broken.push(`坏 SFC：${shown}: ${diagnostic.message}`);
        }
        blocks = [
          { block: parsed.descriptor.script, isSetup: false },
          { block: parsed.descriptor.scriptSetup, isSetup: true },
        ]
          .filter(
            (entry): entry is { block: SfcScriptBlock; isSetup: boolean } =>
              entry.block !== undefined && entry.block !== null,
          )
          // descriptor 的两个字段是类型顺序而非文档顺序；逆序书写时必须按物理偏移装配，否则正文会落到错误行。
          .sort(
            (left, right) =>
              left.block.loc.start.offset - right.block.loc.start.offset,
          );
      } catch (error) {
        broken.push(
          `坏 SFC：${shown}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const directory = path.dirname(identity);
  let buffer = "";
  let cursor = 0;
  for (const { block, isSetup } of blocks) {
    const src = block.src;
    if (src !== undefined && src !== null) {
      if (isSetup) {
        broken.push(`坏 SFC：${shown}: <script setup> 不支持 src`);
        continue;
      }
      const resolved = resolveSfcScriptSrc(src, directory);
      if (resolved === undefined) {
        broken.push(
          `闭包无法完成：${shown} 的 <script src="${src}"> 不是可静态解析的本机路径，不猜测别名`,
        );
        continue;
      }
      if (statSync(resolved, { throwIfNoEntry: false })?.isFile() !== true) {
        broken.push(`坏 SFC：${shown} 的 <script src="${src}"> 指向缺失文件`);
        continue;
      }
      const position = sfcSrcAttributePosition(text ?? "", block, src);
      if (position === undefined) {
        broken.push(
          `闭包无法完成：${shown} 的 <script src="${src}"> 无法在官方块位置划出的开标签区间内定位说明符`,
        );
        continue;
      }
      srcEdges.push({
        column: position.column,
        line: position.line,
        specifier: src,
        target: resolved,
      });
      continue;
    }
    const start = block.loc.start.offset;
    buffer +=
      blankPreservingLines((text ?? "").slice(cursor, start)) + block.content;
    cursor = start + block.content.length;
  }
  buffer += blankPreservingLines((text ?? "").slice(cursor));
  const projection = { buffer, broken, srcEdges };
  sfcProjectionCache.set(identity, projection);

  return projection;
}

/** script src 只按真实文件身份观察本机路径；裸说明符与别名属 bundler 配置，不在此猜测。 */
function resolveSfcScriptSrc(
  src: string,
  sfcDirectory: string,
): string | undefined {
  if (src.startsWith("./") || src.startsWith("../")) {
    return toRealPath(path.resolve(sfcDirectory, src));
  }
  if (path.isAbsolute(src)) return toRealPath(src);

  return undefined;
}

/** 只读闭包 host：沿用原生 createCompilerHost 的官方解析与读取，只把写出封成空操作。 */
function createClosureHost(options: ts.CompilerOptions): {
  readonly baseHost: ts.CompilerHost;
  readonly host: ts.CompilerHost;
  readonly resolutionCache: ts.ModuleResolutionCache;
} {
  const baseHost = ts.createCompilerHost(options, true);
  const resolutionCache = ts.createModuleResolutionCache(
    baseHost.getCurrentDirectory(),
    (fileName) => baseHost.getCanonicalFileName(fileName),
    options,
  );

  return {
    baseHost,
    host: { ...baseHost, writeFile: () => {} },
    resolutionCache,
  };
}

/** 闭合说明符只用官方解析器；`.vue` 按官方相对显式扩展名规则落到真实 SFC（`declare module "*.vue"` 只是类型替身，不是源码边）。 */
function resolveClosureModule(
  literal: ts.StringLiteralLike,
  containingFile: string,
  options: ts.CompilerOptions,
  resolutionMode: ts.ResolutionMode,
  resolutionCache: ts.ModuleResolutionCache,
  baseHost: ts.CompilerHost,
): ts.ResolvedModuleWithFailedLookupLocations {
  if (
    path.extname(literal.text) === ".vue" &&
    /^\.{1,2}\//u.test(literal.text)
  ) {
    const resolved = toRealPath(
      path.resolve(path.dirname(containingFile), literal.text),
    );
    if (statSync(resolved, { throwIfNoEntry: false })?.isFile() === true) {
      return {
        resolvedModule: {
          extension: ".vue",
          isExternalLibraryImport: false,
          resolvedFileName: resolved,
        },
      };
    }
  }

  return ts.resolveModuleName(
    literal.text,
    containingFile,
    options,
    baseHost,
    resolutionCache,
    undefined,
    resolutionMode,
  );
}

type ClosureEdge = {
  readonly column: number;
  readonly from: string;
  readonly line: number;
  readonly specifier: string;
  readonly target: string;
};

/** import、re-export、import= 与静态 dynamic import 的字面说明符都是闭包边；模板串与非静态说明符不属可静态确定的边。 */
function closureModuleSpecifier(
  node: ts.Node,
): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    return specifier !== undefined && ts.isStringLiteral(specifier)
      ? specifier
      : undefined;
  }
  if (ts.isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    if (
      !ts.isExternalModuleReference(reference) ||
      reference.expression === undefined
    ) {
      return undefined;
    }

    return ts.isStringLiteral(reference.expression)
      ? reference.expression
      : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]!)
  ) {
    return node.arguments[0];
  }

  return undefined;
}

function isObservedClosureSourceFile(fileName: string): boolean {
  const relative = path.relative(
    toRealPath(repositoryRoot),
    toRealPath(fileName),
  );

  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    !relative
      .split(path.sep)
      .some(
        (segment) =>
          derivedDirectories.has(segment) ||
          nonAuthoredDirectories.has(segment) ||
          runtimeDirectories.has(segment),
      )
  );
}

/**
 * 对单个执行项目建立官方只读闭包：
 * - TS 侧用原生 CompilerHost/Program，根就是官方配置展开的成员，产品 import 拉入的他包源码由 Program 自己遍历；
 * - SFC 侧用等长内存投影，入口取「原生配置实际纳入的 SFC」与显式跨 SFC 边，其正文里的闭合说明符按同一个官方解析器解析，
 *   落地的本机源码补进 Program 根，逐轮直到闭包不再增长。
 */
function closureFactsForProject(project: ProjectFacts): {
  readonly broken: readonly string[];
  readonly edges: readonly ClosureEdge[];
  readonly openEdges: readonly string[];
} {
  const options = project.commandLine?.options;
  const broken: string[] = [];
  const openEdges: string[] = [];
  const edges: ClosureEdge[] = [];
  if (options === undefined) return { broken, edges, openEdges };
  const { baseHost, host, resolutionCache } = createClosureHost(options);
  const tsRoots = new Set<string>(project.members);
  const sfcQueue = [...project.sfcEntries];
  const sfcSeen = new Set<string>();
  const observedTs = new Set<string>();
  /** 说明符落地的本机源码：TS 侧已由 Program 自己遍历，只有投影发现的源码需要显式进根；SFC 一律走队列，投影自身永不进根。 */
  const queueTarget = (target: string, queueTs: boolean): void => {
    if (path.extname(target) === ".vue") {
      // 与 Program 侧同一口径：非 authored 源码（含第三方包内的 SFC）不进闭包观察。
      if (!isObservedClosureSourceFile(target)) return;
      if (!sfcSeen.has(target) && !sfcQueue.includes(target))
        sfcQueue.push(target);

      return;
    }
    if (queueTs) tsRoots.add(target);
  };
  const recordEdges = (
    sourceFile: ts.SourceFile,
    modeFor: (specifier: ts.StringLiteralLike) => ts.ResolutionMode,
    queueTs: boolean,
  ): void => {
    const from = toRealPath(sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      const specifier = closureModuleSpecifier(node);
      if (specifier !== undefined) {
        const resolved = resolveClosureModule(
          specifier,
          sourceFile.fileName,
          options,
          modeFor(specifier),
          resolutionCache,
          baseHost,
        ).resolvedModule;
        const { character, line } = sourceFile.getLineAndCharacterOfPosition(
          specifier.getStart(sourceFile),
        );
        if (resolved?.resolvedFileName === undefined) {
          if (
            /^\.{1,2}\//u.test(specifier.text) &&
            closureSourceExtensions.includes(path.extname(specifier.text))
          ) {
            openEdges.push(
              `${relativeToRepositoryRoot(from)}:${line + 1}:${character + 1} 引用缺失的本机源码 ${specifier.text}`,
            );
          }
        } else {
          const target = toRealPath(resolved.resolvedFileName);
          edges.push({
            column: character + 1,
            from,
            line: line + 1,
            specifier: specifier.text,
            target,
          });
          queueTarget(target, queueTs);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  };
  let program = ts.createProgram([...tsRoots], options, host);
  let converged = false;
  for (let round = 0; round < closureFixpointRounds; round += 1) {
    const rootsBefore = tsRoots.size;
    for (const sourceFile of program.getSourceFiles()) {
      if (!isObservedClosureSourceFile(sourceFile.fileName)) continue;
      const identity = toRealPath(sourceFile.fileName);
      if (observedTs.has(identity)) continue;
      observedTs.add(identity);
      const walked = program;
      recordEdges(
        sourceFile,
        (specifier) => walked.getModeForUsageLocation(sourceFile, specifier),
        /* queueTs */ false,
      );
    }
    for (;;) {
      const sfc = sfcQueue.shift();
      if (sfc === undefined) break;
      if (sfcSeen.has(sfc)) continue;
      sfcSeen.add(sfc);
      const projection = projectSfcFile(sfc);
      for (const reason of projection.broken) broken.push(reason);
      for (const srcEdge of projection.srcEdges) {
        edges.push({
          column: srcEdge.column,
          from: sfc,
          line: srcEdge.line,
          specifier: srcEdge.specifier,
          target: srcEdge.target,
        });
        queueTarget(srcEdge.target, true);
      }
      const projectionFile = ts.createSourceFile(
        sfc,
        projection.buffer,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      recordEdges(
        projectionFile,
        (specifier) =>
          ts.getModeForUsageLocation(projectionFile, specifier, options),
        /* queueTs */ true,
      );
    }
    if (tsRoots.size === rootsBefore) {
      converged = true;
      break;
    }
    program = ts.createProgram([...tsRoots], options, host, program);
  }
  if (!converged) {
    broken.push(
      `闭包无法完成：${relativeToRepositoryRoot(project.configPath)} 的源码闭包在 ${String(closureFixpointRounds)} 轮内未收敛，不静默按未发现违规处理`,
    );
  }

  return { broken, edges, openEdges };
}

type OwnershipTaskFace = {
  readonly boundary: PackageBoundary;
  readonly buildTask: BoundaryTaskFace;
  readonly scripts: Record<string, string>;
  readonly typecheckTask: BoundaryTaskFace;
};

/** 闭包观察的项目集就是 15A 的真实任务→配置集：协议执行项目（含 --build references 闭包）与无脚本 consumer 的静态配置候选，按配置真实身份去重。 */
function closureProjectEntries(
  layout: WorkspaceLayout,
  faces: readonly OwnershipTaskFace[],
): {
  readonly boundary: PackageBoundary;
  readonly project: ProjectFacts;
  readonly tasks: string[];
}[] {
  const entries = new Map<
    string,
    { boundary: PackageBoundary; project: ProjectFacts; tasks: string[] }
  >();
  const register = (
    key: string,
    boundary: PackageBoundary,
    project: ProjectFacts,
    task: string,
  ) => {
    // 空 rootFiles 的容器（files: [] solution）没有可观察的产品闭包，成员与 references 事实由 15A 面收取；只纳入 SFC 的项目仍要观察。
    if (project.members.size === 0 && project.sfcEntries.length === 0) return;
    const existing = entries.get(key);
    if (existing !== undefined) {
      if (!existing.tasks.includes(task)) existing.tasks.push(task);

      return;
    }
    entries.set(key, { boundary, project, tasks: [task] });
  };
  for (const face of faces) {
    for (const [taskName, taskFace] of [
      ["typecheck", face.typecheckTask],
      ["build", face.buildTask],
    ] as const) {
      for (const executed of taskFace.executed) {
        register(
          toRealPath(executed.project.configPath),
          owningBoundary(layout, executed.project.configPath),
          executed.project,
          taskName,
        );
      }
    }
    if (
      automationScriptFiles(layout, face.boundary).length === 0 &&
      (face.typecheckTask.kind !== "protocol" ||
        face.buildTask.kind !== "protocol")
    ) {
      for (const candidateConfig of staticFaceConfigCandidates(
        face.boundary,
        face.scripts,
      )) {
        const project = readProjectFacts(candidateConfig, undefined);
        if (project.members.size === 0 && project.sfcEntries.length === 0)
          continue;
        register(
          toRealPath(project.configPath),
          face.boundary,
          project,
          "typecheck",
        );
      }
    }
  }

  return [...entries.values()];
}

function automationScriptClosureDiagnostics(
  layout: WorkspaceLayout,
  faces: readonly OwnershipTaskFace[],
  ownerConfigsByBoundary: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const packages = layout.packages;
  const scriptOwners = new Map<string, PackageBoundary>();
  const scriptIdentitiesByBoundary = new Map<string, ReadonlySet<string>>();
  for (const boundary of packages) {
    const identities = new Set(
      automationScriptFiles(layout, boundary).map(toRealPath),
    );
    scriptIdentitiesByBoundary.set(boundary.directory, identities);
    for (const identity of identities) scriptOwners.set(identity, boundary);
  }
  if (scriptOwners.size === 0) return [];

  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const add = (diagnostic: string): void => {
    if (!seen.has(diagnostic)) {
      seen.add(diagnostic);
      diagnostics.push(diagnostic);
    }
  };

  for (const entry of closureProjectEntries(layout, faces)) {
    const shownProject = relativeToRepositoryRoot(entry.project.configPath);
    const shownTasks = entry.tasks.join("、");
    const closure = closureFactsForProject(entry.project);
    for (const reason of closure.broken) {
      add(
        [
          `${shownProject}（任务 ${shownTasks}）开发自动化归属[无法验证]：模块闭包无法完成（${reason}）；检查器不猜测不可静态判定的源码边，也不以「未发现违规」代替判定。`,
          renderOwnershipRepair(
            "修复坏 SFC 或让 SFC 的 script src 指向可静态解析的本机源码；闭包观察只消费 @vue/compiler-sfc.parse 与官方配置事实。",
          ),
        ].join("\n"),
      );
    }
    for (const reason of closure.openEdges) {
      add(
        [
          `${shownProject}（任务 ${shownTasks}）开发自动化归属[无法验证]：模块闭包无法完成（${reason}）；检查器不猜测未解析的本机源码边，也不以「未发现违规」代替判定。`,
          renderOwnershipRepair(
            "补齐或改正该相对源码引用，使闭包能按官方解析器取得真实文件身份。",
          ),
        ].join("\n"),
      );
    }
    for (const edge of closure.edges) {
      const victim = scriptOwners.get(edge.target);
      if (victim === undefined) continue;
      // 成员事实已由 15A 的执行面收取，闭包只补 import 拉入这条新事实。
      if (entry.project.members.has(edge.target)) continue;
      const ownerConfigs = ownerConfigsByBoundary.get(victim.directory);
      const isVictimOwner =
        ownerConfigs !== undefined &&
        ownerConfigs.has(toRealPath(entry.project.configPath));
      // owner 项目对自有脚本的成员与归属机制不是新违规：脚本互相引用或 owner 直接收录的脚本被拉入都属既有事实。
      if (
        isVictimOwner &&
        (scriptIdentitiesByBoundary.get(victim.directory)?.has(edge.from) ===
          true ||
          entry.project.members.has(edge.from))
      ) {
        continue;
      }
      const shownScript = relativeToRepositoryRoot(edge.target);
      const shownEdge = `${relativeToRepositoryRoot(edge.from)}:${edge.line}:${edge.column} → ${edge.specifier}`;
      if (entry.boundary.directory !== victim.directory) {
        const rootAbsorbing = entry.boundary.isRepositoryRoot;
        add(
          [
            `${shownScript} 开发自动化归属[根/兄弟吸收]：脚本归属 ${describe(victim)}，却被${rootAbsorbing ? "根" : ` ${describe(entry.boundary)}`} 的执行项目 ${shownProject}（任务 ${shownTasks}）的模块闭包经 import 边 ${shownEdge} 拉入。`,
            renderOwnershipRepair(
              victim.isRepositoryRoot
                ? "根维护脚本只由根 non-emitting leaf 拥有；从该包产品的 import/re-export/dynamic import 中移除对根脚本的引用。"
                : `把 ${victim.name} 的脚本从 ${entry.boundary.name} 产品闭包的引用中移除，脚本只由所属 boundary 的唯一非产出 owner 项目执行。`,
            ),
          ].join("\n"),
        );
        continue;
      }
      add(
        [
          `${shownScript} 开发自动化归属[构建泄漏]：脚本归属 ${describe(victim)}，非 owner 执行项目 ${shownProject}（任务 ${shownTasks}）的产品闭包经 import 边 ${shownEdge} 拉入该脚本；配置 exclude 不替代产品不引用脚本。`,
          renderOwnershipRepair(
            "把被产品复用的逻辑迁出 scripts/ 成为公开源码，或让产品不再引用维护脚本；脚本成员资格只保留在本包 typecheck 真实执行的非产出 owner 项目。",
          ),
        ].join("\n"),
      );
    }
  }

  return diagnostics;
}

function automationOwnershipDiagnostics(layout: WorkspaceLayout): string[] {
  const packages = layout.packages;
  const faces: OwnershipTaskFace[] = packages.map((boundary) => {
    const scripts = boundaryManifestScripts(boundary);
    return {
      boundary,
      buildTask: taskFaceFor(boundary, scripts.build),
      scripts,
      typecheckTask: taskFaceFor(boundary, scripts.typecheck),
    };
  });

  // 单次执行面收集：所有 boundary（含无本地脚本的已知 TS consumer）按协议执行的项目成员事实进入只读图；
  // 项目归属按其配置所在目录的 owning boundary 归类，消费者经 references 执行他包自身项目不构成吸收。
  const captures = new Map<string, ScriptCapture[]>();
  for (const face of faces) {
    for (const [taskName, taskFace] of [
      ["typecheck", face.typecheckTask],
      ["build", face.buildTask],
    ] as const) {
      for (const executed of taskFace.executed) {
        const projectOwner = owningBoundary(
          layout,
          executed.project.configPath,
        );
        for (const member of executed.project.members) {
          const bucket = captures.get(member) ?? [];
          if (
            !bucket.some(
              (capture) =>
                capture.configPath === executed.project.configPath &&
                capture.face === taskName,
            )
          ) {
            bucket.push({
              configPath: executed.project.configPath,
              face: taskName,
              owner: projectOwner,
              mode: executed.mode,
              project: executed.project,
            });
          }
          captures.set(member, bucket);
        }
      }
    }
    // 无本地脚本的 consumer 若任务不可归约：仍能按 config 文件静态核对成员的事实（他包脚本吸收）继续报告，
    // 但不为它发明任务要求、不扩大 unknown 阻断面。配置来源包含默认名与任务命令中字面写出的 config 操作数，
    // 以免非默认配置名把已接受的跨 boundary 吸收事实漏成静默通过。
    // 触发按「仍有不可归约面」判定：某一面已归约为协议不遮蔽另一面仍可静态确定的成员事实。
    if (
      automationScriptFiles(layout, face.boundary).length === 0 &&
      (face.typecheckTask.kind !== "protocol" ||
        face.buildTask.kind !== "protocol")
    ) {
      for (const candidateConfig of staticFaceConfigCandidates(
        face.boundary,
        face.scripts,
      )) {
        const project = readProjectFacts(candidateConfig, undefined);
        // 官方 API 在配置带错误（如未知选项）时仍返回已确定的实际成员，这里只消费这些成员事实。
        // 配置缺失或不可解析时成员集为空即无事实可报：不为坏配置推断未知成员，也不给它新增 unknown 阻断。
        for (const member of project.members) {
          const bucket = captures.get(member) ?? [];
          // 同一实际配置经协议面与静态面各到达一次时是同一个成员事实，按配置真实身份去重，不制造重复收录。
          if (
            !bucket.some((capture) => capture.configPath === project.configPath)
          ) {
            bucket.push({
              configPath: project.configPath,
              face: "typecheck",
              owner: face.boundary,
              mode: "p",
              project,
            });
          }
          captures.set(member, bucket);
        }
      }
    }
  }

  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const ownerConfigsByBoundary = new Map<string, ReadonlySet<string>>();
  const add = (diagnostic: string): void => {
    if (!seen.has(diagnostic)) {
      seen.add(diagnostic);
      diagnostics.push(diagnostic);
    }
  };

  for (const face of faces) {
    const { boundary, buildTask, scripts, typecheckTask } = face;
    const scriptFiles = automationScriptFiles(layout, boundary);
    if (scriptFiles.length === 0) continue;
    const manifestShown = relativeToRepositoryRoot(
      path.join(boundary.directory, "package.json"),
    );

    // N3：有脚本必须声明标准任务；纯无脚本 boundary 一个都不要求。
    for (const task of standardAutomationTaskNames) {
      if (scripts[task] === undefined) {
        add(
          [
            `${manifestShown} 开发自动化归属[任务缺失]：${describe(boundary)} 含 scripts/**/*.ts 维护脚本但未声明标准任务 "${task}"。`,
            renderOwnershipRepair(
              `在 ${boundary.name} 的 package.json 声明 "${task}"，使脚本进入 format、lint、typecheck 的真实执行覆盖（ADR-0105）。`,
            ),
          ].join("\n"),
        );
      }
    }

    for (const [taskName, taskFace] of [
      ["typecheck", typecheckTask],
      ["build", buildTask],
    ] as const) {
      if (taskFace.kind === "unverifiable") {
        for (const reason of taskFace.unverifiable) {
          add(
            [
              `${manifestShown} 开发自动化归属[无法验证]：${describe(boundary)} 的任务 "${taskName}" 无法归约为闭合执行协议（${reason}）。检查器不做配置猜测，无法判定该包的自动化归属，也不以「未发现违规」代替判定。`,
              renderOwnershipRepair(
                "typecheck/build 必须归约为已知形态：tsc -p <config> [--noEmit]、tsc --build、Vue adapter 的 --build --noEmit、闭合 builder（vite/vike build）或 native（cargo）；修复坏/缺失配置与 references 环。",
              ),
            ].join("\n"),
          );
        }
      }
    }
    if (typecheckTask.kind === "unverifiable") continue;

    const scriptIdentities = scriptFiles.map(toRealPath);
    const protocolMode =
      typecheckTask.kind === "protocol" && typecheckTask.executed.length > 0
        ? typecheckTask.executed[0]!.mode
        : undefined;

    // 协议 owner 资格依 3.3 闭合形态：p 形态的 owner 候选是 typecheck 真实执行的无 references 目标；
    // build 形态（browser）的具名协议 leaf 是 tsconfig.node.json。references 容器与混合容器不充当 leaf。
    const ownerFacts = protocolOwnerFacts(
      boundary,
      typecheckTask,
      scriptIdentities,
    );
    if (ownerFacts.missingNamedLeaf) {
      add(
        [
          `${manifestShown} 开发自动化归属[无法验证]：${describe(boundary)} 的 --build 执行闭包缺少具名协议 tooling leaf ${browserProtocolToolingLeafName}（缺失、重命名或非 leaf），协议形态不可归约，不以静默通过代替。`,
          renderOwnershipRepair(
            `恢复 browser 形态的具名 tooling leaf ${browserProtocolToolingLeafName} 并保持在 solution references 内（重命名属消费者自由，但检查器不再认识该形态）。`,
          ),
        ].join("\n"),
      );
      continue;
    }
    const { containerConfigs, eligibleOwners } = ownerFacts;
    for (const project of ownerFacts.unexecutedContainers) {
      add(
        [
          `${relativeToRepositoryRoot(project.configPath)} 开发自动化归属[假装覆盖]：${describe(boundary)} 的 typecheck 以 tsc -p 指向 references 容器且容器自身不含脚本；-p 不遍历 references，owner leaf 未被真实执行，执行覆盖判定为缺失。`,
          renderOwnershipRepair(
            "改用 --build（或 Vue adapter 的 --build --noEmit 协议）遍历 references，或把 -p 指向真实执行的非产出 leaf 项目。",
          ),
        ].join("\n"),
      );
    }

    const ownerConfigs = new Set(
      eligibleOwners.map((project) => toRealPath(project.configPath)),
    );
    ownerConfigsByBoundary.set(boundary.directory, ownerConfigs);
    for (const project of eligibleOwners) {
      if (project.nonEmitting) continue;
      if (!scriptIdentities.some((identity) => project.members.has(identity))) {
        continue;
      }
      add(
        [
          `${relativeToRepositoryRoot(project.configPath)} 开发自动化归属[产出型 owner]：${describe(boundary)} 的 owner 项目有效 options 非 non-emitting（effective noEmit 不为 true；declaration/emitDeclarationOnly 仅产出声明也是产出）。直接 tsc -p 会把维护脚本编进制品。`,
          renderOwnershipRepair(
            "owner 必须 non-emitting：在配置 JSON 设 compilerOptions.noEmit: true，或给 typecheck 命令携带官方 --noEmit 覆盖（CLI --noEmit 的正常覆盖合法）。",
          ),
        ].join("\n"),
      );
    }

    for (const filePath of scriptFiles) {
      const identity = toRealPath(filePath);
      const relativeFile = relativeToRepositoryRoot(filePath);
      const entries = captures.get(identity) ?? [];
      const ownTypecheck = entries.filter(
        (capture) =>
          capture.face === "typecheck" &&
          capture.owner.directory === boundary.directory,
      );
      const ownerHits = ownTypecheck.filter((capture) =>
        ownerConfigs.has(toRealPath(capture.configPath)),
      );
      const nonOwnerTypecheck = ownTypecheck.filter(
        (capture) => !ownerConfigs.has(toRealPath(capture.configPath)),
      );
      const foreignHits = entries.filter(
        (capture) => capture.owner.directory !== boundary.directory,
      );
      const buildHits = entries.filter((capture) => capture.face === "build");
      const containerHits = containerConfigs.filter(
        (container) =>
          container.capturesScripts && container.project.members.has(identity),
      );

      for (const container of containerHits) {
        add(
          [
            `${relativeFile} 开发自动化归属[容器越界]：混合容器 ${relativeToRepositoryRoot(container.project.configPath)} 既带 references 又把维护脚本收进自身成员；solution 容器与 leaf 必须分离，容器不得充当 owner leaf。`,
            renderOwnershipRepair(
              "把该脚本的成员资格留在 typecheck 真实执行的无 references 非产出 leaf；容器只保留 files: [] 与 references。",
            ),
          ].join("\n"),
        );
      }

      if (ownerHits.length === 0 && typecheckTask.kind === "protocol") {
        const misplaced = nonOwnerTypecheck
          .map((capture) => relativeToRepositoryRoot(capture.configPath))
          .toSorted();
        add(
          [
            `${relativeFile} 开发自动化归属[缺归属]：${describe(boundary)} 的维护脚本不属于任何被 typecheck 真实执行的协议 owner 非产出 leaf${misplaced.length > 0 ? `；当前仅被非 owner 执行项目收录：${misplaced.join("、")}（app/test 等 leaf 不得冒充 owner）` : ""}。`,
            renderOwnershipRepair(
              protocolMode === "build"
                ? `把脚本纳入本包协议 tooling leaf ${browserProtocolToolingLeafName} 的 include，并保持 typecheck 依 --build --noEmit 协议执行它。`
                : "在本包配置唯一 non-emitting 项目（scripts/** 的 owner，作为 typecheck 的 -p 真实执行目标）并挂上标准 typecheck、lint、format:check 任务；Rust 等消费者后加 Node 自动化须手动补本地项目与标准任务。",
            ),
          ].join("\n"),
        );
      } else if (ownerHits.length === 0 && typecheckTask.kind !== "protocol") {
        add(
          [
            `${relativeFile} 开发自动化归属[缺归属]：${describe(boundary)} 的维护脚本没有任何被 typecheck 真实执行的 non-emitting 项目成员资格。`,
            renderOwnershipRepair(
              `为 ${boundary.name} 配置本地 non-emitting TS 项目（含 scripts/**，作为 typecheck 的真实 -p 目标）并声明标准 typecheck、lint、format:check 任务；Root Check 拒绝漏配（ADR-0105 第 7 段）。`,
            ),
          ].join("\n"),
        );
      }

      if (
        ownerHits.length + nonOwnerTypecheck.length > 1 ||
        (nonOwnerTypecheck.length > 0 && ownerHits.length > 0)
      ) {
        const configs = ownTypecheck
          .map((capture) => relativeToRepositoryRoot(capture.configPath))
          .toSorted();
        const ownerShown =
          ownerHits.length > 0
            ? relativeToRepositoryRoot(ownerHits[0]!.configPath)
            : "协议 owner 项目";
        add(
          [
            `${relativeFile} 开发自动化归属[重复收录]：脚本同时是被执行项目 ${configs.join("、")} 的成员；归属必须唯一。`,
            renderOwnershipRepair(
              `只保留协议 owner ${ownerShown} 的成员资格，从其余 config 的 include/files 移除该脚本。`,
            ),
          ].join("\n"),
        );
      }

      for (const hit of buildHits) {
        add(
          [
            `${relativeFile} 开发自动化归属[构建泄漏]：维护脚本是 build 执行面项目 ${relativeToRepositoryRoot(hit.configPath)} 的成员；产品 build 不得包含维护脚本（ADR-0105）。`,
            renderOwnershipRepair(
              `从 ${relativeToRepositoryRoot(hit.configPath)} 的 include/files 移除该脚本，成员资格只保留在本包 typecheck 真实执行的非产出 owner 项目。`,
            ),
          ].join("\n"),
        );
      }

      for (const hit of foreignHits) {
        const rootAbsorbing = hit.owner.isRepositoryRoot;
        add(
          [
            `${relativeFile} 开发自动化归属[根/兄弟吸收]：脚本归属 ${describe(boundary)}，却被${rootAbsorbing ? "根" : ` ${describe(hit.owner)}`} 的执行项目 ${relativeToRepositoryRoot(hit.configPath)}（任务 ${hit.face}）收为成员。`,
            renderOwnershipRepair(
              boundary.isRepositoryRoot
                ? "根维护脚本恰属根 non-emitting leaf；把它从该包项目的 include/files 移除。"
                : `从 ${hit.owner.name} 的项目 include/files 移除该跨 boundary 模式，脚本只由所属 boundary 的唯一非产出 owner 项目执行。`,
            ),
          ].join("\n"),
        );
      }
    }
  }

  return [
    ...diagnostics,
    ...automationScriptClosureDiagnostics(
      layout,
      faces,
      ownerConfigsByBoundary,
    ),
  ];
}

const layout = discoverWorkspaceLayoutOrExit();
const fileResults = layout.packages
  .filter((boundary) => !boundary.isRepositoryRoot)
  .flatMap((boundary) =>
    authoredSourceFiles(layout, boundary).flatMap((filePath) =>
      diagnosticsInFile(boundary, layout, filePath),
    ),
  );
const boundaryDiagnostics = fileResults.flatMap(
  (result) => result.boundaryDiagnostics,
);
const publicContractDiagnostics = fileResults.flatMap(
  (result) => result.publicContractDiagnostics,
);
const unverifiableDiagnostics = fileResults.flatMap(
  (result) => result.unverifiableDiagnostics,
);
const outsideRepositoryDiagnostics = fileResults.flatMap(
  (result) => result.outsideRepositoryDiagnostics,
);
const unresolvablePathDiagnostics = fileResults.flatMap(
  (result) => result.unresolvablePathDiagnostics,
);
const maintenanceDiagnosticsFound = layout.packages.flatMap((boundary) =>
  maintenanceDiagnostics(layout, boundary),
);
const commandDiagnosticsFound = commandDiagnostics(layout);
const automationOwnershipFound = automationOwnershipDiagnostics(layout);

if (
  boundaryDiagnostics.length > 0 ||
  outsideRepositoryDiagnostics.length > 0 ||
  publicContractDiagnostics.length > 0 ||
  unresolvablePathDiagnostics.length > 0 ||
  unverifiableDiagnostics.length > 0 ||
  maintenanceDiagnosticsFound.length > 0 ||
  commandDiagnosticsFound.length > 0 ||
  automationOwnershipFound.length > 0
) {
  const rendered = [
    ...boundaryDiagnostics.toSorted(compareByPosition).map(renderDiagnostic),
    ...outsideRepositoryDiagnostics
      .toSorted(compareByPosition)
      .map(renderOutsideRepositoryDiagnostic),
    ...unresolvablePathDiagnostics
      .toSorted(compareByPosition)
      .map(renderUnresolvableDiagnostic),
    ...publicContractDiagnostics
      .toSorted(compareByPosition)
      .map(renderPublicContractDiagnostic),
    ...unverifiableDiagnostics
      .toSorted(compareByPosition)
      .map(renderUnverifiableDiagnostic),
    ...maintenanceDiagnosticsFound
      .toSorted((left, right) => left.file.localeCompare(right.file))
      .map(renderMaintenanceDiagnostic),
    ...commandDiagnosticsFound,
    ...automationOwnershipFound,
  ];
  process.stderr.write(`${rendered.join("\n")}\n`);
  process.exitCode = 1;
}
