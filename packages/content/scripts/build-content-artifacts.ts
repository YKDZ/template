import { createHash } from "node:crypto";
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  contentIdentityLabel,
  contentIdentityKey,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { PreparedNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import { execa } from "execa";

type NativeMember =
  | LoadedContentMember<unknown, "reference">
  | LoadedContentMember<unknown, "preset">;

type PresetMember = Extract<NativeMember, { readonly kind: "preset" }>;
type ReferenceMember = Extract<NativeMember, { readonly kind: "reference" }>;

type WorkspaceProject = {
  readonly name: string;
  readonly version?: string;
  readonly path: string;
};

export type PackedArtifact = {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly sha256: string;
  /** 内容所属制品的来源身份；SDK制品没有内容来源身份。 */
  readonly provider?: {
    readonly identity: ContentIdentity;
    readonly specifier: string;
  };
};

export type PreparedContentCollection = {
  readonly root: string;
  readonly roots: readonly NativeMember[];
  readonly presets: readonly PresetMember[];
  readonly members: readonly NativeMember[];
  readonly owners: readonly {
    readonly member: NativeMember;
    readonly artifact: PreparedNativeContentArtifact;
    readonly packageRoot: string;
    readonly installRoot: string;
    readonly packed: PackedArtifact;
  }[];
  /** 按来源命名空间隔离解析上下文的原生内容入口包。 */
  readonly providers: readonly PackedArtifact[];
  readonly sdkPackages: readonly PackedArtifact[];
  readonly collection: PackedArtifact;
  readonly archives: ReadonlyMap<string, PackedArtifact>;
  /** 由当前pnpm工作区清单实际解析出的版本。 */
  readonly resolvedVersions: ReadonlyMap<string, string>;
  readonly commands: readonly string[];
  cleanup(): Promise<void>;
};

export type PrepareContentCollectionOptions = {
  readonly content: readonly NativeMember[];
  /** 从同一已加载集合中选择任意预设或参考入口作为闭包根。 */
  readonly roots: readonly NativeMember[];
  /** raw参考声明的拥有者公开准备入口；已准备内容无需提供。 */
  readonly referencePreparation?: {
    readonly specifier: string;
    readonly exportName: string;
  };
  readonly workspaceRoot?: string;
  readonly packageName?: string;
  /** 外部作者工作区集合的原生清单版本。 */
  readonly collectionVersion?: string;
  readonly root?: string;
  /** 供独立作者工作区使用的原生SDK归档；不含本轮内容成员。 */
  readonly sdkArchives?: readonly PackedArtifact[];
};

type PreparedOwnerDefinition = {
  prepareArtifact?: () => PreparedNativeContentArtifact;
};

function manifestURL(member: NativeMember): URL {
  return new URL(member.source.manifestURL);
}

function packageRoot(member: NativeMember): string {
  return path.dirname(fileURLToPath(manifestURL(member)));
}

function ownerDefinition(member: NativeMember): PreparedOwnerDefinition {
  return member.definition as PreparedOwnerDefinition;
}

/** 分发保留所属制品的完整静态用途，实例条件只约束生成目标。 */
function distributionDependencies(
  member: ReferenceMember,
  contentByIdentity: ReadonlyMap<string, ReferenceMember>,
): readonly ContentIdentity[] {
  const dependencies = new Map<string, ContentIdentity>();
  const artifact = ownerDefinition(member).prepareArtifact?.();
  for (const dependency of artifact?.dependencies ?? []) {
    const candidates = [...contentByIdentity.values()].filter(
      (candidate) => candidate.identity.packageName === dependency.name,
    );
    const sameNamespace = candidates.filter(
      (candidate) => candidate.identity.namespace === member.identity.namespace,
    );
    const matching = sameNamespace.length > 0 ? sameNamespace : candidates;
    if (matching.length > 1)
      throw new Error(
        `所属制品 ${contentIdentityLabel(member.identity)} 的静态依赖 ${dependency.name} 对应多个内容入口，无法按来源消歧`,
      );
    const provider = matching[0];
    if (provider !== undefined)
      dependencies.set(
        contentIdentityKey(provider.identity),
        provider.identity,
      );
  }
  return [...dependencies.values()];
}

function selectedMembers(
  content: readonly NativeMember[],
  roots: readonly NativeMember[],
): {
  readonly roots: readonly NativeMember[];
  readonly presets: readonly PresetMember[];
  readonly members: readonly NativeMember[];
} {
  if (roots.length === 0) {
    throw new Error("原生内容集合至少需要一个公开入口根");
  }
  const contentByIdentity = new Map<string, NativeMember>();
  for (const member of content) {
    const key = contentIdentityKey(member.identity);
    if (contentByIdentity.has(key)) {
      throw new Error(
        `原生内容集合存在重复身份：${contentIdentityLabel(member.identity)}`,
      );
    }
    contentByIdentity.set(key, member);
  }

  const selectedRoots = new Map<string, NativeMember>();
  for (const root of roots) {
    const key = contentIdentityKey(root.identity);
    const available = contentByIdentity.get(key);
    if (
      available === undefined ||
      available.kind !== root.kind ||
      available.source.moduleURL !== root.source.moduleURL ||
      available.source.manifestURL !== root.source.manifestURL
    ) {
      throw new Error(
        `内容入口根未由当前原生集合按同一来源修订登记：${contentIdentityLabel(root.identity)}`,
      );
    }
    selectedRoots.set(key, available);
  }

  const references = content.filter(
    (member): member is ReferenceMember => member.kind === "reference",
  );
  const referencesByIdentity = new Map(
    references.map((member) => [contentIdentityKey(member.identity), member]),
  );
  const referencesByDefinition = new Map<
    ReferenceMember["definition"],
    ReferenceMember[]
  >();
  for (const reference of references) {
    const sameDefinition =
      referencesByDefinition.get(reference.definition) ?? [];
    sameDefinition.push(reference);
    referencesByDefinition.set(reference.definition, sameDefinition);
  }
  const selected = new Map<string, NativeMember>();
  const visited = new Set<string>();
  const visit = (member: ReferenceMember): void => {
    const key = contentIdentityKey(member.identity);
    selected.set(key, member);
    if (visited.has(key)) return;
    visited.add(key);
    for (const dependency of distributionDependencies(
      member,
      referencesByIdentity,
    )) {
      const child = referencesByIdentity.get(contentIdentityKey(dependency));
      if (child === undefined) {
        throw new Error(
          `原生入口闭包缺少成员 ${dependency.packageName}#${dependency.exportPath}`,
        );
      }
      visit(child);
    }
  };

  const includePresetReferences = (selectedPreset: PresetMember): void => {
    const nodes = Object.values(
      (selectedPreset.definition as { readonly nodes: unknown })
        .nodes as Record<string, { readonly reference: unknown }>,
    );
    for (const node of nodes) {
      const candidates = referencesByDefinition.get(
        node.reference as ReferenceMember["definition"],
      );
      const sameNamespace = candidates?.filter(
        (candidate) =>
          candidate.identity.namespace === selectedPreset.identity.namespace,
      );
      const matching =
        sameNamespace !== undefined && sameNamespace.length > 0
          ? sameNamespace
          : candidates;
      if (matching === undefined || matching.length !== 1) {
        throw new Error(
          `预设 ${selectedPreset.alias} 的引用未由当前集合唯一登记：${selectedPreset.identity.packageName}`,
        );
      }
      visit(matching[0]!);
    }
  };
  for (const root of selectedRoots.values()) {
    selected.set(contentIdentityKey(root.identity), root);
    if (root.kind === "preset") {
      includePresetReferences(root);
    } else {
      visit(root);
    }
  }

  return {
    roots: [...selectedRoots.values()],
    presets: [...selectedRoots.values()].filter(
      (member): member is PresetMember => member.kind === "preset",
    ),
    members: content.filter((member) =>
      selected.has(contentIdentityKey(member.identity)),
    ),
  };
}

function orderedMembers(
  presets: readonly PresetMember[],
  members: readonly NativeMember[],
): readonly NativeMember[] {
  const references = members.filter(
    (member): member is ReferenceMember => member.kind === "reference",
  );
  const byIdentity = new Map(
    references.map((member) => [contentIdentityKey(member.identity), member]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: NativeMember[] = [];
  const visit = (member: ReferenceMember): void => {
    const key = contentIdentityKey(member.identity);
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`原生内容依赖形成循环：${member.identity.packageName}`);
    }
    visiting.add(key);
    for (const dependency of distributionDependencies(member, byIdentity)) {
      const child = byIdentity.get(contentIdentityKey(dependency));
      if (child === undefined) {
        throw new Error(
          `策略闭包在编译排序时缺少成员：${dependency.packageName}`,
        );
      }
      visit(child);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(member);
  };
  for (const reference of references) visit(reference);
  ordered.push(...presets);
  return ordered;
}

async function runPnpm(
  args: readonly string[],
  cwd: string,
  commandLog: string[],
): Promise<string> {
  const command = `pnpm ${args.join(" ")}`;
  commandLog.push(`${cwd}$ ${command}`);
  const { stdout, stderr } = await execa("pnpm", [...args], { cwd });
  if (stderr.length > 0) commandLog.push(stderr.trimEnd());
  if (stdout.length > 0) commandLog.push(stdout.trimEnd());
  return stdout;
}

async function workspaceProjects(
  workspaceRoot: string,
  commandLog: string[],
): Promise<ReadonlyMap<string, WorkspaceProject>> {
  const stdout = await runPnpm(
    ["list", "--recursive", "--depth=-1", "--json"],
    workspaceRoot,
    commandLog,
  );
  const projects = JSON.parse(stdout) as WorkspaceProject[];
  return new Map(
    projects.flatMap((project) =>
      typeof project.name === "string"
        ? [[project.name, project] as const]
        : [],
    ),
  );
}

type PnpmDependencyNode = {
  readonly name?: string;
  readonly from?: string;
  readonly version?: string;
  readonly path?: string;
  readonly dependencies?: Readonly<Record<string, PnpmDependencyNode>>;
  readonly devDependencies?: Readonly<Record<string, PnpmDependencyNode>>;
  readonly optionalDependencies?: Readonly<Record<string, PnpmDependencyNode>>;
  readonly peerDependencies?: Readonly<Record<string, PnpmDependencyNode>>;
};

type ResolvedPackages = {
  readonly versions: ReadonlyMap<string, string>;
  readonly paths: ReadonlyMap<string, string>;
  readonly nodes: ReadonlyMap<string, PnpmDependencyNode>;
};

type OwnerResolvedDependencies = ReadonlyMap<string, PnpmDependencyNode>;

function collectResolvedPackages(
  value: unknown,
  versions: Map<string, string>,
  paths: Map<string, string>,
  fallbackName?: string,
  nodes?: Map<string, PnpmDependencyNode>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectResolvedPackages(item, versions, paths, fallbackName, nodes);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as PnpmDependencyNode;
  const name = node.name ?? fallbackName ?? node.from;
  if (
    name !== undefined &&
    nodes !== undefined &&
    (nodes.get(name)?.dependencies === undefined ||
      node.dependencies !== undefined)
  )
    nodes.set(name, node);
  if (
    name !== undefined &&
    typeof node.version === "string" &&
    !node.version.startsWith("link:")
  ) {
    versions.set(name, node.version);
  }
  if (name !== undefined && typeof node.path === "string") {
    paths.set(name, node.path);
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const children = node[field];
    if (
      typeof children === "object" &&
      children !== null &&
      !Array.isArray(children)
    ) {
      for (const [childName, child] of Object.entries(children)) {
        collectResolvedPackages(child, versions, paths, childName, nodes);
      }
    } else {
      collectResolvedPackages(children, versions, paths, undefined, nodes);
    }
  }
}

async function resolvedVersions(
  projectsToResolve: readonly string[],
  workspaceRoot: string,
  commandLog: string[],
): Promise<ResolvedPackages> {
  const versions = new Map<string, string>();
  const paths = new Map<string, string>();
  const nodes = new Map<string, PnpmDependencyNode>();
  for (const name of projectsToResolve) {
    const stdout = await runPnpm(
      ["--filter", name, "list", "--depth", "Infinity", "--json"],
      workspaceRoot,
      commandLog,
    );
    collectResolvedPackages(
      JSON.parse(stdout),
      versions,
      paths,
      undefined,
      nodes,
    );
  }
  return { versions, paths, nodes };
}

async function resolvedOwnerDependencies(
  ownerRoot: string,
  commandLog: string[],
): Promise<OwnerResolvedDependencies> {
  const stdout = await runPnpm(
    ["list", "--depth", "0", "--json"],
    ownerRoot,
    commandLog,
  );
  const projects = JSON.parse(stdout) as unknown;
  const project = Array.isArray(projects) ? projects[0] : projects;
  if (typeof project !== "object" || project === null) {
    throw new Error(`原生包管理器未返回所属包的项目依赖：${ownerRoot}`);
  }
  const node = project as PnpmDependencyNode;
  const dependencies = new Map<string, PnpmDependencyNode>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, dependency] of Object.entries(node[field] ?? {})) {
      dependencies.set(name, dependency);
    }
  }
  return dependencies;
}

