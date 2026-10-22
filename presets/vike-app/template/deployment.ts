import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import type { NativeContentArtifactResource } from "@ykdz/template-workspace-authoring/content-artifact";
import {
  dockerEngineEnvironmentNeed,
  shellCheckEnvironmentNeed,
  type CheckEnvironmentNeed,
  type DeploymentEnvironmentNeed,
} from "@ykdz/template-workspace/default-environment";
import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";
import type { DependencyMaintenancePolicy } from "@ykdz/template-workspace/project-requirements";
import type {
  RootResourceOperation,
  SharedRootContribution,
} from "@ykdz/template-workspace/shared-root-files";
import { parseDocument } from "yaml";

const deploymentDirectory = fileURLToPath(
  new URL("../resources/deployment/", import.meta.url),
);
const buildxStepPath = path.join(deploymentDirectory, "setup-buildx-step.yml");
const checkerPath = fileURLToPath(
  new URL("../scripts/check-standalone-deployment.ts", import.meta.url),
);
const checkerSource = readFileSync(checkerPath, "utf8");

function packageResource(
  resourcePath: string,
  filePath: string,
  mode = 0o644,
): NativeContentArtifactResource {
  return {
    path: resourcePath,
    source: createTemplateSourceHandle(filePath),
    mode,
  };
}

export const vikeDeploymentResources = [
  packageResource(
    "resources/deployment/Dockerfile",
    path.join(deploymentDirectory, "Dockerfile"),
  ),
  packageResource(
    "resources/deployment/container.dockerignore",
    path.join(deploymentDirectory, "container.dockerignore"),
  ),
  packageResource(
    "resources/deployment/scripts/container-entrypoint.sh",
    path.join(deploymentDirectory, "scripts/container-entrypoint.sh"),
    0o755,
  ),
  packageResource("scripts/check-standalone-deployment.ts", checkerPath),
  packageResource("resources/deployment/setup-buildx-step.yml", buildxStepPath),
] as const satisfies readonly NativeContentArtifactResource[];

const rootFiles = {
  dockerfile: vikeDeploymentResources[0],
  dockerIgnore: vikeDeploymentResources[1],
  containerEntrypoint: vikeDeploymentResources[2],
} as const;

function readBuildxStep(): Readonly<Record<string, unknown>> & {
  readonly id: string;
} {
  const document = parseDocument(readFileSync(buildxStepPath, "utf8"));
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(
      `Vike 部署步骤 YAML 无效：${[...document.errors, ...document.warnings].map((error) => error.message).join("；")}`,
    );
  }
  const value = document.toJS();
  const id =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).id
      : undefined;
  if (
    id === undefined ||
    typeof id !== "string" ||
    document.get("uses", true) === undefined
  ) {
    throw new Error("Vike Docker Buildx 步骤资源必须是带 uses 的 YAML 对象。");
  }
  return {
    ...(value as Record<string, unknown>),
    id,
    uses: document.get("uses", true),
  };
}

// 装配时准备所属包的不可变原生资源；更新投影只复用事实，不再读盘。
const buildxStep = readBuildxStep();

function copyResource(
  resource: NativeContentArtifactResource,
  to: string,
): RootResourceOperation {
  return {
    kind: "copyFile",
    from: ".",
    to,
    source: resource.source,
    overwrite: true,
  };
}

function packageScript(
  profile: "dev" | "test" | "e2e",
  definition: PackageDefinition,
  script: string,
): string {
  return `DATABASE_PROFILE=${profile} pnpm --filter ${definition.name} run ${script}`;
}

