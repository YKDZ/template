import path from "node:path";

import type {
  SetExecutableOperation,
  WriteTextFromFragmentsOperation,
} from "@ykdz/template-core/renderer";

import type { PackageContribution } from "./package-contribution.ts";
import type { ReferencePackage } from "./reference-package.ts";
import type { RootResourceOperation } from "./shared-root-files.ts";
import {
  copyPreparedWorkspaceResource,
  prepareWorkspaceResources,
  type PreparedWorkspaceResources,
} from "./workspace-resources.ts";

const cliPublicationOwner =
  "工作区公开 CLI 发布能力 @ykdz/template-workspace#./cli-publication";

const cliPublicationFiles = [
  "scripts/npm-publication/changelog.ts",
  "scripts/npm-publication/configuration.ts",
  "scripts/npm-publication/failure.ts",
  "scripts/npm-publication/publish.ts",
  "scripts/npm-publication/release.ts",
  "scripts/npm-publication/remote-context.ts",
  "resources/cli-publication/gitignore",
  "resources/cli-publication/release.yml",
  "publication-setup/README.md",
  "publication-setup/RELEASING.md",
  "publication-setup/assets/CHANGELOG.md.template",
  "publication-setup/assets/LICENSE-APACHE-2.0.txt",
  "publication-setup/assets/LICENSE-MIT.txt",
  "publication-setup/assets/README.md.template",
  "scripts/npm-publication-setup/bridge.ts",
  "publication-setup/setup.sh",
] as const;

// 根脚本目录由工作区根配置治理；包级配置和所属集成测试留在参考包验收中。
const referencePackageOnlyResources = new Set([
  "scripts/publication.integration.test.ts",
  "tsconfig.json",
  "turbo.json",
  "turbo.jsonc",
]);

/** 工作区 CLI owner 在策略准备阶段检查其有限发布资源。 */
export function prepareCliPublicationResources(): PreparedWorkspaceResources {
  return prepareWorkspaceResources(cliPublicationFiles, cliPublicationOwner);
}

export type CliPublicationProjection = {
  readonly candidate: PackageContribution | undefined;
  readonly operations: readonly (
    | RootResourceOperation
    | SetExecutableOperation
  )[];
  readonly gitignoreFragments: WriteTextFromFragmentsOperation["fragments"];
  readonly imports: Readonly<Record<string, string>> | undefined;
  readonly scripts: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly tsconfigCompilerOptions: Readonly<Record<string, unknown>>;
  readonly tsconfigInclude: readonly string[];
};

function publicCliCandidate(
  contributions: readonly PackageContribution[],
): PackageContribution | undefined {
  const candidates = contributions.filter(
    (contribution) =>
      contribution.foundation.npmPublication?.kind === "public-cli-candidate",
  );
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
  return contribution;
}

function publicationOperations(
  candidate: PackageContribution | undefined,
  resources: PreparedWorkspaceResources,
  referencePackage: ReferencePackage | undefined,
): (RootResourceOperation | SetExecutableOperation)[] {
  if (candidate === undefined) return [];
  if (referencePackage === undefined) {
    throw new Error(
      "公开 CLI 候选需要由内容集合显式装配 @ykdz/reference-npm-publication#./template",
    );
  }
  const copy = (
    file: (typeof cliPublicationFiles)[number],
    to: string,
  ): RootResourceOperation =>
    copyPreparedWorkspaceResource(resources, file, to, cliPublicationOwner);
  referencePackage.prepare();
  const scriptOperations = referencePackage
    .operations("scripts/npm-publication")
    .filter(
      (operation) =>
        !referencePackageOnlyResources.has(
          path.posix.relative("scripts/npm-publication", operation.to),
        ),
    );
  return [
    ...scriptOperations,
    ...cliPublicationFiles
      .filter((file) => file.startsWith("scripts/npm-publication/"))
      .map((file) => copy(file, file)),
    ...cliPublicationFiles
      .filter((file) => file.startsWith("scripts/npm-publication-setup/"))
      .map((file) => copy(file, file)),
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
    {
      kind: "writeJson",
      to: "scripts/npm-publication/publication.config.json",
      value: {
        packagePath: candidate.definition.path,
      },
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
  readonly contributions: readonly PackageContribution[];
  readonly resources: PreparedWorkspaceResources;
  readonly referencePackage: ReferencePackage | undefined;
}): CliPublicationProjection {
  const selected = publicCliCandidate(options.contributions);
  if (selected === undefined) {
    return {
      candidate: undefined,
      operations: [],
      gitignoreFragments: [],
      imports: undefined,
      scripts: {},
      devDependencies: {},
      tsconfigCompilerOptions: {},
      tsconfigInclude: [],
    };
  }
  const filter = `'${selected.definition.name.replaceAll("'", "'\\''")}'`;
  return {
    candidate: selected,
    operations: publicationOperations(
      selected,
      options.resources,
      options.referencePackage,
    ),
    gitignoreFragments: [
      copyPreparedWorkspaceResource(
        options.resources,
        "resources/cli-publication/gitignore",
        ".gitignore",
        cliPublicationOwner,
      ),
    ],
    imports: {
      "#npm-publication/*": "./scripts/npm-publication/*.ts",
      "#shared-publication": "./scripts/npm-publication/scripts/publication.ts",
    },
    scripts: {
      "publication:readiness": `pnpm --filter=${filter} run publication:readiness`,
      "publication:prepare":
        "pnpm --workspace-root exec node --conditions=source --experimental-strip-types scripts/npm-publication/scripts/generated/prepare.ts",
      "publication:artifact":
        "node --conditions=source --experimental-strip-types scripts/npm-publication/scripts/generated/artifact.ts",
    },
    devDependencies: {
      "@types/semver": "catalog:",
      "@types/spdx-expression-parse": "catalog:",
      semver: "catalog:",
      "spdx-expression-parse": "catalog:",
      tar: "catalog:",
      "validate-npm-package-name": "catalog:",
    },
    tsconfigCompilerOptions: {},
    tsconfigInclude: [],
  };
}
