import type { RenderOperation } from "@ykdz/template-core/renderer";
import type {
  DeploymentCheckRequirement,
  VueHonoJointE2eRequirement,
} from "@ykdz/template-workspace-authoring/project-requirements";

import type { WorkspaceProjectRequirements } from "./application-requirements.ts";
import {
  copyWorkspaceDirectory,
  copyWorkspaceResource,
} from "./workspace-resources.ts";

function prepareOwnedProjectResources(
  capability: string,
  packageNames: readonly string[],
  prepare: () => readonly RenderOperation[],
): readonly RenderOperation[] {
  try {
    return prepare();
  } catch (cause) {
    const participants =
      packageNames.length === 0 ? "" : `（参与包：${packageNames.join("、")}）`;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${capability}${participants}资源准备阶段失败：${detail}`, {
      cause,
    });
  }
}

function projectVueHonoJointE2eResources(
  requirement: VueHonoJointE2eRequirement,
): readonly RenderOperation[] {
  return prepareOwnedProjectResources(
    "工作区共同 Vue-Hono 联合验收能力 @ykdz/template-workspace#./joint-e2e",
    [requirement.web.name, requirement.api.name],
    () => [
      copyWorkspaceResource(
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
      ...copyWorkspaceDirectory("resources/joint-e2e/test", "test"),
    ],
  );
}

function projectDeploymentResources(
  requirement: DeploymentCheckRequirement,
): readonly RenderOperation[] {
  return prepareOwnedProjectResources(
    "工作区共同部署能力 @ykdz/template-workspace#./deployment",
    [
      requirement.application.name,
      requirement.database.name,
      requirement.migrations.name,
    ],
    () => [
      copyWorkspaceResource("resources/deployment/Dockerfile", "Dockerfile"),
      copyWorkspaceResource(
        "resources/deployment/.dockerignore",
        ".dockerignore",
      ),
      copyWorkspaceResource(
        "resources/deployment/scripts/check-standalone-deployment.ts",
        "scripts/check-standalone-deployment.ts",
      ),
      copyWorkspaceResource(
        "resources/deployment/scripts/container-entrypoint.sh",
        "scripts/container-entrypoint.sh",
      ),
      {
        kind: "writeJson",
        to: "deployment.json",
        value: {
          application: {
            name: requirement.application.name,
            path: requirement.application.path,
          },
          database: {
            name: requirement.database.name,
            path: requirement.database.path,
          },
          migrations: {
            name: requirement.migrations.name,
            path: requirement.migrations.path,
          },
        },
      },
    ],
  );
}

/** 工作区所有者把有限的联合项目能力接到根资源上。 */
export function prepareWorkspaceProjectResources(
  requirements: WorkspaceProjectRequirements,
): readonly RenderOperation[] {
  return [
    ...(requirements.vueHonoJointE2e === undefined
      ? []
      : projectVueHonoJointE2eResources(requirements.vueHonoJointE2e)),
    ...(requirements.deploymentCheck === undefined
      ? []
      : projectDeploymentResources(requirements.deploymentCheck)),
  ];
}
