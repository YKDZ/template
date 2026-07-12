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
  it("owns its source, explicit exposure, catalog dependency, and package checks", () => {
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
    });
    expect(contribution.checks.map((check) => check.kind)).toEqual([
      "typescript-typecheck",
      "oxc-lint",
      "oxc-format-check",
    ]);
    expect(contribution.operations).toContainEqual({
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "turbo.json",
      to: "packages/demo-library/turbo.json",
    });
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
