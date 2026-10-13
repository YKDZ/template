import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  templateSources,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import {
  renderNewProject,
  type CopyFileOperation,
} from "@ykdz/template-core/renderer";

import { tsLibDefinition } from "./definition.ts";

void describe("ts-lib Built-in Preset Definition behavior", () => {
  void it("owns conventional task scripts without a package check registration", () => {
    assert.strictEqual(
      tsLibDefinition.initialPrimaryPackage.defaultLeafName,
      "lib",
    );
    const context = {
      targetDir: "/tmp/demo-library",
      repositoryName: "demo-library",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    };
    const contribution =
      tsLibDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "lib",
          definition: {
            name: "@demo/lib",
            path: "packages/lib",
            role: "shared-library",
          },
        },
      });

    assert.match(
      resolveBuiltInTemplateSource(tsLibDefinition.source, "."),
      /templates[\\/]ts-lib$/,
    );
    assert.deepStrictEqual(contribution.definition, {
      name: "@demo/lib",
      path: "packages/lib",
      role: "shared-library",
    });
    assert.partialDeepStrictEqual(contribution.manifest, {
      dependencies: { valibot: "catalog:" },
      exports: {
        ".": {
          source: "./src/index.ts",
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
      },
      imports: {
        "#/*": {
          source: "./src/*.ts",
          types: "./src/*.ts",
          default: "./dist/*.js",
        },
      },
      scripts: {
        build: "tsc -p tsconfig.build.json --pretty false",
        "format:check": "oxfmt --list-different .",
        "format:write": "oxfmt --write .",
        lint: "oxlint --quiet --format=unix --ignore-pattern node_modules .",
        "lint:fix": "oxlint --format=unix . --fix",
        typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
      },
    });
    assert.ok(!("checks" in (contribution ?? {})));
    assert.ok(!("fixes" in (contribution ?? {})));
    assert.partialDeepStrictEqual(contribution.manifest, {
      scripts: {
        "format:write": "oxfmt --write .",
        "lint:fix": "oxlint --format=unix . --fix",
      },
    });
    const turboCopy = contribution.operations.find(
      (operation) =>
        operation.kind === "copyFile" && operation.from === "turbo.json",
    );
    assert.deepStrictEqual(turboCopy, {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "turbo.json",
      to: "packages/lib/turbo.json",
    });
    const buildConfigCopy = contribution.operations.find(
      (operation) =>
        operation.kind === "copyFile" &&
        operation.from === "tsconfig.build.json",
    );
    assert.deepStrictEqual(buildConfigCopy, {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "tsconfig.build.json",
      to: "packages/lib/tsconfig.build.json",
    });

    const plan = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const rootManifest = plan.operations.find(
      (operation) =>
        operation.kind === "writeJson" && operation.to === "package.json",
    );
    assert.partialDeepStrictEqual(rootManifest, {
      value: {
        scripts: {
          check: "node --conditions=source scripts/quality-gates.ts check",
          "check:heavy":
            "node --conditions=source scripts/quality-gates.ts check:heavy",
          "check:full":
            "node --conditions=source scripts/quality-gates.ts check:full",
          fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
        },
      },
    });
    assert.ok(!("checks" in (plan ?? {})));
    assert.ok(!("fixes" in (plan ?? {})));
    assert.ok(
      plan.operations.some(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.to === "pnpm-workspace.yaml" &&
          operation.replacements.WORKSPACE_PACKAGE_GLOBS ===
            "  - apps/*\n  - packages/*",
      ),
    );
  });

  void it("renders its owned source through opaque handles and persists durable addition facts", async () => {
    type SourceHandle = NonNullable<CopyFileOperation["source"]>;
    type IsEqual<Left, Right> =
      (<Value>() => Value extends Left ? 1 : 2) extends <
        Value,
      >() => Value extends Right ? 1 : 2
        ? (<Value>() => Value extends Right ? 1 : 2) extends <
            Value,
          >() => Value extends Left ? 1 : 2
          ? true
          : false
        : false;
    type IsOpaqueSourceHandle =
      IsEqual<SourceHandle, string> extends false ? true : false;
    const isOpaqueSourceHandle: IsOpaqueSourceHandle = true;
    assert.strictEqual(isOpaqueSourceHandle, true);
    assert.throws(
      () => resolveBuiltInTemplateSource("vue" as never, "src/main.ts"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("unknown Template Source handle"),
    );

    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-definition-")),
      "demo-lib",
    );
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    assert.ok(
      initialization.operations.some(
        (operation) =>
          operation.kind === "copyFile" &&
          operation.source === templateSources.tsLib &&
          operation.from === "src/index.ts",
      ),
    );
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "packages/lib/src/index.ts"),
          "utf8",
        )
      ).includes("export"),
    );
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    assert.ok(
      devcontainerDockerfile.includes(
        'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
      ),
    );
    assert.ok(
      devcontainerDockerfile.includes(
        'corepack enable --install-directory "$PNPM_HOME"',
      ),
    );
    assert.ok(!devcontainerDockerfile.includes("corepack prepare"));
    assert.ok(!devcontainerDockerfile.includes("PACKAGE_MANAGER_PIN"));
    assert.ok(!devcontainerDockerfile.includes("COREPACK_HOME"));
    assert.ok(
      devcontainerDockerfile.includes(
        "git config --system init.defaultBranch main",
      ),
    );
    const gitignorePath = path.join(targetDir, ".gitignore");
    assert.ok((await readFile(gitignorePath, "utf8")).includes(".pnpm-store/"));
    await writeFile(gitignorePath, "private-artifacts/\n", { flag: "a" });
    const turboPath = path.join(targetDir, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    turbo.tasks.custom = { cache: false };
    await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

    const addition = planGeneratedRepositoryPackageAddition({
      definition: tsLibDefinition,
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
      packageLeafName: "utilities",
    });
    assert.ok(
      addition.operations.some(
        (operation) =>
          operation.kind === "copyFile" &&
          operation.to === ".gitignore" &&
          operation.provenance?.planningContribution === "foundationPlan",
      ),
    );
    assert.deepStrictEqual(
      addition.operations.filter(
        (operation) => "overwrite" in operation && operation.overwrite,
      ),
      [],
    );
    assert.ok(
      addition.operations.some(
        (operation) =>
          operation.kind === "mergeJsonTemplate" &&
          operation.to === "turbo.json" &&
          operation.provenance?.planningContribution === "foundationPlan",
      ),
    );
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.projectProjections,
    });
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/utilities/package.json"),
          "utf8",
        ),
      ),
      { name: "@demo/utilities" },
    );
    assert.ok(
      (await readFile(gitignorePath, "utf8")).includes("private-artifacts/"),
    );
    assert.partialDeepStrictEqual(
      await readFile(turboPath, "utf8").then((source) => JSON.parse(source)),
      {
        tasks: { custom: { cache: false } },
      },
    );

    const secondAddition = planGeneratedRepositoryPackageAddition({
      definition: tsLibDefinition,
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
      packageLeafName: "models",
    });
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...secondAddition.projectProjections,
    });
    const updatedGitignore = await readFile(gitignorePath, "utf8");
    assert.strictEqual(
      updatedGitignore.match(/^private-artifacts\/$/gmu)?.length,
      1,
    );
  });
});
