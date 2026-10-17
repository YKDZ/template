import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTemplateSourceHandle,
  type CopyFileOperation,
} from "@ykdz/template-core/renderer";

const resourcePath = (file: string): string =>
  fileURLToPath(import.meta.resolve(`@ykdz/template-workspace/assets/${file}`));

export function readWorkspaceJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resourcePath(file), "utf8")) as Record<
    string,
    unknown
  >;
}

export function copyWorkspaceResource(
  file: string,
  to: string,
): CopyFileOperation {
  return {
    kind: "copyFile",
    source: createTemplateSourceHandle(resourcePath(file)),
    from: ".",
    to,
  };
}

/** 按公开目录自然发现资源，特殊输出位置由能力所有者明确投影。 */
export function copyWorkspaceDirectory(
  directory: string,
  target: string,
): CopyFileOperation[] {
  return readdirSync(resourcePath(directory), { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.posix.join(directory, entry.name);
      const to = path.posix.join(target, entry.name);
      return entry.isDirectory()
        ? copyWorkspaceDirectory(file, to)
        : [copyWorkspaceResource(file, to)];
    });
}