function ownerVersionForDependency(
  name: string,
  specifier: string,
  workspace: ReadonlyMap<string, WorkspaceProject>,
  resolved: OwnerResolvedDependencies,
): string {
  const dependency = resolved.get(name);
  const packageName = dependency?.from;
  const version = dependency?.version;
  if (version !== undefined && !version.startsWith("link:")) {
    return packageName === undefined || packageName === name
      ? version
      : `npm:${packageName}@${version}`;
  }
  if (version?.startsWith("link:")) {
    const project =
      workspace.get(name) ??
      (packageName === undefined ? undefined : workspace.get(packageName));
    if (project?.version !== undefined) {
      return packageName === undefined || packageName === name
        ? project.version
        : `npm:${packageName}@${project.version}`;
    }
  }
  if (!/^(?:workspace|catalog|link):/u.test(specifier)) return specifier;
  throw new Error(
    `原生包管理器未解析依赖坐标 ${name}@${specifier}；无法投影安装清单`,
  );
}

function artifactInstallDependencies(
  member: NativeMember,
  artifact: PreparedNativeContentArtifact,
  members: readonly NativeMember[],
  artifacts: ReadonlyMap<string, PreparedNativeContentArtifact>,
  workspace: ReadonlyMap<string, WorkspaceProject>,
  resolved: OwnerResolvedDependencies,
): Readonly<Record<string, string>> {
  const dependencies: Record<string, string> = {};
  for (const dependency of artifact.dependencies) {
    const contentCandidates = members.filter(
      (candidate) =>
        candidate.identity.packageName === dependency.name &&
        candidate.identity.namespace === member.identity.namespace,
    );
    const allContentCandidates = members.filter(
      (candidate) => candidate.identity.packageName === dependency.name,
    );
    const selectedContent =
      contentCandidates.length === 1
        ? contentCandidates[0]
        : contentCandidates.length > 1
          ? undefined
          : allContentCandidates.length === 1
            ? allContentCandidates[0]
            : undefined;
    if (contentCandidates.length > 1) {
      throw new Error(
        `所属制品 ${contentIdentityLabel(member.identity)} 的依赖 ${dependency.name} 在同一来源中对应多个内容入口`,
      );
    }
    if (
      allContentCandidates.length > 1 &&
      contentCandidates.length === 0 &&
      dependency.purposes.includes("template-execution")
    ) {
      throw new Error(
        `所属制品 ${contentIdentityLabel(member.identity)} 的执行依赖 ${dependency.name} 存在多个来源，无法按原生坐标选择`,
      );
    }
    const contentArtifact =
      selectedContent === undefined
        ? undefined
        : artifacts.get(contentIdentityKey(selectedContent.identity));
    if (contentArtifact !== undefined) {
      if (dependency.purposes.includes("template-execution")) {
        dependencies[dependency.name] = contentArtifact.coordinate.version;
      }
      continue;
    }
    if (selectedContent !== undefined) {
      throw new Error(
        `执行依赖 ${dependency.name} 缺少已准备内容制品：${contentIdentityLabel(selectedContent.identity)}`,
      );
    }
    if (!dependency.purposes.includes("template-execution")) continue;
    dependencies[dependency.name] = ownerVersionForDependency(
      dependency.name,
      dependency.specifier,
      workspace,
      resolved,
    );
  }
  return dependencies;
}

