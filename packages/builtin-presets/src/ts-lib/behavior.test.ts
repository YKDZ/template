import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  renderNewProject,
  type CopyFileOperation,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";

import {
  arrayContaining,
  assertContains,
  assertContainsEqual,
  assertDoesNotContain,
  assertLacksProperty,
  assertMatches,
  assertMatchesPartial,
  assertThrows,
  objectContaining,
  stringContaining,
} from "../../test-support/assertions.ts";
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
    assertMatchesPartial(contribution.manifest, {
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
    assertLacksProperty(contribution, "checks");
    assertLacksProperty(contribution, "fixes");
    assertMatchesPartial(contribution.manifest, {
      scripts: {
        "format:write": "oxfmt --write .",
        "lint:fix": "oxlint --format=unix . --fix",
      },
    });
    assertContainsEqual(contribution.operations, {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "turbo.json",
      to: "packages/lib/turbo.json",
    });
    assertContainsEqual(contribution.operations, {
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
    assertMatchesPartial(rootManifest, {
      value: {
        scripts: {
          check:
            "pnpm run boundaries && turbo run format:check lint typecheck build test test:e2e --concurrency=2 --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
          fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
        },
      },
    });
    assertLacksProperty(plan, "checks");
    assertLacksProperty(plan, "fixes");
    assertContainsEqual(
      plan.operations,
      objectContaining({
        kind: "writeTextTemplate",
        to: "pnpm-workspace.yaml",
        replacements: objectContaining({
          WORKSPACE_PACKAGE_GLOBS: "  - apps/*\n  - packages/*",
        }),
      }),
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
    assertThrows(
      () => resolveBuiltInTemplateSource("vue" as never, "src/main.ts"),
      "unknown Template Source handle",
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
    assertMatches(
      initialization.operations,
      arrayContaining([
        objectContaining({
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
    assertContains(
      await readFile(path.join(targetDir, "packages/lib/src/index.ts"), "utf8"),
      "export",
    );
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    assertContains(
      devcontainerDockerfile,
      'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
    );
    assertContains(
      devcontainerDockerfile,
      'corepack enable --install-directory "$PNPM_HOME"',
    );
    assertDoesNotContain(devcontainerDockerfile, "corepack prepare");
    assertDoesNotContain(devcontainerDockerfile, "PACKAGE_MANAGER_PIN");
    assertDoesNotContain(devcontainerDockerfile, "COREPACK_HOME");
    assertContains(
      devcontainerDockerfile,
      "git config --system init.defaultBranch main",
    );
    const gitignorePath = path.join(targetDir, ".gitignore");
    assertContains(await readFile(gitignorePath, "utf8"), ".pnpm-store/");
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
    assertContainsEqual(
      addition.operations,
      objectContaining({
        kind: "copyFile",
        to: ".gitignore",
        provenance: objectContaining({
          planningContribution: "foundationPlan",
        }),
      }),
    );
    assert.deepStrictEqual(
      addition.operations.filter(
        (operation) => "overwrite" in operation && operation.overwrite,
      ),
      [],
    );
    assertContainsEqual(
      addition.operations,
      objectContaining({
        kind: "mergeJsonTemplate",
        to: "turbo.json",
        provenance: objectContaining({
          planningContribution: "foundationPlan",
        }),
      }),
    );
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.projectProjections,
    });
    assertMatchesPartial(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/utilities/package.json"),
          "utf8",
        ),
      ),
      { name: "@demo/utilities" },
    );
    assertContains(await readFile(gitignorePath, "utf8"), "private-artifacts/");
    assertMatchesPartial(
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

  void it(
    "observes linked provider source changes without a provider build",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-lib-source-link-"),
      );
      const targetDir = path.join(workspace, "consumer");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
            0,
            releaseToolchainSnapshot.nodeVersion.indexOf("."),
          ),
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
        },
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        context,
      });

      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        const consumerPackagePath = initialization.blueprint.packages[0]!.path;
        const addition = planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "provider",
          linkFrom: [consumerPackagePath],
        });
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.projectProjections,
        });
        await execa("pnpm", ["install"], { cwd: targetDir });
        const providerManifest = JSON.parse(
          await readFile(
            path.join(targetDir, "packages/provider/package.json"),
            "utf8",
          ),
        ) as { exports: { ".": Record<string, string> } };
        assert.deepStrictEqual(Object.keys(providerManifest.exports["."]), [
          "source",
          "types",
          "default",
        ]);
        const consumerManifest = JSON.parse(
          await readFile(
            path.join(targetDir, consumerPackagePath, "package.json"),
            "utf8",
          ),
        ) as Readonly<Record<string, unknown>>;
        assertMatchesPartial(consumerManifest, {
          dependencies: { "@demo/provider": "workspace:*" },
        });
        assertLacksProperty(consumerManifest, "dependenciesMeta");

        const consumerRoot = path.join(targetDir, consumerPackagePath);
        await writeFile(
          path.join(consumerRoot, "src/observe-provider.ts"),
          [
            'import { greet } from "@demo/provider";',
            "",
            'console.log(greet("Ada").message);',
            "",
          ].join("\n"),
        );
        const sourceCommand = () =>
          execa("node", ["--conditions=source", "src/observe-provider.ts"], {
            cwd: consumerRoot,
          });

        assert.strictEqual(
          await sourceCommand().then(({ stdout }) => stdout),
          "Hello, Ada",
        );
        const providerEntry = path.join(
          targetDir,
          "packages/provider/src/index.ts",
        );
        await writeFile(
          providerEntry,
          (await readFile(providerEntry, "utf8")).replace(
            "Hello,",
            "Source changed:",
          ),
        );
        assert.strictEqual(
          await sourceCommand().then(({ stdout }) => stdout),
          "Source changed: Ada",
        );
        await execa(
          "pnpm",
          ["--filter", `./${consumerPackagePath}`, "run", "typecheck"],
          { cwd: targetDir },
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it(
    "uses native TypeScript 7 to enforce erasable source syntax",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-lib-erasability-"),
      );
      const targetDir = path.join(workspace, "library");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
            0,
            releaseToolchainSnapshot.nodeVersion.indexOf("."),
          ),
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
        },
      });
      const plan = planGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        context,
      });

      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });
        await execa("pnpm", ["install"], { cwd: targetDir });
        const packagePath = plan.blueprint.packages[0]!.path;
        await mkdir(path.join(targetDir, "scripts"), { recursive: true });
        await mkdir(path.join(targetDir, packagePath, "scripts"), {
          recursive: true,
        });
        await writeFile(
          path.join(targetDir, "scripts/automation-helper.ts"),
          'export const rootAutomationProbe = "root";\n',
        );
        await writeFile(
          path.join(targetDir, packagePath, "scripts/automation-probe.ts"),
          'import { packageAutomationProbe } from "./automation-helper.ts";\n\nconsole.log(packageAutomationProbe);\n',
        );
        await writeFile(
          path.join(targetDir, "scripts/automation-probe.ts"),
          'import { rootAutomationProbe } from "./automation-helper.ts";\n\nconsole.log(rootAutomationProbe);\n',
        );
        await writeFile(
          path.join(targetDir, packagePath, "scripts/automation-helper.ts"),
          'export const packageAutomationProbe = "package";\n',
        );
        await execa("pnpm", ["run", "format:check"], { cwd: targetDir });
        await execa("pnpm", ["run", "lint"], { cwd: targetDir });
        await execa("pnpm", ["run", "typecheck"], { cwd: targetDir });
        for (const command of ["format:check", "lint", "typecheck"] as const) {
          await execa(
            "pnpm",
            ["--filter", `./${packagePath}`, "run", command],
            {
              cwd: targetDir,
            },
          );
        }
        assert.strictEqual(
          await execa(
            "node",
            ["--conditions=source", "scripts/automation-probe.ts"],
            {
              cwd: targetDir,
            },
          ).then(({ stdout }) => stdout),
          "root",
        );
        assert.strictEqual(
          await execa(
            "node",
            ["--conditions=source", "scripts/automation-probe.ts"],
            {
              cwd: path.join(targetDir, packagePath),
            },
          ).then(({ stdout }) => stdout),
          "package",
        );
        const showConfig = async (
          args: readonly string[],
          configName: string,
        ): Promise<{ readonly files: readonly string[] }> => {
          const shown = await execa(
            "pnpm",
            [...args, "exec", "tsc", "-p", configName, "--showConfig"],
            { cwd: targetDir },
          );
          return JSON.parse(shown.stdout) as {
            readonly files: readonly string[];
          };
        };
        const rootConfig = await showConfig([], "tsconfig.json");
        const packageConfig = await showConfig(
          ["--filter", `./${packagePath}`],
          "tsconfig.json",
        );
        const packageBuildConfig = await showConfig(
          ["--filter", `./${packagePath}`],
          "tsconfig.build.json",
        );
        assertContains(rootConfig.files, "./scripts/automation-probe.ts");
        assertDoesNotContain(
          rootConfig.files,
          `./${packagePath}/scripts/automation-probe.ts`,
        );
        assertContains(packageConfig.files, "./scripts/automation-probe.ts");
        assertDoesNotContain(
          packageBuildConfig.files,
          "./scripts/automation-probe.ts",
        );
        await execa("pnpm", ["--filter", `./${packagePath}`, "run", "build"], {
          cwd: targetDir,
        });
        const compilerVersion = await execa(
          "pnpm",
          ["--filter", `./${packagePath}`, "exec", "tsc", "--version"],
          { cwd: targetDir },
        ).then(({ stdout }) => stdout);
        assert.match(compilerVersion, /^Version 7\./u);

        const nonErasableSource = path.join(
          targetDir,
          packagePath,
          "src/non-erasable.ts",
        );
        await writeFile(nonErasableSource, "enum Direction { Left, Right }\n");
        const rejected = await execa(
          "pnpm",
          ["--filter", `./${packagePath}`, "run", "typecheck"],
          { cwd: targetDir, reject: false },
        );
        assert.notStrictEqual(rejected.exitCode, 0);
        assertContains(
          `${rejected.stdout}\n${rejected.stderr}`,
          "erasableSyntaxOnly",
        );

        await rm(nonErasableSource);
        await execa(
          "pnpm",
          ["--filter", `./${packagePath}`, "run", "typecheck"],
          { cwd: targetDir },
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it(
    "builds linked distributions in Turbo order and runs without source",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-lib-dist-link-"),
      );
      const targetDir = path.join(workspace, "consumer");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
            0,
            releaseToolchainSnapshot.nodeVersion.indexOf("."),
          ),
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
        },
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        context,
      });

      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        const consumerPackagePath = initialization.blueprint.packages[0]!.path;
        const addition = planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "provider",
          linkFrom: [consumerPackagePath],
        });
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.projectProjections,
        });
        await execa("pnpm", ["install"], { cwd: targetDir });

        const consumerRoot = path.join(targetDir, consumerPackagePath);
        await writeFile(
          path.join(consumerRoot, "src/decorate.ts"),
          [
            "export function decorate(message: string): string {",
            "  return `[${message}]`;",
            "}",
            "",
          ].join("\n"),
        );
        await writeFile(
          path.join(consumerRoot, "src/observe-provider.ts"),
          [
            'import { greet } from "@demo/provider";',
            "",
            'import { decorate } from "#/decorate";',
            "",
            'console.log(decorate(greet("Ada").message));',
            "",
          ].join("\n"),
        );
        const providerEntry = path.join(
          targetDir,
          "packages/provider/src/index.ts",
        );
        await writeFile(
          providerEntry,
          (await readFile(providerEntry, "utf8")).replace(
            "Hello,",
            "Linked source:",
          ),
        );
        const sourceOutput = await execa(
          "node",
          ["--conditions=source", "src/observe-provider.ts"],
          { cwd: consumerRoot },
        ).then(({ stdout }) => stdout);
        assert.strictEqual(sourceOutput, "[Linked source: Ada]");

        await assert.rejects(
          execa(
            "pnpm",
            ["--filter", `./${consumerPackagePath}`, "run", "build"],
            { cwd: targetDir },
          ),
        );

        const dryRun = await execa(
          "pnpm",
          ["exec", "turbo", "run", "typecheck", "build", "--dry-run=json"],
          { cwd: targetDir },
        );
        const tasks = (
          JSON.parse(dryRun.stdout) as {
            tasks: readonly {
              taskId: string;
              command: string;
              dependencies: readonly string[];
            }[];
          }
        ).tasks;
        const consumerBuild = tasks.find(
          ({ taskId }) => taskId === "@demo/lib#build",
        );
        const consumerTypecheck = tasks.find(
          ({ taskId }) => taskId === "@demo/lib#typecheck",
        );
        assertContains(consumerBuild?.dependencies, "@demo/provider#build");
        assertContains(
          consumerTypecheck?.dependencies,
          "@demo/provider#typecheck",
        );
        assertDoesNotContain(
          consumerTypecheck?.dependencies,
          "@demo/provider#build",
        );
        assert.strictEqual(
          consumerBuild?.command,
          "tsc -p tsconfig.build.json --pretty false",
        );
        assert.doesNotMatch(consumerBuild?.command, /pnpm|turbo/u);

        await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
          cwd: targetDir,
        });
        await rm(path.join(targetDir, "packages/provider/src"), {
          recursive: true,
          force: true,
        });
        const distributionOutput = await execa(
          "node",
          ["dist/observe-provider.js"],
          { cwd: consumerRoot },
        ).then(({ stdout }) => stdout);
        assert.strictEqual(distributionOutput, sourceOutput);
        assertContains(
          await readFile(
            path.join(targetDir, "packages/provider/dist/index.d.ts"),
            "utf8",
          ),
          "declare function greet",
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it(
    "discovers unregistered repair tasks, orders formatting after lint fixes, and keeps successful logs",
    { timeout: 180_000 },
    async () => {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-ts-lib-fix-")),
        "demo-lib",
      );
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
            0,
            releaseToolchainSnapshot.nodeVersion.indexOf("."),
          ),
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
        },
      });
      const plan = planGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await mkdir(path.join(targetDir, "apps/repair"), { recursive: true });
      await writeFile(
        path.join(targetDir, "apps/repair/package.json"),
        JSON.stringify({
          name: "@demo/repair",
          private: true,
          scripts: {
            "lint:fix":
              "node --input-type=module --eval \"import { writeFileSync } from 'node:fs'; writeFileSync('repair.txt', 'lint-fixed')\"",
            "format:write":
              "node --input-type=module --eval \"import { readFileSync, writeFileSync } from 'node:fs'; if (readFileSync('repair.txt', 'utf8') !== 'lint-fixed') process.exit(1); writeFileSync('repair.txt', 'formatted')\"",
          },
        }),
      );
      await execa("pnpm", ["install"], { cwd: targetDir });

      const dryRun = await execa(
        "pnpm",
        ["exec", "turbo", "run", "lint:fix", "format:write", "--dry-run=json"],
        { cwd: targetDir },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly {
            taskId: string;
            dependencies: readonly string[];
            resolvedTaskDefinition: { cache: boolean };
          }[];
        }
      ).tasks;
      assertMatches(
        tasks,
        arrayContaining([
          objectContaining({ taskId: "//#lint:fix" }),
          objectContaining({ taskId: "//#format:write" }),
          objectContaining({ taskId: "@demo/repair#lint:fix" }),
          objectContaining({ taskId: "@demo/repair#format:write" }),
        ]),
      );
      assertContains(
        tasks.find((task) => task.taskId === "//#format:write")?.dependencies,
        "//#lint:fix",
      );
      assertContains(
        tasks.find((task) => task.taskId === "@demo/repair#format:write")
          ?.dependencies,
        "@demo/repair#lint:fix",
      );
      assert.strictEqual(
        tasks.find((task) => task.taskId === "@demo/repair#lint:fix")
          ?.resolvedTaskDefinition.cache,
        false,
      );
      assert.strictEqual(
        tasks.find((task) => task.taskId === "@demo/repair#format:write")
          ?.resolvedTaskDefinition.cache,
        false,
      );

      const fix = await execa("pnpm", ["run", "fix"], { cwd: targetDir });
      assertContains(`${fix.stdout}\n${fix.stderr}`, "@demo/repair:lint:fix");
      assertContains(
        `${fix.stdout}\n${fix.stderr}`,
        "@demo/repair:format:write",
      );
      assert.strictEqual(
        await readFile(path.join(targetDir, "apps/repair/repair.txt"), "utf8"),
        "formatted",
      );
    },
  );

  void it(
    "discovers a package that implements only one repair task",
    { timeout: 180_000 },
    async () => {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-ts-lib-single-fix-")),
        "demo-lib",
      );
      const plan = planGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        context: createGenerationContext({
          targetDir,
          defaultPackageScope: "demo",
          toolchain: {
            nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
              0,
              releaseToolchainSnapshot.nodeVersion.indexOf("."),
            ),
            packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
          },
        }),
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await mkdir(path.join(targetDir, "apps/lint-only"), { recursive: true });
      await writeFile(
        path.join(targetDir, "apps/lint-only/package.json"),
        JSON.stringify({
          name: "@demo/lint-only",
          private: true,
          scripts: {
            "lint:fix":
              "node --input-type=module --eval \"import { writeFileSync } from 'node:fs'; writeFileSync('repair.txt', 'lint-fixed')\"",
          },
        }),
      );
      await execa("pnpm", ["install"], { cwd: targetDir });

      const dryRun = await execa(
        "pnpm",
        ["exec", "turbo", "run", "lint:fix", "format:write", "--dry-run=json"],
        { cwd: targetDir },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly { command: string; taskId: string }[];
        }
      ).tasks;
      assertContainsEqual(
        tasks,
        objectContaining({
          command: stringContaining("writeFileSync"),
          taskId: "@demo/lint-only#lint:fix",
        }),
      );
      assertContainsEqual(
        tasks,
        objectContaining({
          command: "<NONEXISTENT>",
          taskId: "@demo/lint-only#format:write",
        }),
      );

      const fix = await execa("pnpm", ["run", "fix"], { cwd: targetDir });
      assertContains(
        `${fix.stdout}\n${fix.stderr}`,
        "@demo/lint-only:lint:fix",
      );
      assertDoesNotContain(
        `${fix.stdout}\n${fix.stderr}`,
        "@demo/lint-only:format:write",
      );
      assert.strictEqual(
        await readFile(
          path.join(targetDir, "apps/lint-only/repair.txt"),
          "utf8",
        ),
        "lint-fixed",
      );
    },
  );
});
