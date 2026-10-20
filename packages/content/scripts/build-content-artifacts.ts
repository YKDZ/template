import { createHash } from "node:crypto";
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  contentIdentityKey,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import type { PreparedNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import { execa } from "execa";

import type { LoadedTemplateContentMember } from "../src/collection.ts";

type NativeMember = LoadedTemplateContentMember & {
  readonly source: {
    readonly manifestURL: string;
    readonly moduleURL: string;
  };
};

type PresetMember = Extract<NativeMember, { readonly kind: "preset" }>;
type ReferenceMember = Extract<NativeMember, { readonly kind: "reference" }>;

type DependencyStrategy = {
  dependencies(options: {
    readonly content: NativeMember;
    readonly contentByIdentity: ReadonlyMap<string, NativeMember>;
  }): readonly ContentIdentity[];
};

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
  readonly namespace: string;
  readonly preset: PresetMember;
  readonly members: readonly NativeMember[];
  readonly owners: readonly {
    readonly member: NativeMember;
    readonly artifact: PreparedNativeContentArtifact;
    readonly packageRoot: string;
    readonly installRoot: string;
    readonly packed: PackedArtifact;
  }[];
  readonly sdkPackages: readonly PackedArtifact[];
  readonly collection: PackedArtifact;
  readonly archives: ReadonlyMap<string, PackedArtifact>;
  /** 由当前pnpm工作区清单实际解析出的版本。 */
  readonly resolvedVersions: ReadonlyMap<string, string>;
  readonly commands: readonly string[];
  cleanup(): Promise<void>;
};

export type PrepareContentCollectionOptions = {
  readonly content: readonly LoadedTemplateContentMember[];
  /** 从同一原生集合中额外公开、供后续add选择的成员。 */
  readonly additionalMembers?: readonly LoadedTemplateContentMember[];
  readonly presetAlias: string;
  readonly strategy: DependencyStrategy;
  readonly workspaceRoot?: string;
  readonly namespace?: string;
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

function selectedMembers(
  content: readonly NativeMember[],
  presetAlias: string,
  strategy: DependencyStrategy,
  additionalMembers: readonly NativeMember[],
): {
  readonly preset: PresetMember;
  readonly members: readonly NativeMember[];
} {
  const preset = content.find(
    (member): member is PresetMember =>
      member.kind === "preset" && member.alias === presetAlias,
  );
  if (preset === undefined) {
    throw new Error(`内容集合中不存在预设：${presetAlias}`);
  }

  const references = content.filter(
    (member): member is ReferenceMember => member.kind === "reference",
  );
  const referencesByIdentity = new Map(
    references.map((member) => [contentIdentityKey(member.identity), member]),
  );
  const referencesByDefinition = new Map(
    references.map((member) => [member.definition, member]),
  );
  const selected = new Map<string, NativeMember>([
    [contentIdentityKey(preset.identity), preset],
  ]);
  const visited = new Set<string>();
  const visit = (member: ReferenceMember): void => {
    const key = contentIdentityKey(member.identity);
    selected.set(key, member);
    if (visited.has(key)) return;
    visited.add(key);
    for (const dependency of strategy.dependencies({
      content: member,
      contentByIdentity: referencesByIdentity,
    })) {
      const child = referencesByIdentity.get(contentIdentityKey(dependency));
      if (child === undefined) {
        throw new Error(
          `预设 ${presetAlias} 的策略闭包缺少成员 ${dependency.packageName}#${dependency.exportPath}`,
        );
      }
      visit(child);
    }
  };

  const includePresetReferences = (selectedPreset: PresetMember): void => {
    const nodes = Object.values(
      selectedPreset.definition.nodes as Record<
        string,
        { readonly reference: unknown }
      >,
    );
    for (const node of nodes) {
      const reference = referencesByDefinition.get(
        node.reference as ReferenceMember["definition"],
      );
      if (reference === undefined) {
        throw new Error(
          `预设 ${selectedPreset.alias} 引用未由当前集合登记的原生成员`,
        );
      }
      visit(reference);
    }
  };
  includePresetReferences(preset);

  for (const additional of additionalMembers) {
    const identity = contentIdentityKey(additional.identity);
    const available = content.find(
      (member) => contentIdentityKey(member.identity) === identity,
    );
    if (available === undefined) {
      throw new Error(
        `附加集合成员未由当前原生集合登记：${additional.identity.packageName}#${additional.identity.exportPath}`,
      );
    }
    if (available.kind === "preset") {
      throw new Error(
        `附加成员必须是参考包：${available.identity.packageName}#${available.identity.exportPath}`,
      );
    }
    visit(available);
  }

  return {
    preset,
    members: content.filter((member) =>
      selected.has(contentIdentityKey(member.identity)),
    ),
  };
}

function orderedMembers(
  preset: PresetMember,
  members: readonly NativeMember[],
  strategy: DependencyStrategy,
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
    for (const dependency of strategy.dependencies({
      content: member,
      contentByIdentity: byIdentity,
    })) {
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
  ordered.push(preset);
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
};

function collectResolvedPackages(
  value: unknown,
  versions: Map<string, string>,
  paths: Map<string, string>,
  fallbackName?: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectResolvedPackages(item, versions, paths, fallbackName);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as PnpmDependencyNode;
  const name = node.name ?? fallbackName ?? node.from;
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
        collectResolvedPackages(child, versions, paths, childName);
      }
    } else {
      collectResolvedPackages(children, versions, paths);
    }
  }
}

