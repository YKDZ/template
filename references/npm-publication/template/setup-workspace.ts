import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import type { SharedRootContribution } from "@ykdz/template-workspace/shared-root-files";

/** 发布存在时投影显式取得入口、忽略规则与一次性目录的动态检查。 */
export function projectPublicationSetup(options: {
  readonly toolName: string;
}): SharedRootContribution {
  const source = createTemplateSourceHandle(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const setupGlob = "scripts/npm-publication-setup";
  const commands = {
    "publication:setup:format": `pnpm exec oxfmt --list-different --no-error-on-unmatched-pattern --ignore-path=/dev/null '${setupGlob}/'*`,
    "publication:setup:lint": `pnpm exec oxlint --quiet --format=unix --no-ignore --no-error-on-unmatched-pattern '${setupGlob}/'*.ts`,
    "publication:setup:typecheck": "pnpm run typecheck",
    "publication:setup:test": `PUBLICATION_TOOL_NAME=${options.toolName} node --conditions=source --experimental-strip-types --test --test-timeout=60000 --test-reporter=spec '${setupGlob}/**/*.light.test.ts'`,
  };
  const setupTask = (check: string): readonly [string, unknown] => [
    `//#publication:setup:${check}`,
    {
      tags: ["quality:light"],
      inputs: ["$TURBO_DEFAULT$", "scripts/npm-publication-setup/**"],
      outputs: [],
    },
  ];

  return {
    kind: "shared-root-files",
    source: "@ykdz/reference-npm-publication#./template/setup-workspace",
    manifest: {
      scripts: {
        "publication:setup": `node --import ${options.toolName}/setup --eval '' --`,
        ...commands,
      },
    },
    turboTasks: {
      "//#publication:setup": {
        tags: ["work:lifecycle"],
        cache: false,
        inputs: [],
        outputs: [],
      },
      ...Object.fromEntries(
        ["format", "lint", "typecheck", "test"].map(setupTask),
      ),
    },
    gitignoreFragments: [
      {
        from: "resources/setup/gitignore",
        source,
      },
    ],
  };
}
