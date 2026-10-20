import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

export const rootRustDeclarationFileName = "rust-toolchain.toml";
const rootRustToolchainChannelField = "[toolchain].channel";

export class RustToolchainDeclarationFailure extends Error {
  readonly field = rootRustToolchainChannelField;
  readonly suggestion: string;

  constructor(
    requirement: string,
    actualDeclaration: string,
    suggestion: string,
  ) {
    super(
      `加包需要目标仓库根 ${rootRustDeclarationFileName} 的 ${rootRustToolchainChannelField} ${requirement}，实际收到 ${actualDeclaration}。${suggestion}`,
    );
    this.suggestion = suggestion;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 已有 Rust 仓库的加包版本由根 rust-toolchain.toml 当前 channel 拥有。 */
export function readRootRustToolchainChannel(repositoryRoot: string): string {
  const filePath = path.join(repositoryRoot, rootRustDeclarationFileName);
  if (!existsSync(filePath)) {
    throw new RustToolchainDeclarationFailure(
      "存在",
      "文件不存在",
      `请先创建根 ${rootRustDeclarationFileName}，在 [toolchain] 表内声明 channel 再加包。`,
    );
  }
  let declaration: unknown;
  try {
    declaration = parseToml(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new RustToolchainDeclarationFailure(
      "是有效 TOML 声明",
      `无法解析：${error instanceof Error ? error.message : String(error)}`,
      `请先修正根 ${rootRustDeclarationFileName} 的 TOML 语法，使 [toolchain] 表内声明 channel 再加包。`,
    );
  }
  const toolchain = isRecord(declaration) ? declaration.toolchain : undefined;
  const channel = isRecord(toolchain) ? toolchain.channel : undefined;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new RustToolchainDeclarationFailure(
      "为非空字符串",
      JSON.stringify(channel ?? null),
      `请先在根 ${rootRustDeclarationFileName} 的 [toolchain] 表内写入 channel 再加包。`,
    );
  }
  return channel;
}

export type RustToolchainChannelReading =
  | { readonly channel: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "unreadable" };

/** 从模板投影的 Rust 声明结构化读取根 channel，供工具链镜像校验共用。 */
export function readRustToolchainChannelFromToml(
  contents: string,
): RustToolchainChannelReading {
  let declaration: unknown;
  try {
    declaration = parseToml(contents);
  } catch (error) {
    return {
      reason: `不是有效 TOML 声明：${error instanceof Error ? error.message : String(error)}`,
      status: "unreadable",
    };
  }
  const toolchain = isRecord(declaration) ? declaration.toolchain : undefined;
  const channel = isRecord(toolchain) ? toolchain.channel : undefined;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    return {
      reason: `[toolchain].channel 必须是非空字符串，实际为 ${JSON.stringify(channel ?? null)}`,
      status: "unreadable",
    };
  }
  return { channel, status: "explained" };
}