function preparationScripts(options: {
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): Readonly<Record<string, string>> {
  const { application, database, migrations } = options;
  return {
    "database:prepare:dev": [
      packageScript("dev", migrations, "db:push"),
      packageScript("dev", database, "db:seed:example"),
    ].join(" && "),
    "database:prepare:test": [
      packageScript("test", database, "db:reset"),
      packageScript("test", migrations, "db:push"),
      packageScript("test", database, "db:seed:example"),
    ].join(" && "),
    "database:prepare:e2e": [
      packageScript("e2e", database, "db:reset"),
      packageScript("e2e", migrations, "db:push"),
      packageScript("e2e", database, "db:seed:example"),
    ].join(" && "),
    dev: `pnpm run database:prepare:dev && turbo watch dev --filter=${application.name}`,
  };
}

function requiredTaskScripts(options: {
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): readonly {
  readonly definition: PackageDefinition;
  readonly names: readonly string[];
}[] {
  return [
    {
      definition: options.database,
      names: ["build", "db:reset", "db:seed:example", "test"],
    },
    { definition: options.migrations, names: ["db:push", "typecheck"] },
    {
      definition: options.application,
      names: ["build", "dev", "typecheck", "test:e2e"],
    },
  ];
}

function packageManifest(
  targetRoot: string,
  definition: PackageDefinition,
  contribution: PackageContribution,
): Record<string, unknown> {
  const packageManifestPath = path.join(
    targetRoot,
    definition.path,
    "package.json",
  );

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packageManifestPath, "utf8")) as unknown;
  } catch (cause) {
    throw new Error(
      `Vike 预设无法读取 ${definition.path}/package.json：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).name !== definition.name
  ) {
    throw new Error(
      `Vike 预设的实际包身份与实例不匹配：${definition.name} (${definition.path})`,
    );
  }
  const expected = contribution.manifest;
  if (expected.name !== definition.name) {
    throw new Error(`Vike 预设来源包身份不匹配：${definition.name}`);
  }
  return value as Record<string, unknown>;
}

function scriptValue(manifest: Record<string, unknown>, name: string): unknown {
  const scripts = manifest.scripts;
  return typeof scripts === "object" &&
    scripts !== null &&
    !Array.isArray(scripts)
    ? (scripts as Record<string, unknown>)[name]
    : undefined;
}

type RequiredPackage = {
  readonly definition: PackageDefinition;
  readonly names: readonly string[];
};

function assertPackageDeclarations(options: {
  readonly contributions: readonly PackageContribution[];
  readonly packages: readonly RequiredPackage[];
}): ReadonlyMap<string, PackageContribution> {
  const sourceByPath = new Map(
    options.contributions.map((contribution) => [
      contribution.definition.path,
      contribution,
    ]),
  );
  for (const { definition, names } of options.packages) {
    const contribution = sourceByPath.get(definition.path);
    if (
      contribution === undefined ||
      contribution.definition.name !== definition.name ||
      contribution.manifest.name !== definition.name
    ) {
      throw new Error(
        `Vike 预设缺少实际包来源：${definition.name} (${definition.path})`,
      );
    }
    for (const name of names) {
      if (typeof scriptValue(contribution.manifest, name) !== "string") {
        throw new Error(
          `Vike 数据准备要求 ${definition.name} 的来源声明 scripts.${name}`,
        );
      }
    }
  }
  return sourceByPath;
}

/** 更新效果阶段保留数据库协作对当前包身份与任务命令的既有保证。 */
export function validateVikePackageTruth(options: {
  readonly targetRoot: string;
  readonly contributions: readonly PackageContribution[];
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): void {
  assertVikePackageRoles(options);
  const packages = requiredTaskScripts(options);
  const sourceByPath = assertPackageDeclarations({
    contributions: options.contributions,
    packages,
  });
  for (const { definition, names } of packages) {
    const contribution = sourceByPath.get(definition.path)!;
    const manifest = packageManifest(
      options.targetRoot,
      definition,
      contribution,
    );
    for (const name of names) {
      if (
        scriptValue(manifest, name) !== scriptValue(contribution.manifest, name)
      ) {
        throw new Error(
          `Vike 数据准备要求 ${definition.name} 的 scripts.${name} 与来源包保持一致`,
        );
      }
    }
  }
}

function assertVikePackageRoles(options: {
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): void {
  if (options.application.role !== "runtime-service") {
    throw new Error("Vike 应用部署要求应用包具有 runtime-service 角色");
  }
  if (
    options.database.role !== "shared-library" ||
    options.migrations.role !== "shared-library"
  ) {
    throw new Error("Vike 应用部署要求数据库和迁移包具有 shared-library 角色");
  }
  if (
    new Set([
      options.application.name,
      options.database.name,
      options.migrations.name,
    ]).size !== 3 ||
    new Set([
      options.application.path,
      options.database.path,
      options.migrations.path,
    ]).size !== 3
  ) {
    throw new Error("Vike 应用部署要求应用、数据库和迁移包是不同实例");
  }
}

function deploymentTask(
  application: PackageDefinition,
  database: PackageDefinition,
  migrations: PackageDefinition,
) {
  return {
    cache: false,
    dependsOn: [
      `${application.name}#build`,
      `${database.name}#build`,
      `${migrations.name}#build`,
    ],
    tags: ["quality:heavy"],
  };
}

