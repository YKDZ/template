import assert from "node:assert/strict";
import fsPromises, {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import {
  installedIntegrationSignal,
  throwIfInstalledIntegrationWasCancelled,
} from "../../test-support/installed-integration-signal.ts";
import {
  cleanupSharedTsLibProviderRepository,
  withSharedTsLibProviderRepository,
} from "../../test-support/ts-lib-provider-behavior.ts";
import { tsLibDefinition } from "./definition.ts";

void describe("ts-lib Built-in Preset Definition behavior", () => {
  after(async () => {
    await cleanupSharedTsLibProviderRepository();
  });

  void it(
    "observes linked provider source changes without a provider build",
    { timeout: 180_000 },
    async () => {
      await withSharedTsLibProviderRepository(
        "source-link",
        async ({ targetDir, consumerPackagePath }) => {
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
          assert.partialDeepStrictEqual(consumerManifest, {
            dependencies: { "@demo/provider": "workspace:*" },
          });
          assert.ok(!("dependenciesMeta" in (consumerManifest ?? {})));

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
        },
      );
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
        throwIfInstalledIntegrationWasCancelled();
        await execa("pnpm", ["install"], {
          cwd: targetDir,
          cancelSignal: installedIntegrationSignal(),
        });
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
        assert.ok(rootConfig.files.includes("./scripts/automation-probe.ts"));
        assert.ok(
          !rootConfig.files.includes(
            `./${packagePath}/scripts/automation-probe.ts`,
          ),
        );
        assert.ok(
          packageConfig.files.includes("./scripts/automation-probe.ts"),
        );
        assert.ok(
          !packageBuildConfig.files.includes("./scripts/automation-probe.ts"),
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
        assert.ok(
          `${rejected.stdout}\n${rejected.stderr}`.includes(
            "erasableSyntaxOnly",
          ),
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
      await withSharedTsLibProviderRepository(
        "distribution-link",
        async ({ targetDir, consumerPackagePath }) => {
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
          assert.ok(consumerBuild !== undefined);
          assert.ok(consumerTypecheck !== undefined);
          assert.ok(
            consumerBuild.dependencies.includes("@demo/provider#build"),
          );
          assert.ok(
            consumerTypecheck.dependencies.includes("@demo/provider#typecheck"),
          );
          assert.ok(
            !consumerTypecheck.dependencies.includes("@demo/provider#build"),
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
          assert.ok(
            (
              await readFile(
                path.join(targetDir, "packages/provider/dist/index.d.ts"),
                "utf8",
              )
            ).includes("declare function greet"),
          );
        },
      );
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
      await writeFile(
        path.join(targetDir, "apps/repair/turbo.json"),
        JSON.stringify({
          extends: ["//"],
          tags: ["app"],
          tasks: {
            "lint:fix": {
              dependsOn: [],
              inputs: [],
              outputs: [],
              cache: false,
              tags: ["work:repair"],
            },
            "format:write": {
              dependsOn: ["lint:fix"],
              inputs: [],
              outputs: [],
              cache: false,
              tags: ["work:repair"],
            },
          },
        }),
      );
      throwIfInstalledIntegrationWasCancelled();
      await execa("pnpm", ["install"], {
        cwd: targetDir,
        cancelSignal: installedIntegrationSignal(),
      });

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
      for (const taskId of [
        "//#lint:fix",
        "//#format:write",
        "@demo/repair#lint:fix",
        "@demo/repair#format:write",
      ]) {
        assert.ok(tasks.some((task) => task.taskId === taskId));
      }
      const rootFormatWrite = tasks.find(
        (task) => task.taskId === "//#format:write",
      );
      assert.ok(rootFormatWrite !== undefined);
      assert.ok(rootFormatWrite.dependencies.includes("//#lint:fix"));
      const packageFormatWrite = tasks.find(
        (task) => task.taskId === "@demo/repair#format:write",
      );
      assert.ok(packageFormatWrite !== undefined);
      assert.ok(
        packageFormatWrite.dependencies.includes("@demo/repair#lint:fix"),
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
      assert.ok(
        `${fix.stdout}\n${fix.stderr}`.includes("@demo/repair:lint:fix"),
      );
      assert.ok(
        `${fix.stdout}\n${fix.stderr}`.includes("@demo/repair:format:write"),
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
      await writeFile(
        path.join(targetDir, "apps/lint-only/turbo.json"),
        JSON.stringify({
          extends: ["//"],
          tags: ["app"],
          tasks: {
            "lint:fix": {
              dependsOn: [],
              inputs: [],
              outputs: [],
              cache: false,
              tags: ["work:repair"],
            },
          },
        }),
      );
      throwIfInstalledIntegrationWasCancelled();
      await execa("pnpm", ["install"], {
        cwd: targetDir,
        cancelSignal: installedIntegrationSignal(),
      });

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
      assert.ok(
        tasks.some(
          (task) =>
            task.command.includes("writeFileSync") &&
            task.taskId === "@demo/lint-only#lint:fix",
        ),
      );

      const fix = await execa("pnpm", ["run", "fix"], { cwd: targetDir });
      assert.ok(
        `${fix.stdout}\n${fix.stderr}`.includes("@demo/lint-only:lint:fix"),
      );
      assert.ok(
        !`${fix.stdout}\n${fix.stderr}`.includes(
          "@demo/lint-only:format:write",
        ),
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

  void it(
    "retries cleanup of the shared installed provider repository after two failures",
    { timeout: 120_000 },
    async () => {
      const diagnosticsRoot = await mkdtemp(
        path.join(tmpdir(), "template-ts-lib-cleanup-diagnostics-"),
      );
      const diagnosticsVariable =
        "TEMPLATE_BUILTIN_PRESET_DIAGNOSTICS_DIR" as const;
      const priorDiagnosticsRoot = process.env[diagnosticsVariable];
      await withSharedTsLibProviderRepository(
        "cleanup-retry",
        async () => undefined,
      );

      const originalRm = fsPromises.rm.bind(fsPromises);
      let sharedWorkspace: string | undefined;
      let failedRemovals = 0;
      const rmMock = mock.method(
        fsPromises,
        "rm",
        async (
          target: Parameters<typeof fsPromises.rm>[0],
          options?: Parameters<typeof fsPromises.rm>[1],
        ) => {
          const targetPath = path.resolve(String(target));
          if (
            path
              .basename(targetPath)
              .startsWith("template-ts-lib-provider-shared-")
          ) {
            sharedWorkspace = targetPath;
            failedRemovals += 1;
            throw new Error(
              `shared provider removal attempt ${failedRemovals}`,
            );
          }
          return await originalRm(target, options);
        },
      );
      syncBuiltinESMExports();
      process.env[diagnosticsVariable] = diagnosticsRoot;
      let cleanupReport:
        | {
            readonly scenario: string;
            readonly cause: {
              readonly errors?: readonly { readonly message: string }[];
            };
          }
        | undefined;
      try {
        await assert.rejects(cleanupSharedTsLibProviderRepository(), {
          name: "AggregateError",
        });
        assert.strictEqual(failedRemovals, 2);
        assert.ok(sharedWorkspace);
        const reports = await Promise.all(
          (await readdir(diagnosticsRoot)).map(
            async (entry) =>
              JSON.parse(
                await readFile(
                  path.join(diagnosticsRoot, entry, "failure.json"),
                  "utf8",
                ),
              ) as {
                readonly scenario: string;
                readonly cause: {
                  readonly errors?: readonly { readonly message: string }[];
                };
              },
          ),
        );
        cleanupReport = reports.find(
          (report) => report.scenario === "ts-lib-shared-provider-cleanup",
        );
      } finally {
        rmMock.mock.restore();
        syncBuiltinESMExports();
        if (priorDiagnosticsRoot === undefined)
          delete process.env[diagnosticsVariable];
        else process.env[diagnosticsVariable] = priorDiagnosticsRoot;
      }

      await cleanupSharedTsLibProviderRepository();
      await assert.rejects(stat(sharedWorkspace), { code: "ENOENT" });
      assert.ok(cleanupReport);
      assert.deepStrictEqual(
        cleanupReport.cause.errors?.map((error) => error.message),
        [
          "shared provider removal attempt 1",
          "shared provider removal attempt 2",
        ],
      );
      await rm(diagnosticsRoot, { recursive: true, force: true });
    },
  );
});
