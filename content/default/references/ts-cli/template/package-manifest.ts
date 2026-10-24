function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按目标命令名和工作区 Node 大版本转换 CLI 清单。 */
export function projectCliPackageManifest(options: {
  readonly manifest: unknown;
  readonly commandName: string;
  readonly nodeDeclaration: string;
}): Readonly<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(options.commandName)) {
    throw new Error("CLI 命令名必须使用小写 ASCII 字母、数字及单个连字符。");
  }
  if (!isRecord(options.manifest)) {
    throw new Error("CLI 包清单必须是对象。");
  }
  const bin = options.manifest.bin;
  if (!isRecord(bin)) {
    throw new Error("CLI 包清单必须声明唯一命令入口。");
  }
  const entries = Object.entries(bin);
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    typeof entry[1] !== "string"
  ) {
    throw new Error("CLI 包清单必须声明唯一命令入口。");
  }
  return {
    ...options.manifest,
    bin: { [options.commandName]: entry[1] },
    engines: { node: `>=${options.nodeDeclaration.split(".", 1)[0]}` },
  };
}
