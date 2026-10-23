import {
  createGenerator as createContentGenerator,
  deriveTemplateMembers,
  templateContent,
} from "@ykdz/template-content";
import { createContentIndex } from "@ykdz/template-core/content-identity";

export type CliPreset = Extract<
  (typeof templateContent)[number],
  { kind: "preset" }
>;

const templateMembers = deriveTemplateMembers(templateContent);
export const cliPresets: readonly CliPreset[] = templateMembers.presets;
const presetIndex = createContentIndex(cliPresets);

export function presetByAlias(alias: string): CliPreset | undefined {
  if (!cliPresets.some((preset) => preset.alias === alias)) return undefined;
  return presetIndex.resolve(alias, "preset");
}

/** 命令和检查共享内容包公开的唯一默认生成器。 */
export const cliGenerator = createContentGenerator();
