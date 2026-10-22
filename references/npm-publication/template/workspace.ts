import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import type { GeneratorPackageState } from "@ykdz/template-core/workspace-strategy";
import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";
import type { ReferencePackageManifest } from "@ykdz/template-workspace/reference-package";
import type { SharedRootContribution } from "@ykdz/template-workspace/shared-root-files";

import { isPublicationEnabled } from "./target.ts";

const source = createTemplateSourceHandle(
  fileURLToPath(new URL("../", import.meta.url)),
);

export type PublicationWorkspaceOptions = {
  readonly packages: readonly GeneratorPackageState[];
  readonly contributions: readonly PackageContribution[];
};

/** 工作区只装配 Changesets 原生依赖、命令和配置。 */
export function projectChangesetsWorkspace(
  options: PublicationWorkspaceOptions,
  manifest: ReferencePackageManifest,
): readonly SharedRootContribution[] {
  if (
    !options.packages.some((record) =>
      isPublicationEnabled(record.configuration),
    )
  )
    return [];
  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts ?? {}).filter(([name]) =>
      name.startsWith("publication:"),
    ),
  );
  return [
    {
      kind: "shared-root-files",
      source: "@ykdz/reference-npm-publication#./template",
      manifest: {
        devDependencies: {
          "@changesets/cli": manifest.devDependencies!["@changesets/cli"]!,
        },
        scripts,
      },
      turboTasks: Object.fromEntries(
        Object.keys(scripts).map((name) => [
          `//#${name}`,
          { tags: ["work:release"], cache: false },
        ]),
      ),
      gitignoreFragments: [{ from: "resources/gitignore", source }],
      resources: [
        {
          operation: {
            kind: "copyFile",
            from: ".changeset/config.json",
            to: ".changeset/config.json",
            source,
            overwrite: true,
          },
          reconciliation: {
            path: ".changeset/config.json",
            driver: "structured",
          },
        },
        {
          operation: {
            kind: "copyFile",
            from: "resources/release.yml",
            to: ".github/workflows/release.yml",
            source,
            overwrite: true,
          },
        },
      ],
    },
  ];
}
