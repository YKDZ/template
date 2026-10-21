import type { WorkspaceProjectRequirements } from "./application-requirements.ts";
import type { DeploymentCheckRequirement } from "./project-requirements.ts";
import type { RootResourceOperation } from "./shared-root-files.ts";
import {
  copyPreparedWorkspaceResource,
  prepareWorkspaceResources,
  type PreparedWorkspaceResources,
} from "./workspace-resources.ts";

const workspaceProjectOwner =
  "工作区共同项目能力 @ykdz/template-workspace#./project-resources";

const workspaceProjectFiles = [
  "resources/deployment/Dockerfile",
  "resources/deployment/container.dockerignore",
  "resources/deployment/scripts/check-standalone-deployment.ts",
  "resources/deployment/scripts/container-entrypoint.sh",
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

function projectDeploymentResources(
  requirement: DeploymentCheckRequirement,
  resources: PreparedWorkspaceResources,
): readonly RootResourceOperation[] {
  return [
    copy(resources, "resources/deployment/Dockerfile", "Dockerfile"),
    copy(
      resources,
      "resources/deployment/container.dockerignore",
      ".dockerignore",
    ),
    copy(
      resources,
      "resources/deployment/scripts/check-standalone-deployment.ts",
      "scripts/check-standalone-deployment.ts",
    ),
    copy(
      resources,
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
  ];
}

/** 工作区策略准备保留的部署资源。 */
export function projectWorkspaceProjectResources(options: {
  readonly requirements: WorkspaceProjectRequirements;
  readonly resources: PreparedWorkspaceResources;
}): readonly RootResourceOperation[] {
  return [
    ...(options.requirements.deploymentCheck === undefined
      ? []
      : projectDeploymentResources(
          options.requirements.deploymentCheck,
          options.resources,
        )),
  ];
}
