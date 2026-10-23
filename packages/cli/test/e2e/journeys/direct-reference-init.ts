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

const [contentEntry, generatorEntry, strategyEntry, publicationEntry] =
  await Promise.all([
    loadPublicModule("@ykdz/template-content"),
    loadPublicModule("@ykdz/template-generator"),
    loadPublicModule("@ykdz/template-workspace/default-workspace-strategy"),
    loadPublicModule("@ykdz/reference-npm-publication/template"),
  ]);
const templateContent = contentEntry.module.templateContent as readonly {
  readonly kind: string;
  readonly identity: {
    readonly namespace: string;
    readonly packageName: string;
    readonly exportPath: string;
  };
  readonly definition?: {
    readonly dependencyUses: readonly {
      readonly name: string;
      readonly purposes: readonly string[];
    }[];
  };
}[];
const projectPublicationWorkspace = publicationEntry.module
  .projectPublicationWorkspace as (
  options: Record<string, unknown>,
) => readonly unknown[];
const createGenerator = generatorEntry.module.createGenerator as (
  options: Record<string, unknown>,
) => {
  init(options: Record<string, unknown>): Promise<Record<string, unknown>>;
};
const createDefaultWorkspaceStrategy = strategyEntry.module
  .createDefaultWorkspaceStrategy as (
  options?: Record<string, unknown>,
) => unknown;
const projectSelectedPublicationWorkspace = (
  options: Record<string, unknown>,
) => {
  const packages = options.packages as readonly {
    readonly contentIdentity: {
      readonly namespace: string;
      readonly packageName: string;
      readonly exportPath: string;
    };
  }[];
  return projectPublicationWorkspace({
    references: packages.map((record) => {
      const reference = templateContent.find(
        (candidate) =>
          candidate.kind === "reference" &&
          candidate.identity.namespace === record.contentIdentity.namespace &&
          candidate.identity.packageName ===
            record.contentIdentity.packageName &&
          candidate.identity.exportPath === record.contentIdentity.exportPath,
      );
      if (reference?.definition === undefined) {
        throw new Error(
          `唯一内容集合缺少参考包 ${record.contentIdentity.packageName}`,
        );
      }
      return reference.definition;
    }),
  });
};
function requireReference(packageName: string) {
  const member = templateContent.find(
    (candidate) =>
      candidate.kind === "reference" &&
      candidate.identity.packageName === packageName,
  );
  if (member === undefined) {
    throw new Error(`唯一内容集合缺少参考包 ${packageName}`);
  }
  return member as {
    readonly identity: Record<string, unknown>;
  };
}

const library = requireReference("@ykdz/reference-ts-lib");
const configuration = requireReference("@ykdz/reference-tooling-config");
const generator = createGenerator({
  content: templateContent,
  strategy: createDefaultWorkspaceStrategy({
    project: projectSelectedPublicationWorkspace,
  }),
});
const result = await generator.init({
  targetRoot: path.resolve(targetRoot),
  selection: {
    roots: [
      { nodeIdentity: "library", contentIdentity: library.identity },
      {
        nodeIdentity: "tooling-configuration",
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

console.log(
  JSON.stringify({
    mode,
    modules: {
      content: contentEntry.entry,
      generator: generatorEntry.entry,
      strategy: strategyEntry.entry,
    },
  }),
);
