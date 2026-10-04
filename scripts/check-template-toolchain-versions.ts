#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa } from "execa";

type PackageManifest = {
  readonly engines?: unknown;
  readonly packageManager?: unknown;
};

export type TemplateToolchainVersionFacts = {
  readonly rootNodeEngine: string;
  readonly packageManagerDeclaration: string;
  readonly cliNodeEngine: string;
  readonly devcontainerNodeVersion: string;
  readonly rustToolchainChannel: string;
  readonly runningNodeVersion: string;
  readonly runningPnpmVersion: string;
  readonly runningRustVersion: string;
  readonly releaseSnapshotNodeVersion: string;
  readonly releaseSnapshotPackageManagerPin: string;
  readonly releaseSnapshotRustVersion: string;
};

export type ReadTemplateToolchainVersionFactsOptions = {
  readonly repositoryRoot: string;
  readonly readRunningPnpmVersion?: () => Promise<string>;
  readonly readRunningRustVersion?: () => Promise<string>;
};

const exactNodeVersion = /^\d+\.\d+\.\d+$/u;
const exactPackageManagerPin = /^pnpm@(\d+\.\d+\.\d+)$/u;
const exactRustVersion = /^\d+\.\d+\.\d+$/u;

/** 核对模板根 Node/pnpm/Rust 真源、公开 CLI 派生范围、Core 发版快照投影，以及实际运行版本与声明的一致性。 */
export function checkTemplateToolchainVersions(
  facts: TemplateToolchainVersionFacts,
): string[] {
  const rootNodeEngine = facts.rootNodeEngine.trim();
  const rustChannel = facts.rustToolchainChannel.trim();
  if (!exactNodeVersion.test(rootNodeEngine)) {
    return [
      `根 engines.node 必须声明精确的已测 Node patch 版本（形如 24.16.0），当前为 ${facts.rootNodeEngine}`,
    ];
  }

  const pinnedPnpmVersion = exactPackageManagerPin.exec(
    facts.packageManagerDeclaration.trim(),
  )?.[1];
  const derivedCliNodeEngine = `^${rootNodeEngine}`;
  const diagnostics: string[] = [];

  if (pinnedPnpmVersion === undefined) {
    diagnostics.push(
      `根 packageManager 必须是唯一精确 pnpm 固定值（形如 pnpm@11.21.0，不带范围或 hash），当前为 ${facts.packageManagerDeclaration}`,
    );
  } else if (facts.runningPnpmVersion.trim() !== pinnedPnpmVersion) {
    diagnostics.push(
      `实际 pnpm ${facts.runningPnpmVersion} 与根 packageManager 声明的 ${pinnedPnpmVersion} 不一致`,
    );
  }

  if (facts.cliNodeEngine.trim() !== derivedCliNodeEngine) {
    diagnostics.push(
      `公开 CLI engines.node 必须是根精确 Node ${rootNodeEngine} 派生的同 LTS caret 范围 ${derivedCliNodeEngine}，当前为 ${facts.cliNodeEngine}`,
    );
  }

  if (facts.runningNodeVersion.trim() !== rootNodeEngine) {
    diagnostics.push(
      `实际运行 Node ${facts.runningNodeVersion} 与根 engines.node 声明的 ${rootNodeEngine} 不一致`,
    );
  }

  if (facts.devcontainerNodeVersion.trim() !== rootNodeEngine) {
    diagnostics.push(
      `开发容器 .devcontainer/Dockerfile 的 Node 基础镜像必须是根精确 Node ${rootNodeEngine} 投影的静态副本（形如 node:${rootNodeEngine}-bookworm，不接受浮动 tag 或漂移版本），当前为 ${facts.devcontainerNodeVersion}`,
    );
  }

  if (!exactRustVersion.test(rustChannel)) {
    diagnostics.push(
      `根 rust-toolchain.toml 必须声明精确的已测 Rust 版本（形如 1.97.1，不接受 stable、beta、nightly 或范围），当前为 ${facts.rustToolchainChannel}`,
    );
  } else if (facts.runningRustVersion.trim() !== rustChannel) {
    diagnostics.push(
      `实际 Rust ${facts.runningRustVersion} 与根 rust-toolchain.toml 声明的 ${rustChannel} 不一致；请使用 rustup 安装的该 toolchain 或更新唯一真源`,
    );
  }

  if (facts.releaseSnapshotNodeVersion.trim() !== rootNodeEngine) {
    diagnostics.push(
      releaseSnapshotDrift(
        "Node",
        facts.releaseSnapshotNodeVersion,
        rootNodeEngine,
      ),
    );
  }

  if (
    pinnedPnpmVersion !== undefined &&
    facts.releaseSnapshotPackageManagerPin.trim() !==
      facts.packageManagerDeclaration.trim()
  ) {
    diagnostics.push(
      releaseSnapshotDrift(
        "pnpm",
        facts.releaseSnapshotPackageManagerPin,
        facts.packageManagerDeclaration,
      ),
    );
  }

  if (
    exactRustVersion.test(rustChannel) &&
    facts.releaseSnapshotRustVersion.trim() !== rustChannel
  ) {
    diagnostics.push(
      releaseSnapshotDrift(
        "Rust",
        facts.releaseSnapshotRustVersion,
        facts.rustToolchainChannel,
      ),
    );
  }

  return diagnostics;
}