export function projectVikeDeploymentContribution(options: {
  readonly contributions: readonly PackageContribution[];
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): SharedRootContribution {
  const { application, database, migrations } = options;
  assertVikePackageRoles({ application, database, migrations });
  assertPackageDeclarations({
    contributions: options.contributions,
    packages: requiredTaskScripts({ application, database, migrations }),
  });

  const checkEnvironmentNeeds: readonly CheckEnvironmentNeed[] = [
    shellCheckEnvironmentNeed({
      kind: "workspace-orchestration",
      path: ".",
    }),
  ];
  const deploymentEnvironmentNeeds: readonly DeploymentEnvironmentNeed[] = [
    dockerEngineEnvironmentNeed(),
  ];
  const dependencyMaintenance: DependencyMaintenancePolicy = {
    ecosystems: ["docker"],
    extraDirectories: { docker: ["/"] },
    interval: "weekly",
  };

  return {
    kind: "shared-root-files",
    source: "@ykdz/preset-vike-app/template",
    manifest: {
      scripts: {
        ...preparationScripts({ application, database, migrations }),
        deployment:
          "node --conditions=source scripts/check-standalone-deployment.ts",
      },
    },
    turboTasks: {
      "//#database:prepare:dev": {
        cache: false,
        tags: ["work:preparation"],
      },
      "//#database:prepare:e2e": {
        cache: false,
        tags: ["work:preparation"],
      },
      "//#database:prepare:test": {
        cache: false,
        tags: ["work:preparation"],
      },
      "//#deployment": deploymentTask(application, database, migrations),
    },
    ciJob: { name: "Full Check", timeoutMinutes: 45 },
    ciSteps: [
      {
        before: "run-heavy-check",
        steps: [buildxStep],
      },
    ],
    environmentNeeds: {
      check: checkEnvironmentNeeds,
      deployment: deploymentEnvironmentNeeds,
    },
    dependencyMaintenance,
    resources: [
      { operation: copyResource(rootFiles.dockerfile, "Dockerfile") },
      {
        operation: copyResource(rootFiles.dockerIgnore, ".dockerignore"),
      },
      {
        operation: {
          kind: "writeText",
          to: "scripts/check-standalone-deployment.ts",
          text: checkerSource
            .replaceAll(
              JSON.stringify("@ykdz/reference-vike-web"),
              JSON.stringify(application.name),
            )
            .replaceAll(
              JSON.stringify("references/vike-web"),
              JSON.stringify(application.path),
            )
            .replaceAll(
              JSON.stringify("@ykdz/reference-vike-db"),
              JSON.stringify(database.name),
            )
            .replaceAll(
              JSON.stringify("@ykdz/reference-vike-migrations"),
              JSON.stringify(migrations.name),
            ),
          overwrite: true,
        },
      },
      {
        operation: copyResource(
          rootFiles.containerEntrypoint,
          "scripts/container-entrypoint.sh",
        ),
        executable: true,
      },
    ],
  };
}
