import { deriveTemplateMembers, templateContent } from "@ykdz/template-content";
import { createContentIndex } from "@ykdz/template-core/content-identity";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import { createGenerator } from "@ykdz/template-generator";
import {
  createDefaultWorkspaceStrategy,
  type DefaultWorkspaceCreationInput,
} from "@ykdz/template-workspace/default-workspace-strategy";

export type CliPreset = Extract<
  (typeof templateContent)[number],
  { kind: "preset" }
>;

export const cliPresets: readonly CliPreset[] =
  deriveTemplateMembers(templateContent).presets;
const presetIndex = createContentIndex(cliPresets);

export function presetByAlias(alias: string): CliPreset | undefined {
  if (!cliPresets.some((preset) => preset.alias === alias)) return undefined;
  return presetIndex.resolve(alias, "preset");
}

export const cliWorkspaceStrategy =
  createDefaultWorkspaceStrategy<
    DefaultWorkspaceCreationInput<
      PackageCreationInput<"private" | "public-candidate">
    >
  >();

export const cliGenerator = createGenerator({
  content: templateContent,
  strategy: cliWorkspaceStrategy,
});
