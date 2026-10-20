import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTemplateSourceHandle,
  type CopyFileOperation,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

const resourcePath = (file: string): string =>
  path.resolve(workspaceRoot, file);

export function readWorkspaceJson(file: string): Record<string, unknown> {
  const asset = `assets/${file}`;
  try {
    return JSON.parse(readFileSync(resourcePath(asset), "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(`工作区模板准备阶段无法读取 ${asset}`, { cause: error });
  }
}

export type PreparedWorkspaceResource = {
  /** 仅供工作区 owner 识别已准备的公开资源，不含物理路径。 */
  readonly path: string;
  readonly source: TemplateSourceHandle;
  readonly from: string;
  readonly mode: number;
};

export type PreparedWorkspaceResources = ReadonlyMap<
  string,
  PreparedWorkspaceResource | undefined
>;

/** 工作区 owner 在准备阶段检查一组有限资源；缺失项由实际投影能力判定。 */
export function prepareWorkspaceResources(
  files: readonly string[],
  owner: string,
  required: readonly string[] = [],
): PreparedWorkspaceResources {
  const requiredFiles = new Set(required);
  const resources = new Map<string, PreparedWorkspaceResource | undefined>();
  for (const file of files) {
    const resolved = resourcePath(file);
    let resource: PreparedWorkspaceResource | undefined;
    try {
      const metadata = statSync(resolved);
      if (metadata.isFile()) {
        resource = {
          path: file,
          source: createTemplateSourceHandle(workspaceRoot),
          from: file,
          mode: metadata.mode & 0o777,
        };
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`${owner} prepare 阶段无法检查工作区资源：${file}`, {
          cause,
        });
      }
    }
    if (resource === undefined && requiredFiles.has(file)) {
      throw new Error(`${owner} prepare 阶段缺少工作区资源：${file}`);
    }
    resources.set(file, resource);
  }
  return resources;
}

/** 只从准备事实构造 renderer 操作，不查询文件系统。 */
export function copyPreparedWorkspaceResource(
  resources: PreparedWorkspaceResources,
  file: string,
  to: string,
  owner: string,
): CopyFileOperation {
  const resource = resources.get(file);
  if (resource === undefined) {
    throw new Error(`${owner} prepare 阶段缺少工作区资源：${file}`);
  }
  return {
    kind: "copyFile",
    source: resource.source,
    from: resource.from,
    to,
  };
}

export type PreparedWorkspaceRootTemplates = {
  readonly turbo: Readonly<Record<string, unknown>>;
  readonly tsconfig: Readonly<Record<string, unknown>>;
  readonly tsconfigConfig: Readonly<Record<string, unknown>>;
};

/** 工作区拥有者在策略准备阶段读取根模板，投影只消费解析后的对象。 */
export function prepareWorkspaceRootTemplates(): PreparedWorkspaceRootTemplates {
  return {
    turbo: readWorkspaceJson("turbo.json"),
    tsconfig: readWorkspaceJson("tsconfig.json"),
    tsconfigConfig: readWorkspaceJson("tsconfig.config.json"),
  };
}
