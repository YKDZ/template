import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const targetRoot = process.argv[2];
const mode = process.argv[3];
const packedBin = process.argv[4];
if (targetRoot === undefined || mode === undefined) {
  throw new Error("必须提供直接参考项目目录");
}

let packedRequire: NodeJS.Require | undefined;
if (mode === "packed") {
  if (packedBin === undefined) {
    throw new Error("packed 直接参考初始化必须使用已安装 CLI 入口");
  }
  packedRequire = createRequire(await realpath(packedBin));
}

async function loadPublicModule(specifier: string): Promise<{
  readonly module: Record<string, unknown>;
  readonly entry: string;
}> {
  if (packedRequire !== undefined) {
    const entry = await realpath(packedRequire.resolve(specifier));
    return {
      module: (await import(pathToFileURL(entry).href)) as Record<
        string,
        unknown
      >,
      entry,
    };
  }
  const resolvedUrl = import.meta.resolve(specifier);
  return {
    module: (await import(resolvedUrl)) as Record<string, unknown>,
    entry: fileURLToPath(resolvedUrl),
  };
}

const contentEntry = await loadPublicModule("@ykdz/template-content");
const contentModule =
  contentEntry.module as typeof import("@ykdz/template-content");
const { templateContent } = contentModule;
const library = templateContent.find(
  (member) => member.identity.packageName === "@ykdz/reference-ts-lib",
);
const configuration = templateContent.find(
  (member) => member.identity.packageName === "@ykdz/reference-tooling-config",
);
if (library?.kind !== "reference" || configuration?.kind !== "reference") {
  throw new Error("唯一内容集合缺少直接参考初始化所需的参考包");
}
const generator = contentModule.createGenerator();
const result = await generator.init({
  targetRoot: path.resolve(targetRoot),
  selection: {
    roots: [
      {
        nodeIdentity: "library",
        contentIdentity: library.identity,
      },
      {
        nodeIdentity: "tooling-configuration",
        contentIdentity: configuration.identity,
      },
    ],
  },
  conventions: {
    repositoryName: "direct-references",
    defaultPackageScope: "acme",
    todo: false,
  },
});

if (result.status !== "success") {
  throw new Error(`直接参考初始化失败：${JSON.stringify(result)}`);
}

console.log(
  JSON.stringify({
    mode,
    modules: {
      content: contentEntry.entry,
    },
  }),
);
