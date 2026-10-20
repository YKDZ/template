import path from "node:path";

import { templateContent } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

function requireReference(packageName: string) {
  const member = templateContent.find(
    (candidate) =>
      candidate.kind === "reference" &&
      candidate.identity.packageName === packageName,
  );
  if (member === undefined || member.kind !== "reference") {
    throw new Error(`唯一内容集合缺少参考包 ${packageName}`);
  }
  return member;
}

const targetRoot = process.argv[2];
if (targetRoot === undefined) {
  throw new Error("必须提供直接参考项目目录");
}

const library = requireReference("@ykdz/reference-ts-lib");
const configuration = requireReference("@ykdz/reference-typescript-config");
const generator = createGenerator({
  content: templateContent,
  strategy: createDefaultWorkspaceStrategy(),
});
const result = await generator.init({
  targetRoot: path.resolve(targetRoot),
  selection: {
    roots: [
      { nodeIdentity: "library", contentIdentity: library.identity },
      {
        nodeIdentity: "typescript-configuration",
        contentIdentity: configuration.identity,
      },
    ],
  },
  strategyInput: {
    repositoryName: "direct-references",
    defaultPackageScope: "acme",
    todo: false,
  },
});

if (result.status !== "success") {
  throw new Error(`直接参考初始化失败：${JSON.stringify(result)}`);
}
