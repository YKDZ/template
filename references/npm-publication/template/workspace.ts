import type { GeneratorPackageState } from "@ykdz/template-core/workspace-strategy";
import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";
import type { SharedRootContribution } from "@ykdz/template-workspace/shared-root-files";

import { isPublicationEnabled } from "./target.ts";

/** 发布拥有者从现行实例和实际绑定声明共享根内容。 */
export function projectPublicationWorkspace(options: {
  readonly packages: readonly GeneratorPackageState[];
  readonly contributions: readonly PackageContribution[];
}): readonly SharedRootContribution[] {
  const targets = options.packages.filter((record) =>
    isPublicationEnabled(record.configuration),
  );
  if (targets.length === 0) return [];
  const tools = new Map<string, string>();
  for (const target of targets) {
    const contribution = options.contributions.find(
      (item) => item.definition.path === target.definition.path,
    );
    const tool =
      contribution?.referenceBindings?.["@ykdz/reference-npm-publication"];
    if (tool === undefined || contribution?.manifest.private !== false)
      throw new Error(
        `发布目标 ${target.definition.name} 缺少生效的共享工具依赖。`,
      );
    tools.set(tool.path, tool.name);
  }
  if (tools.size !== 1)
    throw new Error("同一工作区的发布目标必须复用一个真实共享工具实例。");
  const toolName = [...tools.values()][0]!;
  return [
    {
      kind: "shared-root-files",
      source: "@ykdz/reference-npm-publication#./template",
      manifest: {
        devDependencies: { [toolName]: "workspace:*" },
        scripts: {
          "publication:artifact": `node --import ${toolName}/artifact`,
        },
      },
      turboTasks: {
        "//#publication:artifact": {
          tags: ["quality:conditional"],
          cache: false,
        },
      },
    },
  ];
}
