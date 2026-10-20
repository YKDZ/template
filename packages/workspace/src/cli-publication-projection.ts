import path from "node:path";
import { fileURLToPath } from "node:url";

import { referencePackage as tsCliReferencePackage } from "@ykdz/reference-ts-cli/template";
import {
  createTemplateSourceHandle,
  type RenderOperation,
} from "@ykdz/template-core/renderer";
import type { GeneratorPackageRecord } from "@ykdz/template-core/workspace-strategy";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";

import type { WorkspaceRootInsertion } from "./root-projection.ts";
import {
  copyWorkspaceDirectory,
  copyWorkspaceResource,
} from "./workspace-resources.ts";

const workspaceSource = createTemplateSourceHandle(
  fileURLToPath(new URL("../", import.meta.url)),
);

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
  readonly record: GeneratorPackageRecord;
};

function publicCliCandidate(
  packages: readonly GeneratorPackageRecord[],
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
  if (record === undefined || record.creationInput === undefined) {
    throw new Error(
      `公开 CLI 候选缺少生成记录创建事实：${contribution.definition.name}`,
    );
  }
  return { contribution, record };
}

function publicationOperations(
  candidate: PublicCliCandidate | undefined,
): RenderOperation[] {
  if (candidate === undefined) return [];
  const identitySource = tsCliReferencePackage.publicationIdentitySource;
  const candidateSelectionSource = tsCliReferencePackage.source(
    "template/creation-input.ts",
  );
  if (identitySource === undefined) {
    throw new Error("公开 CLI 候选缺少原生身份资源");
  }
  return [
    {
      kind: "copyFile",
      source: workspaceSource,
      from: "assets/.pnpmfile.mjs",
      to: ".pnpmfile.mjs",
    },
    ...copyWorkspaceDirectory("publication", "scripts/npm-publication").filter(
      (operation) =>
        ![
          "release.yml",
          "RELEASING.md",
          "publication.config.json",
          "cli-command-identity.ts",
          "cli-candidate-selection.ts",
        ].includes(path.posix.basename(operation.to)),
    ),
    ...copyWorkspaceDirectory(
      "publication-setup",
      "scripts/npm-publication-setup",
    ),
    copyWorkspaceResource("publication/RELEASING.md", "RELEASING.md"),
    {
      kind: "writeJson",
      to: "scripts/npm-publication/publication.config.json",
      value: {
        packagePath: candidate.contribution.definition.path,
        packageDefinitionId: candidate.record.definition.packageDefinitionId,
        creationInput: candidate.record.creationInput,
      },
    },
    {
      kind: "copyFile",
      source: identitySource,
      from: ".",
      to: "scripts/npm-publication/cli-command-identity.ts",
    },
    {
      kind: "copyFile",
      source: candidateSelectionSource,
      from: ".",
      to: "scripts/npm-publication/cli-candidate-selection.ts",
    },
    {
      kind: "setExecutable",
      path: "scripts/npm-publication-setup/setup.sh",
      executable: true,
    },
    copyWorkspaceResource(
      "publication/release.yml",
      ".github/workflows/release.yml",
    ),
  ];
}

/** 默认策略拥有公开 TypeScript CLI 候选的根配置与发版工具投影。 */
export function projectCliPublication(options: {
  readonly packages: readonly GeneratorPackageRecord[];
  readonly contributions: readonly PackageContribution[];
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
    operations: publicationOperations(selected),
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
