import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  prepareGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryPackageAddition,
  type GeneratedRepositoryPlan,
  type InitializationIdentityOverrides,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";

import {
  validateGeneratedDevelopmentContainerProjection,
  validatePlanDependencyCatalog,
  validatePlanSources,
  type GeneratedScenario,
} from "../src/registry-checks.ts";

/** 轻检查与真实消费共同使用正式初始化、加包和链接链路。 */
export async function materializeGeneratedScenario(options: {
  readonly scenario: GeneratedScenario;
  readonly workspace: string;
  readonly initializationOverrides?: InitializationIdentityOverrides;
  readonly additionIdentity?: { readonly name: string; readonly path?: string };
  readonly afterInitialization?: (
    plan: GeneratedRepositoryPlan,
    projectDir: string,
  ) => Promise<void>;
  readonly cancelSignal?: AbortSignal;
}): Promise<{
  readonly projectDir: string;
  readonly plan: GeneratedRepositoryPlan;
  readonly initialPlan: GeneratedRepositoryPlan;
}> {
  const { scenario } = options;
  const projectDir = path.join(options.workspace, scenario.id);
  options.cancelSignal?.throwIfAborted();
  const initialization = prepareGeneratedRepositoryInitialization({
    definition: scenario.base,
    targetDir: projectDir,
    overrides: { scope: "fixture", ...options.initializationOverrides },
  });
  if (initialization.status !== "ready")
    throw new Error(
      `${scenario.id}: 初始化未取得正式计划：${JSON.stringify(initialization)}`,
    );
  await validatePlanSources({
    definition: scenario.base,
    plan: initialization.plan,
  });
  await validatePlanDependencyCatalog(initialization.plan);
  await renderNewProject({
    targetRoot: projectDir,
    operations: [...initialization.plan.operations],
  });
  await options.afterInitialization?.(initialization.plan, projectDir);
  options.cancelSignal?.throwIfAborted();
  let plan = initialization.plan;
  if (scenario.addition !== undefined) {
    const preparation = prepareGeneratedRepositoryPackageAddition({
      repositoryRoot: projectDir,
      preset: scenario.addition.metadata.name,
      packageLeafName:
        options.additionIdentity?.name ??
        `fixture-${scenario.addition.metadata.name}`,
      ...(options.additionIdentity?.path === undefined
        ? {}
        : { packagePath: options.additionIdentity.path }),
      ...(scenario.linkFrom === undefined
        ? {}
        : {
            linkFrom:
              options.initializationOverrides?.path === undefined
                ? scenario.linkFrom
                : [
                    initialization.plan.packageContributions[0]!.definition
                      .path,
                  ],
          }),
    });
    if (preparation.status !== "ready")
      throw new Error(
        `${scenario.id}: 加包未取得正式计划：${JSON.stringify(preparation)}`,
      );
    plan = preparation.plan;
    await validatePlanSources({ definition: scenario.addition, plan });
    await validatePlanDependencyCatalog(plan);
    const result = await reconcileAndApplyProjectProjections({
      targetRoot: projectDir,
      ...preparation.plan.projectProjections,
    });
    if (!result.ok)
      throw new Error(
        `${scenario.id}: 加包协调冲突：${JSON.stringify(result.conflicts)}`,
      );
  }
  await assertGeneratedManifestPublicationPolicy({ projectDir, plan });
  await validateGeneratedDevelopmentContainerProjection({ projectDir, plan });
  return { projectDir, plan, initialPlan: initialization.plan };
}

export async function assertGeneratedManifestPublicationPolicy(options: {
  readonly plan: GeneratedRepositoryPlan;
  readonly projectDir: string;
}): Promise<void> {
  const policies = [
    { path: "package.json", private: true },
    ...options.plan.blueprint.packages.map((definition) => ({
      path: `${definition.path}/package.json`,
      private:
        options.plan.manifests.find(
          (manifest) => manifest.name === definition.name,
        )?.private === true,
    })),
  ];
  for (const policy of policies) {
    const manifest = JSON.parse(
      await readFile(path.join(options.projectDir, policy.path), "utf8"),
    );
    if (policy.private && manifest.private !== true)
      throw new Error(
        `Generated Repository Node manifest ${policy.path} must remain private`,
      );
    if (
      manifest.private !== true &&
      (typeof manifest.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(manifest.version))
    )
      throw new Error(
        `Generated Repository public Node manifest ${policy.path} must declare an exact version`,
      );
  }
}
