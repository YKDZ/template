import type { WorkspaceProjectRequirements } from "./application-requirements.ts";
import type { VueHonoJointE2eRequirement } from "./project-requirements.ts";
import type { RootResourceOperation } from "./shared-root-files.ts";
import {
  copyPreparedWorkspaceResource,
  prepareWorkspaceResources,
  type PreparedWorkspaceResources,
} from "./workspace-resources.ts";

const workspaceProjectOwner =
  "工作区共同项目能力 @ykdz/template-workspace#./project-resources";

const workspaceProjectFiles = [
  "resources/joint-e2e/playwright.config.ts",
  "resources/joint-e2e/test/e2e/app.spec.ts",
  "resources/joint-e2e/test/e2e/fixtures.ts",
] as const;

/** 工作区 owner 在既有生成准备入口检查共同项目能力的有限资源。 */
export function prepareWorkspaceProjectResources(): PreparedWorkspaceResources {
  return prepareWorkspaceResources(
    workspaceProjectFiles,
    workspaceProjectOwner,
  );
}

function copy(
  resources: PreparedWorkspaceResources,
  file: (typeof workspaceProjectFiles)[number],
  to: string,
): RootResourceOperation {
  return copyPreparedWorkspaceResource(
    resources,
    file,
    to,
    workspaceProjectOwner,
  );
}

function projectVueHonoJointE2eResources(
  requirement: VueHonoJointE2eRequirement,
  resources: PreparedWorkspaceResources,
): readonly RootResourceOperation[] {
  return [
    copy(
      resources,
      "resources/joint-e2e/playwright.config.ts",
      "playwright.config.ts",
    ),
    {
      kind: "writeJson",
      to: "joint-e2e.json",
      value: {
        apiPackageName: requirement.api.name,
        webPackageName: requirement.web.name,
      },
    },
    copy(
      resources,
      "resources/joint-e2e/test/e2e/app.spec.ts",
      "test/e2e/app.spec.ts",
    ),
    copy(
      resources,
      "resources/joint-e2e/test/e2e/fixtures.ts",
      "test/e2e/fixtures.ts",
    ),
  ];
}

/** 工作区所有者把有限的联合项目能力接到根资源上。 */
export function projectWorkspaceProjectResources(options: {
  readonly requirements: WorkspaceProjectRequirements;
  readonly resources: PreparedWorkspaceResources;
}): readonly RootResourceOperation[] {
  return [
    ...(options.requirements.vueHonoJointE2e === undefined
      ? []
      : projectVueHonoJointE2eResources(
          options.requirements.vueHonoJointE2e,
          options.resources,
        )),
  ];
}