/** 根真源已变更而 Core 发版快照副本未跟上时的诊断。 */
function releaseSnapshotDrift(
  tool: string,
  snapshotValue: string,
  rootValue: string,
): string {
  return `Core 发版快照的 ${tool} 副本 ${snapshotValue} 与根真源 ${rootValue} 漂移；请把根声明投影进 packages/core/src/release-toolchain-snapshot.ts`;
}

export async function readTemplateToolchainVersionFacts(
  options: ReadTemplateToolchainVersionFactsOptions,
): Promise<TemplateToolchainVersionFacts> {
  const [
    rootManifest,
    cliManifest,
    rustToolchainChannel,
    devcontainerNodeVersion,
  ] = await Promise.all([
    readPackageManifest(path.join(options.repositoryRoot, "package.json")),
    readPackageManifest(
      path.join(options.repositoryRoot, "packages/cli/package.json"),
    ),
    readRustToolchainChannel(
      path.join(options.repositoryRoot, "rust-toolchain.toml"),
    ),
    readDevcontainerNodeVersion(
      path.join(options.repositoryRoot, ".devcontainer/Dockerfile"),
    ),
  ]);
  const [runningPnpmVersion, runningRustVersion] = await Promise.all([
    (options.readRunningPnpmVersion ?? readRunningPnpmVersion)(),
    (
      options.readRunningRustVersion ??
      ((): Promise<string> => readRunningRustVersion(options.repositoryRoot))
    )(),
  ]);

  return {
    rootNodeEngine: readNodeEngine(rootManifest),
    packageManagerDeclaration: readPackageManager(rootManifest),
    cliNodeEngine: readNodeEngine(cliManifest),
    devcontainerNodeVersion,
    rustToolchainChannel,
    runningNodeVersion: process.version.slice(1),
    runningPnpmVersion,
    runningRustVersion,
    releaseSnapshotNodeVersion: releaseToolchainSnapshot.nodeVersion,
    releaseSnapshotPackageManagerPin:
      releaseToolchainSnapshot.packageManagerPin,
    releaseSnapshotRustVersion: releaseToolchainSnapshot.rustVersion,
  };
}

async function readPackageManifest(file: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(file, "utf8")) as PackageManifest;
}

function readNodeEngine(manifest: PackageManifest): string {
  const engines = manifest.engines;
  if (typeof engines !== "object" || engines === null) {
    return "(缺失 engines.node)";
  }
  const node = (engines as { readonly node?: unknown }).node;

  return typeof node === "string" ? node : "(缺失 engines.node)";
}

function readPackageManager(manifest: PackageManifest): string {
  return typeof manifest.packageManager === "string"
    ? manifest.packageManager
    : "(缺失 packageManager)";
}

async function readRustToolchainChannel(file: string): Promise<string> {
  let declaration: string;
  try {
    declaration = await readFile(file, "utf8");
  } catch {
    return "(缺失 rust-toolchain.toml)";
  }
  const sectionBody = /\[toolchain\][^\S\n]*\n([^[]*)/u.exec(declaration)?.[1];
  const channel =
    sectionBody === undefined
      ? undefined
      : /^\s*channel\s*=\s*"([^"]*)"/mu.exec(sectionBody)?.[1];

  return channel ?? "(缺失 rust-toolchain.toml 的 channel)";
}

async function readDevcontainerNodeVersion(file: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    return "(缺失 .devcontainer/Dockerfile)";
  }
  const tag = /^\s*FROM\s+node:(\S+)/imu.exec(contents)?.[1];

  return tag === undefined
    ? "(缺失 .devcontainer/Dockerfile 的 node 基础镜像 tag)"
    : tag.split("-")[0]!;
}

async function readRunningRustVersion(repositoryRoot: string): Promise<string> {
  const rustc = await execa("rustc", ["--version"], {
    cwd: repositoryRoot,
    reject: true,
  });
  const version = /^\s*rustc\s+(\S+)/mu.exec(rustc.stdout)?.[1];
  if (version === undefined) {
    throw new Error(`无法解析 rustc --version 输出：${rustc.stdout}`);
  }

  return version;
}

async function readRunningPnpmVersion(): Promise<string> {
  const pnpm = await execa("pnpm", ["--version"], { reject: true });

  return pnpm.stdout.trim();
}

function repositoryRootArgument(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--repository-root");

  return index === -1 ? undefined : argv.at(index + 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repositoryRoot = path.resolve(
    repositoryRootArgument(process.argv.slice(2)) ??
      path.resolve(import.meta.dirname, ".."),
  );
  const facts = await readTemplateToolchainVersionFacts({ repositoryRoot });
  const diagnostics = checkTemplateToolchainVersions(facts);

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      console.error(diagnostic);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `模板工具链版本真源一致：Node ${facts.rootNodeEngine}、pnpm ${facts.runningPnpmVersion}、公开 CLI ${facts.cliNodeEngine}、Rust ${facts.rustToolchainChannel}，Core 发版快照三值投影一致`,
    );
  }
}
