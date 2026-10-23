import path from "node:path";

const templateSourceHandleBrand: unique symbol = Symbol("template-source");

/** 由资源所属者创建、不能从字符串伪造的模板来源引用。 */
export type TemplateSourceHandle = {
  readonly [templateSourceHandleBrand]: true;
};

const templateSourceRoots = new WeakMap<object, string>();

/** 将有限资源根绑定到不透明句柄。 */
export function createTemplateSourceHandle(root: string): TemplateSourceHandle {
  const handle = Object.freeze({
    [templateSourceHandleBrand]: true as const,
  });
  templateSourceRoots.set(handle, path.resolve(root));
  return handle;
}

/** 在来源根目录内解析相对资源路径。 */
export function resolveTemplateSource(
  source: TemplateSourceHandle,
  relativePath: string,
): string {
  const root =
    typeof source === "object" && source !== null
      ? templateSourceRoots.get(source)
      : undefined;
  if (root === undefined) {
    throw new Error("模板来源句柄无效");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`模板资源路径必须相对：${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const insideRoot =
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);

  if (!insideRoot) {
    throw new Error(`模板资源路径超出所属目录：${relativePath}`);
  }

  return resolvedPath;
}
