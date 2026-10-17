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
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";

import { tsLibDefinition } from "./definition.ts";

void describe("ts-lib Built-in Preset Definition behavior", () => {
  void it("提供标准任务与库导出合同", () => {
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
  });

  void it("持久化增包所需信息，并在连续增包时保留定制", async () => {
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
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });
    assert.partialDeepStrictEqual(
      JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")),
      {
        scripts: {
          check: "node --conditions=source scripts/task-gates.ts check",
          "check:heavy":
            "node --conditions=source scripts/task-gates.ts check:heavy",
          "check:full":
            "node --conditions=source scripts/task-gates.ts check:full",
          fix: "node --conditions=source scripts/task-gates.ts fix",
        },
      },
    );
    const workspace = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    assert.match(workspace, /^  - apps\/\*$/mu);
    assert.match(workspace, /^  - packages\/\*$/mu);
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
