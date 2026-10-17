import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { format } from "oxfmt";
import { parse } from "yaml";

import formatterConfig from "../oxfmt.config.ts";
// 根拥有原生政策及其发布副本；叶包不查找或读取宿主根目录。
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
const raw = `// 由根 sync:workspace-policy 从原生声明派生，请修改其事实源后显式同步。
export const dependencyCatalogSnapshot: Readonly<Record<string, string>> = ${JSON.stringify(workspace.catalog, null, 2)};

export const resourceIgnoreSnapshot = ${JSON.stringify(ignore)};

export const workspaceInstallPolicySnapshot = ${JSON.stringify(installPolicy, null, 2)};

export const generatedJsonPrintWidth = ${formatterConfig.printWidth};
`;
const formatted = await format(
  "workspace-policy-snapshot.ts",
  raw,
  formatterConfig,
);
if (formatted.errors.length > 0) {
  throw new Error("无法格式化工作区政策发布快照。");
}
const content = formatted.code;
const destination = new URL(
  "packages/core/src/workspace-policy-snapshot.ts",
  root,
);
const current = await readFile(destination, "utf8").catch(() => undefined);
if (process.argv.includes("--check")) {
  if (current !== content) {
    throw new Error(
      `${fileURLToPath(destination)} 与根声明不一致，请执行 pnpm run sync。`,
    );
  }
} else if (current !== content) {
  await writeFile(destination, content);
}
