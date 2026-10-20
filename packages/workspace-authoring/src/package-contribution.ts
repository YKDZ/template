import {
  assertCiDiagnosticArtifactDeclaration,
  type CiDiagnosticArtifactDeclaration,
} from "@ykdz/template-core/ci-diagnostic-artifact";
import type { DevelopmentContainerToolLayer } from "@ykdz/template-core/development-container-tool-layer";
import type { EditorCustomizationCapability } from "@ykdz/template-core/editor-customization";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
} from "@ykdz/template-core/module-graph";
import {
  assertPackageContribution as assertPackageContributionPaths,
  type PackageContribution as PackageContributionSkeleton,
} from "@ykdz/template-core/package-contribution";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { DependencyMaintenancePolicy } from "@ykdz/template-core/project-github";
import type {
  RenderOperation,
  TemplateSourceHandle,
} from "@ykdz/template-core/renderer";

export type FoundationContribution = {
  /** 由根策略拥有的封闭式 Vue-Hono 页面/API 浏览器验收能力。 */
  readonly vueHonoJointE2e?: {
    readonly kind: "vue-hono-joint-e2e";
    readonly apiPackageName: string;
  };
  readonly databasePreparation?: {
    readonly kind: "sqlite-database-preparation";
    readonly migrationPackageName: string;
    readonly consumers: readonly {
      readonly kind: "application-dev" | "database-test" | "application-e2e";
      readonly packageName: string;
    }[];
  };
  /** 由 Foundation 投影的封闭式仓库部署能力。 */
  readonly deploymentCheck?: {
    readonly kind: "application-container-with-database-migrations";
    readonly applicationPackageName: string;
    readonly databasePackageName: string;
    readonly migrationPackageName: string;
    readonly environmentNeeds: readonly DeploymentEnvironmentNeed[];
    readonly sources: {
      readonly checker: FoundationTemplateAssetSource;
      readonly controlScript: FoundationTemplateAssetSource;
      readonly dockerfile: FoundationTemplateAssetSource;
      readonly dockerIgnore: FoundationTemplateAssetSource;
    };
  };
  /** 仅由协同根策略消费的封闭式发布能力。 */
  readonly npmPublication?: {
    readonly kind: "public-cli-candidate";
  };
  /** Foundation 必须安装并投影到协同根文件中的工具链。 */
  readonly toolchains: {
    readonly rust?: {
      readonly toolchain: string;
      readonly components: readonly ("rustfmt" | "clippy")[];
      readonly configurationSource: FoundationTemplateAssetSource;
    };
  };
  /** Foundation 必须投影到协同编辑器文件中的编辑器能力。 */
  readonly editorCapabilities: readonly EditorCustomizationCapability[];
  /** 由协同根策略维护的生态系统与路径。 */
  readonly dependencyMaintenance: DependencyMaintenancePolicy;
  /** 包边界提供的工作区成员匹配模式。 */
  readonly workspacePackageGlobs?: readonly string[];
  /** 包自有清单所需的依赖目录条目。 */
  readonly dependencyCatalog?: Readonly<Record<string, string>>;
  /** 由 Foundation 协同并由源码提供的开发容器能力。 */
  readonly developmentContainerToolLayers?:
    | readonly DevelopmentContainerToolLayer[]
    | undefined;
};

export type FoundationTemplateAssetSource = {
  readonly source: TemplateSourceHandle;
  readonly from: string;
};

/** 生成仓库计划中与预设无关的包级片段。 */
export type PackageContribution = PackageContributionSkeleton & {
  /** 原生来源身份及已选择的目标实例；原生依赖仍由来源 manifest 拥有。 */
  readonly referenceSource?: string;
  readonly referenceBindings?: Readonly<Record<string, PackageDefinition>>;
  readonly definition: PackageDefinition;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly exposure: {
    readonly exports: Readonly<Record<string, unknown>>;
    readonly imports: Readonly<Record<string, unknown>>;
  };
  readonly operations: readonly RenderOperation[];
  /** 由 Foundation 消费并投影为协同根输出的类型化需求。 */
  readonly foundation: FoundationContribution;
  readonly environmentNeeds: readonly CheckEnvironmentNeed[];
  /** 由此 Package Boundary 持有的封闭式原生 CI 证据。 */
  readonly ciDiagnosticArtifacts?: readonly CiDiagnosticArtifactDeclaration[];
};

/** 校验 CLI 命令名的格式及工作区内是否重名。 */
export function validateCliCommandName(
  commandName: string,
  occupiedCommandNames: readonly string[] = [],
): string {
  if (/[/\\]/u.test(commandName)) {
    throw new Error(
      `CLI command name must not be a path; received ${JSON.stringify(commandName)}`,
    );
  }
  if (/\p{White_Space}/u.test(commandName)) {
    throw new Error(
      `CLI command name must not contain whitespace; received ${JSON.stringify(commandName)}`,
    );
  }
  if (/\p{Control}/u.test(commandName)) {
    throw new Error(
      `CLI command name must not contain a control character; received ${JSON.stringify(commandName)}`,
    );
  }
  if (commandName.startsWith("-")) {
    throw new Error(
      `CLI command name must not have a leading hyphen; received ${JSON.stringify(commandName)}`,
    );
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(commandName)) {
    throw new Error(
      `CLI command name must use lowercase ASCII letters, digits, and single hyphens; received ${JSON.stringify(commandName)}`,
    );
  }
  if (occupiedCommandNames.includes(commandName)) {
    throw new Error(
      `CLI command name is already used by another workspace package; received ${JSON.stringify(commandName)}`,
    );
  }
  return commandName;
}

function manifestBinEntries(
  contribution: PackageContribution,
): readonly [string, unknown][] {
  const bin = contribution.manifest.bin;
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) {
    return [];
  }
  return Object.entries(bin);
}

/** 校验完整生成计划中的命令名格式和唯一性。 */
export function assertPackageContributionCommandNames(
  contributions: readonly PackageContribution[],
): readonly PackageContribution[] {
  const commandOwner = new Map<string, string>();
  for (const contribution of contributions) {
    const entries = manifestBinEntries(contribution);
    for (const [commandName] of entries) {
      const existingOwner = commandOwner.get(commandName);
      try {
        validateCliCommandName(commandName, [...commandOwner.keys()]);
      } catch (error) {
        if (existingOwner !== undefined) {
          throw new Error(
            `CLI command name ${JSON.stringify(commandName)} from ${contribution.definition.name} is already used by ${existingOwner}`,
            { cause: error },
          );
        }
        throw error;
      }
      commandOwner.set(commandName, contribution.definition.name);
    }
  }
  return contributions;
}

export function assertPackageContribution(
  contribution: PackageContribution,
  provenance: {
    readonly definitionName?: string;
    readonly planner?: string;
  } = {},
): PackageContribution {
  if (contribution.definition.name !== contribution.manifest.name) {
    throw new Error(
      "Package Contribution manifest name must match its Package Definition",
    );
  }
  for (const artifact of contribution.ciDiagnosticArtifacts ?? []) {
    const declaration = assertCiDiagnosticArtifactDeclaration(artifact);
    if (declaration.owner.path !== contribution.definition.path) {
      throw new Error(
        `CI Diagnostic Artifact owner must match its Package Contribution: ${contribution.definition.path}`,
      );
    }
  }
  assertPackageContributionPaths(contribution, provenance);
  return contribution;
}
