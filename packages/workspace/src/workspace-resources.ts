import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTemplateSourceHandle,
  type CopyFileOperation,
} from "@ykdz/template-core/renderer";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

const resourcePath = (file: string): string =>
  path.resolve(workspaceRoot, file);

function requireResourceFile(file: string): string {
  const resolved = resourcePath(file);
  try {
    if (!statSync(resolved).isFile()) {
      throw new Error("资源路径不是文件");
    }
  } catch (error) {
    throw new Error(`工作区资源准备阶段缺少文件：${file}`, { cause: error });
  }
  return resolved;
}

function requireResourceDirectory(directory: string): string {
  const resolved = resourcePath(directory);
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new Error("资源路径不是目录");
    }
  } catch (error) {
    throw new Error(`工作区资源准备阶段缺少目录：${directory}`, {
      cause: error,
    });
  }
  return resolved;
}

export function readWorkspaceJson(file: string): Record<string, unknown> {
  const asset = `assets/${file}`;
  try {
    return JSON.parse(
      readFileSync(requireResourceFile(asset), "utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`工作区模板准备阶段无法读取 ${asset}`, { cause: error });
  }
}

export function copyWorkspaceResource(
  file: string,
  to: string,
): CopyFileOperation {
  return {
    kind: "copyFile",
    source: createTemplateSourceHandle(requireResourceFile(file)),
    from: ".",
    to,
  };
}

/** 按公开目录自然发现资源，特殊输出位置由能力所有者明确投影。 */
export function copyWorkspaceDirectory(
  directory: string,
  target: string,
): CopyFileOperation[] {
  try {
    return readdirSync(requireResourceDirectory(directory), {
      withFileTypes: true,
    })
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const file = path.posix.join(directory, entry.name);
        const to = path.posix.join(target, entry.name);
        return entry.isDirectory()
          ? copyWorkspaceDirectory(file, to)
          : [copyWorkspaceResource(file, to)];
      });
  } catch (error) {
    throw new Error(`工作区模板准备阶段无法枚举 ${directory}`, {
      cause: error,
    });
  }
}
