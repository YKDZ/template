#!/usr/bin/env node
import path from "node:path";

import { execa } from "execa";

import {
  deriveTemplateToolchain,
  readTemplateToolchainDeclarations,
  type TemplateToolchainDeclarations,
} from "./template-toolchain-declarations.ts";

export type TemplateToolchainVersionFacts = TemplateToolchainDeclarations & {
  readonly runningNodeVersion: string;
  readonly runningPnpmVersion: string;
  readonly runningRustVersion: string;
};

export type ReadTemplateToolchainVersionFactsOptions = {
  readonly repositoryRoot: string;
  readonly readRunningPnpmVersion?: () => Promise<string>;
  readonly readRunningRustVersion?: () => Promise<string>;
};

/** 核对根 Node、pnpm、Rust 声明的合法性，以及实际运行版本。 */
export function checkTemplateToolchainVersions(
  facts: TemplateToolchainVersionFacts,
): string[] {
  const derived = deriveTemplateToolchain(facts);
  if (derived.diagnostics.length > 0) return derived.diagnostics;

  const diagnostics: string[] = [];
  const nodeVersion = facts.rootNodeEngine.trim();
  const rustVersion = facts.rustToolchainChannel.trim();
  if (facts.runningNodeVersion.trim() !== nodeVersion) {
    diagnostics.push(
      `实际运行 Node ${facts.runningNodeVersion} 与根 engines.node 声明的 ${nodeVersion} 不一致`,
    );
  }
  if (facts.runningPnpmVersion.trim() !== derived.pnpmVersion) {
    diagnostics.push(
      `实际 pnpm ${facts.runningPnpmVersion} 与根 packageManager 声明的 ${derived.pnpmVersion} 不一致`,
    );
  }
  if (facts.runningRustVersion.trim() !== rustVersion) {
    diagnostics.push(
      `实际 Rust ${facts.runningRustVersion} 与根 rust-toolchain.toml 声明的 ${rustVersion} 不一致；请使用 rustup 安装的该 toolchain 或更新唯一真源`,
    );
  }
  return diagnostics;
}

export async function readTemplateToolchainVersionFacts(
  options: ReadTemplateToolchainVersionFactsOptions,
): Promise<TemplateToolchainVersionFacts> {
  const [declarations, runningPnpmVersion, runningRustVersion] =
    await Promise.all([
      readTemplateToolchainDeclarations(options.repositoryRoot),
      (options.readRunningPnpmVersion ?? readRunningPnpmVersion)(),
      (
        options.readRunningRustVersion ??
        ((): Promise<string> => readRunningRustVersion(options.repositoryRoot))
      )(),
    ]);

  return {
    ...declarations,
    runningNodeVersion: process.version.slice(1),
    runningPnpmVersion,
    runningRustVersion,
  };
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
      `模板工具链版本真源一致：Node ${facts.runningNodeVersion}、pnpm ${facts.runningPnpmVersion}、Rust ${facts.runningRustVersion}`,
    );
  }
}
