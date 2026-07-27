import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  templateSources,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, expectTypeOf, it } from "vitest";

import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import {
  renderNewProject,
  type CopyFileOperation,
} from "#template-core/renderer";

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
        "format:check":
          "oxfmt --list-different --config ../../oxfmt.config.ts .",
        "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
        lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts --ignore-pattern node_modules .",
        "lint:fix":
          "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
        typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
      },
    });
    expect(contribution).not.toHaveProperty("checks");
    expect(contribution).not.toHaveProperty("fixes");
    expect(contribution.manifest).toMatchObject({
      scripts: {
        "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
        "lint:fix":
          "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
      },
    });
    expect(contribution.operations).toContainEqual({
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "turbo.json",
      to: "packages/demo-library/turbo.json",
    });
    expect(contribution.operations).toContainEqual({
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "tsconfig.build.json",
      to: "packages/demo-library/tsconfig.build.json",
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
          fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
        },
      },
    });
    expect(plan).not.toHaveProperty("checks");
    expect(plan).not.toHaveProperty("fixes");
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
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    expect(devcontainerDockerfile).toContain(
      "apt-get install -y --no-install-recommends ca-certificates git",
    );
    expect(devcontainerDockerfile).toContain(
      'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
    );
    expect(devcontainerDockerfile).toContain(
      'corepack prepare "${PACKAGE_MANAGER_PIN}" --activate',
    );
    expect(devcontainerDockerfile).toContain(
      "git config --system init.defaultBranch main",
    );
    const gitignorePath = path.join(targetDir, ".gitignore");
    await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
      ".pnpm-store/",
    );
    await writeFile(gitignorePath, "private-artifacts/\n", { flag: "a" });
    const turboPath = path.join(targetDir, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    turbo.tasks.custom = { cache: false };
    await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

    const addition = planGeneratedRepositoryPackageAddition({
      definition: tsLibDefinition,
      context,
      blueprint: initialization.blueprint,
      packageLeafName: "utilities",
    });
    expect(addition.operations).toContainEqual(
      expect.objectContaining({
        kind: "copyFile",
        to: ".gitignore",
        provenance: expect.objectContaining({
          planningContribution: "foundationPlan",
        }),
      }),
    );
    expect(
      addition.operations.filter(
        (operation) => "overwrite" in operation && operation.overwrite,
      ),
    ).toEqual([]);
    expect(addition.operations).toContainEqual(
      expect.objectContaining({
        kind: "mergeJsonTemplate",
        to: "turbo.json",
        provenance: expect.objectContaining({
          planningContribution: "foundationPlan",
        }),
      }),
    );
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.projectProjections,
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/utilities/package.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ name: "@demo/utilities" });
    await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
      "private-artifacts/",
    );
    await expect(
      readFile(turboPath, "utf8").then((source) => JSON.parse(source)),
    ).resolves.toMatchObject({
      tasks: { custom: { cache: false } },
    });

    const secondAddition = planGeneratedRepositoryPackageAddition({
      definition: tsLibDefinition,
      context,
      blueprint: addition.blueprint,
      packageLeafName: "models",
    });
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...secondAddition.projectProjections,
    });
    const updatedGitignore = await readFile(gitignorePath, "utf8");
    expect(updatedGitignore.match(/^private-artifacts\/$/gmu)).toHaveLength(1);
  });

  it("observes linked provider source changes without a provider build", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-source-link-"),
    );
    const targetDir = path.join(workspace, "consumer");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
        context,
        blueprint: initialization.blueprint,
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
      expect(Object.keys(providerManifest.exports["."])).toEqual([
        "source",
        "types",
        "default",
      ]);
      await expect(
        readFile(
          path.join(targetDir, consumerPackagePath, "package.json"),
          "utf8",
        ).then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        dependencies: { "@demo/provider": "workspace:*" },
        dependenciesMeta: { "@demo/provider": { injected: false } },
      });

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

      await expect(sourceCommand().then(({ stdout }) => stdout)).resolves.toBe(
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
      await expect(sourceCommand().then(({ stdout }) => stdout)).resolves.toBe(
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
  }, 180_000);

  it("uses native TypeScript 7 to enforce erasable source syntax", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-erasability-"),
    );
    const targetDir = path.join(workspace, "library");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
      const compilerVersion = await execa(
        "pnpm",
        ["--filter", `./${packagePath}`, "exec", "tsc", "--version"],
        { cwd: targetDir },
      ).then(({ stdout }) => stdout);
      expect(compilerVersion).toMatch(/^Version 7\./u);

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
      expect(rejected.exitCode).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
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
  }, 180_000);

  it("builds linked distributions in Turbo order and runs without source", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-dist-link-"),
    );
    const targetDir = path.join(workspace, "consumer");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
        context,
        blueprint: initialization.blueprint,
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
      expect(sourceOutput).toBe("[Linked source: Ada]");

      await expect(
        execa(
          "pnpm",
          ["--filter", `./${consumerPackagePath}`, "run", "build"],
          { cwd: targetDir },
        ),
      ).rejects.toThrow();

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
        ({ taskId }) => taskId === "@demo/consumer#build",
      );
      const consumerTypecheck = tasks.find(
        ({ taskId }) => taskId === "@demo/consumer#typecheck",
      );
      expect(consumerBuild?.dependencies).toContain("@demo/provider#build");
      expect(consumerTypecheck?.dependencies).toContain(
        "@demo/provider#typecheck",
      );
      expect(consumerTypecheck?.dependencies).not.toContain(
        "@demo/provider#build",
      );
      expect(consumerBuild?.command).toBe(
        "tsc -p tsconfig.build.json --pretty false",
      );
      expect(consumerBuild?.command).not.toMatch(/pnpm|turbo/u);

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
      expect(distributionOutput).toBe(sourceOutput);
      await expect(
        readFile(
          path.join(targetDir, "packages/provider/dist/index.d.ts"),
          "utf8",
        ),
      ).resolves.toContain("declare function greet");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("discovers unregistered repair tasks, orders formatting after lint fixes, and keeps successful logs", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-fix-")),
      "demo-lib",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "//#lint:fix" }),
        expect.objectContaining({ taskId: "//#format:write" }),
        expect.objectContaining({ taskId: "@demo/repair#lint:fix" }),
        expect.objectContaining({ taskId: "@demo/repair#format:write" }),
      ]),
    );
    expect(
      tasks.find((task) => task.taskId === "//#format:write")?.dependencies,
    ).toContain("//#lint:fix");
    expect(
      tasks.find((task) => task.taskId === "@demo/repair#format:write")
        ?.dependencies,
    ).toContain("@demo/repair#lint:fix");
    expect(
      tasks.find((task) => task.taskId === "@demo/repair#lint:fix")
        ?.resolvedTaskDefinition.cache,
    ).toBe(false);
    expect(
      tasks.find((task) => task.taskId === "@demo/repair#format:write")
        ?.resolvedTaskDefinition.cache,
    ).toBe(false);

    const fix = await execa("pnpm", ["run", "fix"], { cwd: targetDir });
    expect(`${fix.stdout}\n${fix.stderr}`).toContain("@demo/repair:lint:fix");
    expect(`${fix.stdout}\n${fix.stderr}`).toContain(
      "@demo/repair:format:write",
    );
    await expect(
      readFile(path.join(targetDir, "apps/repair/repair.txt"), "utf8"),
    ).resolves.toBe("formatted");
  }, 180_000);

  it("discovers a package that implements only one repair task", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-single-fix-")),
      "demo-lib",
    );
    const plan = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context: createGenerationContext({
        targetDir,
        scope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
    expect(tasks).toContainEqual(
      expect.objectContaining({
        command: expect.stringContaining("writeFileSync"),
        taskId: "@demo/lint-only#lint:fix",
      }),
    );
    expect(tasks).toContainEqual(
      expect.objectContaining({
        command: "<NONEXISTENT>",
        taskId: "@demo/lint-only#format:write",
      }),
    );

    const fix = await execa("pnpm", ["run", "fix"], { cwd: targetDir });
    expect(`${fix.stdout}\n${fix.stderr}`).toContain(
      "@demo/lint-only:lint:fix",
    );
    expect(`${fix.stdout}\n${fix.stderr}`).not.toContain(
      "@demo/lint-only:format:write",
    );
    await expect(
      readFile(path.join(targetDir, "apps/lint-only/repair.txt"), "utf8"),
    ).resolves.toBe("lint-fixed");
  }, 180_000);
});
