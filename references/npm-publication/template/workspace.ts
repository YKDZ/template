import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import type { ReferencePackageManifest } from "@ykdz/template-workspace/reference-package";
import type { SharedRootContribution } from "@ykdz/template-workspace/shared-root-files";

const source = createTemplateSourceHandle(
  fileURLToPath(new URL("../", import.meta.url)),
);

/** 工作区只装配 Changesets 原生依赖、命令和配置。 */
export function projectChangesetsWorkspace(
  manifest: ReferencePackageManifest,
): readonly SharedRootContribution[] {
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
