import { readFileSync } from "node:fs";
import path from "node:path";

import type { CiDiagnosticArtifactDeclaration } from "./ci-diagnostic-artifact.ts";
import type { PackageContribution } from "./package-contribution.ts";
import type {
  DatabasePreparationRequirement,
  DeploymentCheckRequirement,
  VueHonoJointE2eRequirement,
} from "./project-requirements.ts";
import type { DependencyMaintenancePolicy } from "./project-requirements.ts";

type DependencyMaintenanceContribution = {
  readonly foundation: {
    readonly dependencyMaintenance: DependencyMaintenancePolicy;
  };
};

export type WorkspaceProjectRequirements = {
  readonly vueHonoJointE2e?: VueHonoJointE2eRequirement;
  readonly databasePreparation?: DatabasePreparationRequirement;
  readonly deploymentCheck?: DeploymentCheckRequirement;
};

export type { DependencyMaintenancePolicy };

/** 联合浏览器测试位于根工作区，因此根 typecheck 必须覆盖其源码。 */
export function applicationRootTsconfigIncludes(
  requirements: WorkspaceProjectRequirements,
): readonly string[] {
  return requirements.vueHonoJointE2e === undefined ? [] : ["test/**/*.ts"];
}

/** 根工作区联合 Playwright 失败时，需要收集根目录诊断材料。 */
export function applicationCiDiagnosticArtifacts(
  requirements: WorkspaceProjectRequirements,
): readonly CiDiagnosticArtifactDeclaration[] {
  return requirements.vueHonoJointE2e === undefined
    ? []
    : [
        {
          kind: "playwright",
          owner: { kind: "workspace-orchestration", path: "." },
        },
      ];
}

/** 合并包的维护声明，并为部署 Dockerfile 保留根目录 Dependabot 覆盖。 */
export function projectDependencyMaintenancePolicy(options: {
  readonly contributions: readonly DependencyMaintenanceContribution[];
  readonly hasDeployment: boolean;
}): DependencyMaintenancePolicy {
  const ecosystems: DependencyMaintenancePolicy["ecosystems"] = [
    ...new Set([
      "devcontainers" as const,
      ...options.contributions.flatMap(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.ecosystems,
      ),
      ...(options.hasDeployment ? (["docker"] as const) : []),
    ]),
  ];
  const directories: NonNullable<DependencyMaintenancePolicy["directories"]> =
    {};
  const extraDirectories: NonNullable<
    DependencyMaintenancePolicy["extraDirectories"]
  > = {};

  for (const ecosystem of ecosystems) {
    const candidates = [
      ...new Set([
        ...(ecosystem === "docker" ? (["/.devcontainer"] as const) : []),
        ...options.contributions.flatMap((contribution) => {
          const policy = contribution.foundation.dependencyMaintenance;
          const primary = policy.directories?.[ecosystem];
          return [
            ...(primary === undefined ? [] : [primary]),
            ...(policy.extraDirectories?.[ecosystem] ?? []),
          ];
        }),
        ...(ecosystem === "docker" && options.hasDeployment
          ? (["/"] as const)
          : []),
      ]),
    ];
    const [primary, ...extra] = candidates;
    if (primary !== undefined) directories[ecosystem] = primary;
    if (extra.length > 0) extraDirectories[ecosystem] = extra;
  }

  return {
    ecosystems,
    ...(Object.keys(directories).length === 0 ? {} : { directories }),
    ...(Object.keys(extraDirectories).length === 0 ? {} : { extraDirectories }),
    interval: "weekly",
  };
}

export type DatabasePreparationManifestRequirement = {
  readonly databasePackageName: string;
  readonly migrationPackageName: string;
  readonly consumers: Readonly<
    Record<"application-dev" | "application-e2e", string>
  >;
};

type DatabasePreparationContribution = Pick<
  PackageContribution,
  "definition" | "manifest"
>;

