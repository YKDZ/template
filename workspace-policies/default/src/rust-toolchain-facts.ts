import { existsSync, readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import type { CurrentProjectProjectionEntry } from "@ykdz/template-core/project-projection";
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

/** 已有 Rust 仓库的加包版本和待保留字节均由根声明拥有。 */
export function readRootRustToolchainDeclaration(repositoryRoot: string): {
  readonly channel: string;
  readonly declaration: string;
} {
  const filePath = path.join(repositoryRoot, rootRustDeclarationFileName);
  if (!existsSync(filePath)) {
    throw new RustToolchainDeclarationFailure(
      "存在",
      "文件不存在",
      `请先创建根 ${rootRustDeclarationFileName}，在 [toolchain] 表内声明 channel 再加包。`,
    );
  }
  let declarationText: string;
  let declaration: unknown;
  try {
    declarationText = readFileSync(filePath, "utf8");
    declaration = parseToml(declarationText);
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
  return { channel, declaration: declarationText };
}

/** 已有 Rust 仓库的加包版本由根 rust-toolchain.toml 当前 channel 拥有。 */
export function readRootRustToolchainChannel(repositoryRoot: string): string {
  return readRootRustToolchainDeclaration(repositoryRoot).channel;
}

export type RustToolchainChannelReading =
  | { readonly channel: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "unreadable" };

export type PreparedRootRustToolchainTarget = {
  readonly target?: { readonly channel: string; readonly declaration: string };
  readonly readFact: CurrentProjectProjectionEntry;
};

/** 正式 add 准备读取一次根声明，并保留实际文件或缺失前提。 */
export async function prepareRootRustToolchainTarget(options: {
  readonly repositoryRoot: string;
  readonly required: boolean;
}): Promise<PreparedRootRustToolchainTarget> {
  const filePath = path.join(
    options.repositoryRoot,
    rootRustDeclarationFileName,
  );
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      if (options.required) {
        throw new RustToolchainDeclarationFailure(
          "存在",
          "文件不存在",
          `请先创建根 ${rootRustDeclarationFileName}，在 [toolchain] 表内声明 channel 再加包。`,
        );
      }
      return {
        readFact: { path: rootRustDeclarationFileName, kind: "missing" },
      };
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new RustToolchainDeclarationFailure(
      "是普通文件",
      "路径不是普通文件",
      `请先修正根 ${rootRustDeclarationFileName}，使其成为普通 TOML 文件。`,
    );
  }
  const bytes = new Uint8Array(await readFile(filePath));
  const declaration = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const reading = readRustToolchainChannelFromToml(declaration);
  if (reading.status !== "explained") {
    throw new RustToolchainDeclarationFailure(
      "是有效 TOML 声明",
      reading.reason,
      `请先修正根 ${rootRustDeclarationFileName}，在 [toolchain] 表内声明非空 channel 再加包。`,
    );
  }
  return {
    target: { channel: reading.channel, declaration },
    readFact: {
      path: rootRustDeclarationFileName,
      kind: "file",
      content: bytes,
      mode: stat.mode & 0o111,
    },
  };
}

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
