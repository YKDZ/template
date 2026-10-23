import { projectPublicationWorkspace } from "@ykdz/reference-npm-publication/template";
import { deriveTemplateMembers, templateContent } from "@ykdz/template-content";
import {
  contentIdentityKey,
  createContentIndex,
} from "@ykdz/template-core/content-identity";
import type { GeneratorSelectionRoot } from "@ykdz/template-core/workspace-strategy";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import type { GeneratorPackageState } from "@ykdz/template-core/workspace-strategy";
import { createGenerator } from "@ykdz/template-generator";
import {
  createDefaultWorkspaceStrategy,
  selectedWorkspaceConfigurationIdentity,
  type DefaultWorkspaceCreationInput,
} from "@ykdz/template-workspace/default-workspace-strategy";

export type CliPreset = Extract<
  (typeof templateContent)[number],
  { kind: "preset" }
>;

const templateMembers = deriveTemplateMembers(templateContent);
export const cliPresets: readonly CliPreset[] = templateMembers.presets;
const presetIndex = createContentIndex(cliPresets);
const referencePackages = templateMembers.referencePackages;
const referenceIndex = createContentIndex(referencePackages);

/** CLI 外层按已持久参考声明装配原生发布根贡献。 */
function projectSelectedPublicationWorkspace(options: {
  readonly packages: readonly GeneratorPackageState[];
}) {
  return projectPublicationWorkspace({
    references: options.packages.map(
      (record) =>
        referenceIndex.resolve(record.contentIdentity, "reference").definition,
    ),
  });
}

export function presetByAlias(alias: string): CliPreset | undefined {
  if (!cliPresets.some((preset) => preset.alias === alias)) return undefined;
  return presetIndex.resolve(alias, "preset");
}

/** 沿实际选中包的目标依赖图取得配置拥有者公开的默认身份。 */
export function workspaceConfigurationIdentityForPreset(
  preset: CliPreset,
  scope: string,
): ReturnType<typeof selectedWorkspaceConfigurationIdentity> {
  const selection = Object.entries(preset.definition.nodes).map(
    ([nodeIdentity, node]): GeneratorSelectionRoot => ({
      nodeIdentity,
      ...(node.layout === undefined ? {} : { layout: node.layout }),
      configuration: node.configuration?.init,
      ...(node.creationInput?.init === undefined
        ? {}
        : { creationInput: node.creationInput.init }),
      contentIdentity: referenceIndex.resolve(
        { alias: node.reference.alias, namespace: preset.identity.namespace },
        "reference",
      ).identity,
    }),
  );
  const contentByIdentity = new Map(
    referencePackages.map((member) => [
      contentIdentityKey(member.identity),
      member,
    ]),
  );
  return selectedWorkspaceConfigurationIdentity({
    selection,
    contentByIdentity,
    scope,
  });
}

export const cliWorkspaceStrategy = createDefaultWorkspaceStrategy<
  DefaultWorkspaceCreationInput<PackageCreationInput>
>({ project: projectSelectedPublicationWorkspace });

export const cliGenerator = createGenerator({
  content: templateContent,
  strategy: cliWorkspaceStrategy,
});