function databasePreparationExpectedTasks(
  preparation: DatabasePreparationManifestRequirement,
): readonly (readonly [packageName: string, taskName: string])[] {
  return [
    [preparation.databasePackageName, "build"],
    [preparation.databasePackageName, "db:reset"],
    [preparation.databasePackageName, "db:seed:example"],
    [preparation.databasePackageName, "test"],
    [preparation.migrationPackageName, "db:push"],
    [preparation.migrationPackageName, "typecheck"],
    [preparation.consumers["application-dev"], "dev"],
    [preparation.consumers["application-dev"], "typecheck"],
    [preparation.consumers["application-e2e"], "build"],
    [preparation.consumers["application-e2e"], "test:e2e"],
  ];
}

function requireDatabasePreparationContribution(
  packageByName: ReadonlyMap<string, DatabasePreparationContribution>,
  packageName: string,
): DatabasePreparationContribution {
  const contribution = packageByName.get(packageName);
  if (contribution === undefined) {
    throw new Error(
      `Database Preparation references unknown Package ${packageName}`,
    );
  }
  return contribution;
}

/** 读取数据库协作所需包的当前 manifest，供加包前验证使用。 */
export function readDatabasePreparationManifestTruth(options: {
  readonly repositoryRoot: string;
  readonly preparation: DatabasePreparationManifestRequirement | undefined;
  readonly packageByName: ReadonlyMap<string, DatabasePreparationContribution>;
}): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const result = new Map<string, Readonly<Record<string, unknown>>>();
  if (options.preparation === undefined) return result;

  const packagePaths = new Set(
    databasePreparationExpectedTasks(options.preparation).map(
      ([packageName]) =>
        requireDatabasePreparationContribution(
          options.packageByName,
          packageName,
        ).definition.path,
    ),
  );
  for (const packagePath of packagePaths) {
    const expected = [...options.packageByName.values()].find(
      (contribution) => contribution.definition.path === packagePath,
    );
    if (expected === undefined) {
      throw new Error(
        `Database Preparation requires manifest truth for ${packagePath}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(
          path.join(options.repositoryRoot, packagePath, "package.json"),
          "utf8",
        ),
      ) as unknown;
    } catch (error) {
      throw new Error(
        `Package Addition requires manifest truth for ${packagePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).name !== expected.definition.name
    ) {
      throw new Error(
        `Package Addition requires manifest truth for ${packagePath}: expected name ${expected.definition.name}`,
      );
    }
    result.set(packagePath, parsed as Readonly<Record<string, unknown>>);
  }
  return result;
}

/** 保留数据库准备及迁移任务对其现行包 manifest 的精确依赖。 */
export function assertDatabasePreparationManifestTruth(options: {
  readonly preparation: DatabasePreparationManifestRequirement | undefined;
  readonly packageByName: ReadonlyMap<string, DatabasePreparationContribution>;
  readonly manifestTruthByPackagePath:
    | ReadonlyMap<string, Readonly<Record<string, unknown>>>
    | undefined;
}): void {
  const { preparation, packageByName, manifestTruthByPackagePath } = options;
  if (preparation === undefined || manifestTruthByPackagePath === undefined) {
    return;
  }
  for (const [packageName, taskName] of databasePreparationExpectedTasks(
    preparation,
  )) {
    const contribution = requireDatabasePreparationContribution(
      packageByName,
      packageName,
    );
    const manifest = manifestTruthByPackagePath.get(
      contribution.definition.path,
    );
    if (manifest === undefined) {
      throw new Error(
        `Database Preparation requires manifest truth for ${contribution.definition.path}`,
      );
    }
    const actualScripts = manifest.scripts;
    const expectedScripts = contribution.manifest.scripts;
    const actual =
      typeof actualScripts === "object" &&
      actualScripts !== null &&
      !Array.isArray(actualScripts)
        ? (actualScripts as Record<string, unknown>)[taskName]
        : undefined;
    const expected =
      typeof expectedScripts === "object" &&
      expectedScripts !== null &&
      !Array.isArray(expectedScripts)
        ? (expectedScripts as Record<string, unknown>)[taskName]
        : undefined;
    if (actual !== expected) {
      throw new Error(
        `Database Preparation requires exact ${packageName} script ${taskName}`,
      );
    }
  }
}