async function resolvedVersions(
  packageNames: readonly string[],
  workspaceRoot: string,
  commandLog: string[],
): Promise<ResolvedPackages> {
  const versions = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const name of packageNames) {
    const stdout = await runPnpm(
      ["--filter", name, "list", "--depth", "Infinity", "--json"],
      workspaceRoot,
      commandLog,
    );
    collectResolvedPackages(JSON.parse(stdout), versions, paths);
  }
  return { versions, paths };
}

function versionForDependency(
  name: string,
  specifier: string,
  artifacts: ReadonlyMap<string, PreparedNativeContentArtifact>,
  workspace: ReadonlyMap<string, WorkspaceProject>,
  resolved: ReadonlyMap<string, string>,
): string {
  const artifact = artifacts.get(name);
  if (artifact !== undefined) return artifact.coordinate.version;
  const project = workspace.get(name);
  if (project?.version !== undefined) return project.version;
  const version = resolved.get(name);
  if (version !== undefined) return version;
  if (!/^(?:workspace|catalog|link):/u.test(specifier)) return specifier;
  throw new Error(
    `原生包管理器未解析依赖坐标 ${name}@${specifier}；无法投影安装清单`,
  );
}

function artifactInstallDependencies(
  artifact: PreparedNativeContentArtifact,
  artifacts: ReadonlyMap<string, PreparedNativeContentArtifact>,
  workspace: ReadonlyMap<string, WorkspaceProject>,
  resolved: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const dependencies: Record<string, string> = {};
  for (const dependency of artifact.dependencies) {
    if (!dependency.purposes.includes("template-execution")) continue;
    dependencies[dependency.name] = versionForDependency(
      dependency.name,
      dependency.specifier,
      artifacts,
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
    // pnpm versions that omit --json output the archive path as plain text.
  }
  const lines = stdout.trim().split("\n");
  return lines.at(-1) ?? "";
}

async function packNativeProject(
  project: WorkspaceProject,
  artifacts: ReadonlyMap<string, PreparedNativeContentArtifact>,
  workspace: ReadonlyMap<string, WorkspaceProject>,
  root: string,
  destination: string,
  workspaceRoot: string,
  commandLog: string[],
): Promise<PackedArtifact> {
  const nativeManifest = JSON.parse(
    await readFile(path.join(project.path, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const resolved = await resolvedVersions(
    [project.name],
    workspaceRoot,
    commandLog,
  );
  const projectedManifest: Record<string, unknown> = { ...nativeManifest };
  delete projectedManifest.private;
  delete projectedManifest.devDependencies;
  delete projectedManifest.scripts;
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const declarations = nativeManifest[field];
    if (typeof declarations !== "object" || declarations === null) continue;
    const projected: Record<string, string> = {};
    for (const [name, specifier] of Object.entries(
      declarations as Record<string, unknown>,
    )) {
      if (typeof specifier !== "string") continue;
      projected[name] = versionForDependency(
        name,
        specifier,
        artifacts,
        workspace,
        resolved.versions,
      );
    }
    projectedManifest[field] = projected;
  }

  const files = nativeManifest.files;
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    throw new Error(`SDK包 ${project.name} 必须以原生files声明发布范围`);
  }
  const installRoot = path.join(root, "sdk", project.name.replaceAll("/", "+"));
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(installRoot, { recursive: true });
  for (const file of files as string[]) {
    if (/[*?{}[\]]/u.test(file)) {
      throw new Error(
        `SDK包 ${project.name} 的发布范围需使用原生目录项：${file}`,
      );
    }
    const relativePath = safePath(file);
    if (relativePath === ".") {
      throw new Error(`SDK包 ${project.name} 的发布范围不能包含整个作者目录`);
    }
    const source = path.resolve(project.path, relativePath);
    const destinationPath = path.join(installRoot, relativePath);
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`SDK包 ${project.name} 的发布文件包含符号链接：${file}`);
    }
    if (sourceStat.isDirectory()) {
      const visit = async (
        directory: string,
        target: string,
      ): Promise<void> => {
        await mkdir(target, { recursive: true });
        const children = await readdir(directory, { withFileTypes: true });
        for (const child of children) {
          const childSource = path.join(directory, child.name);
          const childTarget = path.join(target, child.name);
          const childStat = await lstat(childSource);
          if (childStat.isSymbolicLink()) {
            throw new Error(
              `SDK包 ${project.name} 的发布文件包含符号链接：${path.relative(project.path, childSource)}`,
            );
          }
          if (childStat.isDirectory()) {
            await visit(childSource, childTarget);
          } else {
            await mkdir(path.dirname(childTarget), { recursive: true });
            await copyFile(childSource, childTarget);
            await chmod(childTarget, childStat.mode & 0o777);
          }
        }
      };
      await visit(source, destinationPath);
    } else if (sourceStat.isFile()) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(source, destinationPath);
      await chmod(destinationPath, sourceStat.mode & 0o777);
    } else {
      throw new Error(`SDK包 ${project.name} 的发布项不是文件或目录：${file}`);
    }
  }
  const version =
    typeof nativeManifest.version === "string"
      ? nativeManifest.version
      : project.version;
  if (version === undefined) {
    throw new Error(`pnpm未返回原生SDK坐标：${project.name}`);
  }
  if (typeof nativeManifest.version !== "string") {
    projectedManifest.version = version;
  }
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify(projectedManifest, null, 2)}\n`,
  );
  return await packPreparedRoot(installRoot, destination, commandLog);
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
): Promise<readonly WorkspaceProject[]> {
  const selected = new Map<string, WorkspaceProject>();
  const projectsByPath = new Map(
    [...projects.values()].map((project) => [
      path.resolve(project.path),
      project,
    ]),
  );
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (selected.has(name)) continue;
    const project = projects.get(name);
    if (project === undefined) continue;
    selected.set(name, project);
    const stdout = await runPnpm(
      ["--filter", name, "list", "--prod", "--depth", "Infinity", "--json"],
      workspaceRoot,
      commandLog,
    );
    const parsed = JSON.parse(stdout) as PnpmDependencyNode[];
    const walk = (node: PnpmDependencyNode): void => {
      const dependencies = [
        ...Object.values(node.dependencies ?? {}),
        ...Object.values(node.optionalDependencies ?? {}),
      ];
      for (const dependency of dependencies) {
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
  return [...selected.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
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

function generatedCollectionSource(
  namespace: string,
  members: readonly NativeMember[],
): string {
  return [
    'import { loadContentSource } from "@ykdz/template-generator/content-source";',
    'import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";',
    "",
    "export const templateContent = await loadContentSource({",
    `  namespace: ${JSON.stringify(namespace)},`,
    "  resolve: (specifier) => import.meta.resolve(specifier),",
    "  members: [",
    ...members.map(
      (member) => `    ${JSON.stringify(member.source.specifier)},`,
    ),
    "  ],",
    "  prepareReferenceDefinition(definition) {",
    "    return defineReferencePackage(",
    "      definition as Parameters<typeof defineReferencePackage>[0],",
    "    );",
    "  },",
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

async function createCollectionInstallRoot(options: {
  readonly root: string;
  readonly packageName: string;
  readonly collectionVersion: string;
  readonly namespace: string;
  readonly members: readonly NativeMember[];
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
}): Promise<string> {
  const installRoot = path.join(options.root, "collection");
  const distRoot = path.join(installRoot, "dist");
  const sourceRoot = path.join(installRoot, "src");
  const nodeModulesRoot = path.join(installRoot, "node_modules");
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(distRoot, { recursive: true });

  const dependencies: Record<string, string> = {};
  for (const member of options.members) {
    const prepared = options.owners.get(contentIdentityKey(member.identity));
    if (prepared === undefined) {
      throw new Error(`集合成员缺少所属制品：${member.identity.packageName}`);
    }
    dependencies[prepared.artifact.coordinate.name] =
      prepared.artifact.coordinate.version;
  }
  for (const name of [
    "@ykdz/template-generator",
    "@ykdz/template-workspace",
    "@ykdz/template-core",
    "@ykdz/template-workspace-authoring",
  ]) {
    const packageRoot = options.sdkPackageRoots.get(name);
    const version = options.sdkVersions.get(name);
    if (packageRoot === undefined || version === undefined) {
      throw new Error(`集合运行依赖未由pnpm工作区解析：${name}`);
    }
    dependencies[name] = version;
  }

  const packageManifest = {
    name: options.packageName,
    version: options.collectionVersion,
    type: "module",
    files: ["dist"],
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    },
    dependencies,
  };
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
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
  await writeFile(
    path.join(sourceRoot, "index.ts"),
    generatedCollectionSource(options.namespace, options.members),
  );

  for (const [name, packageRoot] of options.sdkPackageRoots) {
    await linkPackage(nodeModulesRoot, name, packageRoot);
  }
  for (const [name, owner] of options.owners) {
    await linkPackage(nodeModulesRoot, name, owner.installRoot);
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

/** 按预设节点和默认策略依赖派生制品集合，再由pnpm原生pack。 */
export async function prepareContentCollection(
  options: PrepareContentCollectionOptions,
): Promise<PreparedContentCollection> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const commandLog: string[] = [];
  const { preset, members } = selectedMembers(
    options.content as readonly NativeMember[],
    options.presetAlias,
    options.strategy,
    (options.additionalMembers ?? []) as readonly NativeMember[],
  );
  const buildOrder = orderedMembers(preset, members, options.strategy);
  const collectionName = options.packageName ?? "@ykdz/template-content";
  const workspace = await workspaceProjects(workspaceRoot, commandLog);
  const resolutionRoots = new Set([
    ...buildOrder.map((member) => member.identity.packageName),
    collectionName,
    "@ykdz/template-content",
  ]);
  const resolved = await resolvedVersions(
    [...resolutionRoots].filter((name) => workspace.has(name)),
    workspaceRoot,
    commandLog,
  );

  const root =
    options.root ?? (await mkdtemp(path.join("/tmp", "preset-content-")));
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  const archiveRoot = path.join(root, "archives");
  const ownerDirectory = path.join(root, "owners");
  await mkdir(archiveRoot, { recursive: true });
  await mkdir(ownerDirectory, { recursive: true });
  const artifactsByName = new Map<string, PreparedNativeContentArtifact[]>();
  const owners: {
    member: NativeMember;
    artifact: PreparedNativeContentArtifact;
    packageRoot: string;
    installRoot: string;
    packed: PackedArtifact;
  }[] = [];

  for (const member of buildOrder) {
    const ownerRoot = packageRoot(member);
    const artifact = ownerDefinition(member).prepareArtifact?.();
    if (artifact === undefined) {
      throw new Error(
        `所属包 ${member.identity.packageName} 未公开 prepareArtifact 接口`,
      );
    }
    const sameName = artifactsByName.get(artifact.coordinate.name) ?? [];
    if (sameName.length > 0) {
      throw new Error(
        `当前集合含多个同名来源制品，pnpm原生根override无法表达来源选择：${artifact.coordinate.name} (${sameName.map((existing) => existing.coordinate.version).join(", ")} 与 ${artifact.coordinate.version})`,
      );
    }
    sameName.push(artifact);
    artifactsByName.set(artifact.coordinate.name, sameName);
    const artifactByName = new Map(
      [...artifactsByName].map(([name, values]) => [name, values[0]!] as const),
    );
    const dependencies = artifactInstallDependencies(
      artifact,
      artifactByName,
      workspace,
      resolved.versions,
    );
    const installRoot = path.join(
      ownerDirectory,
      artifact.coordinate.name.replaceAll("/", "+"),
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
    "@ykdz/template-generator",
    "@ykdz/template-workspace",
    "@ykdz/template-core",
    "@ykdz/template-workspace-authoring",
  ];
  const sdkProjects = await workspaceDependencyClosure(
    sdkRoots,
    workspaceRoot,
    workspace,
    commandLog,
  );
  const sdkPackagesByName = new Map(
    (options.sdkArchives ?? []).map((artifact) => [artifact.name, artifact]),
  );
  for (const project of sdkProjects) {
    if (
      artifactsByName.has(project.name) ||
      sdkPackagesByName.has(project.name)
    ) {
      continue;
    }
    const packed = await packNativeProject(
      project,
      new Map(
        [...artifactsByName].map(
          ([name, values]) => [name, values[0]!] as const,
        ),
      ),
      workspace,
      root,
      archiveRoot,
      workspaceRoot,
      commandLog,
    );
    sdkPackagesByName.set(packed.name, packed);
  }
  const sdkPackages = [...sdkPackagesByName.values()];

  const sdkPackageRoots = new Map<string, string>();
  for (const name of sdkRoots) {
    const project = workspace.get(name);
    const resolvedPath = resolved.paths.get(name);
    const packageRoot = project?.path ?? resolvedPath;
    if (packageRoot !== undefined) sdkPackageRoots.set(name, packageRoot);
  }
  const sdkVersions = new Map(
    sdkRoots.flatMap((name) => {
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
  const collectionRoot = await createCollectionInstallRoot({
    root,
    packageName: collectionName,
    collectionVersion,
    namespace: options.namespace ?? preset.identity.namespace,
    members,
    owners: ownerByIdentity,
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
    namespace: options.namespace ?? preset.identity.namespace,
    preset,
    members,
    owners,
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
  const byName = new Map<
    string,
    { readonly archive: PackedArtifact; readonly path: string }
  >();
  for (const archive of archives) {
    const existing = byName.get(archive.name);
    if (existing !== undefined) {
      if (existing.archive.tarball !== archive.tarball) {
        throw new Error(
          `pnpm根override无法唯一安装同名来源制品 ${archive.name}：${existing.archive.version} 与 ${archive.version}`,
        );
      }
      continue;
    }
    const filename = `${archive.name.replaceAll("/", "+")}-${archive.version}-${archive.sha256.slice(0, 12)}.tgz`;
    const archivePath = path.join(artifactRoot, filename);
    await copyFile(archive.tarball, archivePath);
    byName.set(archive.name, { archive, path: archivePath });
  }
  const overrideLines = [...byName.values()]
    .sort((left, right) => left.archive.name.localeCompare(right.archive.name))
    .map(
      ({ archive, path: archivePath }) =>
        `  ${JSON.stringify(archive.name)}: ${JSON.stringify(`file:${archivePath}`)}`,
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
      `预设：${prepared.preset.identity.packageName}#${prepared.preset.identity.exportPath}`,
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
