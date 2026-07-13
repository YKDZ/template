import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  templateSources,
} from "@ykdz/template-builtin-presets";
import {
  renderNewProject,
  renderProjectAtomically,
  type CopyFileOperation,
} from "@ykdz/template-core/renderer";
import { describe, expect, expectTypeOf, it } from "vitest";

import { tsLibDefinition } from "./definition.ts";

describe("ts-lib Built-in Preset Definition behavior", () => {
  it("owns conventional task scripts without a package check registration", () => {
    const context = {
      targetDir: "/tmp/demo-library",
      projectName: "demo-library",
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    };
    const contribution = tsLibDefinition.planInitialization(context);

    expect(resolveBuiltInTemplateSource(tsLibDefinition.source, ".")).toMatch(
      /templates[\\/]ts-lib$/,
    );
    expect(contribution.definition).toEqual({
      name: "@demo/demo-library",
      path: "packages/demo-library",
      role: "shared-library",
    });
    expect(contribution.manifest).toMatchObject({
      dependencies: { valibot: "catalog:" },
      exports: { ".": { default: "./src/index.ts" } },
      imports: { "#/*": { default: "./src/*.ts" } },
      scripts: {
        "format:check":
          "oxfmt --list-different --config ../../oxfmt.config.ts .",
        "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
        lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts --ignore-pattern node_modules .",
        "lint:fix:run":
          "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
        typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
      },
    });
    expect(contribution).not.toHaveProperty("checks");
    expect(contribution.operations).toContainEqual({
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "turbo.json",
      to: "packages/demo-library/turbo.json",
    });

    const plan = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const rootManifest = plan.operations.find(
      (operation) =>
        operation.kind === "writeJson" && operation.to === "package.json",
    );
    expect(rootManifest).toMatchObject({
      value: {
        scripts: {
          check:
            "turbo run boundaries format:check lint typecheck build test test:e2e --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
        },
      },
    });
    expect(plan).not.toHaveProperty("checks");
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        kind: "writeTextTemplate",
        to: "pnpm-workspace.yaml",
        replacements: expect.objectContaining({
          WORKSPACE_PACKAGE_GLOBS: "  - apps/*\n  - packages/*",
        }),
      }),
    );
  });

  it("renders its owned source through opaque handles and persists durable addition facts", async () => {
    expectTypeOf<
      NonNullable<CopyFileOperation["source"]>
    >().not.toEqualTypeOf<string>();
    expect(() =>
      resolveBuiltInTemplateSource("vue" as never, "src/main.ts"),
    ).toThrow("unknown Template Source handle");

    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-definition-")),
      "demo-lib",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    expect(initialization.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "copyFile",
          source: templateSources.tsLib,
          from: "src/index.ts",
        }),
      ]),
    );
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });
    expect(
      await readFile(
        path.join(targetDir, "packages/demo-lib/src/index.ts"),
        "utf8",
      ),
    ).toContain("export");

    const addition = planGeneratedRepositoryPackageAddition({
      definition: tsLibDefinition,
      context,
      blueprint: initialization.blueprint,
      packageLeafName: "utilities",
    });
    await renderProjectAtomically({
      targetRoot: targetDir,
      operations: [...addition.operations],
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/utilities/package.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ name: "@demo/utilities" });
  });
});
