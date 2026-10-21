import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  templateContent,
  type TemplateReferencePackage,
} from "@ykdz/template-content";
import {
  prepareContentCollection,
  writeNativeArchiveOverrides,
  type PackedArtifact,
  type PreparedContentCollection,
} from "@ykdz/template-content/artifact-builder";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { execa } from "execa";

type PackageManifest = {
  name: string;
  version: string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bundleDependencies?: string[];
};

type WorkspaceDependency = {
  version?: string;
};

type WorkspacePackage = {
  name?: string;
  dependencies?: Record<string, WorkspaceDependency>;
};

const { values } = parseArgs({
  options: { "pack-destination": { type: "string", default: "." } },
});
const destination = path.resolve(values["pack-destination"]);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageManifestPath = path.join(packageRoot, "package.json");
const packageManifest = JSON.parse(
  await readFile(packageManifestPath, "utf8"),
) as PackageManifest;
const npmPublicationReference = templateContent.find(
  (member): member is TemplateReferencePackage =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-npm-publication" &&
    member.identity.exportPath === "./template",
);
if (npmPublicationReference === undefined) {
  throw new Error(
    "CLI 内容集合缺少共享发布参考包 @ykdz/reference-npm-publication#./template",
  );
}
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "template-cli-pack-"));
let prepared: PreparedContentCollection | undefined;

function archiveByName(
  archives: readonly PackedArtifact[],
): ReadonlyMap<string, PackedArtifact> {
  const result = new Map<string, PackedArtifact>();
  for (const archive of archives) {
    const current = result.get(archive.name);
    if (
      current !== undefined &&
      (current.version !== archive.version || current.sha256 !== archive.sha256)
    ) {
      throw new Error(
        `CLI 归档无法在同一原生包名下封装多个内容坐标：${archive.name}`,
      );
    }
    result.set(archive.name, archive);
  }
  return result;
}

async function resolvedDependencies(): Promise<
  Readonly<Record<string, WorkspaceDependency>>
> {
  const { stdout } = await execa(
    "pnpm",
    ["--filter", packageManifest.name, "list", "--depth", "0", "--json"],
    { cwd: packageRoot },
  );
  const projects = JSON.parse(stdout) as WorkspacePackage[];
  const project = projects.find(
    (candidate) => candidate.name === packageManifest.name,
  );
  if (project?.dependencies === undefined) {
    throw new Error(`pnpm 未返回 CLI 原生依赖解析：${packageManifest.name}`);
  }
  return project.dependencies;
}

async function workspaceRoot(): Promise<string> {
  const { stdout } = await execa(
    "pnpm",
    ["--workspace-root", "exec", "node", "-p", "process.cwd()"],
    { cwd: packageRoot },
  );
  return path.resolve(stdout.trim());
}

function packageManifestForArchives(
  archives: readonly PackedArtifact[],
  resolved: Readonly<Record<string, WorkspaceDependency>>,
): PackageManifest {
  const localArchives = archiveByName(archives);
  const dependencies = { ...packageManifest.dependencies };
  for (const [name, archive] of localArchives) {
    dependencies[name] = archive.version;
  }
  for (const name of Object.keys(dependencies)) {
    if (localArchives.has(name)) continue;
    const version = resolved[name]?.version;
    if (version === undefined || version.startsWith("link:")) {
      throw new Error(`CLI 原生归档缺少可解析依赖：${name}`);
    }
    dependencies[name] = version;
  }

  const bundleDependencies = [
    ...new Set([
      ...(packageManifest.bundleDependencies ?? []),
      ...localArchives.keys(),
    ]),
  ].toSorted();
  const scripts = { ...packageManifest.scripts };
  delete scripts.prepack;
  delete scripts["pack:bundled"];

  return {
    ...packageManifest,
    files: [
      "dist",
      ...bundleDependencies.map((name) => `node_modules/${name}`),
      "!**/node_modules/**/node_modules",
    ],
    scripts,
    dependencies,
    bundleDependencies,
    devDependencies: {},
  };
}

function packedFilename(stdout: string): string {
  const output = JSON.parse(stdout) as unknown;
  const record = Array.isArray(output) ? output[0] : output;
  if (
    typeof record !== "object" ||
    record === null ||
    !("filename" in record) ||
    typeof record.filename !== "string"
  ) {
    throw new Error("pnpm 原生 pack 未返回归档路径");
  }
  return record.filename;
}

try {
  prepared = await prepareContentCollection({
    content: templateContent,
    roots: templateContent,
    referencePreparation: {
      specifier: "@ykdz/template-workspace/reference-package",
      exportName: "defineReferencePackage",
    },
    strategy: createDefaultWorkspaceStrategy({
      cliPublicationReference: npmPublicationReference.definition,
    }),
    workspaceRoot: await workspaceRoot(),
    root: path.join(temporaryRoot, "content"),
  });

  const archives = [...prepared.archives.values()];
  const stage = path.join(temporaryRoot, "package");
  const dependencies = await resolvedDependencies();
  await mkdir(stage, { recursive: true });
  await cp(path.join(packageRoot, "dist"), path.join(stage, "dist"), {
    recursive: true,
  });
  await writeFile(
    path.join(stage, "package.json"),
    `${JSON.stringify(packageManifestForArchives(archives, dependencies), null, 2)}\n`,
  );
  await writeNativeArchiveOverrides(stage, archives);
  await mkdir(destination, { recursive: true });

  const install = await execa(
    "pnpm",
    ["--config.node-linker=hoisted", "install", "--prod", "--prefer-offline"],
    { reject: false, cwd: stage },
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `pnpm 原生安装 CLI 内容闭包失败：${install.stderr || install.stdout}`,
    );
  }

  const packed = await execa(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      "pack",
      "--json",
      "--pack-destination",
      destination,
    ],
    { cwd: stage },
  );
  console.log(path.resolve(stage, packedFilename(packed.stdout)));
} finally {
  try {
    await prepared?.cleanup();
  } finally {
    if (process.env.TEMPLATE_CLI_PACK_KEEP_STAGE === "1") {
      console.error(`保留打包排查现场：${temporaryRoot}`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