function safePath(value: string): string {
  const raw = value.replaceAll("\\", "/");
  if (
    raw.length === 0 ||
    raw.startsWith("/") ||
    raw.split("/").some((part) => part === "..")
  ) {
    throw new Error(`所属制品包含越界路径：${value}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".") {
    throw new Error(`所属制品路径不能指向包根目录：${value}`);
  }
  return normalized;
}

async function copyOwnerArtifact(
  artifact: PreparedNativeContentArtifact,
  installRoot: string,
  dependencies: Readonly<Record<string, string>>,
): Promise<void> {
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(path.join(installRoot, "native"), { recursive: true });
  await writeFile(
    path.join(installRoot, "native", "package.json"),
    `${JSON.stringify(artifact.manifest, null, 2)}\n`,
  );
  const allFiles = [...artifact.compiled, ...artifact.resources];
  for (const file of allFiles) {
    const relativePath = safePath(file.path);
    const destination = path.join(installRoot, "native", relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.data);
    await chmod(destination, file.mode);
  }
  const entry = {
    ...(artifact.entry.types === undefined
      ? {}
      : { types: `./native/${safePath(artifact.entry.types)}` }),
    default: `./native/${safePath(artifact.entry.default)}`,
  };
  const packageManifest = {
    name: artifact.coordinate.name,
    version: artifact.coordinate.version,
    type: "module",
    files: ["native"],
    exports: {
      "./reference": "./native/package.json",
      [artifact.exportPath]: entry,
    },
    dependencies,
  };
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );
}

function parsePackOutput(stdout: string): string {
  try {
    const output = JSON.parse(stdout) as unknown;
    if (typeof output === "string") return output;
    if (Array.isArray(output) && typeof output[0] === "string") {
      return output[0];
    }
    if (
      Array.isArray(output) &&
      typeof output[0] === "object" &&
      output[0] !== null &&
      "filename" in output[0] &&
      typeof output[0].filename === "string"
    ) {
      return output[0].filename;
    }
    if (
      typeof output === "object" &&
      output !== null &&
      "filename" in output &&
      typeof output.filename === "string"
    ) {
      return output.filename;
    }
  } catch {
    // 未输出 JSON 的 pnpm 版本会以纯文本输出归档路径。
  }
  const lines = stdout.trim().split("\n");
  return lines.at(-1) ?? "";
}

async function packNativeProject(
  project: WorkspaceProject,
  destination: string,
  workspaceRoot: string,
  commandLog: string[],
): Promise<PackedArtifact> {
  if (project.version === undefined) {
    throw new Error(`pnpm未返回原生SDK坐标：${project.name}`);
  }
  await mkdir(destination, { recursive: true });
  const stdout = await runPnpm(
    [
      "--filter",
      project.name,
      "pack",
      "--json",
      "--pack-destination",
      destination,
    ],
    workspaceRoot,
    commandLog,
  );
  const tarball = parsePackOutput(stdout);
  if (tarball.length === 0) {
    throw new Error(`SDK包 ${project.name} 的原生 pnpm pack 未返回制品路径`);
  }
  return packedArtifact(
    project.name,
    project.version,
    path.isAbsolute(tarball) ? tarball : path.resolve(workspaceRoot, tarball),
  );
}

async function packedArtifact(
  name: string,
  version: string,
  tarball: string,
  provider?: PackedArtifact["provider"],
): Promise<PackedArtifact> {
  return {
    name,
    version,
    tarball,
    sha256: createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex"),
    ...(provider === undefined ? {} : { provider }),
  };
}

async function packPreparedRoot(
  root: string,
  destination: string,
  commandLog: string[],
): Promise<PackedArtifact> {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { readonly name: string; readonly version: string };
  await mkdir(destination, { recursive: true });
  const stdout = await runPnpm(
    ["--dir", root, "pack", "--json", "--pack-destination", destination],
    root,
    commandLog,
  );
  const tarball = parsePackOutput(stdout);
  if (tarball.length === 0) {
    throw new Error(`原生 pnpm pack 未返回制品路径：${manifest.name}`);
  }
  return packedArtifact(
    manifest.name,
    manifest.version,
    path.isAbsolute(tarball) ? tarball : path.resolve(root, tarball),
  );
}

async function workspaceDependencyClosure(
  roots: readonly string[],
  workspaceRoot: string,
  projects: ReadonlyMap<string, WorkspaceProject>,
  commandLog: string[],
  resolvedNodes: ReadonlyMap<string, PnpmDependencyNode>,
): Promise<{
  readonly projects: readonly WorkspaceProject[];
  readonly names: ReadonlySet<string>;
}> {
  const names = new Set<string>();
  const selected = new Map<string, WorkspaceProject>();
  const projectsByPath = new Map(
    [...projects.values()].map((project) => [
      path.resolve(project.path),
      project,
    ]),
  );
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    names.add(name);
    const project = projects.get(name);
    let parsed: readonly PnpmDependencyNode[];
    if (project === undefined) {
      const installed = resolvedNodes.get(name);
      parsed = installed === undefined ? [] : [installed];
    } else {
      selected.set(name, project);
      const stdout = await runPnpm(
        ["--filter", name, "list", "--prod", "--depth", "Infinity", "--json"],
        workspaceRoot,
        commandLog,
      );
      parsed = JSON.parse(stdout) as PnpmDependencyNode[];
    }
    const walk = (node: PnpmDependencyNode): void => {
      const dependencies = {
        ...node.dependencies,
        ...node.optionalDependencies,
      };
      for (const [dependencyName, dependency] of Object.entries(dependencies)) {
        names.add(dependencyName);
        const dependencyProject =
          (dependency.name === undefined
            ? undefined
            : projects.get(dependency.name)) ??
          (dependency.path === undefined
            ? undefined
            : projectsByPath.get(path.resolve(dependency.path)));
        if (
          dependencyProject !== undefined &&
          !selected.has(dependencyProject.name)
        ) {
          pending.push(dependencyProject.name);
        }
        walk(dependency);
      }
    };
    for (const packageNode of parsed) walk(packageNode);
  }
  return {
    projects: [...selected.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    names,
  };
}

async function linkPackage(
  nodeModulesRoot: string,
  packageName: string,
  packageRoot: string,
): Promise<void> {
  const parts = packageName.startsWith("@")
    ? packageName.split("/")
    : [packageName];
  const linkPath = path.join(nodeModulesRoot, ...parts);
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(packageRoot, linkPath, "dir");
}

function specifierPackageName(specifier: string): string {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.includes(":")
  ) {
    throw new Error(`准备入口必须使用公开包specifier：${specifier}`);
  }
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

function generatedCollectionSource(
  namespace: string,
  members: readonly NativeMember[],
  preparation: PrepareContentCollectionOptions["referencePreparation"],
): string {
  return [
    'import { loadContentSource } from "@ykdz/template-generator/content-source";',
    ...(preparation === undefined
      ? []
      : [
          `import { ${preparation.exportName} as prepareReferenceDefinition } from ${JSON.stringify(preparation.specifier)};`,
        ]),
    "",
    "export const templateContent = await loadContentSource({",
    `  namespace: ${JSON.stringify(namespace)},`,
    "  resolve: (specifier) => import.meta.resolve(specifier),",
    "  members: [",
    ...members.map(
      (member) => `    ${JSON.stringify(member.source.specifier)},`,
    ),
    "  ],",
    ...(preparation === undefined
      ? []
      : [
          "  prepareReferenceDefinition(definition) {",
          "    return prepareReferenceDefinition(",
          "      definition as Parameters<typeof prepareReferenceDefinition>[0],",
          "    );",
          "  },",
        ]),
    "});",
    "",
    "export const templatePresets = templateContent.filter(",
    '  (member) => member.kind === "preset",',
    ");",
    "export const templateReferencePackages = templateContent.filter(",
    '  (member) => member.kind === "reference",',
    ");",
    "",
  ].join("\n");
}

function generatedProviderAggregateSource(
  packageNames: readonly string[],
): string {
  const imports = packageNames.map(
    (name, index) =>
      `import { templateContent as provider${index} } from ${JSON.stringify(name)};`,
  );
  return [
    'import { deriveTemplateMembers } from "./template-members.js";',
    'import type { LoadedContentMember } from "@ykdz/template-core/content-identity";',
    ...imports,
    "",
    "export { deriveTemplateMembers };",
    'export type { ContentKind } from "@ykdz/template-core/content-identity";',
    "export const templateContent = [",
    ...packageNames.map((_, index) => `  ...provider${index},`),
    "] as readonly LoadedContentMember[];",
    "export type TemplateContentMember = (typeof templateContent)[number];",
    'export type TemplatePreset = TemplateContentMember & { readonly kind: "preset" };',
    'export type TemplateReferencePackage = TemplateContentMember & { readonly kind: "reference" };',
    "const templateMembers = deriveTemplateMembers(templateContent);",
    "export const templatePresets = templateMembers.presets;",
    "export const templateReferencePackages = templateMembers.referencePackages;",
    "",
  ].join("\n");
}

function providerPackageName(namespace: string): string {
  const suffix = createHash("sha256")
    .update(namespace)
    .digest("hex")
    .slice(0, 16);
  return `@ykdz/template-content-provider-${suffix}`;
}

async function createModulePackageRoot(options: {
  readonly root: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly source: string;
  readonly additionalSources?: ReadonlyMap<string, string>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly packageRoots: ReadonlyMap<string, string>;
  readonly sdkPackageRoots: ReadonlyMap<string, string>;
  readonly workspaceRoot: string;
  readonly commandLog: string[];
}): Promise<string> {
  const installRoot = path.join(
    options.root,
    "packages",
    options.packageName.replaceAll("/", "+"),
  );
  const sourceRoot = path.join(installRoot, "src");
  const distRoot = path.join(installRoot, "dist");
  const nodeModulesRoot = path.join(installRoot, "node_modules");
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(distRoot, { recursive: true });
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify(
      {
        name: options.packageName,
        version: options.packageVersion,
        type: "module",
        files: ["dist"],
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        },
        dependencies: options.dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(installRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: "src",
          outDir: "dist",
          declaration: true,
          strict: true,
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(sourceRoot, "index.ts"), options.source);
  for (const [fileName, source] of options.additionalSources ?? []) {
    await writeFile(path.join(sourceRoot, fileName), source);
  }

  for (const [name, packageRoot] of options.sdkPackageRoots) {
    await linkPackage(nodeModulesRoot, name, packageRoot);
  }
  for (const [name, packageRoot] of options.packageRoots) {
    await linkPackage(nodeModulesRoot, name, packageRoot);
  }
  await linkPackage(
    nodeModulesRoot,
    "@types/node",
    path.join(options.workspaceRoot, "node_modules", "@types", "node"),
  );
  const tscPath = path.join(options.workspaceRoot, "node_modules", ".bin");
  const { stdout, stderr } = await execa(
    "pnpm",
    [
      "exec",
      "tsc",
      "-p",
      path.join(installRoot, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    {
      cwd: options.workspaceRoot,
      env: {
        ...process.env,
        PATH: `${tscPath}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
  options.commandLog.push(
    `${options.workspaceRoot}$ pnpm exec tsc -p ${path.join(installRoot, "tsconfig.json")} --pretty false`,
  );
  if (stderr.length > 0) options.commandLog.push(stderr.trimEnd());
  if (stdout.length > 0) options.commandLog.push(stdout.trimEnd());
  await rm(nodeModulesRoot, { recursive: true, force: true });
  return installRoot;
}

async function createContentProviderRoot(options: {
  readonly root: string;
  readonly namespace: string;
  readonly members: readonly NativeMember[];
  readonly referencePreparation?: PrepareContentCollectionOptions["referencePreparation"];
  readonly owners: ReadonlyMap<
    string,
    {
      readonly artifact: PreparedNativeContentArtifact;
      readonly installRoot: string;
    }
  >;
  readonly sdkPackageRoots: ReadonlyMap<string, string>;
  readonly sdkVersions: ReadonlyMap<string, string>;
  readonly workspaceRoot: string;
  readonly commandLog: string[];
}): Promise<{ readonly packageName: string; readonly installRoot: string }> {
  const packageName = providerPackageName(options.namespace);
  const dependencies: Record<string, string> = {};
  const packageRoots = new Map<string, string>();
  for (const member of options.members) {
    const owner = options.owners.get(contentIdentityKey(member.identity));
    if (owner === undefined) {
      throw new Error(`来源入口缺少所属制品：${member.identity.packageName}`);
    }
    const previous = packageRoots.get(owner.artifact.coordinate.name);
    if (previous !== undefined && previous !== owner.installRoot) {
      throw new Error(
        `同一来源命名空间含多个同名原生包，无法形成公开解析入口：${owner.artifact.coordinate.name}`,
      );
    }
    packageRoots.set(owner.artifact.coordinate.name, owner.installRoot);
    dependencies[owner.artifact.coordinate.name] =
      owner.artifact.coordinate.version;
  }
  for (const name of [
    "@ykdz/template-generator",
    ...(options.referencePreparation === undefined
      ? []
      : [specifierPackageName(options.referencePreparation.specifier)]),
  ]) {
    const version = options.sdkVersions.get(name);
    if (version === undefined)
      throw new Error(`公开准备入口未由原生依赖解析：${name}`);
    dependencies[name] = version;
  }
  const installRoot = await createModulePackageRoot({
    root: options.root,
    packageName,
    packageVersion: "1.0.0",
    source: generatedCollectionSource(
      options.namespace,
      options.members,
      options.referencePreparation,
    ),
    dependencies,
    packageRoots,
    sdkPackageRoots: options.sdkPackageRoots,
    workspaceRoot: options.workspaceRoot,
    commandLog: options.commandLog,
  });
  return { packageName, installRoot };
}

async function createCollectionInstallRoot(options: {
  readonly root: string;
  readonly packageName: string;
  readonly collectionVersion: string;
  readonly providers: readonly {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly installRoot: string;
  }[];
  readonly sdkPackageRoots: ReadonlyMap<string, string>;
  readonly sdkVersions: ReadonlyMap<string, string>;
  readonly workspaceRoot: string;
  readonly commandLog: string[];
}): Promise<string> {
  const dependencies: Record<string, string> = {};
  const packageRoots = new Map<string, string>();
  for (const provider of options.providers) {
    dependencies[provider.packageName] = provider.packageVersion;
    packageRoots.set(provider.packageName, provider.installRoot);
  }
  for (const name of ["@ykdz/template-core"]) {
    const packageRoot = options.sdkPackageRoots.get(name);
    const version = options.sdkVersions.get(name);
    if (packageRoot === undefined || version === undefined) {
      throw new Error(`集合运行依赖未由pnpm工作区解析：${name}`);
    }
    dependencies[name] = version;
  }
  const memberModuleSource = await readFile(
    fileURLToPath(new URL("../src/template-members.ts", import.meta.url)),
    "utf8",
  );
  return await createModulePackageRoot({
    root: options.root,
    packageName: options.packageName,
    packageVersion: options.collectionVersion,
    source: generatedProviderAggregateSource(
      options.providers.map(({ packageName }) => packageName),
    ),
    additionalSources: new Map([["template-members.ts", memberModuleSource]]),
    dependencies,
    packageRoots,
    sdkPackageRoots: options.sdkPackageRoots,
    workspaceRoot: options.workspaceRoot,
    commandLog: options.commandLog,
  });
}

/** 按显式装配和所属资源执行用途派生制品集合，再由pnpm原生pack。 */
export async function prepareContentCollection(
  options: PrepareContentCollectionOptions,
): Promise<PreparedContentCollection> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const commandLog: string[] = [];
  const { roots, presets, members } = selectedMembers(
    options.content as readonly NativeMember[],
    options.roots as readonly NativeMember[],
  );
  const buildOrder = orderedMembers(presets, members);
  const collectionName = options.packageName ?? "@ykdz/template-content";
  const workspace = await workspaceProjects(workspaceRoot, commandLog);

  const root =
    options.root ?? (await mkdtemp(path.join("/tmp", "preset-content-")));
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  const archiveRoot = path.join(root, "archives");
  const ownerDirectory = path.join(root, "owners");
  await mkdir(archiveRoot, { recursive: true });
  await mkdir(ownerDirectory, { recursive: true });
  const preparedOwners = buildOrder.map((member) => {
    const artifact = ownerDefinition(member).prepareArtifact?.();
    if (artifact === undefined) {
      throw new Error(
        `所属包 ${member.identity.packageName} 未公开 prepareArtifact 接口`,
      );
    }
    return {
      member,
      artifact,
      packageRoot: packageRoot(member),
    };
  });
  const artifactsByIdentity = new Map(
    preparedOwners.map(({ member, artifact }) => [
      contentIdentityKey(member.identity),
      artifact,
    ]),
  );
  const ownerDependenciesByRoot = new Map<string, OwnerResolvedDependencies>();
  for (const { packageRoot: ownerRoot } of preparedOwners) {
    if (!ownerDependenciesByRoot.has(ownerRoot)) {
      ownerDependenciesByRoot.set(
        ownerRoot,
        await resolvedOwnerDependencies(ownerRoot, commandLog),
      );
    }
  }
  const owners: {
    member: NativeMember;
    artifact: PreparedNativeContentArtifact;
    packageRoot: string;
    installRoot: string;
    packed: PackedArtifact;
  }[] = [];

  for (const { member, artifact, packageRoot: ownerRoot } of preparedOwners) {
    const identityKey = contentIdentityKey(member.identity);
    const dependencies = artifactInstallDependencies(
      member,
      artifact,
      members,
      artifactsByIdentity,
      workspace,
      ownerDependenciesByRoot.get(ownerRoot) ?? new Map(),
    );
    const identitySuffix = createHash("sha256")
      .update(identityKey)
      .digest("hex")
      .slice(0, 16);
    const installRoot = path.join(
      ownerDirectory,
      `${artifact.coordinate.name.replaceAll("/", "+")}-${identitySuffix}`,
    );
    await copyOwnerArtifact(artifact, installRoot, dependencies);
    const packed = await packPreparedRoot(installRoot, archiveRoot, commandLog);
    const provider = {
      identity: member.identity,
      specifier: member.source.specifier,
    };
    owners.push({
      member,
      artifact,
      packageRoot: ownerRoot,
      installRoot,
      packed: { ...packed, provider },
    });
  }

  const sdkRoots = [
    ...new Set([
      "@ykdz/template-generator",
      ...(options.referencePreparation === undefined
        ? []
        : [specifierPackageName(options.referencePreparation.specifier)]),
      ...owners.flatMap(({ artifact }) =>
        artifact.dependencies
          .filter((dependency) =>
            dependency.purposes.includes("template-execution"),
          )
          .map((dependency) => dependency.name),
      ),
    ]),
  ].filter(
    (name) => !owners.some(({ artifact }) => artifact.coordinate.name === name),
  );
  const resolved = await resolvedVersions(
    [
      ...new Set([
        ...sdkRoots,
        ...buildOrder.map((member) => member.identity.packageName),
        collectionName,
      ]),
    ].filter((name) => workspace.has(name)),
    workspaceRoot,
    commandLog,
  );
  const sdkClosure = await workspaceDependencyClosure(
    sdkRoots,
    workspaceRoot,
    workspace,
    commandLog,
    resolved.nodes,
  );
  const sdkProjects = sdkClosure.projects;
  const sdkPackagesByName = new Map(
    (options.sdkArchives ?? [])
      .filter((artifact) => sdkClosure.names.has(artifact.name))
      .map((artifact) => [artifact.name, artifact]),
  );
  const ownerNames = new Set(
    owners.map(({ artifact }) => artifact.coordinate.name),
  );
  for (const project of sdkProjects) {
    if (ownerNames.has(project.name) || sdkPackagesByName.has(project.name)) {
      continue;
    }
    const packed = await packNativeProject(
      project,
      archiveRoot,
      workspaceRoot,
      commandLog,
    );
    sdkPackagesByName.set(packed.name, packed);
  }
  const sdkPackages = [...sdkPackagesByName.values()];

  const sdkPackageRoots = new Map<string, string>();
  for (const name of new Set([
    ...sdkRoots,
    ...sdkPackages.map(({ name }) => name),
  ])) {
    const project = workspace.get(name);
    const resolvedPath = resolved.paths.get(name);
    const packageRoot = project?.path ?? resolvedPath;
    if (packageRoot !== undefined) sdkPackageRoots.set(name, packageRoot);
  }
  const sdkVersions = new Map(
    [...sdkPackageRoots.keys()].flatMap((name) => {
      const version =
        workspace.get(name)?.version ?? resolved.versions.get(name);
      return version === undefined ? [] : [[name, version] as const];
    }),
  );

  const collectionVersion =
    workspace.get(collectionName)?.version ?? options.collectionVersion;
  if (collectionVersion === undefined) {
    throw new Error(`pnpm未返回原生集合制品坐标：${collectionName}`);
  }

  const ownerByIdentity = new Map(
    owners.map((owner) => [contentIdentityKey(owner.member.identity), owner]),
  );
  const providerMembers = new Map<string, NativeMember[]>();
  for (const member of members) {
    const namespaceMembers =
      providerMembers.get(member.identity.namespace) ?? [];
    namespaceMembers.push(member);
    providerMembers.set(member.identity.namespace, namespaceMembers);
  }
  const providerPackages: PackedArtifact[] = [];
  const providers: {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly installRoot: string;
  }[] = [];
  for (const [namespace, namespaceMembers] of providerMembers) {
    const provider = await createContentProviderRoot({
      root,
      namespace,
      members: namespaceMembers,
      ...(options.referencePreparation === undefined
        ? {}
        : { referencePreparation: options.referencePreparation }),
      owners: ownerByIdentity,
      sdkPackageRoots,
      sdkVersions,
      workspaceRoot,
      commandLog,
    });
    const packed = await packPreparedRoot(
      provider.installRoot,
      archiveRoot,
      commandLog,
    );
    providerPackages.push(packed);
    providers.push({
      packageName: packed.name,
      packageVersion: packed.version,
      installRoot: provider.installRoot,
    });
  }
  const collectionRoot = await createCollectionInstallRoot({
    root,
    packageName: collectionName,
    collectionVersion,
    providers,
    sdkPackageRoots,
    sdkVersions,
    workspaceRoot,
    commandLog,
  });
  const collection = await packPreparedRoot(
    collectionRoot,
    archiveRoot,
    commandLog,
  );
  const archives = new Map<string, PackedArtifact>();
  for (const artifact of [
    ...sdkPackages,
    ...owners.map((owner) => owner.packed),
    ...providerPackages,
    collection,
  ]) {
    const key =
      artifact.provider === undefined
        ? `${artifact.name}@${artifact.version}`
        : `${artifact.name}@${artifact.version}#${contentIdentityKey(artifact.provider.identity)}`;
    if (archives.has(key)) {
      throw new Error(`内容制品集合存在重复来源键：${key}`);
    }
    archives.set(key, artifact);
  }

  return {
    root,
    roots,
    presets,
    members,
    owners,
    providers: providerPackages,
    sdkPackages,
    collection,
    archives,
    resolvedVersions: resolved.versions,
    commands: commandLog,
    cleanup: async () => await rm(root, { recursive: true, force: true }),
  };
}

/** 把当次归档坐标交给消费工作区的pnpm原生override解析。 */
export async function writeNativeArchiveOverrides(
  root: string,
  archives: readonly PackedArtifact[],
  workspacePackages: readonly string[] = [],
): Promise<void> {
  const artifactRoot = path.join(root, ".artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const byCoordinate = new Map<
    string,
    { readonly archive: PackedArtifact; readonly path: string }
  >();
  for (const archive of archives) {
    const coordinate = `${archive.name}@${archive.version}`;
    const existing = byCoordinate.get(coordinate);
    if (existing !== undefined) {
      if (existing.archive.sha256 !== archive.sha256) {
        throw new Error(
          `pnpm原生精确坐标无法区分不同来源制品 ${coordinate}；请为来源发布不同原生版本`,
        );
      }
      continue;
    }
    const filename = `${archive.name.replaceAll("/", "+")}-${archive.version}-${archive.sha256.slice(0, 12)}.tgz`;
    const archivePath = path.join(artifactRoot, filename);
    await copyFile(archive.tarball, archivePath);
    byCoordinate.set(coordinate, { archive, path: archivePath });
  }
  const overrideLines = [...byCoordinate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([coordinate, { path: archivePath }]) =>
        `  ${JSON.stringify(coordinate)}: ${JSON.stringify(`file:${archivePath}`)}`,
    );
  const workspaceLines =
    workspacePackages.length === 0
      ? ["packages: []"]
      : [
          "packages:",
          ...workspacePackages.map(
            (pattern) => `  - ${JSON.stringify(pattern)}`,
          ),
        ];
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    [...workspaceLines, "overrides:", ...overrideLines, ""].join("\n"),
  );
}

/** 在隔离pnpm工作区中只从本轮原生归档安装集合。 */
export async function installContentCollection(
  prepared: PreparedContentCollection,
  consumerRoot: string,
): Promise<void> {
  await rm(consumerRoot, { recursive: true, force: true });
  await mkdir(consumerRoot, { recursive: true });
  await writeNativeArchiveOverrides(consumerRoot, [
    ...prepared.archives.values(),
  ]);
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "content-consumer", version: "1.0.0", private: true }, null, 2)}\n`,
  );
  await execa(
    "pnpm",
    ["--dir", consumerRoot, "add", prepared.collection.tarball],
    {
      cwd: consumerRoot,
    },
  );
}

export async function writeContentCollectionEvidence(
  prepared: PreparedContentCollection,
  destination: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(
    destination,
    [
      `# 原生内容制品证据`,
      "",
      `入口根：${prepared.roots.map((member) => `${member.identity.packageName}#${member.identity.exportPath}`).join(", ")}`,
      `预设：${prepared.presets.map((preset) => `${preset.identity.packageName}#${preset.identity.exportPath}`).join(", ") || "无"}`,
      `成员：${prepared.members.map((member) => `${member.identity.packageName}#${member.identity.exportPath}`).join(", ")}`,
      "",
      "## 制品",
      "",
      ...[...prepared.archives.values()].map(
        (archive) =>
          `- ${archive.name}@${archive.version}: ${archive.tarball} sha256=${archive.sha256}`,
      ),
      "",
      "## 原生命令",
      "",
      "```text",
      ...prepared.commands,
      "```",
      "",
    ].join("\n"),
  );
}
