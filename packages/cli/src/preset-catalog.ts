import { deriveTemplateMembers, templateContent } from "@ykdz/template-content";
import { createContentIndex } from "@ykdz/template-core/content-identity";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

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

/** 命令和检查共享同一正式内容集合对应的默认生成器。 */
export const cliGenerator = createDefaultGenerator({
  content: templateContent,
});
