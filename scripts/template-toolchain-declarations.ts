import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export type TemplateToolchainDeclarations = {
  readonly rootNodeEngine: string;
  readonly packageManagerDeclaration: string;
  readonly rustToolchainChannel: string;
  readonly playwrightTestVersion: string;
};

export function deriveTemplateToolchain(
  declarations: TemplateToolchainDeclarations,
): {
  readonly diagnostics: string[];
  readonly cliNodeEngine: string;
  readonly pnpmVersion: string | undefined;
} {
  const node = declarations.rootNodeEngine.trim();
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(
    declarations.packageManagerDeclaration.trim(),
  )?.[1];
  const diagnostics: string[] = [];
  if (!/^\d+\.\d+\.\d+$/u.test(node))
    diagnostics.push(
      `根 engines.node 必须声明精确的已测 Node patch 版本（形如 24.16.0），当前为 ${declarations.rootNodeEngine}`,
    );
  if (pnpmVersion === undefined)
    diagnostics.push(
      `根 packageManager 必须是唯一精确 pnpm 固定值（形如 pnpm@11.21.0，不带范围或 hash），当前为 ${declarations.packageManagerDeclaration}`,
    );
  if (!/^\d+\.\d+\.\d+$/u.test(declarations.rustToolchainChannel.trim()))
    diagnostics.push(
      `根 rust-toolchain.toml 必须声明精确的已测 Rust 版本（形如 1.97.1，不接受 stable、beta、nightly 或范围），当前为 ${declarations.rustToolchainChannel}`,
    );
  if (declarations.playwrightTestVersion.trim().length === 0) {
    diagnostics.push(
      "根 pnpm-workspace.yaml 必须在 catalog 中声明 @playwright/test 版本",
    );
  }
  return { diagnostics, cliNodeEngine: `^${node}`, pnpmVersion };
}

export function readNodeEngine(manifest: {
  readonly engines?: unknown;
}): string {
  const engines = manifest.engines;
  const node =
    typeof engines === "object" && engines !== null
      ? (engines as { readonly node?: unknown }).node
      : undefined;
  return typeof node === "string" ? node : "(缺失 engines.node)";
}

export async function readTemplateToolchainDeclarations(
  repositoryRoot: string,
): Promise<TemplateToolchainDeclarations> {
  const [manifestContents, rustContents, workspaceContents] = await Promise.all(
    [
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "rust-toolchain.toml"), "utf8").catch(
        () => "",
      ),
      readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8").catch(
        () => "",
      ),
    ],
  );
  const manifest = JSON.parse(manifestContents) as {
    readonly engines?: unknown;
    readonly packageManager?: unknown;
  };
  const rustDeclaration = parseToml(rustContents);
  const workspaceDeclaration = parseYaml(workspaceContents) as unknown;
  const workspaceCatalog =
    typeof workspaceDeclaration === "object" &&
    workspaceDeclaration !== null &&
    !Array.isArray(workspaceDeclaration) &&
    "catalog" in workspaceDeclaration &&
    typeof workspaceDeclaration.catalog === "object" &&
    workspaceDeclaration.catalog !== null &&
    !Array.isArray(workspaceDeclaration.catalog)
      ? workspaceDeclaration.catalog
      : undefined;
  const playwrightTestVersion =
    workspaceCatalog?.["@playwright/test"] ?? workspaceCatalog?.playwright;
  const toolchain = rustDeclaration.toolchain;
  const channel =
    typeof toolchain === "object" &&
    toolchain !== null &&
    "channel" in toolchain
      ? toolchain.channel
      : undefined;
  return {
    rootNodeEngine: readNodeEngine(manifest),
    packageManagerDeclaration:
      typeof manifest.packageManager === "string"
        ? manifest.packageManager
        : "(缺失 packageManager)",
    rustToolchainChannel:
      typeof channel === "string"
        ? channel
        : "(缺失 rust-toolchain.toml 的 channel)",
    playwrightTestVersion:
      typeof playwrightTestVersion === "string" ? playwrightTestVersion : "",
  };
}
