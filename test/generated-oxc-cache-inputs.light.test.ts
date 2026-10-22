import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectPreparedWorkspaceRoot } from "@ykdz/template-workspace/root-projection";

void describe("Generated Repository Oxc cache inputs", () => {
  void it("tracks the selected tooling-config instance in Turbo global inputs", () => {
    const projection = projectPreparedWorkspaceRoot({
      rootManifest: { scripts: {} },
      packageGlobs: ["packages/*"],
      dependencyCatalog: {},
      dependencyOverrides: {},
      turboTemplate: {
        globalDependencies: ["oxfmt.config.ts", "oxlint.config.ts"],
        tasks: {},
      },
      referenceNames: new Map(),
      toolingConfigPackagePath: "packages/custom-tooling-config",
      rootTsconfigCompilerOptions: {},
      rootTsconfigInclude: [],
      tsconfigConfigTemplate: {},
    });

    assert.deepStrictEqual(
      (projection.turbo as { readonly value: { globalDependencies: string[] } })
        .value.globalDependencies,
      [
        "oxfmt.config.ts",
        "oxlint.config.ts",
        "packages/custom-tooling-config/oxfmt.config.ts",
        "packages/custom-tooling-config/oxlint.config.ts",
      ],
    );
  });
});
