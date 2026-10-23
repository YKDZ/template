import { projectTomlStringValues } from "@ykdz/template-core/toml";
import { parse } from "smol-toml";

export type RustToolchainRequirement = {
  readonly toolchain: string;
  readonly components: readonly string[];
  readonly configurationText: string;
};

export type PreparedRustToolchainDeclaration = {
  readonly channel: string;
  readonly components: readonly string[];
  readonly declaration: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从已准备的声明文本提取 Rust channel 与组件事实。 */
export function parseRustToolchainDeclaration(
  declaration: string,
): PreparedRustToolchainDeclaration {
  let parsed: unknown;
  try {
    parsed = parse(declaration);
  } catch (error) {
    throw new Error(
      `Rust 工具链声明不是有效 TOML：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const toolchain = isRecord(parsed) ? parsed.toolchain : undefined;
  const channel = isRecord(toolchain) ? toolchain.channel : undefined;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new Error("Rust 工具链声明的 [toolchain].channel 必须是非空字符串");
  }
  const components = isRecord(toolchain) ? toolchain.components : undefined;
  if (
    components !== undefined &&
    (!Array.isArray(components) ||
      !components.every((component) => typeof component === "string"))
  ) {
    throw new Error(
      "Rust 工具链声明的 [toolchain].components 必须是字符串数组",
    );
  }
  return {
    channel,
    components: components ?? [],
    declaration,
  };
}

/** 合并 Rust 内容声明的工具链要求；版本、组件和配置文本都须兼容。 */
export function resolveRustToolchainRequirements(
  requirements: readonly RustToolchainRequirement[],
): RustToolchainRequirement | undefined {
  if (requirements.length === 0) return undefined;
  const fingerprints = requirements.map((requirement) => {
    parseRustToolchainDeclaration(requirement.configurationText);
    return JSON.stringify({
      toolchain: requirement.toolchain,
      components: [...new Set(requirement.components)].toSorted(),
      configurationText: requirement.configurationText,
    });
  });
  if (new Set(fingerprints).size > 1) {
    throw new Error("工作区要求所有 Rust 工具链声明相互兼容");
  }
  return requirements[0];
}

/** 投影根声明；加包时保留已校验的用户声明原始字节。 */
export function projectRustToolchainDeclaration(options: {
  readonly requirement: RustToolchainRequirement;
  readonly existingDeclaration?: string;
}): string {
  if (options.existingDeclaration !== undefined) {
    const existing = parseRustToolchainDeclaration(options.existingDeclaration);
    if (existing.channel !== options.requirement.toolchain) {
      throw new Error("现有根 Rust channel 与共同工具链输入不一致");
    }
    return options.existingDeclaration;
  }
  return projectTomlStringValues(options.requirement.configurationText, [
    { path: ["toolchain", "channel"], value: options.requirement.toolchain },
  ]);
}
