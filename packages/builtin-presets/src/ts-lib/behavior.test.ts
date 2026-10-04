import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  prepareGeneratedRepositoryInitialization,
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
import { describe, expect, expectTypeOf, it } from "vitest";

import { tsLibDefinition } from "./definition.ts";

describe("ts-lib Built-in Preset Definition behavior", () => {
  it("owns conventional task scripts without a package check registration", () => {
    expect(tsLibDefinition.initialPrimaryPackage.defaultLeafName).toBe("lib");
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

    expect(resolveBuiltInTemplateSource(tsLibDefinition.source, ".")).toMatch(
      /templates[\\/]ts-lib$/,
    );
    expect(contribution.definition).toEqual({
      name: "@demo/lib",
      path: "packages/lib",
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
        "format:check": "oxfmt --list-different .",
        "format:write": "oxfmt --write .",
        lint: "oxlint --quiet --format=unix --ignore-pattern node_modules .",
        "lint:fix": "oxlint --format=unix . --fix",
        typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
      },
    });
    expect(contribution).not.toHaveProperty("checks");
    expect(contribution).not.toHaveProperty("fixes");
    expect(contribution.manifest).toMatchObject({
      scripts: {
        "format:write": "oxfmt --write .",
        "lint:fix": "oxlint --format=unix . --fix",
      },
    });
    expect(contribution.operations).toContainEqual({
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "turbo.json",
      to: "packages/lib/turbo.json",
    });
    expect(contribution.operations).toContainEqual({
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
    expect(rootManifest).toMatchObject({
      value: {
        scripts: {
          check:
            "pnpm run boundaries && turbo run format:check lint typecheck build test test:e2e --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
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

  it("composes the root boundary task with a checked isolation entry", () => {
    const context = {
      targetDir: "/tmp/demo-library",
      repositoryName: "demo-library",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    };
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
        devDependencies: { typescript: "catalog:", "typescript-7": "catalog:" },
        scripts: {
          boundaries:
            "turbo boundaries --no-color && node --conditions=source scripts/check-package-boundaries.ts && node --conditions=source scripts/check-toolchain-versions.ts",
          check:
            "pnpm run boundaries && turbo run format:check lint typecheck build test test:e2e --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
        },
      },
    });
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        kind: "copyFile",
        source: templateSources.foundation,
        from: "scripts/check-package-boundaries.ts",
        to: "scripts/check-package-boundaries.ts",
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
      defaultPackageScope: "demo",
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
      await readFile(path.join(targetDir, "packages/lib/src/index.ts"), "utf8"),
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
      'corepack enable --install-directory "$PNPM_HOME"',
    );
    expect(devcontainerDockerfile).not.toContain("corepack prepare");
    expect(devcontainerDockerfile).not.toContain("PACKAGE_MANAGER_PIN");
    expect(devcontainerDockerfile).not.toContain("COREPACK_HOME");
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
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
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
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
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
      expect(Object.keys(providerManifest.exports["."])).toEqual([
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
      expect(consumerManifest).toMatchObject({
        dependencies: { "@demo/provider": "workspace:*" },
      });
      expect(consumerManifest).not.toHaveProperty("dependenciesMeta");

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

  it("blocks basic cross-package filesystem paths from the root check entry", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-filesystem-isolation-"),
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
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const consumerPackagePath = initialization.blueprint.packages[0]!.path;

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "provider",
          linkFrom: [consumerPackagePath],
        }).projectProjections,
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const rootCheck = async () =>
        execa("pnpm", ["run", "check"], {
          cwd: targetDir,
          reject: false,
        });
      const writePackageFile = async (
        relativePath: string,
        lines: readonly string[],
      ) =>
        writeFile(
          path.join(targetDir, consumerPackagePath, relativePath),
          lines.join("\n"),
        );
      for (const directory of ["src/data", "test", "scripts"]) {
        await mkdir(path.join(targetDir, consumerPackagePath, directory), {
          recursive: true,
        });
      }
      await writeFile(
        path.join(targetDir, consumerPackagePath, "src/data/notes.md"),
        "notes\n",
      );
      const rootCheckCommand =
        "pnpm run boundaries && turbo run format:check lint typecheck build test test:e2e";
      const clean = await rootCheck();
      expect(clean.exitCode).toBe(0);
      const cleanOutput = `${clean.stdout}\n${clean.stderr}`;
      expect(cleanOutput).toContain(rootCheckCommand);
      expect(cleanOutput).toContain(
        "Running format:check, lint, typecheck, build, test, test:e2e",
      );

      const samePackagePath = path.join(
        targetDir,
        consumerPackagePath,
        "src/same-package-read.ts",
      );
      await writeFile(
        samePackagePath,
        [
          'import { readFileSync } from "node:fs";',
          'import { readFileSync as read } from "node:fs";',
          "",
          'export const localNotes = readFileSync("./src/data/notes.md", "utf8");',
          "",
          'export const aliasedNotes = read("./src/index.ts", "utf8");',
          "",
        ].join("\n"),
      );

      // 07A1 静态路径形态的同包正例，覆盖 src、test、scripts 与 Node 工具配置四种入口。
      await writePackageFile("src/import-meta-lookup.ts", [
        'import { readFileSync } from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const dataFile = "notes.md";',
        "const dataUrl = new URL(`../src/data/${dataFile}`, import.meta.url);",
        "const entryPath = fileURLToPath(import.meta.url);",
        "const here = path.dirname(entryPath);",
        "",
        "export function readData(): string {",
        '  return readFileSync(dataUrl, "utf8");',
        "}",
        "",
        "export function readEntry(): string {",
        '  return readFileSync(path.join(here, "index.ts"), "utf8");',
        "}",
        "",
      ]);
      await writePackageFile("src/static-path-lookup.ts", [
        'import { readFileSync } from "node:fs";',
        'import path from "node:path";',
        "",
        'const dataDirectory = "./src/data";',
        'const notesName = path.join(dataDirectory, "notes.md");',
        "const notesFile = `./src/${notesName}`;",
        "",
        "export function notes(): string {",
        '  return readFileSync(notesFile, "utf8");',
        "}",
        "",
      ]);
      await writePackageFile("test/same-package-url.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const entryUrl = new URL("../src/index.ts", import.meta.url);',
        "const entryPath = fileURLToPath(entryUrl);",
        "",
        "export function entrySource(): string {",
        '  return readFileSync(entryPath, "utf8");',
        "}",
        "",
      ]);
      await writePackageFile("scripts/same-package-resolve.ts", [
        'import { readdirSync } from "node:fs";',
        'import path from "node:path";',
        "",
        'const sourceDirectory = path.resolve("src");',
        "",
        "export function sourceEntries(): string[] {",
        "  return readdirSync(sourceDirectory);",
        "}",
        "",
      ]);
      await writePackageFile("vitest.config.ts", [
        'import { existsSync } from "node:fs";',
        'import path from "node:path";',
        "",
        'const dataFile = "notes.md";',
        'const notesPath = path.join("./src/data", dataFile);',
        "",
        "const dataFileExists = existsSync(notesPath);",
        "",
        "export default { dataFileExists };",
        "",
      ]);

      // 08 正例：普通未知工具的 "../" 字符串参数不被猜成 fs 路径调用。
      await writePackageFile("src/unknown-tool.ts", [
        "function renderReference(entry: string): string {",
        "  return `see ${entry}`;",
        "}",
        "",
        'export const referenceHint = renderReference("../provider/src/internal.ts");',
        "",
      ]);
      // 08 正例：运行时数据库/临时目录形态的路径参数没有仓库定位线索，不属于本检查的阻断范围。
      await writePackageFile("src/runtime-dynamic.ts", [
        'import { mkdirSync, readFileSync } from "node:fs";',
        'import path from "node:path";',
        "",
        "interface JourneyContext {",
        "  workDir: string;",
        "}",
        "",
        "export function loadRuntimeConfig(configFile: string): string {",
        '  return readFileSync(configFile, "utf8");',
        "}",
        "",
        "export function ensureScratchDirectory(context: JourneyContext): void {",
        "  mkdirSync(context.workDir, { recursive: true });",
        "}",
        "",
        "export function readScratch(context: JourneyContext): string {",
        '  return readFileSync(path.join(context.workDir, "journey-ready.txt"), "utf8");',
        "}",
        "",
      ]);
      // 08 正例：形参 `readFileSync` 遮蔽 node:fs 导入时调用身份不可确认，不得误报；
      // 未被遮蔽的同名导入仍按同包目标判定。
      await writePackageFile("src/shadowed-api.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        "export function applyReader(readFileSync: (file: string) => string): string {",
        '  return readFileSync("../provider/src/index.ts");',
        "}",
        "",
        'export const ownNotes = readFileSync("./src/data/notes.md", "utf8");',
        "",
      ]);
      // LX-1 正例：嵌套 if/else 块内的 `var` 提升到包裹函数作用域，是合法的局部遮蔽；
      // 块外的本地调用不得被误认成导入的 fs API，即使实参写成跨包字面路径。
      // 同文件 top-level 的真实导入仍被求值，证明遮蔽只在包裹函数内生效。
      await writePackageFile("src/nested-var-shadow.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        "export function useReader(strip: boolean): string {",
        "  if (strip) {",
        "    var readFileSync = (file: string): string => file;",
        "  } else {",
        "    var readFileSync = (file: string): string => `wrapped ${file}`;",
        "  }",
        '  return readFileSync("../provider/src/index.ts");',
        "}",
        "",
        'export const ownNotes = readFileSync("./src/data/notes.md", "utf8");',
        "",
      ]);

      // 07 独立构造正例：不接 fs sink 的同包路径构造（initializer、export、对象字段）
      // 与外层求值同构；无仓库定位线索的运行时目录构造不误认。
      await writePackageFile("src/independent-construction-pass.ts", [
        'import { mkdtempSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const anchorUrl = new URL("./anchor.json", import.meta.url);',
        "",
        "export const anchorPath = fileURLToPath(anchorUrl);",
        "",
        'export const packageEntry = path.join("./src", "index.ts");',
        "",
        "export function scratch(prefix: string): string {",
        "  return mkdtempSync(path.join(tmpdir(), prefix));",
        "}",
        "",
      ]);
      // 07 独立构造正例：形参 `URL` 遮蔽全局构造器时，同文件的 new URL 身份不可确认，
      // 与既有求值语义一致地整体不求值；未知成员的 path.join 无线索也不猜路径。
      await writePackageFile("src/independent-construction-shadow.ts", [
        'import path from "node:path";',
        "",
        "export function build(URL: typeof globalThis.URL): string {",
        '  const escaped = new URL("../../provider/private.json", import.meta.url);',
        "  return path.join(escaped.pathname, URL.name);",
        "}",
        "",
      ]);

      const passed = await rootCheck();
      expect(passed.exitCode).toBe(0);
      expect(`${passed.stdout}\n${passed.stderr}`).not.toContain(
        "包文件系统隔离",
      );

      const crossPackagePath = path.join(
        targetDir,
        consumerPackagePath,
        "src/provider-read.ts",
      );
      await writeFile(
        crossPackagePath,
        [
          'import fs from "node:fs";',
          "",
          "export const providerSource = fs.readFileSync(",
          '  "../provider/src/internal.ts",',
          '  "utf8",',
          ");",
          "",
        ].join("\n"),
      );
      const aliasedCrossPackagePath = path.join(
        targetDir,
        consumerPackagePath,
        "src/provider-read-aliased.ts",
      );
      await writeFile(
        aliasedCrossPackagePath,
        [
          'import { readFileSync as read } from "node:fs";',
          "",
          'export const aliasedProviderSource = read("../provider/src/internal.ts", "utf8");',
          "",
        ].join("\n"),
      );
      const rootTargetPath = path.join(
        targetDir,
        consumerPackagePath,
        "src/workspace-root-read.ts",
      );
      await writeFile(
        rootTargetPath,
        [
          'import { readdirSync as list } from "node:fs";',
          "",
          "export const workspaceRootEntries = list(",
          '  "../../",',
          ");",
          "",
        ].join("\n"),
      );
      // 07A1 静态路径形态的越界负例：兄弟包私有路径与仓库根目标，同样覆盖四种入口。
      await writePackageFile("src/import-meta-escape.ts", [
        'import { readdirSync, readFileSync } from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const siblingUrl = new URL("../../provider/src/internal.ts", import.meta.url);',
        "const internalModule = fileURLToPath(siblingUrl);",
        'const rootUrl = new URL("../../../package.json", import.meta.url);',
        "const manifestPath = fileURLToPath(rootUrl);",
        'const workspaceDirectories = path.join("..");',
        "",
        "export function providerSource(): string {",
        '  return readFileSync(internalModule, "utf8");',
        "}",
        "",
        "export function rootManifest(): string {",
        '  return readFileSync(manifestPath, "utf8");',
        "}",
        "",
        "export function packageEntries(): string[] {",
        "  return readdirSync(workspaceDirectories);",
        "}",
        "",
      ]);
      await writePackageFile("src/static-path-escape.ts", [
        'import { readFileSync, readdirSync } from "node:fs";',
        'import path from "node:path";',
        "",
        'const sibling = "provider";',
        "const internalPath = `../${sibling}/src/internal.ts`;",
        'const siblingDirectory = path.join("..", sibling);',
        "",
        "export function providerSource(): string {",
        '  return readFileSync(internalPath, "utf8");',
        "}",
        "",
        "export function siblingEntries(): string[] {",
        "  return readdirSync(siblingDirectory);",
        "}",
        "",
      ]);
      await writePackageFile("test/sibling-escape.ts", [
        'import { existsSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const siblingUrl = new URL("../../provider/src/internal.ts", import.meta.url);',
        "const internalPath = fileURLToPath(siblingUrl);",
        "",
        "export const internalExists = existsSync(internalPath);",
        "",
      ]);
      await writePackageFile("scripts/workspace-root-escape.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const manifestUrl = new URL("../../../package.json", import.meta.url);',
        "",
        "export function rootManifest(): string {",
        '  return readFileSync(fileURLToPath(manifestUrl), "utf8");',
        "}",
        "",
      ]);
      await writePackageFile("scripts/static-path-escape.ts", [
        'import { readdirSync } from "node:fs";',
        'import path from "node:path";',
        "",
        'const workspaceDirectories = path.resolve("..");',
        'const siblingSources = path.join(workspaceDirectories, "provider", "src");',
        "",
        "export function packageEntries(): string[] {",
        "  return readdirSync(workspaceDirectories);",
        "}",
        "",
        "export function siblingEntries(): string[] {",
        "  return readdirSync(siblingSources);",
        "}",
        "",
      ]);
      await writePackageFile("oxfmt.config.ts", [
        'import { readdirSync } from "node:fs";',
        'import path from "node:path";',
        "",
        'const siblingDir = "provider";',
        'const internalFile = path.join("..", siblingDir, "src/internal.ts");',
        'const siblingEntries = readdirSync(path.join("..", siblingDir, "src"));',
        "",
        "export default { internalFile, siblingEntries };",
        "",
      ]);

      // 08 不可验证负例：已确认 fs API 的路径参数带仓库定位线索（上跳相对片段或
      // import.meta.url 锚点经同文件顶层常量展开）但静态求值失败；报独立类别、
      // 源位置、所属包与修正方向，不虚构目标。
      await writePackageFile("src/unverifiable-shadow.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        "interface PathLike {",
        "  join(...segments: string[]): string;",
        "}",
        "",
        "export function loadProviderEntry(path: PathLike): string {",
        '  return readFileSync(path.join("..", "provider", "src", "index.ts"), "utf8");',
        "}",
        "",
      ]);
      await writePackageFile("src/unverifiable-dynamic-name.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        "export function readSiblingSource(sibling: string): string {",
        '  return readFileSync(`../${sibling}/src/internal.ts`, "utf8");',
        "}",
        "",
      ]);
      await writePackageFile("src/unverifiable-import-meta.ts", [
        'import { readdirSync } from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        "const entryDirectory = path.dirname(fileURLToPath(import.meta.url));",
        "",
        "export function neighborEntries(name: string): string[] {",
        "  return readdirSync(path.join(entryDirectory, name));",
        "}",
        "",
      ]);
      // 修复回归负例：同文件混合词法作用域。top-level 真实导入的确定越界必须仍被拦截，
      // 不能因无关函数存在同名 `readFileSync` 形参而被全局遮蔽；遮蔽调用本身不误认。
      await writePackageFile("src/mixed-lexical-escape.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        'export const leaked = readFileSync("../provider/src/internal.ts", "utf8");',
        "",
        "export function useReader(readFileSync: (file: string) => string): string {",
        '  return readFileSync("../provider/src/index.ts");',
        "}",
        "",
      ]);
      // LX-1 负例：另一函数的嵌套 var 不得遮蔽 top-level 真实导入的确定越界；
      // 本函数内被 var 遮蔽的本地调用（11:）不误认。
      await writePackageFile("src/nested-var-mixed.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        'export const leaked = readFileSync("../provider/src/internal.ts", "utf8");',
        "",
        "export function wrapper(strip: boolean): string {",
        "  if (strip) {",
        "    var readFileSync = (file: string): string => file;",
        "  } else {",
        "    var readFileSync = (file: string): string => `wrapped ${file}`;",
        "  }",
        '  return readFileSync("../provider/src/index.ts");',
        "}",
        "",
      ]);
      // repair3 负例：类 static 块的 var 是一个作用域边界，不并入外层函数；
      // 块后第 11 行是真实导入的确定越界必须报出，块内 7: 的遮蔽调用不误认。
      await writePackageFile("src/static-block-escape.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        "export function readInternal(): string {",
        "  class Local {",
        "    static {",
        "      var readFileSync = (file: string): string => file;",
        '      readFileSync("local string");',
        "    }",
        "  }",
        "  void Local;",
        '  return readFileSync("../provider/src/internal.ts", "utf8");',
        "}",
        "",
      ]);

      // 07 修复回归负例：无 fs sink 的独立路径构造（initializer、export、return、对象字段）
      // 按同一身份与求值判为越界；外层未知调用不吞掉已知的内层构造；同一构造嵌入已确认
      // fs 路径参数位时只保留来源调用一条诊断；含仓库线索的动态构造按不可验证报出。
      await writePackageFile("src/independent-construction-escape.ts", [
        'import path from "node:path";',
        "",
        "function asText(value: unknown): string {",
        "  return String(value);",
        "}",
        "",
        "export const privateResource = new URL(",
        '  "../../provider/private.json",',
        "  import.meta.url,",
        ");",
        "",
        "export const wrappedPrivate = asText(",
        '  new URL("../../provider/private.json", import.meta.url),',
        ");",
        "",
        "export function internalSource(): string {",
        '  return path.join("..", "provider", "src", "internal.ts");',
        "}",
        "",
        "export default {",
        '  workspaceRoot: path.resolve(".."),',
        "};",
        "",
      ]);
      await writePackageFile("src/construction-in-fs-argument.ts", [
        'import { readFileSync } from "node:fs";',
        "",
        "export const internal = readFileSync(",
        '  new URL("../../provider/src/internal.ts", import.meta.url),',
        '  "utf8",',
        ");",
        "",
      ]);
      await writePackageFile("src/construction-unverifiable-dynamic.ts", [
        "export function locate(name: string): URL {",
        "  return new URL(`../../provider/${name}/index.ts`, import.meta.url);",
        "}",
        "",
      ]);
      // RC-IC3 回归负例：外层已识别但含动态 cwd 不可完整求值时，外层仍按不可验证报出，
      // 内层 fileURLToPath(new URL(兄弟包私有目标)) 的确定越界必须保留原始位置、owner 与目标；
      // 完整可求值的透明包裹仍同来源一条；同目标不同来源不做全局去重。
      await writePackageFile("src/construction-outer-failed-inner-escape.ts", [
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        "const runtimeCwd = process.cwd();",
        "",
        "export const escaped = path.resolve(",
        "  runtimeCwd,",
        '  fileURLToPath(new URL("../../provider/private.json", import.meta.url)),',
        ");",
        "",
        "export const transparent = fileURLToPath(",
        '  new URL("../../provider/private.json", import.meta.url),',
        ");",
        "",
      ]);
      await writePackageFile("test/independent-construction-escape.ts", [
        'import { fileURLToPath } from "node:url";',
        "",
        "export default {",
        "  siblingSource: fileURLToPath(",
        '    new URL("../../provider/src/index.ts", import.meta.url),',
        "  ),",
        "};",
        "",
      ]);
      await writePackageFile("scripts/independent-construction-escape.ts", [
        'import path from "node:path";',
        "",
        "export default {",
        '  workspaceRoot: path.resolve(".."),',
        "};",
        "",
      ]);
      await writePackageFile("oxlint.config.ts", [
        'import path from "node:path";',
        "",
        "export default {",
        '  siblingDir: path.join("..", "provider"),',
        "};",
        "",
      ]);

      const failed = await rootCheck();
      expect(failed.exitCode).not.toBe(0);
      const failureOutput = `${failed.stdout}\n${failed.stderr}`;
      expect(failureOutput).toContain(rootCheckCommand);
      expect(failureOutput).toContain(
        "turbo boundaries --no-color && node --conditions=source scripts/check-package-boundaries.ts",
      );
      expect(failureOutput).toContain("Checking packages...");
      expect(failureOutput).toContain(
        `${consumerPackagePath}/src/provider-read.ts:3:`,
      );
      expect(failureOutput).toContain(
        `${consumerPackagePath}/src/provider-read-aliased.ts:3:`,
      );
      expect(failureOutput).toContain(`包 @demo/lib (${consumerPackagePath})`);
      expect(failureOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider/src/internal.ts",
      );
      expect(failureOutput).toContain("公开 exports");
      expect(failureOutput).toContain("Workspace Orchestration Package");
      expect(failureOutput).toContain(
        `${consumerPackagePath}/src/workspace-root-read.ts:3:`,
      );
      expect(failureOutput).toContain(
        `包 @demo/lib (${consumerPackagePath}) 通过本地文件系统路径访问 生成仓库根的私有路径 .。`,
      );
      expect(failureOutput).toContain(
        "把该仓库范围读取交给根 Workspace Orchestration Package 的任务，或改用本包内资源。",
      );
      for (const staticNegativePath of [
        `${consumerPackagePath}/src/import-meta-escape.ts`,
        `${consumerPackagePath}/src/static-path-escape.ts`,
        `${consumerPackagePath}/test/sibling-escape.ts`,
        `${consumerPackagePath}/scripts/workspace-root-escape.ts`,
        `${consumerPackagePath}/scripts/static-path-escape.ts`,
        `${consumerPackagePath}/oxfmt.config.ts`,
      ]) {
        expect(failureOutput).toContain(`${staticNegativePath}:`);
      }
      expect(failureOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider/src。",
      );
      expect(failureOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider。",
      );
      expect(failureOutput).toContain(
        `包 @demo/lib (${consumerPackagePath}) 通过本地文件系统路径访问 生成仓库根的私有路径 package.json。`,
      );
      expect(failureOutput).toContain(
        `包 @demo/lib (${consumerPackagePath}) 通过本地文件系统路径访问 生成仓库根的私有路径 packages。`,
      );
      // 07 独立构造负例：initializer/对象字段/return 中无 fs sink 的构造在各自来源位置报出，
      // 外层未知调用（asText）不吞掉内层已知构造；test、scripts 与 Node 工具配置入口同判。
      for (const constructionEscapePath of [
        `${consumerPackagePath}/src/independent-construction-escape.ts:7:`,
        `${consumerPackagePath}/src/independent-construction-escape.ts:13:`,
        `${consumerPackagePath}/src/independent-construction-escape.ts:17:`,
        `${consumerPackagePath}/src/independent-construction-escape.ts:21:`,
        `${consumerPackagePath}/test/independent-construction-escape.ts:4:`,
        `${consumerPackagePath}/scripts/independent-construction-escape.ts:4:`,
        `${consumerPackagePath}/oxlint.config.ts:4:`,
      ]) {
        expect(failureOutput).toContain(constructionEscapePath);
      }
      expect(failureOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider/private.json",
      );
      // IC3：同一构造嵌入已确认 fs 路径参数位时只保留来源调用一条诊断，不在构造位置重复。
      const embeddedConstructionLines = failureOutput
        .split("\n")
        .filter((line) =>
          line.includes(
            `${consumerPackagePath}/src/construction-in-fs-argument.ts:`,
          ),
        );
      expect(embeddedConstructionLines).toHaveLength(1);
      expect(embeddedConstructionLines[0]).toContain(
        `${consumerPackagePath}/src/construction-in-fs-argument.ts:3:`,
      );
      // RC-IC3：求值失败的外层 path.resolve 不吞掉内层确定越界——原始位置 8: 保留 owner 与目标；
      // 同目标不同来源各自保留一条（不做全局去重）；完整可求值的透明包裹
      // fileURLToPath(new URL(...)) 仍只在来源调用 11: 报一条，内层 12: 不重复。
      const ic3File = `${consumerPackagePath}/src/construction-outer-failed-inner-escape.ts`;
      expect(failureOutput).toContain(`${ic3File}:6:`);
      expect(failureOutput).toContain(`${ic3File}:8:`);
      expect(failureOutput).toContain(`${ic3File}:11:`);
      expect(failureOutput).not.toContain(`${ic3File}:12:`);
      expect(
        failureOutput
          .split("\n")
          .filter(
            (line) =>
              line.includes(`${ic3File}:`) &&
              line.includes("通过本地文件系统路径访问"),
          ),
      ).toHaveLength(2);
      for (const unverifiableNegativePath of [
        `${consumerPackagePath}/src/unverifiable-shadow.ts`,
        `${consumerPackagePath}/src/unverifiable-dynamic-name.ts`,
        `${consumerPackagePath}/src/unverifiable-import-meta.ts`,
      ]) {
        expect(failureOutput).toContain(`${unverifiableNegativePath}:`);
      }
      expect(failureOutput).toContain(
        `包 @demo/lib (${consumerPackagePath}) 在已支持的 node:fs API 路径参数中给出了带仓库定位线索但无法静态求值的表达式`,
      );
      expect(failureOutput).toContain(
        "修正方向：把该路径改写为可静态确定的本包内目标",
      );
      const unverifiableLines = failureOutput
        .split("\n")
        .filter((line) => line.includes("无法静态求值"));
      // RC-IC3 后：fs 类 3 条不变；独立构造类 2 条（动态模板 1 条 + 求值失败外层 1 条）。
      expect(unverifiableLines).toHaveLength(5);
      expect(
        unverifiableLines.filter((line) =>
          line.includes("已支持的 node:fs API 路径参数"),
        ),
      ).toHaveLength(3);
      // 07 独立构造的不可验证类别：动态片段带 `../` 仓库线索时按同一语义报出；
      // RC-IC3 外层自身仍按不可验证报出，不虚构目标。
      expect(
        unverifiableLines.filter((line) =>
          line.includes("已支持的独立路径构造"),
        ),
      ).toHaveLength(2);
      expect(failureOutput).toContain(
        `${consumerPackagePath}/src/construction-unverifiable-dynamic.ts:2:`,
      );
      expect(
        unverifiableLines.filter((line) => line.includes(`${ic3File}:`)),
      ).toHaveLength(1);
      for (const line of unverifiableLines) {
        expect(line).not.toContain("私有路径");
      }
      // 混合词法作用域文件：top-level 真实导入的确定越界在 3: 报出；
      // 形参遮蔽的调用（6:）既不报越界也不报不可验证。
      expect(failureOutput).toContain(
        `${consumerPackagePath}/src/mixed-lexical-escape.ts:3:`,
      );
      expect(failureOutput).not.toContain(
        `${consumerPackagePath}/src/mixed-lexical-escape.ts:6:`,
      );
      // LX-1：他函数嵌套 var 不屏蔽 top-level 越界（3: 报出）；
      // 本函数 var 遮蔽的调用（11:）既不报越界也不报不可验证。
      expect(failureOutput).toContain(
        `${consumerPackagePath}/src/nested-var-mixed.ts:3:`,
      );
      expect(failureOutput).not.toContain(
        `${consumerPackagePath}/src/nested-var-mixed.ts:11:`,
      );
      // repair3：static 块 var 不外泄，外层 11: 确定越界报出；块内 7: 遮蔽调用不误认。
      expect(failureOutput).toContain(
        `${consumerPackagePath}/src/static-block-escape.ts:11:`,
      );
      expect(failureOutput).not.toContain(
        `${consumerPackagePath}/src/static-block-escape.ts:7:`,
      );
      // 同包静态形态正例即使在越界失败的同一次运行里也不应被报出。
      for (const staticPositivePath of [
        "src/import-meta-lookup.ts",
        "src/static-path-lookup.ts",
        "test/same-package-url.ts",
        "scripts/same-package-resolve.ts",
        "vitest.config.ts",
        "src/unknown-tool.ts",
        "src/runtime-dynamic.ts",
        "src/shadowed-api.ts",
        "src/nested-var-shadow.ts",
        "src/independent-construction-pass.ts",
        "src/independent-construction-shadow.ts",
      ]) {
        expect(failureOutput).not.toContain(
          `${consumerPackagePath}/${staticPositivePath}:`,
        );
      }

      for (const staticNegativeFile of [
        "src/import-meta-escape.ts",
        "src/static-path-escape.ts",
        "test/sibling-escape.ts",
        "scripts/workspace-root-escape.ts",
        "scripts/static-path-escape.ts",
        "oxfmt.config.ts",
        "src/unverifiable-shadow.ts",
        "src/unverifiable-dynamic-name.ts",
        "src/unverifiable-import-meta.ts",
        "src/mixed-lexical-escape.ts",
        "src/nested-var-mixed.ts",
        "src/static-block-escape.ts",
        "src/independent-construction-escape.ts",
        "src/construction-in-fs-argument.ts",
        "src/construction-unverifiable-dynamic.ts",
        "src/construction-outer-failed-inner-escape.ts",
        "test/independent-construction-escape.ts",
        "scripts/independent-construction-escape.ts",
        "oxlint.config.ts",
      ]) {
        await rm(path.join(targetDir, consumerPackagePath, staticNegativeFile));
      }
      await rm(crossPackagePath);
      await rm(aliasedCrossPackagePath);
      await rm(rootTargetPath);
      await rm(samePackagePath);
      expect((await rootCheck()).exitCode).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 420_000);

  it("grants only the requested public package resource from the root check entry", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-public-resource-"),
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
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const consumerPackagePath = initialization.blueprint.packages[0]!.path;
    const providerPackagePath = "packages/provider";
    const providerSchemaSource = `${providerPackagePath}/src/schema.ts`;
    const providerAssetSource = `${providerPackagePath}/src/public-asset`;
    const schemaExport = {
      "./schema": {
        source: "./src/schema.ts",
        types: "./dist/schema.d.ts",
        default: "./dist/schema.js",
      },
    };

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "provider",
          linkFrom: [consumerPackagePath],
        }).projectProjections,
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const consumerManifestPath = path.join(
        targetDir,
        consumerPackagePath,
        "package.json",
      );
      const providerManifestPath = path.join(
        targetDir,
        providerPackagePath,
        "package.json",
      );
      const consumerManifestText = await readFile(consumerManifestPath, "utf8");
      const providerManifestText = await readFile(providerManifestPath, "utf8");
      const boundariesCheck = () =>
        execa("pnpm", ["run", "boundaries"], {
          cwd: targetDir,
          reject: false,
        });
      const checkText = (result: { stderr: string; stdout: string }) =>
        `${result.stdout}\n${result.stderr}`;
      const unverifiableLines = (output: string) =>
        output.split("\n").filter((line) => line.includes("无法静态求值"));
      const writePackageFile = async (
        relativePath: string,
        lines: readonly string[],
      ) =>
        writeFile(
          path.join(targetDir, consumerPackagePath, relativePath),
          `${lines.join("\n")}\n`,
        );
      const publishProviderExports = async (
        entries: Record<string, unknown>,
      ) => {
        const manifest = JSON.parse(providerManifestText) as {
          exports?: Record<string, unknown>;
        };
        manifest.exports = { ...manifest.exports, ...entries };
        await writeFile(
          providerManifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
      };
      const dropProviderDependency = async () => {
        const manifest = JSON.parse(consumerManifestText) as {
          dependencies?: Record<string, string>;
        };
        const dependencies = manifest.dependencies;
        if (dependencies === undefined) {
          throw new Error("@demo/lib 应声明 @demo/provider 的 workspace 依赖");
        }
        delete dependencies["@demo/provider"];
        await writeFile(
          consumerManifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
        );

        return Object.keys(dependencies);
      };
      const restoreManifests = async () => {
        await writeFile(consumerManifestPath, consumerManifestText);
        await writeFile(providerManifestPath, providerManifestText);
      };
      const removeFiles = async (relativePaths: readonly string[]) => {
        for (const relativePath of relativePaths) {
          await rm(path.join(targetDir, relativePath));
        }
      };

      // T09-1 前提：provider 从未构建，公开出口的 default/types target 文件都不存在。
      const providerDistState = await stat(
        path.join(targetDir, providerPackagePath, "dist"),
      ).then(
        () => "present",
        () => "missing",
      );
      expect(providerDistState).toBe("missing");
      await writeFile(
        path.join(targetDir, providerSchemaSource),
        'export const schemaName = "name";\n',
      );
      await publishProviderExports(schemaExport);
      await writePackageFile("src/public-resource-read.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function providerEntry(): string {",
        '  return readFileSync(fileURLToPath(import.meta.resolve("@demo/provider")), "utf8");',
        "}",
        "",
      ]);
      await writePackageFile("src/public-resource-schema.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const schemaSpecifier = "@demo/provider/schema";',
        "const schemaPath = fileURLToPath(",
        "  import.meta.resolve(schemaSpecifier),",
        ");",
        "",
        "export function providerSchema(): string {",
        '  return readFileSync(schemaPath, "utf8");',
        "}",
        "",
      ]);

      // T09-1 正例：声明依赖加有效公开 runtime 出口即授权被请求资源定位。
      const authorized = await boundariesCheck();
      expect(authorized.exitCode).toBe(0);
      const authorizedOutput = checkText(authorized);
      expect(authorizedOutput).toContain(
        "turbo boundaries --no-color && node --conditions=source scripts/check-package-boundaries.ts",
      );
      expect(authorizedOutput).not.toContain("公开资源分支");
      expect(authorizedOutput).not.toContain("包文件系统隔离");

      // T09-2 变异一：缺 consumer 依赖时明确失败，且检查器不自动建立依赖。
      const remainingDependencies = await dropProviderDependency();
      expect(remainingDependencies).not.toContain("@demo/provider");
      await writePackageFile("src/public-resource-missing-dependency.ts", [
        'import { existsSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export const providerEntryExists = existsSync(",
        '  fileURLToPath(import.meta.resolve("@demo/provider")),',
        ");",
        "",
      ]);
      const missingDependency = await boundariesCheck();
      expect(missingDependency.exitCode).not.toBe(0);
      const missingDependencyOutput = checkText(missingDependency);
      expect(missingDependencyOutput).toContain(
        `${consumerPackagePath}/src/public-resource-missing-dependency.ts:5:3 公开资源分支：包 @demo/lib (${consumerPackagePath}) 通过 import.meta.resolve("@demo/provider") 定位公开资源，但公开契约不成立。`,
      );
      expect(missingDependencyOutput).toContain(
        "@demo/provider 未声明为 @demo/lib 的 workspace 依赖",
      );
      expect(missingDependencyOutput).toContain("也不会自动建立依赖");
      expect(missingDependencyOutput).toContain(
        `在 @demo/lib 声明 @demo/provider 的 workspace 依赖`,
      );
      expect(unverifiableLines(missingDependencyOutput)).toHaveLength(0);
      await restoreManifests();
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-missing-dependency.ts`,
      ]);

      // T09-2 变异二：未公开的私有 subpath 不因包名已声明而放行。
      await writePackageFile("src/public-resource-private.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function providerInternal(): string {",
        '  return readFileSync(fileURLToPath(import.meta.resolve("@demo/provider/src/internal.ts")), "utf8");',
        "}",
        "",
      ]);
      const privateSubpath = await boundariesCheck();
      expect(privateSubpath.exitCode).not.toBe(0);
      const privateSubpathOutput = checkText(privateSubpath);
      expect(privateSubpathOutput).toContain(
        'import.meta.resolve("@demo/provider/src/internal.ts")',
      );
      expect(privateSubpathOutput).toContain(
        '@demo/provider 的 exports["./src/internal.ts"] 没有把该 subpath 公开为出口',
      );
      expect(privateSubpathOutput).toContain(
        "物理读取 @demo/provider 的私有布局",
      );
      expect(unverifiableLines(privateSubpathOutput)).toHaveLength(0);
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-private.ts`,
      ]);

      // T09-2 变异三：types 单独存在不证明 runtime 出口。
      await publishProviderExports({
        "./only-types": { types: "./dist/only-types.d.ts" },
        ...schemaExport,
      });
      await writePackageFile("src/public-resource-types-only.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function typeDeclaration(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/only-types")),',
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      const typesOnly = await boundariesCheck();
      expect(typesOnly.exitCode).not.toBe(0);
      const typesOnlyOutput = checkText(typesOnly);
      expect(typesOnlyOutput).toContain(
        '@demo/provider 的 exports["./only-types"] 只有 types 声明',
      );
      expect(typesOnlyOutput).toContain("类型不能单独证明 runtime 出口");
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-types-only.ts`,
      ]);

      // T09-2 变异四：target 越出 provider 包目录不是可用的公开出口。
      await publishProviderExports({
        "./escape": "../../../outside/x.js",
        ...schemaExport,
      });
      await writePackageFile("src/public-resource-escape.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function outsideTarget(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/escape")),',
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      const escapingTarget = await boundariesCheck();
      expect(escapingTarget.exitCode).not.toBe(0);
      const escapingTargetOutput = checkText(escapingTarget);
      expect(escapingTargetOutput).toContain(
        '@demo/provider 的 exports["./escape"] 的 runtime target 不是包内单个文件',
      );
      expect(escapingTargetOutput).toContain("不得越出 @demo/provider 包目录");
      await restoreManifests();
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-escape.ts`,
      ]);

      // T09-2 变异五（R09-RC-1）：target 是已存在目录或带尾斜杠时只授权单个资源，整目录布局不放行。
      await publishProviderExports({
        "./src-dir": "./src",
        "./src-slash": "./src/",
        ...schemaExport,
      });
      await writePackageFile("src/public-resource-directory-target.ts", [
        'import { readdirSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function providerSourceEntries(): string[] {",
        '  return readdirSync(fileURLToPath(import.meta.resolve("@demo/provider/src-dir")));',
        "}",
        "",
        "export function providerSourceEntriesSlash(): string[] {",
        "  return readdirSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/src-slash")),',
        "  );",
        "}",
        "",
      ]);
      const directoryTarget = await boundariesCheck();
      expect(directoryTarget.exitCode).not.toBe(0);
      const directoryTargetOutput = checkText(directoryTarget);
      expect(directoryTargetOutput).toContain(
        '@demo/provider 的 exports["./src-dir"] 的 runtime target 是 @demo/provider 内的目录',
      );
      expect(directoryTargetOutput).toContain("不放行整目录布局");
      expect(directoryTargetOutput).toContain(
        "让 @demo/provider 的所有者将 ./src-dir 的 runtime target 声明为具体文件出口",
      );
      expect(directoryTargetOutput).toContain(
        '@demo/provider 的 exports["./src-slash"] 的 runtime target 不是包内单个文件',
      );
      expect(unverifiableLines(directoryTargetOutput)).toHaveLength(0);
      await restoreManifests();
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-directory-target.ts`,
      ]);

      // T09-2 变异六（R09-RC-2 / R09-RC-3）：Node 在 ESM seam 拒绝的 target 形态不获得授权；require-only 只是 CJS 出口。
      await publishProviderExports({
        "./lexical": "./src/../src/index.ts",
        "./dotslash": "././src/index.ts",
        "./require-only": { require: "./dist/legacy.cjs" },
        ...schemaExport,
      });
      await writePackageFile("src/public-resource-invalid-forms.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function lexicalTarget(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/lexical")),',
        '    "utf8",',
        "  );",
        "}",
        "",
        "export function dotSegmentTarget(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/dotslash")),',
        '    "utf8",',
        "  );",
        "}",
        "",
        "export function requireOnlyTarget(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/require-only")),',
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      const invalidForms = await boundariesCheck();
      expect(invalidForms.exitCode).not.toBe(0);
      const invalidFormsOutput = checkText(invalidForms);
      expect(invalidFormsOutput).toContain(
        '@demo/provider 的 exports["./lexical"] 的 runtime target 不是包内单个文件',
      );
      expect(invalidFormsOutput).toContain(
        '@demo/provider 的 exports["./dotslash"] 的 runtime target 不是包内单个文件',
      );
      expect(invalidFormsOutput).not.toContain(
        '@demo/provider 的 exports["./require-only"]',
      );
      expect(unverifiableLines(invalidFormsOutput)).toHaveLength(1);
      await restoreManifests();
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-invalid-forms.ts`,
      ]);

      // T09-3 一：授权只覆盖被请求资源，dirname 回退仍受 containment（前提使用 Node 有效的公开 target）。
      await publishProviderExports({
        ...schemaExport,
        "./dist-entry": "./dist/index.js",
      });
      await writePackageFile("src/public-resource-granted-directory.ts", [
        'import { readdirSync } from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        "const publicEntry = fileURLToPath(",
        '  import.meta.resolve("@demo/provider/dist-entry"),',
        ");",
        "",
        "export function providerDistEntries(): string[] {",
        "  return readdirSync(path.dirname(publicEntry));",
        "}",
        "",
      ]);
      const grantedDirectory = await boundariesCheck();
      expect(grantedDirectory.exitCode).not.toBe(0);
      const grantedDirectoryOutput = checkText(grantedDirectory);
      expect(grantedDirectoryOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider/dist。",
      );
      expect(grantedDirectoryOutput).not.toContain("公开资源分支");
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-granted-directory.ts`,
      ]);

      // T09-3 二：从公开定位结果继续派生私有文件路径不借公开分支放行。
      await publishProviderExports(schemaExport);
      await writePackageFile("src/public-resource-derived-private.ts", [
        'import { readFileSync } from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        "const publicEntry = fileURLToPath(",
        '  import.meta.resolve("@demo/provider/schema"),',
        ");",
        "const providerRoot = path.dirname(publicEntry);",
        'const privateLeaf = path.join(providerRoot, "../src/internal.ts");',
        "",
        "export function providerInternal(): string {",
        '  return readFileSync(privateLeaf, "utf8");',
        "}",
        "",
      ]);
      const derivedPrivate = await boundariesCheck();
      expect(derivedPrivate.exitCode).not.toBe(0);
      const derivedPrivateOutput = checkText(derivedPrivate);
      expect(derivedPrivateOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider/src/internal.ts。",
      );
      expect(derivedPrivateOutput).not.toContain("公开资源分支");
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-derived-private.ts`,
      ]);

      // T09-3 三：同一文件里的合法公开访问与 sibling 私有物理路径并存时后者仍失败。
      await writePackageFile("src/public-resource-mixed.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function providerEntry(): string {",
        '  return readFileSync(fileURLToPath(import.meta.resolve("@demo/provider")), "utf8");',
        "}",
        "",
        "export function providerInternal(): string {",
        '  return readFileSync("../provider/src/internal.ts", "utf8");',
        "}",
        "",
      ]);
      const mixed = await boundariesCheck();
      expect(mixed.exitCode).not.toBe(0);
      const mixedOutput = checkText(mixed);
      expect(mixedOutput).toContain(
        `${consumerPackagePath}/src/public-resource-mixed.ts:9:10 包文件系统隔离`,
      );
      expect(mixedOutput).not.toContain("公开资源分支");
      expect(mixedOutput).not.toContain("无法静态求值");
      await restoreManifests();
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-mixed.ts`,
      ]);

      // T09-4 一：动态 package identity 是明确不可验证，不冒充静态安全结论。
      await writePackageFile("src/public-resource-dynamic.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function readNamedPackage(name: string): string {",
        "  return readFileSync(",
        "    fileURLToPath(import.meta.resolve(name)),",
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      const dynamicIdentity = await boundariesCheck();
      expect(dynamicIdentity.exitCode).not.toBe(0);
      const dynamicIdentityOutput = checkText(dynamicIdentity);
      expect(unverifiableLines(dynamicIdentityOutput)).toHaveLength(1);
      expect(dynamicIdentityOutput).toContain(
        `${consumerPackagePath}/src/public-resource-dynamic.ts:6:5`,
      );
      expect(dynamicIdentityOutput).not.toContain("私有路径");
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-dynamic.ts`,
      ]);

      // T09-4 二：已声明但不是 workspace 成员的包拿不到 provider contract。
      await writePackageFile("src/public-resource-external.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function vendorEntry(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("valibot")),',
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      const externalPackage = await boundariesCheck();
      expect(externalPackage.exitCode).not.toBe(0);
      expect(unverifiableLines(checkText(externalPackage))).toHaveLength(1);
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-external.ts`,
      ]);

      // T09-4 三：有限条件键与通配之外的出口形态不猜测，独立给出不可验证结果。
      await publishProviderExports({
        "./browser": { browser: "./src/browser.js" },
        "./pattern": { "./*": "./src/*.ts" },
        ...schemaExport,
      });
      await writePackageFile("src/public-resource-unknown-export.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function browserEntry(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/browser")),',
        '    "utf8",',
        "  );",
        "}",
        "",
        "export function patternEntry(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/pattern")),',
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      const unknownExport = await boundariesCheck();
      expect(unknownExport.exitCode).not.toBe(0);
      const unknownExportOutput = checkText(unknownExport);
      expect(unverifiableLines(unknownExportOutput)).toHaveLength(2);
      expect(unknownExportOutput).not.toContain("公开资源分支");
      expect(unknownExportOutput).not.toContain("私有路径");
      await restoreManifests();
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-unknown-export.ts`,
      ]);

      // T09-4 四：顶层通配 exports 在 Node 中可放行该 subpath，只报告不可验证而非未公开。
      await publishProviderExports({ "./*": "./src/*.ts", ...schemaExport });
      await writePackageFile("src/public-resource-pattern-leaf.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function patternLeaf(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/pattern-leaf")),',
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      const patternRootExport = await boundariesCheck();
      expect(patternRootExport.exitCode).not.toBe(0);
      const patternRootExportOutput = checkText(patternRootExport);
      expect(unverifiableLines(patternRootExportOutput)).toHaveLength(1);
      expect(patternRootExportOutput).not.toContain("公开资源分支");
      await restoreManifests();
      await removeFiles([
        `${consumerPackagePath}/src/public-resource-pattern-leaf.ts`,
      ]);

      // T09-5 恢复：公开正例与无关的 package 形状参数一起通过真实 boundary task。
      await writeFile(
        path.join(targetDir, providerSchemaSource),
        'export const schemaName = "name";\n',
      );
      await publishProviderExports({
        ...schemaExport,
        "./asset": "./src/public-asset",
      });
      await writeFile(path.join(targetDir, providerAssetSource), "name\n");
      await writePackageFile("src/public-resource-extension-less.ts", [
        'import { readFileSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        "",
        "export function providerAsset(): string {",
        "  return readFileSync(",
        '    fileURLToPath(import.meta.resolve("@demo/provider/asset")),',
        '    "utf8",',
        "  );",
        "}",
        "",
      ]);
      await writePackageFile("src/unknown-tool-reference.ts", [
        "function renderReference(entry: string): string {",
        "  return `see ${entry}`;",
        "}",
        "",
        'export const referenceHint = renderReference("@demo/provider/src/internal.ts");',
        "",
      ]);
      // 有限对照：无扩展名的真实文件与仍缺失的 dist target 都不因修复而被误拒。
      const restoredDistState = await stat(
        path.join(targetDir, providerPackagePath, "dist"),
      ).then(
        () => "present",
        () => "missing",
      );
      expect(restoredDistState).toBe("missing");
      const restored = await boundariesCheck();
      expect(restored.exitCode).toBe(0);
      expect(checkText(restored)).not.toContain("公开资源分支");
      expect(checkText(restored)).not.toContain("包文件系统隔离");
      await removeFiles([
        `${consumerPackagePath}/src/unknown-tool-reference.ts`,
        `${consumerPackagePath}/src/public-resource-extension-less.ts`,
        `${consumerPackagePath}/src/public-resource-read.ts`,
        `${consumerPackagePath}/src/public-resource-schema.ts`,
        providerSchemaSource,
        providerAssetSource,
      ]);

      // 完整 Root Check 在移除全部变异后重新通过，06/07/08 门禁不受影响。
      const rootCheck = await execa("pnpm", ["run", "check"], {
        cwd: targetDir,
        reject: false,
      });
      expect(rootCheck.exitCode).toBe(0);
      expect(checkText(rootCheck)).not.toContain("公开资源分支");
      expect(checkText(rootCheck)).not.toContain("包文件系统隔离");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("discovers real workspace members and serves every scan face from one layout", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-workspace-discovery-"),
    );
    const targetDir = path.join(workspace, "library");
    const outsideDirectory = path.join(workspace, "outside-repo");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
          0,
          releaseToolchainSnapshot.nodeVersion.indexOf("."),
        ),
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const consumerPackagePath = initialization.blueprint.packages[0]!.path;
    const providerPackagePath = "packages/provider";
    const libPackage = `包 @demo/lib (${consumerPackagePath})`;
    const providerTarget = `兄弟包 @demo/provider (${providerPackagePath})`;
    const providerPrivateTarget = `${providerTarget} 的私有路径 ${providerPackagePath}/src/internal.ts。`;
    const declaredPatterns = [
      "apps/*",
      "packages/*",
      "packages/*-link/inner",
      "packages/*/plugins/*",
    ];

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "provider",
          linkFrom: [consumerPackagePath],
        }).projectProjections,
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const boundariesCheck = async () =>
        execa("pnpm", ["run", "boundaries"], {
          cwd: targetDir,
          reject: false,
        });
      const checkerRun = async () =>
        execa(
          "node",
          ["--conditions=source", "scripts/check-package-boundaries.ts"],
          { cwd: targetDir, reject: false },
        );
      const checkText = (result: { stderr: string; stdout: string }) =>
        `${result.stdout}\n${result.stderr}`;
      const writeRepoFile = async (
        relativePath: string,
        lines: readonly string[],
      ) => {
        const filePath = path.join(targetDir, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${lines.join("\n")}\n`);
      };
      const writeManifest = (relativeDirectory: string, name: string) =>
        writeRepoFile(`${relativeDirectory}/package.json`, [
          "{",
          `  "name": ${JSON.stringify(name)},`,
          '  "private": true,',
          '  "type": "module",',
          '  "version": "0.0.0"',
          "}",
        ]);
      const writeEscape = (relativePath: string, specifier: string) =>
        writeRepoFile(relativePath, [
          'import { readFileSync } from "node:fs";',
          "",
          `export const leaked = readFileSync(${JSON.stringify(specifier)}, "utf8");`,
          "",
        ]);
      const workspaceManifestPath = path.join(targetDir, "pnpm-workspace.yaml");
      // 只改写 packages 段：正/负模式与 block/flow 形态都是生成仓库自身的既定输入。
      const setPackagesSection = async (section: string) => {
        const lines = (await readFile(workspaceManifestPath, "utf8")).split(
          "\n",
        );
        const start = lines.findIndex(
          (line) => line === "packages:" || line.startsWith("packages: ["),
        );
        if (start === -1) {
          await writeFile(
            workspaceManifestPath,
            `${section}\n${lines.join("\n")}`,
          );

          return;
        }
        let end = start;
        while (end + 1 < lines.length && lines[end + 1]!.startsWith("  ")) {
          end += 1;
        }
        await writeFile(
          workspaceManifestPath,
          [
            ...lines.slice(0, start),
            ...(section.length === 0 ? [] : section.split("\n")),
            ...lines.slice(end + 1),
          ].join("\n"),
        );
      };
      const renderedPatterns = (
        patterns: readonly string[],
        style: "block" | "flow",
      ) => {
        const items = patterns.map((pattern) => JSON.stringify(pattern));

        return style === "flow"
          ? `packages: [${items.join(", ")}]`
          : ["packages:", ...items.map((item) => `  - ${item}`)].join("\n");
      };
      const setWorkspacePatterns = async (
        patterns: readonly string[],
        style: "block" | "flow" = "block",
      ) => setPackagesSection(renderedPatterns(patterns, style));

      const clean = await boundariesCheck();
      expect(clean.exitCode).toBe(0);
      const originalWorkspaceManifest = await readFile(
        workspaceManifestPath,
        "utf8",
      );

      await writeRepoFile(`${providerPackagePath}/src/internal.ts`, [
        'export const internalValue = "internal";',
        "",
      ]);

      // T12-M1 反例：不被任何正模式命中的 manifest 不获得包身份，其越界读取由外缘真实成员承担，
      // 修正方向也只对该成员声明 workspace 依赖，不要求非成员声明。
      await writeManifest(
        `${consumerPackagePath}/fixture/pkg`,
        "@demo/unmatched",
      );
      await writeEscape(
        `${consumerPackagePath}/fixture/pkg/src/unmatched-read.ts`,
        "../provider/src/internal.ts",
      );
      // T12-M1/D12A-1：无成员祖先的未匹配目录归根，由根豁免承担而不是伪造包身份。
      await writeManifest("packages/standalone/pkg", "@demo/standalone");
      await writeEscape(
        "packages/standalone/pkg/src/root-owned-read.ts",
        "../provider/src/internal.ts",
      );

      // T12-M2：嵌套真实成员按最具体包根判定；自身读 ./src/local.txt 通过。
      await writeManifest(
        `${consumerPackagePath}/plugins/inner`,
        "@demo/inner",
      );
      await writeRepoFile(
        `${consumerPackagePath}/plugins/inner/src/local.txt`,
        ["local", ""],
      );
      await writeEscape(
        `${consumerPackagePath}/plugins/inner/src/private-read.ts`,
        "../provider/src/internal.ts",
      );
      await writeEscape(
        `${consumerPackagePath}/plugins/inner/src/local-read.ts`,
        "./src/local.txt",
      );
      await writeEscape(
        `${consumerPackagePath}/src/inner-read.ts`,
        "./plugins/inner/src/local.txt",
      );
      // T12-M9：语言门与路径归属共用同一布局（该文件在排除态由外缘成员的扫描面看到）。
      await writeRepoFile(`${consumerPackagePath}/plugins/inner/helper.js`, [
        'export const helper = "plain javascript";',
        "",
      ]);

      // T12-M8：点目录不再泛跳过；派生角色名集仍不作为 authored 源码。
      await writeEscape(
        `${consumerPackagePath}/.custom-out/dotdir-read.ts`,
        "../provider/src/internal.ts",
      );
      await writeEscape(
        `${consumerPackagePath}/dist/dist-read.ts`,
        "../provider/src/internal.ts",
      );

      // T12-M10 成员形态：只有 package.yaml 的目录建立成员边界，身份标签用相对路径而不是名称。
      await writeRepoFile("packages/yaml-member/package.yaml", [
        "name: '@demo/yaml-member'",
        "version: 0.0.0",
        "",
      ]);
      await writeEscape(
        "packages/yaml-member/src/yaml-read.ts",
        "../provider/src/internal.ts",
      );

      // T12-M7：alias-only 后代成员，两份语义相同的 fixture 让真实目录与链接分支各排在其之前。
      await writeManifest("packages/aa-target/inner", "@demo/real-first");
      await writeRepoFile("packages/aa-target/inner/src/local.txt", [
        "local",
        "",
      ]);
      await writeEscape(
        "packages/aa-target/inner/src/alias-inner-read.ts",
        "../../provider/src/internal.ts",
      );
      await symlink("aa-target", path.join(targetDir, "packages/zz-link"));
      await writeManifest("packages/zz-target/inner", "@demo/alias-first");
      await writeRepoFile("packages/zz-target/inner/src/local.txt", [
        "local",
        "",
      ]);
      await writeEscape(
        "packages/zz-target/inner/src/alias-inner-read.ts",
        "../../provider/src/internal.ts",
      );
      await symlink("zz-target", path.join(targetDir, "packages/aa-link"));
      await writeEscape(
        `${consumerPackagePath}/src/alias-read.ts`,
        "../zz-link/inner/src/local.txt",
      );
      await writeEscape(
        `${consumerPackagePath}/src/alias-real-spelling-read.ts`,
        "../aa-target/inner/src/local.txt",
      );
      await writeEscape(
        `${consumerPackagePath}/src/alias-second-read.ts`,
        "../aa-link/inner/src/local.txt",
      );

      // T12-M12 的链接环与仓库外链接在后面的独立阶段构造：
      // turbo 自身的目录发现会拒绝符号链接环，那一组负例只由检查器入口判定。

      await setWorkspacePatterns(declaredPatterns);
      const blockRun = await boundariesCheck();
      expect(blockRun.exitCode).toBe(1);
      const blockText = checkText(blockRun);

      // T12-M1：外缘成员是 owner，非成员身份不出现。
      expect(blockText).toContain(
        `${consumerPackagePath}/fixture/pkg/src/unmatched-read.ts:3:`,
      );
      expect(blockText).toContain(
        `${libPackage} 通过本地文件系统路径访问 ${providerPrivateTarget}`,
      );
      expect(blockText).not.toContain("@demo/unmatched");
      expect(blockText).not.toContain("packages/standalone");
      // T12-M2：inner 是 owner，不被断为 app。
      expect(blockText).toContain(
        `${consumerPackagePath}/plugins/inner/src/private-read.ts:3:`,
      );
      expect(blockText).toContain(
        `包 @demo/inner (${consumerPackagePath}/plugins/inner) 通过本地文件系统路径访问 兄弟包 @demo/lib (${consumerPackagePath}) 的私有路径 ${consumerPackagePath}/plugins/provider/src/internal.ts。`,
      );
      expect(blockText).toContain(
        `${libPackage} 通过本地文件系统路径访问 兄弟包 @demo/inner (${consumerPackagePath}/plugins/inner) 的私有路径 ${consumerPackagePath}/plugins/inner/src/local.txt。`,
      );
      expect(blockText).not.toContain("local-read.ts");
      // T12-M7：两种顺序都让 alias-only 后代以模式命中的拼写成为成员，真实拼写不建第二身份。
      expect(blockText).toContain(
        "包 @demo/real-first (packages/zz-link/inner)",
      );
      expect(blockText).toContain(
        "包 @demo/alias-first (packages/aa-link/inner)",
      );
      expect(blockText).not.toContain("(packages/aa-target");
      expect(blockText).not.toContain("(packages/zz-target");
      expect(blockText).not.toContain(
        "packages/aa-target/inner/src/alias-inner-read.ts",
      );
      expect(blockText).not.toContain(
        "packages/zz-target/inner/src/alias-inner-read.ts",
      );
      // 同一真实文件按任一拼写读取都折叠到一个 owner，且只有一条扫描结论。
      expect(blockText).toContain(
        `兄弟包 @demo/real-first (packages/zz-link/inner) 的私有路径 packages/zz-link/inner/src/local.txt。`,
      );
      expect(blockText).toContain(
        `兄弟包 @demo/real-first (packages/zz-link/inner) 的私有路径 packages/aa-target/inner/src/local.txt。`,
      );
      expect(
        blockText
          .split("\n")
          .filter((line) => line.includes("inner/src/alias-inner-read.ts:3:")),
      ).toHaveLength(2);
      // T12-M8：点目录内的 authored 越界读取失败，派生目录内的同源文件不算 authored。
      expect(blockText).toContain(
        `${consumerPackagePath}/.custom-out/dotdir-read.ts:3:`,
      );
      expect(blockText).not.toContain("dist/dist-read.ts");
      // T12-M10：package.yaml 成员边界成立且标签是相对路径。
      expect(blockText).toContain(
        "包 packages/yaml-member (packages/yaml-member) 通过本地文件系统路径访问",
      );
      expect(blockText).not.toContain("@demo/yaml-member");

      await setWorkspacePatterns(declaredPatterns, "flow");
      const flowRun = await boundariesCheck();
      expect(flowRun.exitCode).toBe(1);
      const flowText = checkText(flowRun);
      // D12A-1：block 与 flow 序列按官方协议是同一组模式。
      expect(flowText).toContain(
        `${libPackage} 通过本地文件系统路径访问 ${providerPrivateTarget}`,
      );
      expect(flowText).toContain(
        `包 @demo/inner (${consumerPackagePath}/plugins/inner) 通过本地文件系统路径访问`,
      );
      expect(flowText).toContain(
        "包 @demo/real-first (packages/zz-link/inner)",
      );

      // T12-M3：排除取消成员资格但不取消 authored 扫描，owner 转为外缘成员。
      await setWorkspacePatterns([
        ...declaredPatterns,
        `!${consumerPackagePath}/plugins/*`,
      ]);
      const excludedRun = await boundariesCheck();
      expect(excludedRun.exitCode).toBe(1);
      const excludedText = checkText(excludedRun);
      expect(excludedText).toContain(
        `${consumerPackagePath}/plugins/inner/src/private-read.ts:3:`,
      );
      expect(excludedText).toContain(
        `${libPackage} 通过本地文件系统路径访问 ${providerPrivateTarget}`,
      );
      expect(excludedText).not.toContain("包 @demo/inner");
      // 排除后 inner 的文件归 lib：lib 读它不再构成跨包越界。
      expect(excludedText).not.toContain(
        `${consumerPackagePath}/src/inner-read.ts`,
      );
      // T12-M9：语言门与路径归属在同一目录给出同一边界。
      expect(excludedText).toContain(
        `${consumerPackagePath}/plugins/inner/helper.js 维护脚本语言门`,
      );

      // T12-M10 失败模式：非法输入明确失败，不回退目录树发现，也不吞掉读取错误。
      const failureModes: {
        readonly section: string;
        readonly detail: string;
      }[] = [
        { section: "packages:\n  - apps/*\n  - 42", detail: "非字符串项" },
        { section: 'packages:\n  - ""\n  - packages/*', detail: "非字符串项" },
        { section: "packages:\n  - /packages/*", detail: "绝对模式" },
        { section: "packages: [", detail: "合法 YAML" },
        { section: "packages:\n  apps: true", detail: "字符串序列" },
      ];
      for (const failureMode of failureModes) {
        await setPackagesSection(failureMode.section);
        const failed = await checkerRun();
        expect(failed.exitCode).toBe(1);
        expect(checkText(failed)).toContain("workspace 成员发现失败");
        expect(checkText(failed)).toContain(failureMode.detail);
        expect(checkText(failed)).not.toContain("包文件系统隔离：包");
      }

      // 成员 manifest 损坏明确失败；非成员目录内的损坏 manifest 从不解析。
      await setWorkspacePatterns(declaredPatterns);
      await writeRepoFile("packages/broken-member/package.json", [
        '{"name": "@demo/broken",',
        "",
      ]);
      const brokenMember = await checkerRun();
      expect(brokenMember.exitCode).toBe(1);
      expect(checkText(brokenMember)).toContain(
        "packages/broken-member/package.json 无法解析",
      );
      await rm(path.join(targetDir, "packages/broken-member"), {
        recursive: true,
        force: true,
      });
      await writeRepoFile(`${consumerPackagePath}/fixture/pkg/package.json`, [
        '{"name": "@demo/unmatched",',
        "",
      ]);
      const brokenNonMember = await checkerRun();
      expect(checkText(brokenNonMember)).not.toContain("无法解析");
      expect(checkText(brokenNonMember)).toContain(
        `${consumerPackagePath}/fixture/pkg/src/unmatched-read.ts:3:`,
      );
      await writeManifest(
        `${consumerPackagePath}/fixture/pkg`,
        "@demo/unmatched",
      );

      // packages 段缺失、YAML 文件缺失与显式空序列：前两者走默认 ['.', '**'] 且不报错。
      await setPackagesSection("");
      const withoutPackages = await checkerRun();
      expect(checkText(withoutPackages)).not.toContain(
        "workspace 成员发现失败",
      );
      expect(checkText(withoutPackages)).toContain(
        `包 @demo/inner (${consumerPackagePath}/plugins/inner)`,
      );
      expect(checkText(withoutPackages)).toContain("包 @demo/unmatched");
      await rm(workspaceManifestPath);
      const withoutManifest = await checkerRun();
      expect(checkText(withoutManifest)).not.toContain(
        "workspace 成员发现失败",
      );
      expect(checkText(withoutManifest)).toContain(
        `包 @demo/inner (${consumerPackagePath}/plugins/inner)`,
      );
      await writeFile(workspaceManifestPath, originalWorkspaceManifest);
      await setPackagesSection("packages: []");
      const rootOnlyMember = await checkerRun();
      // 只有根成员：不产生跨包结论，但取消成员资格不取消该目录里 authored 源码的扫描。
      expect(checkText(rootOnlyMember)).not.toContain("包文件系统隔离：包");
      expect(checkText(rootOnlyMember)).toContain(
        `${consumerPackagePath}/plugins/inner/helper.js 维护脚本语言门`,
      );

      // T12-M12：互指与自指链接目录有限终止；仓库根外的链接目录不入扫描面也不建身份。
      await writeRepoFile("packages/loop-a/keep.txt", ["a", ""]);
      await writeRepoFile("packages/loop-b/keep.txt", ["b", ""]);
      await symlink("../loop-b", path.join(targetDir, "packages/loop-a/link"));
      await symlink("../loop-a", path.join(targetDir, "packages/loop-b/link"));
      await writeRepoFile("packages/loop-self/keep.txt", ["s", ""]);
      await symlink("..", path.join(targetDir, "packages/loop-self/self"));
      await mkdir(outsideDirectory, { recursive: true });
      await writeFile(
        path.join(outsideDirectory, "package.json"),
        `${JSON.stringify({ name: "@demo/outside", private: true, version: "0.0.0" }, null, 2)}\n`,
      );
      await writeFile(
        path.join(outsideDirectory, "escape.ts"),
        'import { readFileSync } from "node:fs";\n\nexport const leaked = readFileSync("../provider/src/internal.ts", "utf8");\n',
      );
      await symlink(
        "../../outside-repo",
        path.join(targetDir, "packages/outside-link"),
      );
      await setWorkspacePatterns(declaredPatterns);
      const linkedRun = await checkerRun();
      expect(linkedRun.exitCode).toBe(1);
      expect(checkText(linkedRun)).not.toContain("@demo/outside");
      expect(checkText(linkedRun)).not.toContain("packages/loop");

      // 恢复：成员与扫描结论回到既有业务，环与仓库外链接在场时仍有限退出 0。
      await writeFile(workspaceManifestPath, originalWorkspaceManifest);
      for (const fixturePath of [
        `${consumerPackagePath}/fixture`,
        `${consumerPackagePath}/plugins`,
        `${consumerPackagePath}/.custom-out`,
        `${consumerPackagePath}/dist`,
        `${consumerPackagePath}/src/inner-read.ts`,
        `${consumerPackagePath}/src/alias-read.ts`,
        `${consumerPackagePath}/src/alias-real-spelling-read.ts`,
        `${consumerPackagePath}/src/alias-second-read.ts`,
        "packages/yaml-member",
        "packages/standalone",
        "packages/aa-target",
        "packages/aa-link",
        "packages/zz-target",
        "packages/zz-link",
      ]) {
        await rm(path.join(targetDir, fixturePath), {
          recursive: true,
          force: true,
        });
      }
      const restoredWithLinks = await checkerRun();
      expect(restoredWithLinks.exitCode).toBe(0);
      await rm(path.join(targetDir, "packages/loop-a"), {
        recursive: true,
        force: true,
      });
      await rm(path.join(targetDir, "packages/loop-b"), {
        recursive: true,
        force: true,
      });
      await rm(path.join(targetDir, "packages/loop-self"), {
        recursive: true,
        force: true,
      });
      await rm(path.join(targetDir, "packages/outside-link"), { force: true });
      expect((await boundariesCheck()).exitCode).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("judges file system targets by their real position through links and missing segments", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-physical-path-"),
    );
    const targetDir = path.join(workspace, "library");
    const outsideDirectory = path.join(workspace, "outside-repo");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
          0,
          releaseToolchainSnapshot.nodeVersion.indexOf("."),
        ),
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const consumerPackagePath = initialization.blueprint.packages[0]!.path;
    const libPackage = `包 @demo/lib (${consumerPackagePath})`;
    const siblingPackage = "packages/sibling";
    const siblingTarget = `兄弟包 @demo/sibling (${siblingPackage})`;
    const declaredPatterns = ["apps/*", "packages/*"];

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const boundariesCheck = async () =>
        execa("pnpm", ["run", "boundaries"], {
          cwd: targetDir,
          reject: false,
        });
      const rootCheck = async () =>
        execa("pnpm", ["run", "check"], { cwd: targetDir, reject: false });
      const checkText = (result: { stderr: string; stdout: string }) =>
        `${result.stdout}\n${result.stderr}`;
      const writeRepoFile = async (
        relativePath: string,
        lines: readonly string[],
      ) => {
        const filePath = path.join(targetDir, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${lines.join("\n")}\n`);
      };
      const writeManifest = (relativeDirectory: string, name: string) =>
        writeRepoFile(`${relativeDirectory}/package.json`, [
          "{",
          `  "name": ${JSON.stringify(name)},`,
          '  "private": true,',
          '  "type": "module",',
          '  "version": "0.0.0"',
          "}",
        ]);
      // 负例的共同业务语义：读取一个不属于本包的内容，而不只是换个文件名。
      const writeEscape = (relativePath: string, specifier: string) =>
        writeRepoFile(relativePath, [
          'import { readFileSync } from "node:fs";',
          "",
          `export const leaked = readFileSync(${JSON.stringify(specifier)}, "utf8");`,
          "",
        ]);
      const writeOwnRead = (
        relativePath: string,
        expression: string,
        imports: readonly string[] = [
          'import { readFileSync } from "node:fs";',
        ],
      ) =>
        writeRepoFile(relativePath, [
          ...imports,
          "",
          `export const ownValue = readFileSync(${expression}, "utf8");`,
          "",
        ]);
      const workspaceManifestPath = path.join(targetDir, "pnpm-workspace.yaml");
      const originalWorkspaceManifest = await readFile(
        workspaceManifestPath,
        "utf8",
      );
      const setWorkspacePatterns = async (
        patterns: readonly string[],
      ): Promise<void> => {
        const lines = originalWorkspaceManifest.split("\n");
        const start = lines.findIndex((line) => line === "packages:");
        if (start === -1) {
          throw new Error("生成的 pnpm-workspace.yaml 缺少 packages 段。");
        }
        let end = start;
        while (end + 1 < lines.length && lines[end + 1]!.startsWith("  ")) {
          end += 1;
        }
        await writeFile(
          workspaceManifestPath,
          [
            ...lines.slice(0, start),
            "packages:",
            ...patterns.map((pattern) => `  - ${JSON.stringify(pattern)}`),
            ...lines.slice(end + 1),
          ].join("\n"),
        );
      };

      await setWorkspacePatterns(declaredPatterns);
      expect((await boundariesCheck()).exitCode).toBe(0);

      // 正例：本包数据、经本包内链接的读取、链接缺席时的普通缺失 leaf 与已归一的构造值。
      await writeRepoFile(`${consumerPackagePath}/src/local-data.txt`, [
        "local",
      ]);
      await writeRepoFile(`${consumerPackagePath}/src/private.txt`, ["own"]);
      await symlink(
        "./local-data.txt",
        path.join(
          targetDir,
          `${consumerPackagePath}/src/same-package-link.txt`,
        ),
      );
      await writeOwnRead(
        `${consumerPackagePath}/src/same-package-link-read.ts`,
        '"./src/same-package-link.txt"',
      );
      await writeOwnRead(
        `${consumerPackagePath}/src/missing-leaf-in-package.ts`,
        '"./src/missing-dir/local.txt"',
      );

      // 兄弟包与指向其 src 的目录链接：词法留在本包，真实位置在 sibling。
      await writeManifest(siblingPackage, "@demo/sibling");
      await writeRepoFile(`${siblingPackage}/src/secret.txt`, ["s3cret"]);
      await writeRepoFile(`${siblingPackage}/private.txt`, ["sibling-root"]);
      await symlink(
        "../../sibling/src",
        path.join(targetDir, `${consumerPackagePath}/src/link`),
      );

      // T12-M4：无 `..` 的链接读取必须按真实归属拒绝。
      await writeEscape(
        `${consumerPackagePath}/src/link-read.ts`,
        "./src/link/secret.txt",
      );
      // T12-M5：链接目录下的缺失 leaf 按最近存在祖先的真实归属判定，不因不存在放行。
      await writeEscape(
        `${consumerPackagePath}/src/link-missing-read.ts`,
        "./src/link/nothere.txt",
      );
      // T12-M11：未归一原字面量的 `..` 属于链接目标的父目录，能离开所属包。
      await writeEscape(
        `${consumerPackagePath}/src/link-parent-read.ts`,
        "./src/link/../private.txt",
      );
      // 归一状态跟着表达式形态走：顶层常量指向同一字面量时仍未归一。
      await writeRepoFile(
        `${consumerPackagePath}/src/constant-parent-read.ts`,
        [
          'import { readFileSync } from "node:fs";',
          "",
          'const target = "./src/link/../private.txt";',
          "",
          'export const leaked = readFileSync(target, "utf8");',
          "",
        ],
      );
      // T12-M11 正例：path.join 在到达 fs 前已归一，不得倒推成未归一形态制造越界。
      await writeOwnRead(
        `${consumerPackagePath}/src/join-normalized-read.ts`,
        'path.join("./src/link", "..", "private.txt")',
        [
          'import { readFileSync } from "node:fs";',
          'import path from "node:path";',
        ],
      );

      // RC-1：独立构造面与 fs 面共用真实归属判定——词法留在本包的构造值按真实位置独立判归属。
      await writeRepoFile(
        `${consumerPackagePath}/src/indep-cross-link-export.ts`,
        [
          'import path from "node:path";',
          "",
          'export const crossLinkTarget = path.join("./src/link", "secret.txt");',
          "",
        ],
      );
      // RC-1：构造值落在链接目录下的缺失 leaf，按最近存在祖先的真实归属判定，不因不存在放行。
      await writeRepoFile(
        `${consumerPackagePath}/src/indep-cross-link-missing-leaf.ts`,
        [
          'import path from "node:path";',
          "",
          'export const pending = path.join("./src/link", "nothere.txt");',
          "",
        ],
      );
      // RC-1 正例：归一构造值物理留在本包（link 段被 `..` 在归一时消去），不因中间链接段误报。
      await writeRepoFile(`${consumerPackagePath}/src/indep-join-pass.ts`, [
        'import path from "node:path";',
        "",
        'export const ownCopy = path.join("./src/link", "..", "local-data.txt");',
        "",
      ]);

      // T12-M6：断裂链接与自指环是真实路径无法验证，既不放行也不虚构目标。
      await symlink(
        "../../sibling/gone.txt",
        path.join(targetDir, `${consumerPackagePath}/src/broken-link.txt`),
      );
      await writeEscape(
        `${consumerPackagePath}/src/broken-link-read.ts`,
        "./src/broken-link.txt",
      );
      await symlink(
        "./self-loop.txt",
        path.join(targetDir, `${consumerPackagePath}/src/self-loop.txt`),
      );
      await writeEscape(
        `${consumerPackagePath}/src/self-loop-read.ts`,
        "./src/self-loop.txt",
      );

      // 真实位置落在仓库根外：按工作区外目标拒绝，不为其伪造包身份。
      await mkdir(outsideDirectory, { recursive: true });
      await writeFile(path.join(outsideDirectory, "secret.txt"), "outside\n");
      await symlink(
        outsideDirectory,
        path.join(targetDir, `${consumerPackagePath}/src/outside-link`),
      );
      await writeEscape(
        `${consumerPackagePath}/src/outside-read.ts`,
        "./src/outside-link/secret.txt",
      );

      // 原值点段：`/.` 与 `/./` 是内核逐段解析的一部分，不能在任何验证前当作无意义段去掉。
      await writeRepoFile(`${consumerPackagePath}/src/nested/local.txt`, [
        "nested",
      ]);
      await writeRepoFile(`${consumerPackagePath}/src/file-dot-slash-read.ts`, [
        'import { readFileSync } from "node:fs";',
        "",
        'export const unreadable = readFileSync("./src/private.txt/.", "utf8");',
        "",
      ]);
      // 同一形态经顶层常量传递：归一状态跟着表达式形态走，常量不把它变成已归一值。
      await writeRepoFile(
        `${consumerPackagePath}/src/constant-dot-slash-read.ts`,
        [
          'import { readFileSync } from "node:fs";',
          "",
          'const dotTarget = "./src/private.txt/./";',
          "",
          'export const unreadable = readFileSync(dotTarget, "utf8");',
          "",
        ],
      );
      // 链接指向的普通文件后再接 `/.`：该位置永远读不到，不得据此虚构兄弟包归属。
      await writeRepoFile(`${consumerPackagePath}/src/link-dot-slash-read.ts`, [
        'import { readFileSync } from "node:fs";',
        "",
        "export const unreadable = readFileSync(",
        '  "./src/link/secret.txt/.",',
        '  "utf8",',
        ");",
        "",
      ]);
      // 正项：普通目录后接 `/.`、目录内部的 `./` 段在内核上都真实存在。
      await writeOwnRead(
        `${consumerPackagePath}/src/dir-dot-read.ts`,
        '"./src/nested/."',
      );
      await writeOwnRead(
        `${consumerPackagePath}/src/dir-inner-dot-read.ts`,
        '"./src/./private.txt"',
      );
      // 正项：点段在到达 fs 前已被 path.resolve 折叠，按实际运行值判定，不冒充未归一原值。
      await writeOwnRead(
        `${consumerPackagePath}/src/resolve-dot-read.ts`,
        'path.resolve("./src/nested", ".")',
        [
          'import { readFileSync } from "node:fs";',
          'import path from "node:path";',
        ],
      );

      const redRun = await boundariesCheck();
      expect(redRun.exitCode).toBe(1);
      const redText = checkText(redRun);
      const escapeLines = redText
        .split("\n")
        .filter((line) => line.includes("的私有路径"));

      // T12-M4：owner 是 sibling，且诊断呈现真实位置。
      expect(redText).toContain(`${consumerPackagePath}/src/link-read.ts:3:`);
      expect(redText).toContain(
        `${siblingTarget} 的私有路径 ${consumerPackagePath}/src/link/secret.txt。`,
      );
      expect(redText).toContain(`真实位置：${siblingPackage}/src/secret.txt。`);
      expect(redText).toContain(libPackage);
      // T12-M5：缺失 leaf 仍按链接祖先的真实归属拒绝。
      expect(redText).toContain(
        `${consumerPackagePath}/src/link-missing-read.ts:3:`,
      );
      expect(redText).toContain(
        `${siblingTarget} 的私有路径 ${consumerPackagePath}/src/link/nothere.txt。`,
      );
      expect(redText).toContain(
        `真实位置：${siblingPackage}/src/nothere.txt。`,
      );
      // T12-M11：未归一 literal 与指向它的顶层常量同一结论，原值随诊断呈现。
      expect(redText).toContain(
        `${consumerPackagePath}/src/link-parent-read.ts:3:`,
      );
      expect(redText).toContain(
        `${consumerPackagePath}/src/constant-parent-read.ts:5:`,
      );
      expect(redText).toContain(`真实位置：${siblingPackage}/private.txt。`);
      expect(redText).toContain(
        `交给文件系统的原值：${consumerPackagePath}/src/link/../private.txt。`,
      );
      // 已归一的构造值、同包链接与本包缺失 leaf 都不被判为越界。
      expect(redText).not.toContain("join-normalized-read.ts");
      expect(redText).not.toContain("same-package-link-read.ts");
      expect(redText).not.toContain("missing-leaf-in-package.ts");
      // RC-1：构造面同一物理接缝——跨链接构造值按真实归属拒绝并呈现真实位置；
      // 链接目录下的缺失 leaf 按最近存在祖先判定，不因不存在放行；归一后留在本包的构造值不误报。
      expect(redText).toContain(
        `${consumerPackagePath}/src/indep-cross-link-export.ts:3:`,
      );
      expect(redText).toContain(
        `${siblingTarget} 的私有路径 ${consumerPackagePath}/src/link/secret.txt。`,
      );
      expect(redText).toContain(
        `${consumerPackagePath}/src/indep-cross-link-missing-leaf.ts:3:`,
      );
      expect(redText).toContain(
        `${siblingTarget} 的私有路径 ${consumerPackagePath}/src/link/nothere.txt。`,
      );
      expect(redText).not.toContain("indep-join-pass.ts");
      // 越界结论只来自这六个真实归属逃逸，无法验证与工作区外不虚构兄弟包身份。
      expect(escapeLines).toHaveLength(6);
      for (const unfabricated of [
        "broken-link-read.ts",
        "self-loop-read.ts",
        "outside-read.ts",
      ]) {
        for (const line of escapeLines) {
          expect(line).not.toContain(unfabricated);
        }
      }
      // T12-M6：明确无法验证，含真实失败码，且不复用“无法静态求值”结论。
      expect(redText).toContain(
        `${consumerPackagePath}/src/broken-link-read.ts:3:`,
      );
      expect(redText).toContain(
        `${libPackage} 交给文件系统的 ${consumerPackagePath}/src/broken-link.txt 无法验证真实路径（ENOENT）`,
      );
      expect(redText).toContain(
        `${consumerPackagePath}/src/self-loop-read.ts:3:`,
      );
      expect(redText).toContain("无法验证真实路径（ELOOP）");
      expect(redText).not.toContain("无法静态求值");
      // 仓库根外目标：绝对真实位置入诊断，没有伪造的包身份标签。
      expect(redText).toContain(
        `${consumerPackagePath}/src/outside-read.ts:3:`,
      );
      expect(redText).toContain(
        `工作区之外的 ${path.join(outsideDirectory, "secret.txt")}。`,
      );
      expect(redText).not.toContain("outside-repo (");

      // 点段原值按真实解析失败上报，且诊断呈现的就是程序交给 fs 的那段文本。
      expect(redText).toContain(
        `${consumerPackagePath}/src/file-dot-slash-read.ts:3:`,
      );
      expect(redText).toContain(
        `${libPackage} 交给文件系统的 ${consumerPackagePath}/src/private.txt/. 无法验证真实路径（ENOTDIR）`,
      );
      expect(redText).toContain(
        `${consumerPackagePath}/src/constant-dot-slash-read.ts:5:`,
      );
      expect(redText).toContain(
        `${libPackage} 交给文件系统的 ${consumerPackagePath}/src/private.txt/./ 无法验证真实路径（ENOTDIR）`,
      );
      // 链接后的文件再接点段：无法验证即无法验证，不产出真实位置或兄弟包归属。
      const linkDotLines = redText
        .split("\n")
        .filter((line) => line.includes("link-dot-slash-read.ts"))
        .join("\n");
      expect(linkDotLines).toContain(
        `交给文件系统的 ${consumerPackagePath}/src/link/secret.txt/. 无法验证真实路径（ENOTDIR）`,
      );
      expect(linkDotLines).not.toContain("真实位置：");
      expect(linkDotLines).not.toContain(siblingTarget);
      // 目录点段、内部 `./` 段与已归一的 resolve 结果都是合法归属，不出现在任何诊断里。
      expect(redText).not.toContain("dir-dot-read.ts");
      expect(redText).not.toContain("dir-inner-dot-read.ts");
      expect(redText).not.toContain("resolve-dot-read.ts");

      // 真实 Root Check 入口同样红，并且失败原因来自包文件系统隔离。
      const rootRed = await rootCheck();
      expect(rootRed.exitCode).not.toBe(0);
      expect(checkText(rootRed)).toContain("包文件系统隔离：");

      // 只移除越界或无法验证的 authored 源码：链接与数据留在原位时合法归属通过。
      for (const violatingPath of [
        `${consumerPackagePath}/src/link-read.ts`,
        `${consumerPackagePath}/src/link-missing-read.ts`,
        `${consumerPackagePath}/src/link-parent-read.ts`,
        `${consumerPackagePath}/src/constant-parent-read.ts`,
        `${consumerPackagePath}/src/indep-cross-link-export.ts`,
        `${consumerPackagePath}/src/indep-cross-link-missing-leaf.ts`,
        `${consumerPackagePath}/src/broken-link-read.ts`,
        `${consumerPackagePath}/src/self-loop-read.ts`,
        `${consumerPackagePath}/src/outside-read.ts`,
        `${consumerPackagePath}/src/file-dot-slash-read.ts`,
        `${consumerPackagePath}/src/constant-dot-slash-read.ts`,
        `${consumerPackagePath}/src/link-dot-slash-read.ts`,
      ]) {
        await rm(path.join(targetDir, violatingPath));
      }
      const greenWithLinks = await boundariesCheck();
      expect(greenWithLinks.exitCode).toBe(0);
      expect(checkText(greenWithLinks)).not.toContain("包文件系统隔离：");

      // 移除全部物理路径夹具后，生成仓库的 Root Check 与成员集合恢复原状。
      await writeFile(workspaceManifestPath, originalWorkspaceManifest);
      for (const fixturePath of [
        `${consumerPackagePath}/src/link`,
        `${consumerPackagePath}/src/outside-link`,
        `${consumerPackagePath}/src/broken-link.txt`,
        `${consumerPackagePath}/src/self-loop.txt`,
        `${consumerPackagePath}/src/same-package-link.txt`,
        `${consumerPackagePath}/src/same-package-link-read.ts`,
        `${consumerPackagePath}/src/missing-leaf-in-package.ts`,
        `${consumerPackagePath}/src/join-normalized-read.ts`,
        `${consumerPackagePath}/src/indep-join-pass.ts`,
        `${consumerPackagePath}/src/dir-dot-read.ts`,
        `${consumerPackagePath}/src/dir-inner-dot-read.ts`,
        `${consumerPackagePath}/src/resolve-dot-read.ts`,
        `${consumerPackagePath}/src/nested`,
        `${consumerPackagePath}/src/local-data.txt`,
        `${consumerPackagePath}/src/private.txt`,
        siblingPackage,
      ]) {
        await rm(path.join(targetDir, fixturePath), {
          recursive: true,
          force: true,
        });
      }
      const restored = await rootCheck();
      expect(restored.exitCode).toBe(0);
      expect(checkText(restored)).not.toContain("包文件系统隔离：");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("blocks known-path commands in package manifests from the root check entry", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-manifest-command-"),
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
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const consumerPackagePath = initialization.blueprint.packages[0]!.path;

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "provider",
          linkFrom: [consumerPackagePath],
        }).projectProjections,
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const rootCheck = async () =>
        execa("pnpm", ["run", "check"], { cwd: targetDir, reject: false });
      const boundariesCheck = async () =>
        execa("pnpm", ["run", "boundaries"], { cwd: targetDir, reject: false });
      const manifestPath = path.join(
        targetDir,
        consumerPackagePath,
        "package.json",
      );
      const originalManifest = await readFile(manifestPath, "utf8");
      const restoreManifest = () =>
        writeFile(manifestPath, originalManifest, "utf8");
      const setScripts = async (scripts: Readonly<Record<string, string>>) => {
        const manifest = JSON.parse(originalManifest) as {
          scripts: Record<string, string>;
        };
        Object.assign(manifest.scripts, scripts);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      };

      // 真实根安装解析 shell-quote@1.11.0 后，生成根 typecheck 必须通过其自带类型
      // （含 Array.join 全局增强）编译 checker 脚本。
      const typecheck = await execa("pnpm", ["run", "typecheck"], {
        cwd: targetDir,
        reject: false,
      });
      expect(typecheck.exitCode).toBe(0);

      // 正常模板的已知单段命令不产生命令诊断。
      const clean = await rootCheck();
      expect(clean.exitCode).toBe(0);
      expect(`${clean.stdout}\n${clean.stderr}`).not.toContain(
        "包文件系统隔离",
      );

      // 目录/config/source-entry/executable/工作目录 operand 与多 positional 变异。
      await setScripts({
        "format:check": "oxfmt --list-different ../provider ../provider/src",
      });
      const directoryEscape = await boundariesCheck();
      expect(directoryEscape.exitCode).not.toBe(0);
      const directoryOutput = `${directoryEscape.stdout}\n${directoryEscape.stderr}`;
      expect(directoryOutput).toMatch(
        /packages\/lib\/package\.json:\d+:\d+ 包文件系统隔离：manifest script "format:check" 的 目录 operand \.\.\/provider(?!\/src)/,
      );
      expect(directoryOutput).toContain(
        `manifest script "format:check" 的 目录 operand ../provider/src`,
      );
      expect(directoryOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider",
      );
      expect(directoryOutput).toContain(
        "跨包任务交给根 Workspace Orchestration Package",
      );

      await restoreManifest();
      await setScripts({
        typecheck: "tsc -p ../provider/tsconfig.json --noEmit --pretty false",
      });
      const configEscape = await boundariesCheck();
      expect(configEscape.exitCode).not.toBe(0);
      expect(`${configEscape.stdout}\n${configEscape.stderr}`).toContain(
        `包文件系统隔离：manifest script "typecheck" 的 config operand ../provider/tsconfig.json`,
      );

      await restoreManifest();
      await setScripts({
        "test:e2e": "node --conditions=source ../provider/test/e2e/run.ts",
      });
      const entryEscape = await boundariesCheck();
      expect(entryEscape.exitCode).not.toBe(0);
      expect(`${entryEscape.stdout}\n${entryEscape.stderr}`).toContain(
        `manifest script "test:e2e" 的 source-entry operand ../provider/test/e2e/run.ts`,
      );

      await restoreManifest();
      await setScripts({ build: "pnpm --dir ../provider exec tsc --version" });
      const cwdEscape = await boundariesCheck();
      expect(cwdEscape.exitCode).not.toBe(0);
      expect(`${cwdEscape.stdout}\n${cwdEscape.stderr}`).toContain(
        `manifest script "build" 的 工作目录 operand ../provider`,
      );

      await restoreManifest();
      await setScripts({ lint: "../provider/scripts/tool.sh --quiet ." });
      const executableEscape = await boundariesCheck();
      expect(executableEscape.exitCode).not.toBe(0);
      expect(
        `${executableEscape.stdout}\n${executableEscape.stderr}`,
      ).toContain(
        `manifest script "lint" 的 executable operand ../provider/scripts/tool.sh`,
      );

      await restoreManifest();
      await setScripts({
        test: "vitest run ../provider/test test/unit --reporter=verbose",
      });
      const positionalEscape = await boundariesCheck();
      expect(positionalEscape.exitCode).not.toBe(0);
      expect(
        `${positionalEscape.stdout}\n${positionalEscape.stderr}`,
      ).toContain(
        `manifest script "test" 的 工具 positional operand ../provider/test`,
      );

      // 精确 sibling 编排归根：包名 selector、裸 sibling task 与目录 selector。
      await restoreManifest();
      await setScripts({
        build:
          "pnpm --filter @demo/provider run build && tsc -p tsconfig.build.json --pretty false",
      });
      const nameOrchestration = await boundariesCheck();
      expect(nameOrchestration.exitCode).not.toBe(0);
      const nameOrchestrationOutput = `${nameOrchestration.stdout}\n${nameOrchestration.stderr}`;
      expect(nameOrchestrationOutput).toContain(
        `manifest script "build" 的 selector operand @demo/provider`,
      );
      expect(nameOrchestrationOutput).toContain("跨包任务编排归");

      await restoreManifest();
      await setScripts({ lint: "pnpm run start" });
      const selfTask = await boundariesCheck();
      expect(selfTask.exitCode).toBe(0);

      await restoreManifest();
      await setScripts({ lint: "pnpm --filter ../provider run build" });
      const selectorEscape = await boundariesCheck();
      expect(selectorEscape.exitCode).not.toBe(0);
      expect(`${selectorEscape.stdout}\n${selectorEscape.stderr}`).toContain(
        `manifest script "lint" 的 selector operand ../provider`,
      );

      // 目录 selector 按 command cwd（owning 包目录）解释：workspace 根相对写法不是成员，不猜测、不阻断。
      await restoreManifest();
      await setScripts({
        lint: "pnpm --filter ./packages/provider run build",
        check: "pnpm --filter ./packages/lib run check",
      });
      const selectorByCwd = await boundariesCheck();
      expect(selectorByCwd.exitCode).toBe(0);
      expect(`${selectorByCwd.stdout}\n${selectorByCwd.stderr}`).not.toContain(
        "包文件系统隔离",
      );

      // 单一排除前缀不改变目录 selector 的 cwd 判定。
      await restoreManifest();
      await setScripts({ lint: "pnpm --filter=!../provider run build" });
      expect((await boundariesCheck()).exitCode).not.toBe(0);

      // 非路径 operand、非路径 flag 取值与运行时对照：均不阻断。
      await restoreManifest();
      await setScripts({
        "format:check":
          "oxlint --quiet --ignore-pattern node_modules --format=unix .",
        lint: "turbo run build --output-logs=errors-only --log-prefix=task",
        "test:e2e":
          "pnpm --filter ./packages/lib exec playwright test --host 127.0.0.1 --strictPort",
        build: "cargo clippy --workspace --all-targets -- -D warnings",
        "lint:fix": "oxlint --ignore-pattern ../provider/src .",
      });
      const nonPath = await boundariesCheck();
      expect(nonPath.exitCode).toBe(0);
      expect(`${nonPath.stdout}\n${nonPath.stderr}`).not.toContain(
        "包文件系统隔离",
      );

      // 相关动态值阻断、无关运行时动态值不阻断。
      await restoreManifest();
      await setScripts({
        "format:check": "oxfmt --list-different ../$PKG/src",
        typecheck: "tsc -p $TS_CONFIG --noEmit --pretty false",
        "test:e2e": 'node -e "if (true) process.exit(0)"',
        preview: "vite preview --host 127.0.0.1",
      });
      const dynamic = await boundariesCheck();
      expect(dynamic.exitCode).not.toBe(0);
      const dynamicOutput = `${dynamic.stdout}\n${dynamic.stderr}`;
      expect(dynamicOutput).toContain(
        `manifest script "format:check" 的 目录 operand ../$PKG/src`,
      );
      expect(dynamicOutput).toContain("无法静态求值");
      expect(dynamicOutput).not.toContain(`manifest script "typecheck"`);
      expect(dynamicOutput).not.toContain(`manifest script "test:e2e"`);

      // 带仓库定位线索的内联程序不可验证而非执行或猜目标。
      await restoreManifest();
      await setScripts({
        postbuild:
          "node -e \"require('node:fs').chmodSync('../provider/cli.js', 0o755)\"",
      });
      const inlineEscape = await boundariesCheck();
      expect(inlineEscape.exitCode).not.toBe(0);
      const inlineOutput = `${inlineEscape.stdout}\n${inlineEscape.stderr}`;
      expect(inlineOutput).toContain(`manifest script "postbuild" 的 内联程序`);
      expect(inlineOutput).toContain("无法静态求值");
      expect(inlineOutput).not.toContain("私有路径 packages/provider");

      // 原闭集补漏：字面量 env 前缀、cd、cargo --manifest-path、Node 独立值 flag、opaque env 词边界、仓库根私有 executable、空串 operand。
      await restoreManifest();
      await setScripts({
        "s-env-node": "MODE=test node ../provider/src/entry.ts",
        "s-cd": "cd ../provider && node entry.ts",
        "s-cargo": "cargo build --manifest-path ../provider/Cargo.toml",
        "s-node-flag": "node --conditions source ../provider/src/entry.ts",
        "s-env-word": "oxlint ../$PKG /safe",
        "s-exe-root": "../../scripts/tools/tool.ts --check",
        "s-empty": 'oxlint "" ../provider/src',
      });
      const closedSet = await boundariesCheck();
      expect(closedSet.exitCode).not.toBe(0);
      const closedOutput = `${closedSet.stdout}\n${closedSet.stderr}`;
      for (const expected of [
        `manifest script "s-env-node" 的 source-entry operand ../provider/src/entry.ts`,
        `manifest script "s-cd" 的 工作目录 operand ../provider`,
        `manifest script "s-cargo" 的 config operand ../provider/Cargo.toml`,
        `manifest script "s-node-flag" 的 source-entry operand ../provider/src/entry.ts`,
        `manifest script "s-exe-root" 的 executable operand ../../scripts/tools/tool.ts`,
        `manifest script "s-empty" 的 目录 operand ../provider/src`,
      ]) {
        expect(closedOutput).toContain(expected);
      }
      // opaque env 词边界：../$PKG 保留为独立 operand，绝不伪造 /safe 并入。
      expect(closedOutput).toContain(
        `manifest script "s-env-word" 的 目录 operand ../$PKG`,
      );
      expect(closedOutput).not.toContain("../$PKG/safe");

      // 不猜测的 selector 形态保持非阻断。
      await restoreManifest();
      await setScripts({ lint: "turbo run build --filter=**" });
      expect((await boundariesCheck()).exitCode).toBe(0);

      // R10-M1 标记碰撞消歧：本轮 env 回调生成的 opaque 标记必须与原始字面文本区分。
      // 无变量的字面 __BOUNDARY_UNKNOWN_PKG__ 目录名不得被降级为 unknown，本包路径照常通过。
      await restoreManifest();
      await setScripts({
        "m-own": "oxlint ../lib/__BOUNDARY_UNKNOWN_PKG__/safe",
      });
      const collisionOwn = await boundariesCheck();
      expect(collisionOwn.exitCode).toBe(0);
      expect(`${collisionOwn.stdout}\n${collisionOwn.stderr}`).not.toContain(
        "包文件系统隔离",
      );

      // 同一无碰撞标记出现在兄弟包路径：确定 provider 目标而非 unknown，保留真实字面目录名。
      await restoreManifest();
      await setScripts({
        "m-sibling": "oxlint ../provider/__BOUNDARY_UNKNOWN_PKG__/safe",
      });
      const collisionSibling = await boundariesCheck();
      expect(collisionSibling.exitCode).not.toBe(0);
      const collisionSiblingOutput = `${collisionSibling.stdout}\n${collisionSibling.stderr}`;
      expect(collisionSiblingOutput).toContain(
        `manifest script "m-sibling" 的 目录 operand ../provider/__BOUNDARY_UNKNOWN_PKG__/safe`,
      );
      expect(collisionSiblingOutput).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider/__BOUNDARY_UNKNOWN_PKG__/safe",
      );
      expect(collisionSiblingOutput).not.toContain("无法静态求值");
      expect(collisionSiblingOutput).not.toContain("$PKG");

      // 真实 env 展开仍标 unknown，显示复原真实变量名，与字面文本互不干扰。
      await restoreManifest();
      await setScripts({ "m-realenv": "oxlint ../$PKG/src" });
      const collisionRealEnv = await boundariesCheck();
      expect(collisionRealEnv.exitCode).not.toBe(0);
      const collisionRealEnvOutput = `${collisionRealEnv.stdout}\n${collisionRealEnv.stderr}`;
      expect(collisionRealEnvOutput).toContain(
        `manifest script "m-realenv" 的 目录 operand ../$PKG/src`,
      );
      expect(collisionRealEnvOutput).toContain("无法静态求值");

      // 字面标记与确定 sibling operand 共存：确定目标保留，后继 operand 不被吞，不伪造 $PKG。
      await restoreManifest();
      await setScripts({
        "m-mix": "oxlint __BOUNDARY_UNKNOWN_PKG__ ../provider/src",
      });
      const collisionMix = await boundariesCheck();
      expect(collisionMix.exitCode).not.toBe(0);
      const collisionMixOutput = `${collisionMix.stdout}\n${collisionMix.stderr}`;
      expect(collisionMixOutput).toContain(
        `manifest script "m-mix" 的 目录 operand ../provider/src`,
      );
      expect(collisionMixOutput).not.toContain("$PKG");

      // R10-Q1 引号合并标记碰撞（当前标记格式 __BOUNDARY_ENV{n}__）：官方 shell-quote@1.11.0
      // 在解析阶段先合并相邻引号（'a'0'b→a0b），合并后的纯字面词可能恰好等于同 KEY 的登记标记
      // base+KEY+base；与真实 env 同命令共存时，父候选 1410173d 会把字面 operand 降级 unknown 并
      // 伪造成 $PKG，丢失确定 target/owner。修复按合并后的字面词集合现选基底，使引号拼接无法撞标记。
      const probeCommand = async (cmd: string) => {
        await restoreManifest();
        await setScripts({ "mf-probe": cmd });
        const result = await boundariesCheck();
        const output = `${result.stdout}\n${result.stderr}`;
        return {
          code: result.exitCode,
          output,
          diag: (output.match(/包文件系统隔离/g)?.length ?? 0) as number,
        };
      };

      // MF1-03（必修反例，父 red→修复 green）：兄弟包字面路径 + 同名真实 env。修复后保留确定
      // provider 目标与真实目录名，第二 operand 仍独立 unknown，绝不把字面路径伪造成 ../provider/$PKG。
      const mf1_03 = await probeCommand(
        "oxlint '../provider/__BOUNDARY_ENV'0__PKG'__BOUNDARY_ENV'0__/safe ../$PKG/src",
      );
      expect(mf1_03.code).not.toBe(0);
      expect(mf1_03.output).toContain(
        "私有路径 packages/provider/__BOUNDARY_ENV0__PKG__BOUNDARY_ENV0__/safe",
      );
      expect(mf1_03.output).toContain("目录 operand ../$PKG/src");
      expect(mf1_03.output).toContain("无法静态求值");
      expect(mf1_03.output).not.toContain("../provider/$PKG");

      // MF1-04（必修反例，父 red→修复 green）：本包字面路径 + 同名真实 env。修复后不得为本包字面
      // operand 新增 unknown（假红），只有第二真实 env 不可验证；父候选会为 ../lib/$PKG/safe 伪造 unknown。
      const mf1_04 = await probeCommand(
        "oxlint '../lib/__BOUNDARY_ENV'0__PKG'__BOUNDARY_ENV'0__/safe ../$PKG/src",
      );
      expect(mf1_04.code).not.toBe(0);
      expect(mf1_04.diag).toBe(1);
      expect(mf1_04.output).toContain("目录 operand ../$PKG/src");
      expect(mf1_04.output).not.toContain("../lib/$PKG");

      // MF1-07（不同 KEY 对照）：字面 PKG 标记未登记 → 确定 provider 目标保留，$OTHER 独立 unknown。
      const mf1_07 = await probeCommand(
        "oxlint '../provider/__BOUNDARY_ENV'0__PKG'__BOUNDARY_ENV'0__/safe ../$OTHER/src",
      );
      expect(mf1_07.code).not.toBe(0);
      expect(mf1_07.output).toContain(
        "私有路径 packages/provider/__BOUNDARY_ENV0__PKG__BOUNDARY_ENV0__/safe",
      );
      expect(mf1_07.output).toContain("目录 operand ../$OTHER/src");
      expect(mf1_07.output).not.toContain("../provider/$PKG");

      // MF1-08（原文完整含基底→nonce 递增 对照）：命令原文含 __BOUNDARY_ENV0__ 使 nonce 升到 ENV1，
      // 候选机制在该形态下有效：确定 provider 目标保留，$PKG 独立 unknown。
      const mf1_08 = await probeCommand(
        "oxlint '../provider/__BOUNDARY_ENV0__/x' ../$PKG/src",
      );
      expect(mf1_08.code).not.toBe(0);
      expect(mf1_08.output).toContain(
        "目录 operand ../provider/__BOUNDARY_ENV0__/x",
      );
      expect(mf1_08.output).toContain(
        "兄弟包 @demo/provider (packages/provider)",
      );
      expect(mf1_08.output).toContain("目录 operand ../$PKG/src");
      expect(mf1_08.output).not.toContain("../provider/$PKG");

      // MF1 控制：无 env 时纯字面本包通过 / 兄弟包确定越界；真实 env 自身 unknown；双 operand 不吞；
      // 碰撞文本落在非路径位（--ignore-pattern 值）不新增误报。
      const mf1_01 = await probeCommand(
        "oxlint '../lib/__BOUNDARY_ENV'0__PKG'__BOUNDARY_ENV'0__/safe",
      );
      expect(mf1_01.code).toBe(0);
      const mf1_02 = await probeCommand(
        "oxlint '../provider/__BOUNDARY_ENV'0__PKG'__BOUNDARY_ENV'0__/safe",
      );
      expect(mf1_02.code).not.toBe(0);
      expect(mf1_02.output).toContain(
        "私有路径 packages/provider/__BOUNDARY_ENV0__PKG__BOUNDARY_ENV0__/safe",
      );
      expect(mf1_02.output).not.toContain("无法静态求值");
      const mf1_05 = await probeCommand("oxlint ../$PKG/src");
      expect(mf1_05.code).not.toBe(0);
      expect(mf1_05.output).toContain("目录 operand ../$PKG/src");
      const mf1_06 = await probeCommand(
        "oxlint '../lib/__BOUNDARY_ENV'0__PKG'__BOUNDARY_ENV'0__/safe ../$PKG/src",
      );
      expect(mf1_06.diag).toBe(1);
      expect(mf1_06.output).not.toContain("../lib/$PKG");
      const mf1_09 = await probeCommand("oxlint ../$PKG/src ../$PKG/dist");
      expect(mf1_09.diag).toBe(2);
      const mf1_10 = await probeCommand(
        "oxlint --ignore-pattern '../x__BOUNDARY_ENV'0__PKG'__BOUNDARY_ENV'0__' ../$PKG/src",
      );
      expect(mf1_10.code).not.toBe(0);
      expect(mf1_10.diag).toBe(1);
      expect(mf1_10.output).toContain("目录 operand ../$PKG/src");

      // c01..30 旧固定闭集在修复 checker 下逐 operand 复跑（权威来自 ticket-10-marker-fixed-proof 记录）。
      // 本次只改基底选择；这些命令的合并字面词都不含 __BOUNDARY_ENV0__，故 base 仍取 ENV0，行为逐字不变。
      const legacyClosedSet: ReadonlyArray<{
        cmd: string;
        code: number;
        diag: number;
      }> = [
        { cmd: "node scripts/run.ts", code: 0, diag: 0 },
        { cmd: "MODE=test node ../provider/src/entry.ts", code: 1, diag: 1 },
        {
          cmd: "MODE=test NODE_OPTIONS=--conditions=source node scripts/run.ts",
          code: 0,
          diag: 0,
        },
        { cmd: "cd ../provider && node entry.ts", code: 1, diag: 1 },
        { cmd: "oxfmt --list-different ../provider", code: 1, diag: 1 },
        { cmd: "pnpm --filter @demo/provider run build", code: 1, diag: 1 },
        { cmd: "pnpm --filter=../provider run build", code: 1, diag: 1 },
        { cmd: "pnpm --filter ../provider run build", code: 1, diag: 1 },
        { cmd: "pnpm exec turbo run build --filter=.", code: 0, diag: 0 },
        {
          cmd: "pnpm --filter=./packages/provider run build",
          code: 0,
          diag: 0,
        },
        { cmd: "pnpm --filter=./packages/lib run check", code: 0, diag: 0 },
        { cmd: "pnpm --filter=!../provider run build", code: 1, diag: 1 },
        {
          cmd: "oxlint --quiet --ignore-pattern node_modules .",
          code: 0,
          diag: 0,
        },
        { cmd: "vite preview --host 127.0.0.1 --strictPort", code: 0, diag: 0 },
        {
          cmd: "cargo build --manifest-path ../provider/Cargo.toml",
          code: 1,
          diag: 1,
        },
        {
          cmd: "cargo clippy --workspace --all-targets -- -D warnings",
          code: 0,
          diag: 0,
        },
        {
          cmd: "node --conditions source ../provider/src/entry.ts",
          code: 1,
          diag: 1,
        },
        {
          cmd: "node -e \"require('node:fs').chmodSync('../provider/cli.js', 0o755)\"",
          code: 1,
          diag: 1,
        },
        { cmd: 'node -e "if (true) console.log(1)"', code: 0, diag: 0 },
        {
          cmd: "turbo run build --output-logs=errors-only --log-prefix=task",
          code: 0,
          diag: 0,
        },
        { cmd: "oxlint ../$PKG/src", code: 1, diag: 1 },
        // c22：未知 $ENTRY 之后的 ../provider/src/entry.ts 只是 Node 用户 argv，不因 ../ 升格为路径（R10-2 裁定）。
        { cmd: "node $PKG ../provider/src/entry.ts", code: 0, diag: 0 },
        { cmd: "oxlint ../$PKG /safe", code: 1, diag: 1 },
        { cmd: 'oxlint "" ../provider/src', code: 1, diag: 1 },
        {
          cmd: "oxlint ../provider/src && oxfmt --write ../provider/dist",
          code: 1,
          diag: 2,
        },
        { cmd: "../../scripts/tools/tool.ts --check", code: 1, diag: 1 },
        { cmd: "../scripts/tools/tool.ts --check", code: 1, diag: 1 },
        { cmd: "oxlint ../lib/src", code: 0, diag: 0 },
        { cmd: "oxfmt --list-different .", code: 0, diag: 0 },
        {
          cmd: "pnpm --filter=$PKG exec turbo run build --filter=../provider",
          code: 1,
          diag: 1,
        },
      ];
      for (const legacy of legacyClosedSet) {
        const res = await probeCommand(legacy.cmd);
        expect({ cmd: legacy.cmd, code: res.code, diag: res.diag }).toEqual({
          cmd: legacy.cmd,
          code: legacy.code,
          diag: legacy.diag,
        });
      }

      // R10-X1/X2 解析异常局部承接：官方 shell-quote@1.11.0 对未闭合 `${` 在解析阶段主动抛
      // "Bad substitution"。父候选 dca654af 的单条 command 分析（freshEnvMarkerBase 与 commandSegments
      // 的两次 parse）没有异常边界，任一 script 抛出即让整个 Root Check 在渲染诊断前崩溃并吞掉兄弟包确定违规。
      // 修复把单个 parse 抛错沿用 commandSegments 返回 null 的「放弃分析该命令」语义：抛出命令被跳过，
      // 同一 manifest 的另一 script 与兄弟包确定违规仍被准确报告，且不出现未捕获 parser 堆栈。
      // 父 red→修复 green：父在此崩溃、0 边界诊断且有 Bad substitution 堆栈；修复报告确定违规、无堆栈。
      await restoreManifest();
      await setScripts({
        "pe-throw": "oxlint ../provider/src ${bad",
        "pe-violation": "oxlint ../provider/src",
      });
      const parseThrow = await boundariesCheck();
      const parseThrowOutput = `${parseThrow.stdout}\n${parseThrow.stderr}`;
      expect(parseThrow.exitCode).not.toBe(0);
      expect(parseThrowOutput).toContain(
        `manifest script "pe-violation" 的 目录 operand ../provider/src`,
      );
      expect(parseThrowOutput).toContain(
        "兄弟包 @demo/provider (packages/provider)",
      );
      expect(parseThrowOutput).not.toContain("Bad substitution");

      // R10-X2 边界：抛出命令自身不必从不可结构化输入恢复 operand——单独存在时被整体放弃、不产生命令诊断，
      // 也不因此终止兄弟包检查（对照 c25 的 `&&` 串联仍逐段诊断）。
      await restoreManifest();
      await setScripts({ "pe-throw": "oxlint ../provider/src ${bad" });
      const onlyThrow = await boundariesCheck();
      const onlyThrowOutput = `${onlyThrow.stdout}\n${onlyThrow.stderr}`;
      expect(onlyThrow.exitCode).toBe(0);
      expect(onlyThrowOutput).not.toContain("Bad substitution");
      expect(onlyThrowOutput).not.toContain("包文件系统隔离");

      // RC-2：词法留在本包的已知静态 operand 不再被 command 面提前放行——operand 是原样交给
      // 进程的字面路径，按最近存在前缀/native realpath 的真实归属判定，与 fs 面同一物理接缝。
      await symlink(
        "../../provider/src",
        path.join(targetDir, `${consumerPackagePath}/src/link`),
      );
      await symlink(
        "./gone",
        path.join(targetDir, `${consumerPackagePath}/src/broken-link`),
      );
      await mkdir(path.join(targetDir, `${consumerPackagePath}/src/nested`), {
        recursive: true,
      });
      await writeFile(
        path.join(targetDir, `${consumerPackagePath}/src/nested/own.ts`),
        "export const own = 1;\n",
      );
      await symlink(
        "./nested",
        path.join(targetDir, `${consumerPackagePath}/src/same-link`),
      );

      const linkEntry = await probeCommand("node ./src/link/index.ts");
      expect(linkEntry.code).not.toBe(0);
      expect(linkEntry.diag).toBe(1);
      expect(linkEntry.output).toContain(
        `manifest script "mf-probe" 的 source-entry operand ./src/link/index.ts 通过本地文件系统路径访问 兄弟包 @demo/provider (packages/provider) 的私有路径 ${consumerPackagePath}/src/link/index.ts`,
      );
      // 链接目录下的缺失 entry 按最近存在祖先的真实归属判定，不因目标不存在而放行。
      const linkMissing = await probeCommand("node ./src/link/nothere.ts");
      expect(linkMissing.code).not.toBe(0);
      expect(linkMissing.diag).toBe(1);
      expect(linkMissing.output).toContain(
        `manifest script "mf-probe" 的 source-entry operand ./src/link/nothere.ts 通过本地文件系统路径访问 兄弟包 @demo/provider (packages/provider)`,
      );
      // 目录 selector 同理：物理落到兄弟包的 `./` 形态 selector 按跨包编排归根。
      const linkSelector = await probeCommand(
        "pnpm --filter ./src/link run build",
      );
      expect(linkSelector.code).not.toBe(0);
      expect(linkSelector.diag).toBe(1);
      expect(linkSelector.output).toContain(
        `manifest script "mf-probe" 的 selector operand ./src/link 指向兄弟包 @demo/provider (packages/provider)`,
      );
      // 断裂链接 operand：真实位置无法验证的独立类别，含真实失败码，不复用「无法静态求值」结论。
      const brokenEntry = await probeCommand("node ./src/broken-link/entry.ts");
      expect(brokenEntry.code).not.toBe(0);
      expect(brokenEntry.diag).toBe(1);
      expect(brokenEntry.output).toContain(
        `source-entry operand ./src/broken-link/entry.ts 无法验证真实路径（ENOENT）`,
      );
      expect(brokenEntry.output).not.toContain("无法静态求值");
      // 正项：物理留在本包的链接穿越 operand 与目录 selector 不误报。
      const ownLinkEntry = await probeCommand("node ./src/same-link/own.ts");
      expect(ownLinkEntry.code).toBe(0);
      expect(ownLinkEntry.diag).toBe(0);
      const ownLinkSelector = await probeCommand(
        "pnpm --filter ./src/same-link run build",
      );
      expect(ownLinkSelector.code).toBe(0);
      expect(ownLinkSelector.diag).toBe(0);

      // RC-3：词法在本包内、经包内链接物理落到仓库根外的 operand 不被 command 面静默放行。
      // 同一条真实链接在 fs、独立构造、known command（source/config/cwd）与目录 selector 四面
      // 得到同一「工作区之外」结论，且检查器不为根外目标伪造成员包身份。
      const outsideTree = path.join(workspace, "outside-tree");
      await mkdir(outsideTree, { recursive: true });
      await writeFile(
        path.join(outsideTree, "outside-target.ts"),
        "export const outside = 1;\n",
      );
      await writeFile(path.join(outsideTree, "tsconfig.json"), "{}\n");
      await writeFile(path.join(outsideTree, "outside.txt"), "outside\n");
      await symlink(
        "../../../../outside-tree",
        path.join(targetDir, `${consumerPackagePath}/src/outlink`),
      );
      await writeFile(
        path.join(
          targetDir,
          `${consumerPackagePath}/src/outside-command-read.ts`,
        ),
        'import { readFileSync } from "node:fs";\nimport path from "node:path";\n\nexport const read = readFileSync(\n  path.join("./src/outlink", "outside.txt"),\n  "utf8",\n);\n',
      );
      await writeFile(
        path.join(
          targetDir,
          `${consumerPackagePath}/src/outside-command-construct.ts`,
        ),
        'import path from "node:path";\n\nexport const outsideTarget = path.join("./src/outlink", "outside.txt");\n',
      );

      await restoreManifest();
      await setScripts({
        "mf-entry": "node ./src/outlink/outside-target.ts",
        "mf-config": "tsc -p ./src/outlink/tsconfig.json --noEmit",
        "mf-dir": "pnpm --dir ./src/outlink exec tsc --version",
        "mf-selector": "pnpm --filter ./src/outlink run build",
      });
      const outsideFaces = await boundariesCheck();
      const outsideOutput = `${outsideFaces.stdout}\n${outsideFaces.stderr}`;
      expect(outsideFaces.exitCode).not.toBe(0);
      expect(outsideOutput).toContain(
        `${consumerPackagePath}/src/outside-command-read.ts:`,
      );
      expect(outsideOutput).toContain(
        `${consumerPackagePath}/src/outside-command-construct.ts:`,
      );
      for (const expected of [
        `manifest script "mf-entry" 的 source-entry operand ./src/outlink/outside-target.ts`,
        `manifest script "mf-config" 的 config operand ./src/outlink/tsconfig.json`,
        `manifest script "mf-dir" 的 工作目录 operand ./src/outlink`,
        `manifest script "mf-selector" 的 selector operand ./src/outlink`,
      ]) {
        expect(outsideOutput).toContain(expected);
      }
      // 六个消费者面都点名同一仓库根外目标；没有一条被伪装成成员包的私有路径。
      expect(
        outsideOutput.match(/工作区之外的 [^\n]*outside-tree/g)?.length,
      ).toBe(6);
      expect(outsideOutput).not.toContain("私有路径 packages/");
      expect(outsideOutput).not.toContain("无法静态求值");

      // 正项：仓库根外链接的存在不影响同一命令面对本包真实链接的判定。
      for (const outsideFaceFile of [
        `${consumerPackagePath}/src/outside-command-read.ts`,
        `${consumerPackagePath}/src/outside-command-construct.ts`,
      ]) {
        await rm(path.join(targetDir, outsideFaceFile));
      }
      const ownLinkWithOutside = await probeCommand(
        "node ./src/same-link/own.ts",
      );
      expect(ownLinkWithOutside.code).toBe(0);
      expect(ownLinkWithOutside.diag).toBe(0);

      // 移除命令变异后恢复通过（R10-X2「删除违规恢复 clean0」）。
      await restoreManifest();
      for (const physicalFixture of [
        `${consumerPackagePath}/src/link`,
        `${consumerPackagePath}/src/broken-link`,
        `${consumerPackagePath}/src/same-link`,
        `${consumerPackagePath}/src/nested`,
        `${consumerPackagePath}/src/outlink`,
      ]) {
        await rm(path.join(targetDir, physicalFixture), {
          recursive: true,
          force: true,
        });
      }
      await rm(outsideTree, { recursive: true, force: true });
      const afterParseThrow = await rootCheck();
      expect(afterParseThrow.exitCode).toBe(0);
      expect(
        `${afterParseThrow.stdout}\n${afterParseThrow.stderr}`,
      ).not.toContain("包文件系统隔离");

      // 移除全部命令变异后恢复通过。
      await restoreManifest();
      const restored = await rootCheck();
      expect(restored.exitCode).toBe(0);
      expect(`${restored.stdout}\n${restored.stderr}`).not.toContain(
        "包文件系统隔离",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("judges chained commands segment-wise and reports complex command unknowns", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-command-chains-"),
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
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const consumerPackagePath = initialization.blueprint.packages[0]!.path;

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "provider",
          linkFrom: [consumerPackagePath],
        }).projectProjections,
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const rootCheck = async () =>
        execa("pnpm", ["run", "check"], { cwd: targetDir, reject: false });
      const boundariesCheck = async () =>
        execa("pnpm", ["run", "boundaries"], { cwd: targetDir, reject: false });
      const outputOf = (result: { stderr: string; stdout: string }) =>
        `${result.stdout}\n${result.stderr}`;
      const libManifestPath = path.join(
        targetDir,
        consumerPackagePath,
        "package.json",
      );
      const providerManifestPath = path.join(
        targetDir,
        "packages/provider/package.json",
      );
      const rootManifestPath = path.join(targetDir, "package.json");
      const originalLibManifest = await readFile(libManifestPath, "utf8");
      const originalProviderManifest = await readFile(
        providerManifestPath,
        "utf8",
      );
      const originalRootManifest = await readFile(rootManifestPath, "utf8");
      const assignScripts = async (
        manifestPath: string,
        original: string,
        scripts: Readonly<Record<string, string>>,
      ) => {
        const manifest = JSON.parse(original) as {
          scripts: Record<string, string>;
        };
        Object.assign(manifest.scripts, scripts);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      };
      const setScripts = (scripts: Readonly<Record<string, string>>) =>
        assignScripts(libManifestPath, originalLibManifest, scripts);
      const setProviderScripts = (scripts: Readonly<Record<string, string>>) =>
        assignScripts(providerManifestPath, originalProviderManifest, scripts);
      const setRootScripts = (scripts: Readonly<Record<string, string>>) =>
        assignScripts(rootManifestPath, originalRootManifest, scripts);
      const restoreManifests = async () => {
        await writeFile(libManifestPath, originalLibManifest, "utf8");
        await writeFile(providerManifestPath, originalProviderManifest, "utf8");
        await writeFile(rootManifestPath, originalRootManifest, "utf8");
      };

      // T11-3 正向：正常模板，以及不含仓库定位线索的复杂命令都不阻断（08 窄范围继续成立）。
      // 内联程序、管道、glob selector 与重定向都不得被升级为硬失败。
      const clean = await rootCheck();
      expect(clean.exitCode).toBe(0);
      await setScripts({
        "cx-inline": 'node -e "if (true) process.exit(0)"',
        "cx-pipe": "oxlint --ignore-pattern node_modules . | tee lint.log",
        "cx-glob": "turbo run build --filter=** | cat",
        "cx-redirect": "vitest run src > result.log",
      });
      const unrelatedComplex = await boundariesCheck();
      expect(unrelatedComplex.exitCode).toBe(0);
      expect(outputOf(unrelatedComplex)).not.toContain("包文件系统隔离");

      // RC11-A：带不支持 operator 的命令里，只有构造自身携带的 operand 才是路径候选。
      // Node source-entry 之后的用户 argv、未知工具的普通参数、pattern/配置取值、`--` 之后 passthrough
      // 与引号内的消息文本，都不能因为同一条命令别处出现 `|`、`;` 或 `>` 而被升格为路径。
      await restoreManifests();
      await setScripts({
        "rp-node-argv":
          "node --conditions=source scripts/run.ts ../provider/notes.md | tee log",
        "rp-unknown-tool": "dx-doctor --target ../provider/src | tee log",
        "rp-pattern": "oxlint --ignore-pattern ../provider . | tee log",
        "rp-config-semi":
          "oxlint --config ../provider/.oxlintrc.json . ; pnpm run lint",
        "rp-passthrough": "cargo test --workspace -- ../provider/x | tee log",
        "rp-quoted-message":
          'echo "moved ../provider/notes.md today" | tee log',
        "rp-quoted-body":
          'pnpm run build | node scripts/notify.ts --body "see ../provider/docs.md"',
        "rp-unknown-after-semi":
          "oxlint . ; echo done --path ../provider/README.md",
      });
      const nonOperandsWithOperator = await boundariesCheck();
      expect(nonOperandsWithOperator.exitCode).toBe(0);
      expect(outputOf(nonOperandsWithOperator)).not.toContain("包文件系统隔离");

      // T11-1：简单顺序串联逐段同判断——前/中/后段的已知 operand 各自判定，同 script 内多个违规 operand 全保留。
      await restoreManifests();
      await setScripts({
        chain:
          "oxlint ../provider/src && tsc -p ../provider/tsconfig.json --noEmit && vitest run ../provider/test",
      });
      const chainEscape = await boundariesCheck();
      expect(chainEscape.exitCode).not.toBe(0);
      const chainOutput = outputOf(chainEscape);
      for (const expected of [
        `manifest script "chain" 的 目录 operand ../provider/src`,
        `manifest script "chain" 的 config operand ../provider/tsconfig.json`,
        `manifest script "chain" 的 工具 positional operand ../provider/test`,
      ]) {
        expect(chainOutput).toContain(expected);
      }
      expect(chainOutput.match(/包文件系统隔离/g)?.length ?? 0).toBe(3);
      // 字面量 env 前缀与同包串联仍按 10 的原语义通过。
      await restoreManifests();
      await setScripts({
        chain:
          "MODE=test oxlint . && tsc -p tsconfig.json --noEmit --pretty false",
      });
      expect((await boundariesCheck()).exitCode).toBe(0);

      // T11-2：与已知路径 operand 相关联的复杂构造给出"无法验证"或逐段确定判定，不猜目标。
      // 管道/分号后的段仍交同一 evaluator：已知跨包 operand 得到精确归属（父候选对此静默通过）。
      await restoreManifests();
      await setScripts({
        "cu-pipe": "oxlint ../provider/src | tee lint.log",
        "cu-semi": "pnpm run lint; oxfmt --list-different ../provider/src",
      });
      const structuredUnknown = await boundariesCheck();
      expect(structuredUnknown.exitCode).not.toBe(0);
      const unknownOutput = outputOf(structuredUnknown);
      expect(unknownOutput).toContain(
        `manifest script "cu-pipe" 的 目录 operand ../provider/src`,
      );
      expect(unknownOutput).toContain(
        `manifest script "cu-semi" 的 目录 operand ../provider/src`,
      );

      // 命令替换与重定向目标：无法可靠结构化 ⇒ 报告不支持的构造与 operand，给修正方向，不伪造归属。
      await restoreManifests();
      await setScripts({
        "cu-subst": "echo $(cat ../provider/secret.txt) && oxlint .",
        "cu-redirect": "oxlint . > ../provider/out.log",
      });
      const unverifiableUnknown = await boundariesCheck();
      expect(unverifiableUnknown.exitCode).not.toBe(0);
      const substOutput = outputOf(unverifiableUnknown);
      for (const expected of [
        `${consumerPackagePath}/package.json:`,
        `manifest script "cu-subst" 使用了检查器不支持的命令构造`,
        "其中的 operand ../provider/secret.txt 带仓库定位线索",
        `manifest script "cu-redirect" 使用了检查器不支持的命令构造`,
        "其中的 operand ../provider/out.log 带仓库定位线索",
        "无法可靠结构化判定目标",
        "修正方向：把该 operand 改写为可静态确定的本包内目标",
      ]) {
        expect(substOutput).toContain(expected);
      }
      // 不虚构目标归属，也不把该 operand 当成可执行文件。
      expect(substOutput).not.toContain("私有路径 packages/provider");
      expect(substOutput).not.toContain("executable operand");

      // T11-2 覆盖代表性支持外形态：subshell 内的已知工具段照常逐段判定，opaque env 词边界跨管道保持。
      await restoreManifests();
      await setScripts({
        "cu-subshell": "(oxlint ../provider/src)",
        "cu-expand": "oxlint ../$PKG/src | tee out",
      });
      const representative = await boundariesCheck();
      expect(representative.exitCode).not.toBe(0);
      const representativeOutput = outputOf(representative);
      expect(representativeOutput).toContain(
        `manifest script "cu-subshell" 的 目录 operand ../provider/src`,
      );
      expect(representativeOutput).toContain(
        `manifest script "cu-expand" 的 目录 operand ../$PKG/src`,
      );
      expect(representativeOutput).toContain("无法静态求值");

      // T11-4：单命令的不支持构造不吞掉同命令其余可判证据，也不吞掉其余 script 与其它包。
      await restoreManifests();
      await setScripts({
        "cs-mixed":
          "echo start | oxlint ../provider/src && vitest run ../provider/test > log",
      });
      const mixed = await boundariesCheck();
      expect(mixed.exitCode).not.toBe(0);
      const mixedOutput = outputOf(mixed);
      expect(mixedOutput).toContain(
        `manifest script "cs-mixed" 的 目录 operand ../provider/src`,
      );
      expect(mixedOutput).toContain(
        `manifest script "cs-mixed" 的 工具 positional operand ../provider/test`,
      );

      // 官方 parser 抛错的 script 被放弃，但同 manifest 其余 script 与兄弟包的违规仍各自出证据。
      await restoreManifests();
      await setScripts({
        "cs-throw": "oxlint ../provider/src ${bad",
        "cs-keep": "oxfmt --list-different ../provider/src",
      });
      await setProviderScripts({
        "cs-provider": "oxlint ../lib/src",
      });
      const surviving = await boundariesCheck();
      expect(surviving.exitCode).not.toBe(0);
      const survivingOutput = outputOf(surviving);
      expect(survivingOutput).not.toContain("Bad substitution");
      expect(survivingOutput).toContain(
        `manifest script "cs-keep" 的 目录 operand ../provider/src`,
      );
      expect(survivingOutput).toContain(
        `manifest script "cs-provider" 的 目录 operand ../lib/src`,
      );

      // 主裁定根侧义务：根只豁免静态跨包 containment——根自身的跨包编排与无关内联程序继续不阻断，
      // 已知 Node 内联程序与不支持构造自身携带的 operand 带仓库线索时仍要出证据，不能仅因 owner 是根就静默认证。
      await restoreManifests();
      await setRootScripts({
        "rp-root-orchestration": "turbo run build --filter=@demo/provider",
        "rp-root-orchestration-pnpm": "pnpm --filter @demo/provider run lint",
        "rp-root-inline-clean": 'node -e "if (true) process.exit(0)"',
        // 11+12 组合对照①：根的静态跨包 source-entry/config/工作目录/目录 operand/目录 selector 编排继续通过。
        // 这些形态在 12 的最近真实成员归属下若按普通包判定就会被误判成逃逸到 provider，根豁免必须保留在这里。
        "rp-root-source-entry": "node packages/provider/src/index.ts",
        "rp-root-config": "tsc -p packages/provider/tsconfig.json --noEmit",
        "rp-root-cwd": "cd packages/provider && oxlint .",
        "rp-root-dir-operand": "oxfmt --list-different packages/provider/src",
        "rp-root-dir-selector": "turbo run build --filter=./packages/provider",
      });
      const rootOrchestration = await boundariesCheck();
      expect(rootOrchestration.exitCode).toBe(0);
      expect(outputOf(rootOrchestration)).not.toContain("包文件系统隔离");

      // 11+12 组合对照②：同一静态跨包目标由普通包取得时仍按 12 的真实归属拒绝，根豁免不外溢到普通包。
      await restoreManifests();
      await setScripts({
        "rp-lib-source-entry": "node ../provider/src/index.ts",
      });
      const packageSameShape = await boundariesCheck();
      expect(packageSameShape.exitCode).not.toBe(0);
      expect(outputOf(packageSameShape)).toContain(
        'manifest script "rp-lib-source-entry" 的 source-entry operand ../provider/src/index.ts',
      );
      expect(outputOf(packageSameShape)).toContain(
        "兄弟包 @demo/provider (packages/provider) 的私有路径 packages/provider/src/index.ts",
      );

      await restoreManifests();
      await setRootScripts({
        "rp-root-inline":
          "node -e 'const u = new URL(\"../provider/src/index.ts\", import.meta.url); void u'",
        "rp-root-redirect": "oxlint . > ../provider/out.log",
      });
      const rootUnknown = await boundariesCheck();
      expect(rootUnknown.exitCode).not.toBe(0);
      const rootUnknownOutput = outputOf(rootUnknown);
      expect(rootUnknownOutput).toContain(
        'manifest script "rp-root-inline" 的 内联程序 给出了带仓库定位线索但无法静态求值',
      );
      expect(rootUnknownOutput).toContain(
        'manifest script "rp-root-redirect" 使用了检查器不支持的命令构造',
      );
      expect(rootUnknownOutput).toContain(
        "其中的 operand ../provider/out.log 带仓库定位线索",
      );
      expect(rootUnknownOutput).toContain(
        "生成仓库根 Workspace Orchestration Package",
      );
      // 根侧同样不虚构归属：内联程序与重定向目标都只声明"无法验证"。
      expect(rootUnknownOutput).not.toContain("私有路径 packages/provider");

      // 移除命令变异后恢复通过。
      await restoreManifests();
      const restored = await rootCheck();
      expect(restored.exitCode).toBe(0);
      expect(outputOf(restored)).not.toContain("包文件系统隔离");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("rejects plain JavaScript and Shell maintenance from the root language gate", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-language-gate-"),
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
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const packagePath = initialization.blueprint.packages[0]!.path;

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const rootCheck = () =>
        execa("pnpm", ["run", "check"], { cwd: targetDir, reject: false });
      const boundariesCheck = () =>
        execa("pnpm", ["run", "boundaries"], { cwd: targetDir, reject: false });
      const writeRepositoryFile = async (
        relativePath: string,
        lines: readonly string[],
        mode?: number,
      ) => {
        const filePath = path.join(targetDir, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${lines.join("\n")}\n`);
        if (mode !== undefined) await chmod(filePath, mode);
      };
      const removeRepositoryFile = (relativePath: string) =>
        rm(path.join(targetDir, relativePath));
      const gateProbe = () =>
        execa(
          "node",
          ["--conditions=source", "scripts/check-package-boundaries.ts"],
          {
            cwd: targetDir,
            reject: false,
          },
        );

      // 封闭角色的正文来自 checked Template Source；位置精确匹配时 Root Check 保持通过。
      const templateRoot = path.resolve(import.meta.dirname, "../../templates");
      await writeRepositoryFile(
        "scripts/container-entrypoint.sh",
        (
          await readFile(
            path.join(
              templateRoot,
              "vike-app/web/scripts/container-entrypoint.sh",
            ),
            "utf8",
          )
        ).split("\n"),
        0o755,
      );
      await writeRepositoryFile(
        "scripts/npm-publication-setup/setup.sh",
        (
          await readFile(
            path.join(templateRoot, "ts-cli/publication-setup/setup.sh"),
            "utf8",
          )
        ).split("\n"),
        0o755,
      );
      // 运行数据与派生产物不是 authored 维护源码，不被语言门误报。
      await writeRepositoryFile("data/runtime-state.js", [
        'export const cachedRun = "runtime";',
      ]);
      await writeRepositoryFile(`${packagePath}/dist/legacy-output.js`, [
        'export const built = "derived";',
      ]);

      const withRoles = await rootCheck();
      expect(withRoles.exitCode).toBe(0);
      expect(`${withRoles.stdout}\n${withRoles.stderr}`).not.toContain(
        "维护脚本语言门",
      );

      // 版本库元数据与 gitignore 标记的生成、缓存、派生目录不是 authored 扫描面。
      const nonAuthoredDirectories = [
        ".git/hooks/legacy-hook.js",
        ".template/staging/draft.js",
        ".pnpm-store/v3/entry.cjs",
        `${packagePath}/.turbo/cached/output.mjs`,
      ];
      for (const excluded of nonAuthoredDirectories) {
        await writeRepositoryFile(excluded, ["export const notAuthored = 1;"]);
      }
      const nonAuthored = await boundariesCheck();
      expect(nonAuthored.exitCode).toBe(0);
      expect(`${nonAuthored.stdout}\n${nonAuthored.stderr}`).not.toContain(
        "维护脚本语言门",
      );
      for (const excluded of nonAuthoredDirectories) {
        await removeRepositoryFile(excluded);
      }

      await writeRepositoryFile("scripts/deploy-helper.sh", [
        "#!/bin/sh",
        'echo "nightly cleanup"',
      ]);
      const rootShell = await boundariesCheck();
      expect(rootShell.exitCode).not.toBe(0);
      const rootShellOutput = `${rootShell.stdout}\n${rootShell.stderr}`;
      expect(rootShellOutput).toContain(
        "scripts/deploy-helper.sh 维护脚本语言门",
      );
      expect(rootShellOutput).toContain("可擦除的 TypeScript");
      expect(rootShellOutput).toContain("工具原生配置");
      await removeRepositoryFile("scripts/deploy-helper.sh");

      await writeRepositoryFile("scripts/legacy-report.js", [
        'import { readFileSync } from "node:fs";',
        "",
        'console.log(readFileSync("./package.json", "utf8").length);',
        "",
      ]);
      await writeRepositoryFile("scripts/nightly-summary.mjs", [
        'console.log("nightly");',
      ]);
      await writeRepositoryFile("scripts/release-tag.cjs", [
        'console.log("release");',
      ]);
      const rootJavaScript = await boundariesCheck();
      expect(rootJavaScript.exitCode).not.toBe(0);
      const rootJavaScriptOutput = `${rootJavaScript.stdout}\n${rootJavaScript.stderr}`;
      for (const escaped of [
        "scripts/legacy-report.js",
        "scripts/nightly-summary.mjs",
        "scripts/release-tag.cjs",
      ]) {
        expect(rootJavaScriptOutput).toContain(`${escaped} 维护脚本语言门`);
      }
      for (const ignored of [
        "data/runtime-state.js",
        `${packagePath}/dist/legacy-output.js`,
      ]) {
        expect(rootJavaScriptOutput).not.toContain(`${ignored} 维护脚本语言门`);
      }
      await removeRepositoryFile("scripts/legacy-report.js");
      await removeRepositoryFile("scripts/nightly-summary.mjs");
      await removeRepositoryFile("scripts/release-tag.cjs");

      await writeRepositoryFile(`${packagePath}/scripts/maintenance.js`, [
        'const helper = require("./helper.js");',
        "",
        "helper.run();",
        "",
      ]);
      await writeRepositoryFile(`${packagePath}/scripts/helper.js`, [
        'exports.run = () => console.log("helper");',
        "",
      ]);
      await writeRepositoryFile(`${packagePath}/scripts/report.mjs`, [
        'import { helper } from "./helper.mjs";',
        "",
        "helper();",
        "",
      ]);
      const packageJavaScript = await boundariesCheck();
      expect(packageJavaScript.exitCode).not.toBe(0);
      const packageJavaScriptOutput = `${packageJavaScript.stdout}\n${packageJavaScript.stderr}`;
      expect(packageJavaScriptOutput).toContain(
        `${packagePath}/scripts/maintenance.js 维护脚本语言门`,
      );
      expect(packageJavaScriptOutput).toContain(
        `${packagePath}/scripts/report.mjs 维护脚本语言门`,
      );
      for (const removed of [
        `${packagePath}/scripts/maintenance.js`,
        `${packagePath}/scripts/helper.js`,
        `${packagePath}/scripts/report.mjs`,
      ]) {
        await removeRepositoryFile(removed);
      }

      // 作者自建 checkJs 项目不构成豁免，包级 .pnpmfile.mjs 也不能冒充根 pnpm 原生 hook。
      await writeRepositoryFile(`${packagePath}/tsconfig.maintenance.json`, [
        '{"compilerOptions":{"allowJs":true,"checkJs":true},"files":["evil.mjs"]}',
      ]);
      await writeRepositoryFile(`${packagePath}/evil.mjs`, [
        "export const evil = 1;",
      ]);
      await writeRepositoryFile(`${packagePath}/.pnpmfile.mjs`, [
        "// hook",
        "export const hooks = { beforePacking(pkg) { return pkg; } };",
      ]);
      const selfChecked = await boundariesCheck();
      expect(selfChecked.exitCode).not.toBe(0);
      const selfCheckedOutput = `${selfChecked.stdout}\n${selfChecked.stderr}`;
      expect(selfCheckedOutput).toContain(
        `${packagePath}/evil.mjs 维护脚本语言门`,
      );
      expect(selfCheckedOutput).toContain(
        `${packagePath}/.pnpmfile.mjs 维护脚本语言门`,
      );
      await removeRepositoryFile(`${packagePath}/tsconfig.maintenance.json`);
      await removeRepositoryFile(`${packagePath}/evil.mjs`);
      await removeRepositoryFile(`${packagePath}/.pnpmfile.mjs`);

      // 借角色目录或相似文件名不获豁免。
      await writeRepositoryFile("scripts/npm-publication-setup/helper.sh", [
        "#!/bin/sh",
        'echo "impersonated"',
      ]);
      await writeRepositoryFile("scripts/nightly-entrypoint.sh", [
        "#!/bin/sh",
        'echo "impersonated"',
      ]);
      const impersonated = await boundariesCheck();
      expect(impersonated.exitCode).not.toBe(0);
      const impersonatedOutput = `${impersonated.stdout}\n${impersonated.stderr}`;
      expect(impersonatedOutput).toContain(
        "scripts/npm-publication-setup/helper.sh 维护脚本语言门",
      );
      expect(impersonatedOutput).toContain(
        "scripts/nightly-entrypoint.sh 维护脚本语言门",
      );
      expect(impersonatedOutput).not.toContain(
        "scripts/container-entrypoint.sh 维护脚本语言门",
      );
      expect(impersonatedOutput).not.toContain(
        "scripts/npm-publication-setup/setup.sh 维护脚本语言门",
      );
      await removeRepositoryFile("scripts/npm-publication-setup/helper.sh");
      await removeRepositoryFile("scripts/nightly-entrypoint.sh");

      // 真实 authored 点目录（角色目录、CI 与容器目录、作者自建隐藏目录）不逃逸语言门。
      const authoredDotDirectoryScripts = [
        "scripts/.hidden/legacy.js",
        ".github/scripts/deploy.js",
        ".devcontainer/setup.sh",
      ];
      await writeRepositoryFile(authoredDotDirectoryScripts[0]!, [
        'console.log("hidden cleanup");',
      ]);
      await writeRepositoryFile(authoredDotDirectoryScripts[1]!, [
        'console.log("runner action bootstrap");',
      ]);
      await writeRepositoryFile(authoredDotDirectoryScripts[2]!, [
        "#!/bin/sh",
        'echo "feature install"',
      ]);
      const authoredDotDirectory = await boundariesCheck();
      expect(authoredDotDirectory.exitCode).not.toBe(0);
      const authoredDotDirectoryOutput = `${authoredDotDirectory.stdout}\n${authoredDotDirectory.stderr}`;
      for (const escaped of authoredDotDirectoryScripts) {
        expect(authoredDotDirectoryOutput).toContain(
          `${escaped} 维护脚本语言门`,
        );
      }
      expect(authoredDotDirectoryOutput).toContain("可擦除的 TypeScript");
      expect(authoredDotDirectoryOutput).not.toContain(
        "scripts/container-entrypoint.sh 维护脚本语言门",
      );
      for (const removed of authoredDotDirectoryScripts) {
        await removeRepositoryFile(removed);
      }
      const dotDirectoryRestored = await boundariesCheck();
      expect(dotDirectoryRestored.exitCode).toBe(0);

      // 根 .pnpmfile.mjs 只有被根 tsconfig 的 checkJs 项目真实登记时才是封闭角色。
      await writeRepositoryFile(".pnpmfile.mjs", [
        "// @ts-check",
        "",
        "export const hooks = {",
        "  /**",
        "   * @param {{ name?: string }} pkg",
        "   * @returns {{ name?: string }}",
        "   */",
        "  beforePacking(pkg) {",
        "    return pkg;",
        "  },",
        "};",
      ]);
      const withoutMembership = await gateProbe();
      expect(withoutMembership.exitCode).not.toBe(0);
      expect(
        `${withoutMembership.stdout}\n${withoutMembership.stderr}`,
      ).toContain(".pnpmfile.mjs 维护脚本语言门");

      const rootConfigPath = path.join(targetDir, "tsconfig.json");
      const rootConfigText = await readFile(rootConfigPath, "utf8");
      const rootConfig = JSON.parse(rootConfigText) as {
        compilerOptions: Record<string, unknown>;
        files?: string[];
      };
      rootConfig.compilerOptions.checkJs = true;
      rootConfig.files = [".pnpmfile.mjs"];
      await writeFile(
        rootConfigPath,
        `${JSON.stringify(rootConfig, null, 2)}\n`,
      );
      const withMembership = await gateProbe();
      expect(withMembership.exitCode).toBe(0);
      await removeRepositoryFile(".pnpmfile.mjs");
      // 恢复逐字节写回原始根配置，Root Check 才不会被格式漂移干扰。
      await writeFile(rootConfigPath, rootConfigText);

      // 恢复全部变异后，真实 Root Check 重新通过。
      const restored = await rootCheck();
      expect(restored.exitCode).toBe(0);
      expect(`${restored.stdout}\n${restored.stderr}`).not.toContain(
        "维护脚本语言门",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("refuses maintenance scripts that no executed non-emitting project owns", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-ownership-"),
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
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const packagePath = initialization.blueprint.packages[0]!.path;
    const packageName = initialization.blueprint.packages[0]!.name;

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const gateProbe = () =>
        execa(
          "node",
          ["--conditions=source", "scripts/check-package-boundaries.ts"],
          { cwd: targetDir, reject: false },
        );
      const writeRepositoryFile = async (
        relativePath: string,
        lines: readonly string[],
      ) => {
        const filePath = path.join(targetDir, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${lines.join("\n")}\n`);
      };
      const readText = (relativePath: string) =>
        readFile(path.join(targetDir, relativePath), "utf8");
      const writeText = (relativePath: string, text: string) =>
        writeFile(path.join(targetDir, relativePath), text);
      const manifestPath = path.join(packagePath, "package.json");
      const readManifest = async () =>
        JSON.parse(await readText(manifestPath)) as {
          scripts: Record<string, string>;
        };
      const writeManifest = async (manifest: Record<string, unknown>) =>
        writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const packageTsconfigPath = path.join(packagePath, "tsconfig.json");
      const packageBuildTsconfigPath = path.join(
        packagePath,
        "tsconfig.build.json",
      );

      expect((await gateProbe()).exitCode).toBe(0);

      // 新增带类型错误的维护脚本：owner 项目排除 scripts 且缺 typecheck 任务时，Root Check 点名两类归属缺口。
      await writeRepositoryFile(`${packagePath}/scripts/probe-ownership.ts`, [
        "export const probeFlag: string = 42;",
      ]);
      const ownedIncludeText = await readText(packageTsconfigPath);
      const unownedIncludeText = ownedIncludeText.replace(
        '"include": ["src/**/*.ts", "scripts/**/*.ts"]',
        '"include": ["src/**/*.ts"]',
      );
      if (unownedIncludeText === ownedIncludeText) {
        throw new Error(
          "生成 owner 配置的 scripts include 字面形状已变化，缺归属负例不再成立",
        );
      }
      await writeText(packageTsconfigPath, unownedIncludeText);
      const unownedManifest = await readManifest();
      const originalTypecheck = unownedManifest.scripts.typecheck;
      if (originalTypecheck === undefined) {
        throw new Error("ts-lib 生成包默认应声明 typecheck 任务");
      }
      delete unownedManifest.scripts.typecheck;
      await writeManifest(unownedManifest);
      const unowned = await gateProbe();
      expect(unowned.exitCode).not.toBe(0);
      const unownedOutput = `${unowned.stdout}\n${unowned.stderr}`;
      expect(unownedOutput).toContain(
        `${packagePath}/scripts/probe-ownership.ts 开发自动化归属[缺归属]`,
      );
      expect(unownedOutput).toContain(
        `${packagePath}/package.json 开发自动化归属[任务缺失]`,
      );

      // 恢复 owner include 与标准 typecheck 任务后归属成立，但真实 typecheck 仍拒绝业务类型错。
      await writeText(packageTsconfigPath, ownedIncludeText);
      const restoredManifest = await readManifest();
      restoredManifest.scripts.typecheck = originalTypecheck;
      await writeManifest(restoredManifest);
      const owned = await gateProbe();
      expect(owned.exitCode).toBe(0);
      const badTypecheck = await execa(
        "pnpm",
        ["-F", packageName, "run", "typecheck"],
        { cwd: targetDir, reject: false },
      );
      expect(badTypecheck.exitCode).not.toBe(0);
      expect(`${badTypecheck.stdout}\n${badTypecheck.stderr}`).toContain(
        "scripts/probe-ownership.ts(1,14): error TS2322",
      );
      await writeRepositoryFile(`${packagePath}/scripts/probe-ownership.ts`, [
        "export const probeFlag = 42;",
      ]);
      const goodTypecheck = await execa(
        "pnpm",
        ["-F", packageName, "run", "typecheck"],
        { cwd: targetDir, reject: false },
      );
      expect(goodTypecheck.exitCode).toBe(0);

      // 产品 build 项目收脚本成员构成构建泄漏，与 typecheck 归属是否成立无关。
      const buildTsconfigText = await readText(packageBuildTsconfigPath);
      const leakingBuildText = buildTsconfigText.replace(
        '"include": ["src/**/*.ts"]',
        '"include": ["src/**/*.ts", "scripts/**/*.ts"]',
      );
      if (leakingBuildText === buildTsconfigText) {
        throw new Error(
          "生成 build 配置的 include 字面形状已变化，构建泄漏负例不再成立",
        );
      }
      await writeText(packageBuildTsconfigPath, leakingBuildText);
      const leaking = await gateProbe();
      expect(leaking.exitCode).not.toBe(0);
      expect(`${leaking.stdout}\n${leaking.stderr}`).toContain(
        `${packagePath}/scripts/probe-ownership.ts 开发自动化归属[构建泄漏]`,
      );
      await writeText(packageBuildTsconfigPath, buildTsconfigText);

      // 去掉官方 CLI --noEmit 覆盖后 owner 项目按 declaration 产出即被拒绝；覆盖本身合法。
      const emittingManifest = await readManifest();
      emittingManifest.scripts.typecheck =
        "tsc -p tsconfig.json --pretty false";
      await writeManifest(emittingManifest);
      const emitting = await gateProbe();
      expect(emitting.exitCode).not.toBe(0);
      expect(`${emitting.stdout}\n${emitting.stderr}`).toContain(
        `${packagePath}/tsconfig.json 开发自动化归属[产出型 owner]`,
      );
      const finalManifest = await readManifest();
      finalManifest.scripts.typecheck = originalTypecheck;
      await writeManifest(finalManifest);
      expect((await gateProbe()).exitCode).toBe(0);

      // R15-B：tsc 的 -p 目录操作数按原生协议落到实际配置，与 -p tsconfig.json 得到同一执行集与归属判定。
      const dirOperandManifest = await readManifest();
      dirOperandManifest.scripts.typecheck = "tsc -p . --noEmit --pretty false";
      await writeManifest(dirOperandManifest);
      expect((await gateProbe()).exitCode).toBe(0);
      const dirGoodTypecheck = await execa(
        "pnpm",
        ["-F", packageName, "run", "typecheck"],
        { cwd: targetDir, reject: false },
      );
      expect(dirGoodTypecheck.exitCode).toBe(0);

      // 同一目录操作数注入业务类型错：真实 tsc 拒绝该脚本，检查器仍判定归属成立且不误报坏配置。
      await writeRepositoryFile(`${packagePath}/scripts/probe-dir-operand.ts`, [
        "export const dirFlag: string = 42;",
      ]);
      const dirBadTypecheck = await execa(
        "pnpm",
        ["-F", packageName, "run", "typecheck"],
        { cwd: targetDir, reject: false },
      );
      expect(dirBadTypecheck.exitCode).not.toBe(0);
      expect(`${dirBadTypecheck.stdout}\n${dirBadTypecheck.stderr}`).toContain(
        "scripts/probe-dir-operand.ts(1,14): error TS2322",
      );
      const dirOwnedWithBadType = await gateProbe();
      expect(dirOwnedWithBadType.exitCode).toBe(0);
      expect(
        `${dirOwnedWithBadType.stdout}\n${dirOwnedWithBadType.stderr}`,
      ).not.toContain("开发自动化归属[无法验证]");

      // 目录操作数与文件操作数共享同一 owner 身份：去掉 --noEmit 覆盖后点名的仍是该包实际配置文件。
      const emittingDirManifest = await readManifest();
      emittingDirManifest.scripts.typecheck = "tsc -p . --pretty false";
      await writeManifest(emittingDirManifest);
      const emittingDir = await gateProbe();
      expect(emittingDir.exitCode).not.toBe(0);
      expect(`${emittingDir.stdout}\n${emittingDir.stderr}`).toContain(
        `${packagePath}/tsconfig.json 开发自动化归属[产出型 owner]`,
      );
      const restoredTypecheckManifest = await readManifest();
      restoredTypecheckManifest.scripts.typecheck = originalTypecheck;
      await writeManifest(restoredTypecheckManifest);
      await rm(
        path.join(targetDir, packagePath, "scripts/probe-dir-operand.ts"),
        {
          force: true,
        },
      );
      expect((await gateProbe()).exitCode).toBe(0);

      // R15-A：本地无脚本的 consumer 即使任务不可归约且配置名非默认，官方配置 API 能确定的跨包吸收仍被拒绝。
      const consumerPath = "packages/ownership-consumer";
      await writeRepositoryFile(
        `${packagePath}/scripts/tooling/probe-absorb.ts`,
        ["export const absorbFlag = 1;"],
      );
      const writeConsumer = async (task: string, configName: string) => {
        await rm(path.join(targetDir, consumerPath), {
          recursive: true,
          force: true,
        });
        await writeRepositoryFile(`${consumerPath}/package.json`, [
          "{",
          '  "name": "ownership-consumer",',
          '  "private": true,',
          `  "scripts": { "typecheck": "${task}" }`,
          "}",
        ]);
        await writeRepositoryFile(`${consumerPath}/${configName}`, [
          "{",
          '  "compilerOptions": { "noEmit": true },',
          '  "include": ["../lib/scripts/**/*.ts"]',
          "}",
        ]);
      };

      await writeConsumer(
        "pnpm exec tsc -p tsconfig.check.json --noEmit --pretty false",
        "tsconfig.check.json",
      );
      const absorbedNonDefault = await gateProbe();
      expect(absorbedNonDefault.exitCode).not.toBe(0);
      const absorbedOutput = `${absorbedNonDefault.stdout}\n${absorbedNonDefault.stderr}`;
      expect(absorbedOutput).toContain(
        `${packagePath}/scripts/tooling/probe-absorb.ts 开发自动化归属[根/兄弟吸收]`,
      );
      // 该面只补成员事实：不为无脚本包发明标准任务，也不把不可归约命令扩大成 unknown 阻断面。
      expect(absorbedOutput).not.toContain(
        `${consumerPath}/package.json 开发自动化归属[任务缺失]`,
      );
      expect(absorbedOutput).not.toContain(
        `${consumerPath}/package.json 开发自动化归属[无法验证]`,
      );

      // 对照一：默认配置名的不可归约命令仍给出同一吸收拒绝。
      await writeConsumer(
        "pnpm exec tsc -p tsconfig.json --noEmit --pretty false",
        "tsconfig.json",
      );
      const absorbedDefault = await gateProbe();
      expect(absorbedDefault.exitCode).not.toBe(0);
      expect(`${absorbedDefault.stdout}\n${absorbedDefault.stderr}`).toContain(
        `${packagePath}/scripts/tooling/probe-absorb.ts 开发自动化归属[根/兄弟吸收]`,
      );

      // 对照二：非默认配置名但命令可归约为闭合协议时，判定路径不经兜底也成立。
      await writeConsumer(
        "tsc -p tsconfig.check.json --noEmit --pretty false",
        "tsconfig.check.json",
      );
      const absorbedReducible = await gateProbe();
      expect(absorbedReducible.exitCode).not.toBe(0);
      expect(
        `${absorbedReducible.stdout}\n${absorbedReducible.stderr}`,
      ).toContain(
        `${packagePath}/scripts/tooling/probe-absorb.ts 开发自动化归属[根/兄弟吸收]`,
      );

      // R15-M：某一面可归约为协议时，另一面不可归约但仍能按官方配置 API 确定的跨包吸收事实不得被遮蔽。
      const writeMixedFaceConsumer = async (
        tasks: { readonly build: string; readonly typecheck: string },
        ownNonDefaultConfigs: readonly string[],
        absorbConfig: readonly string[] = [
          "{",
          '  "compilerOptions": { "noEmit": true },',
          '  "include": ["../lib/scripts/**/*.ts"]',
          "}",
        ],
      ) => {
        await rm(path.join(targetDir, consumerPath), {
          recursive: true,
          force: true,
        });
        await writeRepositoryFile(`${consumerPath}/src/index.ts`, [
          "export const consumerValue = 1;",
        ]);
        await writeRepositoryFile(`${consumerPath}/package.json`, [
          "{",
          '  "name": "ownership-consumer",',
          '  "private": true,',
          '  "scripts": {',
          `    "typecheck": "${tasks.typecheck}",`,
          `    "build": "${tasks.build}"`,
          "  }",
          "}",
        ]);
        // 自有配置真实含 src 成员：可归约面据此成立，而不是空输入项目的假象。
        for (const configName of ["tsconfig.json", ...ownNonDefaultConfigs]) {
          await writeRepositoryFile(`${consumerPath}/${configName}`, [
            "{",
            '  "compilerOptions": { "noEmit": true },',
            '  "include": ["src/**/*.ts"]',
            "}",
          ]);
        }
        await writeRepositoryFile(
          `${consumerPath}/tsconfig.check.json`,
          absorbConfig,
        );
      };
      // build 面不可归约：吸收事实仍被报告，且去重不制造重复收录、不新增阻断面。
      await writeMixedFaceConsumer(
        {
          typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
          build: "pnpm exec tsc -p tsconfig.check.json --noEmit --pretty false",
        },
        [],
      );
      const mixedBuildFace = await gateProbe();
      expect(mixedBuildFace.exitCode).not.toBe(0);
      const mixedBuildOutput = `${mixedBuildFace.stdout}\n${mixedBuildFace.stderr}`;
      expect(mixedBuildOutput).toContain(
        `${packagePath}/scripts/tooling/probe-absorb.ts 开发自动化归属[根/兄弟吸收]`,
      );
      expect(mixedBuildOutput).toContain(
        `${consumerPath}/tsconfig.check.json（任务 typecheck）`,
      );
      expect(mixedBuildOutput).not.toContain("开发自动化归属[重复收录]");
      expect(mixedBuildOutput).not.toContain("开发自动化归属[无法验证]");
      expect(mixedBuildOutput).not.toContain(
        `${consumerPath}/package.json 开发自动化归属[任务缺失]`,
      );

      // typecheck 面不可归约（反向形状）：同一吸收事实与同一拒绝类别。
      await writeMixedFaceConsumer(
        {
          typecheck:
            "pnpm exec tsc -p tsconfig.check.json --noEmit --pretty false",
          build: "tsc -p tsconfig.build-side.json --noEmit --pretty false",
        },
        ["tsconfig.build-side.json"],
      );
      const mixedTypecheckFace = await gateProbe();
      expect(mixedTypecheckFace.exitCode).not.toBe(0);
      const mixedTypecheckOutput = `${mixedTypecheckFace.stdout}\n${mixedTypecheckFace.stderr}`;
      expect(mixedTypecheckOutput).toContain(
        `${packagePath}/scripts/tooling/probe-absorb.ts 开发自动化归属[根/兄弟吸收]`,
      );
      expect(mixedTypecheckOutput).toContain(
        `${consumerPath}/tsconfig.check.json（任务 typecheck）`,
      );
      expect(mixedTypecheckOutput).not.toContain("开发自动化归属[重复收录]");
      expect(mixedTypecheckOutput).not.toContain("开发自动化归属[无法验证]");

      // 兜底不扩面：混合面下不可归约命令指向自有合法配置时没有吸收事实可报。
      await writeMixedFaceConsumer(
        {
          typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
          build: "pnpm exec tsc -p tsconfig.extra.json --noEmit --pretty false",
        },
        ["tsconfig.extra.json"],
      );
      const mixedOwnConfig = await gateProbe();
      expect(mixedOwnConfig.exitCode).toBe(0);
      expect(mixedOwnConfig.stderr).toBe("");
      expect(mixedOwnConfig.stdout).toBe("");

      // R15-S：吸收配置带 Unknown compiler option 时官方配置 API 仍返回真实的跨包成员事实，静默通过不得发生。
      const optionErrorAbsorbConfig = [
        "{",
        '  "compilerOptions": { "noEmit": true, "totallyBogusOption": true },',
        '  "include": ["../lib/scripts/**/*.ts"]',
        "}",
      ];
      await writeMixedFaceConsumer(
        {
          typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
          build: "pnpm exec tsc -p tsconfig.check.json --noEmit --pretty false",
        },
        [],
        optionErrorAbsorbConfig,
      );
      const optionErrorAbsorb = await gateProbe();
      expect(optionErrorAbsorb.exitCode).not.toBe(0);
      const optionErrorOutput = `${optionErrorAbsorb.stdout}\n${optionErrorAbsorb.stderr}`;
      expect(optionErrorOutput).toContain(
        `${packagePath}/scripts/tooling/probe-absorb.ts 开发自动化归属[根/兄弟吸收]`,
      );
      expect(optionErrorOutput).toContain(
        `${consumerPath}/tsconfig.check.json（任务 typecheck）`,
      );
      expect(optionErrorOutput).not.toContain("开发自动化归属[重复收录]");
      expect(optionErrorOutput).not.toContain("开发自动化归属[无法验证]");

      // 反向面（typecheck 不可归约）指向同一带选项错误的吸收配置：同一成员事实、同一拒绝类别。
      await writeMixedFaceConsumer(
        {
          typecheck:
            "pnpm exec tsc -p tsconfig.check.json --noEmit --pretty false",
          build: "tsc -p tsconfig.build-side.json --noEmit --pretty false",
        },
        ["tsconfig.build-side.json"],
        optionErrorAbsorbConfig,
      );
      const optionErrorAbsorbReverse = await gateProbe();
      expect(optionErrorAbsorbReverse.exitCode).not.toBe(0);
      const optionErrorReverseOutput = `${optionErrorAbsorbReverse.stdout}\n${optionErrorAbsorbReverse.stderr}`;
      expect(optionErrorReverseOutput).toContain(
        `${packagePath}/scripts/tooling/probe-absorb.ts 开发自动化归属[根/兄弟吸收]`,
      );
      expect(optionErrorReverseOutput).not.toContain(
        "开发自动化归属[重复收录]",
      );

      // 合法对照一：同一未知选项落在只含自有成员的配置上没有跨包事实，坏配置本身不被认证 owner 也不新增阻断。
      await writeMixedFaceConsumer(
        {
          typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
          build:
            "pnpm exec tsc -p tsconfig.option-error.json --noEmit --pretty false",
        },
        [],
      );
      await writeRepositoryFile(`${consumerPath}/tsconfig.option-error.json`, [
        "{",
        '  "compilerOptions": { "noEmit": true, "totallyBogusOption": true },',
        '  "include": ["src/**/*.ts"]',
        "}",
      ]);
      const optionErrorOwnProject = await gateProbe();
      expect(optionErrorOwnProject.exitCode).toBe(0);
      expect(optionErrorOwnProject.stderr).toBe("");
      expect(optionErrorOwnProject.stdout).toBe("");

      // 合法对照二：不可归约面指向彻底损坏的配置，官方成员集为空 → 不推断未知成员、不为该配置发明阻断。
      await writeMixedFaceConsumer(
        {
          typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
          build:
            "pnpm exec tsc -p tsconfig.broken.json --noEmit --pretty false",
        },
        [],
      );
      await writeRepositoryFile(`${consumerPath}/tsconfig.broken.json`, [
        "this is not json at all {{{",
      ]);
      const brokenConfigWithoutMembers = await gateProbe();
      expect(brokenConfigWithoutMembers.exitCode).toBe(0);
      expect(brokenConfigWithoutMembers.stderr).toBe("");
      expect(brokenConfigWithoutMembers.stdout).toBe("");

      await rm(path.join(targetDir, consumerPath), {
        recursive: true,
        force: true,
      });
      await rm(path.join(targetDir, packagePath, "scripts/tooling"), {
        recursive: true,
        force: true,
      });
      expect((await gateProbe()).exitCode).toBe(0);

      await rm(path.join(targetDir, packagePath, "scripts"), {
        recursive: true,
        force: true,
      });
      const clean = await gateProbe();
      expect(clean.exitCode).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("does not let a nested non-workspace manifest hide maintenance scripts from ownership", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-nested-manifest-"),
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
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const packagePath = initialization.blueprint.packages[0]!.path;
    const packageName = initialization.blueprint.packages[0]!.name;

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const gateProbe = () =>
        execa(
          "node",
          ["--conditions=source", "scripts/check-package-boundaries.ts"],
          { cwd: targetDir, reject: false },
        );
      const writeRepositoryFile = async (
        relativePath: string,
        lines: readonly string[],
      ) => {
        const filePath = path.join(targetDir, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${lines.join("\n")}\n`);
      };
      const readText = (relativePath: string) =>
        readFile(path.join(targetDir, relativePath), "utf8");
      const writeText = (relativePath: string, text: string) =>
        writeFile(path.join(targetDir, relativePath), text);
      const packageTsconfigPath = path.join(packagePath, "tsconfig.json");

      expect((await gateProbe()).exitCode).toBe(0);

      // RI15-2：嵌套 package.json 的存在不得被误读为 workspace 身份而截断向下扫描，藏起未覆盖的维护脚本。
      await writeRepositoryFile(`${packagePath}/scripts/nested/package.json`, [
        "{",
        '  "name": "ownership-hidden-probe",',
        '  "private": true,',
        '  "type": "module"',
        "}",
      ]);
      await writeRepositoryFile(
        `${packagePath}/scripts/nested/probe-hidden.ts`,
        ["export const hiddenFlag = 42;"],
      );
      const ownedIncludeText = await readText(packageTsconfigPath);
      const unownedIncludeText = ownedIncludeText.replace(
        '"include": ["src/**/*.ts", "scripts/**/*.ts"]',
        '"include": ["src/**/*.ts"]',
      );
      if (unownedIncludeText === ownedIncludeText) {
        throw new Error(
          "生成 owner 配置的 scripts include 字面形状已变化，嵌套隐藏负例不再成立",
        );
      }
      await writeText(packageTsconfigPath, unownedIncludeText);

      const hidden = await gateProbe();
      expect(hidden.exitCode).not.toBe(0);
      expect(`${hidden.stdout}\n${hidden.stderr}`).toContain(
        `${packagePath}/scripts/nested/probe-hidden.ts 开发自动化归属[缺归属]`,
      );

      // 合法归属控制：owner 重新收录嵌套脚本后其真实 typecheck 覆盖该脚本，嵌套 manifest 仍在时归属成立且门归零。
      await writeText(packageTsconfigPath, ownedIncludeText);
      const owned = await gateProbe();
      expect(owned.exitCode).toBe(0);
      const ownedTypecheck = await execa(
        "pnpm",
        ["-F", packageName, "run", "typecheck"],
        { cwd: targetDir, reject: false },
      );
      expect(ownedTypecheck.exitCode).toBe(0);

      // 解除控制：脚本连同嵌套 manifest 一并撤除后门保持归零。
      await rm(path.join(targetDir, packagePath, "scripts"), {
        recursive: true,
        force: true,
      });
      expect((await gateProbe()).exitCode).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);

  it("rejects maintenance scripts captured by the native module closure of executed projects", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-closure-"),
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
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const packagePath = initialization.blueprint.packages[0]!.path;
    const consumerPath = "packages/closure-consumer";
    const consumerName = "@demo/closure-consumer";
    const entryPath = `${packagePath}/src/index.ts`;
    const scriptPath = `${packagePath}/scripts/probe-closure.ts`;
    const scriptSpecifier = "../scripts/probe-closure.ts";

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const gateProbe = () =>
        execa(
          "node",
          ["--conditions=source", "scripts/check-package-boundaries.ts"],
          { cwd: targetDir, reject: false },
        );
      const rootTask = () =>
        execa("pnpm", ["run", "boundaries"], {
          cwd: targetDir,
          reject: false,
        });
      const checkText = (result: { stderr: string; stdout: string }) =>
        `${result.stdout}\n${result.stderr}`;
      const writeRepositoryFile = async (
        relativePath: string,
        lines: readonly string[],
      ) => {
        const filePath = path.join(targetDir, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${lines.join("\n")}\n`);
      };
      const readText = (relativePath: string) =>
        readFile(path.join(targetDir, relativePath), "utf8");
      const writeText = (relativePath: string, text: string) =>
        writeFile(path.join(targetDir, relativePath), text);
      // 诊断锚定说明符字面量起点，据此从实际 fixture 推出期望位置，而不是反向锁定文案。
      const specifierColumn = (line: string) => String(line.indexOf('"') + 1);
      const writeConsumer = async (sourceLines: readonly string[]) => {
        await rm(path.join(targetDir, consumerPath), {
          recursive: true,
          force: true,
        });
        await writeRepositoryFile(`${consumerPath}/package.json`, [
          "{",
          `  "name": "${consumerName}",`,
          '  "private": true,',
          '  "scripts": {',
          '    "build": "tsc -p tsconfig.build.json --pretty false",',
          '    "typecheck": "tsc -p tsconfig.json --noEmit --pretty false"',
          "  }",
          "}",
        ]);
        await writeRepositoryFile(`${consumerPath}/tsconfig.json`, [
          "{",
          '  "compilerOptions": {',
          '    "module": "nodenext",',
          '    "moduleResolution": "nodenext",',
          '    "noEmit": true,',
          '    "rewriteRelativeImportExtensions": true,',
          '    "target": "es2024",',
          '    "types": []',
          "  },",
          '  "include": ["src/**/*.ts"]',
          "}",
        ]);
        await writeRepositoryFile(`${consumerPath}/tsconfig.build.json`, [
          "{",
          '  "extends": "./tsconfig.json",',
          '  "compilerOptions": {',
          '    "noEmit": false,',
          '    "outDir": "dist",',
          '    "rootDir": "src"',
          "  },",
          '  "include": ["src/**/*.ts"]',
          "}",
        ]);
        await writeRepositoryFile(`${consumerPath}/src/index.ts`, sourceLines);
      };

      const baseline = await gateProbe();
      expect(baseline.exitCode).toBe(0);
      // 无 browser 形态不引入 SFC 解析依赖。
      const rootManifest = JSON.parse(await readText("package.json")) as {
        devDependencies?: Record<string, string>;
      };
      expect(rootManifest.devDependencies).not.toHaveProperty(
        "@vue/compiler-sfc",
      );

      await writeRepositoryFile(scriptPath, ["export const closureValue = 1;"]);
      const originalEntry = await readText(entryPath);

      // 产品 build 配置已 exclude scripts：真实 Program 成员闭包仍按 import 边捕获维护脚本。
      const staticImport = `import { closureValue } from "${scriptSpecifier}";`;
      await writeText(
        entryPath,
        `${staticImport}\nvoid closureValue;\n\n${originalEntry}`,
      );
      const leakedStatic = await gateProbe();
      expect(leakedStatic.exitCode).not.toBe(0);
      const leakedStaticText = checkText(leakedStatic);
      expect(leakedStaticText).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      expect(leakedStaticText).toContain(
        `非 owner 执行项目 ${packagePath}/tsconfig.build.json（任务 build）的产品闭包经 import 边`,
      );
      expect(leakedStaticText).toContain(
        `${entryPath}:1:${specifierColumn(staticImport)} → ${scriptSpecifier}`,
      );
      // owner 项目按协议收录 scripts，不构成泄漏事实。
      expect(leakedStaticText).not.toContain(
        `${packagePath}/tsconfig.json（任务 typecheck）的产品闭包`,
      );
      await writeText(entryPath, originalEntry);
      expect((await gateProbe()).exitCode).toBe(0);

      // re-export 边同样被闭包捕获。
      const reExport = `export { closureValue } from "${scriptSpecifier}";`;
      await writeText(entryPath, `${reExport}\n\n${originalEntry}`);
      const leakedReExport = await gateProbe();
      expect(leakedReExport.exitCode).not.toBe(0);
      const leakedReExportText = checkText(leakedReExport);
      expect(leakedReExportText).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      expect(leakedReExportText).toContain(
        `${entryPath}:1:${specifierColumn(reExport)} → ${scriptSpecifier}`,
      );
      await writeText(entryPath, originalEntry);
      expect((await gateProbe()).exitCode).toBe(0);

      // 静态可求值的 dynamic import 同样构成边。
      const dynamicImport = `const loadClosure = (): Promise<unknown> => import("${scriptSpecifier}");`;
      await writeText(
        entryPath,
        `${dynamicImport}\nvoid loadClosure;\n\n${originalEntry}`,
      );
      const leakedDynamic = await gateProbe();
      expect(leakedDynamic.exitCode).not.toBe(0);
      const leakedDynamicText = checkText(leakedDynamic);
      expect(leakedDynamicText).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      expect(leakedDynamicText).toContain(
        `${entryPath}:1:${specifierColumn(dynamicImport)} → ${scriptSpecifier}`,
      );
      await writeText(entryPath, originalEntry);
      expect((await gateProbe()).exitCode).toBe(0);

      // 已知协议但本地无脚本的兄弟包经模块闭包吸收他包维护脚本：typecheck 与 build 两面都拒绝。
      const siblingSpecifier = "../../lib/scripts/probe-closure.ts";
      const siblingStatic = `import { closureValue } from "${siblingSpecifier}";`;
      const siblingDynamic = `const loadSibling = (): Promise<unknown> => import("${siblingSpecifier}");`;
      await writeConsumer([
        siblingStatic,
        "void closureValue;",
        "",
        "export const consumerValue = 1;",
        siblingDynamic,
      ]);
      const absorbedBySibling = await gateProbe();
      expect(absorbedBySibling.exitCode).not.toBe(0);
      const absorbedBySiblingText = checkText(absorbedBySibling);
      expect(absorbedBySiblingText).toContain(
        `${scriptPath} 开发自动化归属[根/兄弟吸收]`,
      );
      expect(absorbedBySiblingText).toContain(
        `却被 包 ${consumerName} (${consumerPath}) 的执行项目 ${consumerPath}/tsconfig.json（任务 typecheck）的模块闭包经 import 边`,
      );
      expect(absorbedBySiblingText).toContain(
        `却被 包 ${consumerName} (${consumerPath}) 的执行项目 ${consumerPath}/tsconfig.build.json（任务 build）的模块闭包经 import 边`,
      );
      expect(absorbedBySiblingText).toContain(
        `${consumerPath}/src/index.ts:1:${specifierColumn(siblingStatic)} → ${siblingSpecifier}`,
      );
      expect(absorbedBySiblingText).toContain(
        `${consumerPath}/src/index.ts:5:${specifierColumn(siblingDynamic)} → ${siblingSpecifier}`,
      );

      // 根非 owner 执行项目捕获同一脚本。
      await rm(path.join(targetDir, consumerPath), {
        recursive: true,
        force: true,
      });
      const rootSpecifier = "../packages/lib/scripts/probe-closure.ts";
      const rootStatic = `import { closureValue } from "${rootSpecifier}";`;
      await writeRepositoryFile("scripts/probe-root-closure.ts", [
        rootStatic,
        "",
        "export const rootSeen = closureValue;",
      ]);
      const absorbedByRoot = await gateProbe();
      expect(absorbedByRoot.exitCode).not.toBe(0);
      const absorbedByRootText = checkText(absorbedByRoot);
      expect(absorbedByRootText).toContain(
        `${scriptPath} 开发自动化归属[根/兄弟吸收]`,
      );
      expect(absorbedByRootText).toContain(
        "却被根 的执行项目 tsconfig.json（任务 typecheck）的模块闭包经 import 边",
      );
      expect(absorbedByRootText).toContain(
        `scripts/probe-root-closure.ts:1:${specifierColumn(rootStatic)} → ${rootSpecifier}`,
      );
      await rm(path.join(targetDir, "scripts/probe-root-closure.ts"), {
        force: true,
      });

      // 合法普通产品依赖边通过：兄弟包只引用他包产品源码，脚本仍只由 owner 项目收录执行。
      await writeConsumer([
        'import { greet } from "../../lib/src/index.ts";',
        "",
        'export const consumerValue = greet("demo");',
      ]);
      const legalProductEdge = await gateProbe();
      expect(legalProductEdge.exitCode).toBe(0);
      expect(checkText(legalProductEdge)).not.toContain("开发自动化归属");

      await rm(path.join(targetDir, consumerPath), {
        recursive: true,
        force: true,
      });
      const ownerOnly = await gateProbe();
      expect(ownerOnly.exitCode).toBe(0);

      // 经 Root 自定义入口（turbo boundaries 串联根检查器）证明同一变异被拒、解除后归零。
      await writeText(
        entryPath,
        `${staticImport}\nvoid closureValue;\n\n${originalEntry}`,
      );
      const rootTaskLeak = await rootTask();
      expect(rootTaskLeak.exitCode).not.toBe(0);
      expect(checkText(rootTaskLeak)).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      await writeText(entryPath, originalEntry);
      const rootTaskClean = await rootTask();
      expect(rootTaskClean.exitCode).toBe(0);
      expect(checkText(rootTaskClean)).not.toContain("开发自动化归属");

      await rm(path.join(targetDir, packagePath, "scripts"), {
        recursive: true,
        force: true,
      });
      expect((await gateProbe()).exitCode).toBe(0);
      expect(await readText(entryPath)).toBe(originalEntry);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 300_000);

  it("keeps the generated pnpm packing hook as a checked closed role", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-lib-packing-hook-"),
    );
    const targetDir = path.join(workspace, "demo-cli");

    try {
      // 本业务需要一个初始包角色为 cli-tool 的 Preset，从公开 registry 的既有能力选取来源。
      const cliToolDefinition = builtInPresetRegistry
        .all()
        .find(
          (definition) => definition.initialPrimaryPackage?.role === "cli-tool",
        );
      if (cliToolDefinition === undefined) {
        throw new Error(
          "Expected a Built-in Preset whose initial Package Role is cli-tool",
        );
      }
      const prepared = prepareGeneratedRepositoryInitialization({
        definition: cliToolDefinition,
        targetDir,
        overrides: { scope: "demo" },
      });
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...prepared.plan.operations],
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const boundariesCheck = () =>
        execa("pnpm", ["run", "boundaries"], { cwd: targetDir, reject: false });
      const clean = await boundariesCheck();
      expect(clean.exitCode).toBe(0);
      expect(`${clean.stdout}\n${clean.stderr}`).not.toContain(
        "维护脚本语言门",
      );

      // 包在自己真实 tsconfig 里打开 allowJs/checkJs，也不能把普通 JS 变成角色。
      const packageScriptsDir = path.join(targetDir, "packages/cli/scripts");
      await mkdir(packageScriptsDir, { recursive: true });
      await writeFile(
        path.join(packageScriptsDir, "checkJs.mjs"),
        'export const run = () => console.log("plain automation");\n',
      );
      const packageConfigPath = path.join(
        targetDir,
        "packages/cli/tsconfig.json",
      );
      const packageConfigText = await readFile(packageConfigPath, "utf8");
      const packageConfig = JSON.parse(packageConfigText) as {
        compilerOptions: Record<string, unknown>;
      };
      packageConfig.compilerOptions.allowJs = true;
      packageConfig.compilerOptions.checkJs = true;
      await writeFile(
        packageConfigPath,
        `${JSON.stringify(packageConfig, null, 2)}\n`,
      );
      await writeFile(
        path.join(targetDir, "packages/cli/tsconfig.maintenance.json"),
        '{"compilerOptions":{"allowJs":true,"checkJs":true},"files":["scripts/checkJs.mjs"]}\n',
      );

      const impersonated = await boundariesCheck();
      expect(impersonated.exitCode).not.toBe(0);
      const impersonatedOutput = `${impersonated.stdout}\n${impersonated.stderr}`;
      expect(impersonatedOutput).toContain(
        "packages/cli/scripts/checkJs.mjs 维护脚本语言门",
      );

      await writeFile(packageConfigPath, packageConfigText);
      await rm(path.join(targetDir, "packages/cli/tsconfig.maintenance.json"));
      await rm(packageScriptsDir, { recursive: true, force: true });
      const restored = await boundariesCheck();
      expect(restored.exitCode).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 420_000);

  it("uses native TypeScript 7 to enforce erasable source syntax", async () => {
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
        await execa("pnpm", ["--filter", `./${packagePath}`, "run", command], {
          cwd: targetDir,
        });
      }
      await expect(
        execa("node", ["--conditions=source", "scripts/automation-probe.ts"], {
          cwd: targetDir,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("root");
      await expect(
        execa("node", ["--conditions=source", "scripts/automation-probe.ts"], {
          cwd: path.join(targetDir, packagePath),
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("package");
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
      expect(rootConfig.files).toContain("./scripts/automation-probe.ts");
      expect(rootConfig.files).not.toContain(
        `./${packagePath}/scripts/automation-probe.ts`,
      );
      expect(packageConfig.files).toContain("./scripts/automation-probe.ts");
      expect(packageBuildConfig.files).not.toContain(
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
        ({ taskId }) => taskId === "@demo/lib#build",
      );
      const consumerTypecheck = tasks.find(
        ({ taskId }) => taskId === "@demo/lib#typecheck",
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
