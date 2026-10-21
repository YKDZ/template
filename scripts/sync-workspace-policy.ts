import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { format } from "oxfmt";
import { parse } from "yaml";

import formatterConfig from "../oxfmt.config.ts";

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
const rendererPolicySnapshot = await formattedSource(
  "renderer-policy-snapshot.ts",
  `// 由根 sync:workspace-policy 从格式化器原生配置派生，请修改事实源后显式同步。
export const generatedJsonPrintWidth = ${formatterConfig.printWidth};
`,
);

await Promise.all([
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
  sendToOwner(
    "@ykdz/template-core",
    "sync:renderer-policy-snapshot",
    rendererPolicySnapshot,
  ),
]);

const publicationResources = await execa(
  "pnpm",
  [
    "--filter",
    "@ykdz/template-workspace",
    "run",
    "sync:npm-publication-resources",
    ...(check ? ["--", "--check"] : []),
  ],
  { cwd: fileURLToPath(root), reject: false },
);
if (publicationResources.failed) {
  throw new Error(
    `共享 npm 发布资源同步失败：${publicationResources.stderr || publicationResources.stdout}`,
  );
}
