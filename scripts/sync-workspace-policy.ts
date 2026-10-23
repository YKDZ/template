import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { format } from "oxfmt";
import { parse } from "yaml";

import formatterConfig from "../oxfmt.config.ts";
import {
  readTemplateToolchainDeclarations,
  deriveTemplateToolchain,
} from "./template-toolchain-declarations.ts";

const root = new URL("../", import.meta.url);
const workspace = parse(
  await readFile(new URL("pnpm-workspace.yaml", root), "utf8"),
) as Record<string, unknown> & { catalog: Record<string, string> };
const ignore = await readFile(new URL(".gitignore", root), "utf8");
const {
  packages: _packages,
  catalog: _catalog,
  catalogs: _catalogs,
  ...installPolicy
} = workspace;
const check = process.argv.includes("--check");

async function formattedSource(name: string, source: string): Promise<string> {
  const result = await format(name, source, formatterConfig);
  if (result.errors.length > 0) {
    throw new Error(`无法格式化 ${name}。`);
  }
  return result.code;
}

async function sendToOwner(
  packageName: string,
  taskName: string,
  source: string,
): Promise<void> {
  const result = await execa(
    "pnpm",
    [
      "--filter",
      packageName,
      "run",
      taskName,
      ...(check ? ["--", "--check"] : []),
    ],
    {
      cwd: fileURLToPath(root),
      input: source,
      reject: false,
    },
  );
  if (result.failed) {
    throw new Error(
      `${packageName} ${taskName} 失败：${result.stderr || result.stdout}`,
    );
  }
}

const workspaceSnapshot = await formattedSource(
  "workspace-policy-snapshot.ts",
  `// 由根 sync:workspace-policy 从原生声明派生，请修改其事实源后显式同步。
export const dependencyCatalogSnapshot: Readonly<Record<string, string>> = ${JSON.stringify(workspace.catalog, null, 2)};

export const workspaceInstallPolicySnapshot = ${JSON.stringify(installPolicy, null, 2)};
`,
);
const resourceIgnoreSnapshot = await formattedSource(
  "resource-ignore-snapshot.ts",
  `// 由根 sync:workspace-policy 从根 .gitignore 派生，请修改事实源后显式同步。
export const resourceIgnoreSnapshot = ${JSON.stringify(ignore)};
`,
);
const declarations = await readTemplateToolchainDeclarations(
  fileURLToPath(root),
);
const derived = deriveTemplateToolchain(declarations);
if (derived.diagnostics.length > 0)
  throw new Error(derived.diagnostics.join("\n"));
const toolchainSnapshot = await formattedSource(
  "release-toolchain-snapshot.ts",
  `// 由根 sync:workspace-policy 从原生工具链声明派生，请修改事实源后显式同步。
export const releaseToolchainSnapshot = Object.freeze(${JSON.stringify({ nodeVersion: declarations.rootNodeEngine.trim(), packageManagerPin: declarations.packageManagerDeclaration.trim(), rustVersion: declarations.rustToolchainChannel.trim() }, null, 2)} as const);

export type ReleaseToolchainSnapshot = typeof releaseToolchainSnapshot;
`,
);

await Promise.all([
  sendToOwner(
    "@ykdz/template-workspace",
    "sync:release-toolchain-snapshot",
    toolchainSnapshot,
  ),
  sendToOwner(
    "@ykdz/template-workspace",
    "sync:policy-snapshot",
    workspaceSnapshot,
  ),
  sendToOwner(
    "@ykdz/template-workspace-authoring",
    "sync:resource-ignore-snapshot",
    resourceIgnoreSnapshot,
  ),
]);
