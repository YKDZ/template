import path from "node:path";

import type { RenderOperation } from "@ykdz/template-core/renderer";
import type { GeneratorPackageState } from "@ykdz/template-core/workspace-strategy";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";

import type { WorkspaceRootInsertion } from "./root-projection.ts";
import {
  copyPreparedWorkspaceResource,
  prepareWorkspaceResources,
  type PreparedWorkspaceResources,
} from "./workspace-resources.ts";

const cliPublicationOwner =
  "工作区公开 CLI 发布能力 @ykdz/template-workspace#./cli-publication";

const cliPublicationFiles = [
  "assets/.pnpmfile.mjs",
  "publication/artifact.ts",
  "publication/changelog.ts",
  "publication/check-artifact.ts",
  "publication/check-readiness.ts",
  "publication/configuration.ts",
  "publication/handoff.ts",
  "publication/publish.ts",
  "publication/readiness.ts",
  "publication/release.ts",
  "publication/RELEASING.md",
  "resources/cli-publication/release.yml",
  "publication-setup/README.md",
  "publication-setup/assets/CHANGELOG.md.template",
  "publication-setup/assets/LICENSE-APACHE-2.0.txt",
  "publication-setup/assets/LICENSE-MIT.txt",
  "publication-setup/assets/README.md.template",
  "publication-setup/bridge.ts",
  "publication-setup/setup.sh",
] as const;

/** 工作区 CLI owner 在策略准备阶段检查其有限发布资源。 */
export function prepareCliPublicationResources(): PreparedWorkspaceResources {
  return prepareWorkspaceResources(cliPublicationFiles, cliPublicationOwner);
}

export type CliPublicationProjection = {
  readonly candidate: PackageContribution | undefined;
  readonly operations: readonly RenderOperation[];
  readonly imports: Readonly<Record<string, string>> | undefined;
  readonly scriptInsertions: readonly WorkspaceRootInsertion[];
  readonly dependencyInsertions: readonly WorkspaceRootInsertion[];
  readonly tsconfigCompilerOptions: Readonly<Record<string, unknown>>;
  readonly tsconfigInclude: readonly string[];
};

type PublicCliCandidate = {
  readonly contribution: PackageContribution;
  readonly record: GeneratorPackageState;
};

function publicCliCandidate(
  packages: readonly GeneratorPackageState[],
  contributions: readonly PackageContribution[],
): PublicCliCandidate | undefined {
  const recordsByPackagePath = new Map(
    packages.map((record) => [record.definition.path, record]),
  );
  const candidates = contributions.filter(
    (contribution) =>
      contribution.foundation.npmPublication?.kind === "public-cli-candidate",
  );
  for (const candidate of candidates) {
    const record = recordsByPackagePath.get(candidate.definition.path);
    if (record?.createdBy !== "initialization") {
      throw new Error(
        `公开 CLI 候选只能在初始化时选择：${candidate.definition.name}`,
      );
    }
  }
  if (candidates.length > 1) {
    throw new Error(
      `工作区最多只能选择一个公开 CLI 候选：${candidates.map((candidate) => `${candidate.definition.name} 位于 ${candidate.definition.path}`).join("、")}`,
    );
  }
  const contribution = candidates[0];
  if (
    contribution !== undefined &&
    contribution.definition.role !== "cli-tool"
  ) {
    throw new Error(
      `公开 CLI 候选必须使用 cli-tool 包角色：${contribution.definition.name}`,
    );
  }
  if (contribution === undefined) return undefined;
  const record = recordsByPackagePath.get(contribution.definition.path);
  if (record === undefined || record.creationInput === null) {
    throw new Error(
      `公开 CLI 候选缺少生成记录创建事实：${contribution.definition.name}`,
    );
  }
  return { contribution, record };
}

function publicationOperations(
  candidate: PublicCliCandidate | undefined,
  resources: PreparedWorkspaceResources,
): RenderOperation[] {
  if (candidate === undefined) return [];
  const publication = candidate.contribution.foundation.npmPublication;
  if (
    publication?.commandIdentitySource === undefined ||
    publication.creationInputSource === undefined
  ) {
    throw new Error(
      `公开 CLI 候选 ${candidate.contribution.definition.name} 缺少所属发布资源事实`,
    );
  }
  const copy = (
    file: (typeof cliPublicationFiles)[number],
    to: string,
  ): RenderOperation =>
    copyPreparedWorkspaceResource(resources, file, to, cliPublicationOwner);
  return [
    copy("assets/.pnpmfile.mjs", ".pnpmfile.mjs"),
    ...cliPublicationFiles
      .filter(
        (file) =>
          file.startsWith("publication/") &&
          file !== "publication/RELEASING.md" &&
          file !== "resources/cli-publication/release.yml",
      )
      .map((file) =>
        copy(
          file,
          path.posix.join("scripts/npm-publication", path.posix.basename(file)),
        ),
      ),
    ...cliPublicationFiles
      .filter((file) => file.startsWith("publication-setup/"))
      .map((file) =>
        copy(
          file,
          path.posix.join(
            "scripts/npm-publication-setup",
            path.posix.relative("publication-setup", file),
          ),
        ),
      ),
    copy("publication/RELEASING.md", "RELEASING.md"),
    {
      kind: "writeJson",
      to: "scripts/npm-publication/publication.config.json",
      value: {
        packagePath: candidate.contribution.definition.path,
        packageDefinitionId: candidate.record.packageDefinitionId,
        creationInput: candidate.record.creationInput,
      },
    },
    {
      kind: "copyFile",
      ...publication.commandIdentitySource,
      to: "scripts/npm-publication/cli-command-identity.ts",
    },
    {
      kind: "copyFile",
      ...publication.creationInputSource,
      to: "scripts/npm-publication/cli-candidate-selection.ts",
    },
    {
      kind: "setExecutable",
      path: "scripts/npm-publication-setup/setup.sh",
      executable: true,
    },
    copy(
      "resources/cli-publication/release.yml",
      ".github/workflows/release.yml",
    ),
  ];
}

/** 默认策略拥有公开 TypeScript CLI 候选的根配置与发版工具投影。 */
export function projectCliPublication(options: {
  readonly packages: readonly GeneratorPackageState[];
  readonly contributions: readonly PackageContribution[];
  readonly resources: PreparedWorkspaceResources;
}): CliPublicationProjection {
  const selected = publicCliCandidate(options.packages, options.contributions);
  if (selected === undefined) {
    return {
      candidate: undefined,
      operations: [],
      imports: undefined,
      scriptInsertions: [],
      dependencyInsertions: [],
      tsconfigCompilerOptions: {},
      tsconfigInclude: [],
    };
  }
  return {
    candidate: selected.contribution,
    operations: publicationOperations(selected, options.resources),
    imports: { "#npm-publication/*": "./scripts/npm-publication/*.ts" },
    scriptInsertions: [
      {
        before: "fix",
        values: {
          "publication:readiness":
            "node --conditions=source scripts/npm-publication/check-readiness.ts",
          "publication:artifact":
            "node --conditions=source scripts/npm-publication/check-artifact.ts",
        },
      },
    ],
    dependencyInsertions: [
      {
        before: "oxfmt",
        values: {
          "@types/semver": "catalog:",
          "@types/spdx-expression-parse": "catalog:",
        },
      },
      {
        before: "turbo",
        values: {
          semver: "catalog:",
          "spdx-expression-parse": "catalog:",
          npm: "catalog:",
          tar: "catalog:",
        },
      },
    ],
    tsconfigCompilerOptions: { allowJs: true, checkJs: true },
    tsconfigInclude: [".pnpmfile.mjs"],
  };
}
