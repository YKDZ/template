import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
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
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  renderNewProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { vueAppDefinition } from "./definition.ts";

describe("vue-app Built-in Preset Definition behavior", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  /**
   * 运行夹具：真正渲染并执行生成仓库自身检查的现场必须携带发版快照的精确 Node 事实，
   * 因为该检查要求根 engines.node 是精确三段版本。发版快照是固定副本里的既有真源，
   * 这里不另立版本常量。
   */
  const runtimeToolchain = {
    nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
      0,
      releaseToolchainSnapshot.nodeVersion.indexOf("."),
    ),
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
  };

  it("owns a browser application contribution with explicit exposure and preparation", () => {
    expect(builtInPresetRegistry.require("vue-app").metadata).toEqual(
      vueAppDefinition.metadata,
    );
    const contribution = vueAppDefinition.planInitialization({
      targetDir: "/tmp/demo-vue",
      repositoryName: "demo-vue",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain,
    });

    expect(vueAppDefinition.metadata).toEqual({
      name: "vue-app",
      title: "Vue 应用",
      description: "使用 Vite、Tailwind、Pinia 和测试工具的 Vue 应用工作区。",
    });
    expect(contribution.definition).toEqual({
      name: "@demo/web",
      path: "apps/web",
      role: "runtime-service",
    });
    expect(contribution.exposure).toEqual({
      exports: { ".": { default: "./src/main.ts", types: "./src/main.ts" } },
      imports: { "#/*": { default: "./src/*.ts", types: "./src/*.ts" } },
    });
    expect(contribution.manifest.dependencies).toEqual({
      "@vue/devtools-api": "catalog:",
      pinia: "catalog:",
      vue: "catalog:",
    });
    expect(contribution).not.toHaveProperty("checks");
    expect(contribution.environmentNeeds).toMatchObject([
      { kind: "playwright-browser-assets", browser: "chromium" },
    ]);
    expect(contribution.foundation).toMatchObject({
      workspacePackageGlobs: ["apps/*"],
    });
  });

  it("declares the shared source-backed browser-test Tool Layer", () => {
    const contribution = vueAppDefinition.planInitialization({
      targetDir: "/tmp/demo-vue",
      repositoryName: "demo-vue",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain,
    });
    const [layer] =
      contribution.foundation.developmentContainerToolLayers ?? [];
    const playwrightCliPackage =
      layer?.buildArguments?.find(
        (argument) => argument.name === "PLAYWRIGHT_CLI_PACKAGE",
      )?.value ?? "";

    expect(layer).toMatchObject({
      identity: "browser-test",
      requires: ["node-pnpm"],
      buildArguments: [
        {
          name: "PLAYWRIGHT_CLI_PACKAGE",
          value: expect.stringMatching(/^@playwright\/test@/u),
        },
      ],
      probes: [
        {
          identity: "playwright",
          command: "npx",
          args: [
            "--yes",
            "--package",
            playwrightCliPackage,
            "playwright",
            "--version",
          ],
        },
      ],
    });
    expect(
      resolveTemplateSource(layer!.dockerfile.source, layer!.dockerfile.from),
    ).toBe(
      path.resolve(
        import.meta.dirname,
        "../../templates/shared/devcontainer/browser-test.Dockerfile",
      ),
    );
  });

  it("initializes and adds Vue applications at default and explicit Package Paths", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vue-")),
      "demo-vue",
    );
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: runtimeToolchain,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: vueAppDefinition,
      context,
    });

    expect(
      initialization.nextStepInstructions.map((step) => step.display),
    ).toEqual(["pnpm install", "pnpm run fix", "pnpm run check"]);
    expect(initialization.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "copyFile",
          from: "src/App.vue",
          to: "apps/web/src/App.vue",
        }),
      ]),
    );

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });
    await writeFile(
      path.join(targetDir, "apps/web/scripts/automation-helper.ts"),
      'export const automationOwner = "vue";\n',
    );
    await writeFile(
      path.join(targetDir, "apps/web/scripts/automation-probe.ts"),
      'import { automationOwner } from "./automation-helper.ts";\n\nconsole.log(automationOwner);\n',
    );
    const viteConfig = await readFile(
      path.join(targetDir, "apps/web/vite.config.ts"),
      "utf8",
    );
    expect(
      await readFile(path.join(targetDir, ".devcontainer/Dockerfile"), "utf8"),
    ).toContain("playwright install --with-deps chromium");
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      build: {
        args: {
          PLAYWRIGHT_CLI_PACKAGE: expect.stringMatching(/^@playwright\/test@/u),
        },
      },
    });
    expect(viteConfig).toContain("@tailwindcss/vite");
    expect(viteConfig).not.toContain("alias:");
    expect(
      await readFile(path.join(targetDir, "apps/web/vitest.config.ts"), "utf8"),
    ).not.toContain("alias:");
    for (const configPath of ["tsconfig.app.json", "tsconfig.test.json"]) {
      const config = JSON.parse(
        await readFile(path.join(targetDir, "apps/web", configPath), "utf8"),
      ) as {
        readonly compilerOptions?: Readonly<Record<string, unknown>>;
        readonly extends?: string;
      };
      expect(config.compilerOptions).toMatchObject({
        customConditions: ["source"],
      });
      expect(config.compilerOptions).not.toHaveProperty("erasableSyntaxOnly");
      if (configPath === "tsconfig.app.json") {
        expect(config.compilerOptions).toMatchObject({
          exactOptionalPropertyTypes: false,
        });
      } else {
        expect(config.extends).toBe("./tsconfig.app.json");
      }
    }
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "apps/web/tsconfig.node.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      compilerOptions: {
        customConditions: ["source"],
        erasableSyntaxOnly: true,
      },
    });

    const defaultAddition = planGeneratedRepositoryPackageAddition({
      definition: vueAppDefinition,
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
      packageLeafName: "admin",
    });
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...defaultAddition.projectProjections,
    });
    const explicitAddition = planGeneratedRepositoryPackageAddition({
      definition: vueAppDefinition,
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
      packageLeafName: "portal",
      packagePath: "products/portal",
    });
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...explicitAddition.projectProjections,
    });

    expect(explicitAddition.blueprint.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@demo/admin",
          path: "apps/admin",
          role: "runtime-service",
        }),
        expect.objectContaining({
          name: "@demo/portal",
          path: "products/portal",
          role: "runtime-service",
        }),
      ]),
    );
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/admin/package.json"), "utf8"),
      ),
    ).toMatchObject({ name: "@demo/admin" });

    await execa("pnpm", ["install"], { cwd: targetDir });
    await expect(
      execa("node", ["--conditions=source", "scripts/automation-probe.ts"], {
        cwd: path.join(targetDir, "apps/web"),
      }).then(({ stdout }) => stdout),
    ).resolves.toBe("vue");
    await execa("pnpm", ["--filter", "./apps/web", "run", "typecheck"], {
      cwd: targetDir,
    });
    await execa(
      "pnpm",
      ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
      { cwd: targetDir },
    );
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 300_000);

  it("owns its default Package Path and updates an explicit Link Intent atomically", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vue-link-")),
      "demo-vue",
    );
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: runtimeToolchain,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: vueAppDefinition,
      context,
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });

    const addition = planGeneratedRepositoryPackageAddition({
      definition: vueAppDefinition,
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
      packageLeafName: "admin",
      linkFrom: ["apps/web"],
    });

    expect(addition.blueprint.packages).toContainEqual(
      expect.objectContaining({
        name: "@demo/admin",
        path: "apps/admin",
        role: "runtime-service",
      }),
    );
    expect(addition.blueprint.packageLinkIntents).toContainEqual({
      consumerPackagePath: "apps/web",
      providerPackagePath: "apps/admin",
    });
    expect(addition.operations).toContainEqual(
      expect.objectContaining({
        kind: "mergeJson",
        to: "apps/web/package.json",
        value: {
          dependencies: { "@demo/admin": "workspace:*" },
          dependenciesMeta: { "@demo/admin": { injected: true } },
        },
        provenance: expect.objectContaining({
          definitionName: "vue-app",
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
        await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ),
    ).toMatchObject({ dependencies: { "@demo/admin": "workspace:*" } });
    await execa("pnpm", ["install"], { cwd: targetDir });
    await execa(
      "pnpm",
      ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
      { cwd: targetDir },
    );
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 300_000);

  it("reconciles Foundation structured customization and reruns idempotently", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-structured-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const baseDefinition = builtInPresetRegistry.require("ts-lib");

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const turboPath = path.join(targetDir, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, unknown>;
      };
      turbo.tasks["user:report"] = { cache: false };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

      const addition = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await expect(
        readFile(turboPath, "utf8").then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        boundaries: {
          tags: {
            app: { dependencies: { allow: ["app", "library"] } },
          },
        },
        tasks: { "user:report": { cache: false } },
      });

      const repeated = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      await expect(
        reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...repeated.projectProjections,
        }),
      ).resolves.toEqual({ ok: true, changedPaths: [], actions: [] });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns a structured conflict before mutating an incompatible Turbo customization", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-structured-conflict-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const baseDefinition = builtInPresetRegistry.require("ts-lib");

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const turboPath = path.join(targetDir, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        boundaries: { tags: Record<string, unknown> };
      };
      turbo.boundaries.tags.app = {
        dependencies: { allow: ["app"] },
      };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

      const addition = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result).toEqual({
        ok: false,
        conflicts: [
          expect.objectContaining({
            path: "turbo.json",
            driver: "structured",
            location: "/boundaries/tags/app/dependencies/allow",
          }),
        ],
      });
      await expect(
        readFile(path.join(targetDir, "apps/dashboard/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects maintenance scripts reached through SFC script source", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-sfc-closure-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: runtimeToolchain,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: vueAppDefinition,
      context,
    });
    const packagePath = initialization.blueprint.packages[0]!.path;
    const appProject = `${packagePath}/tsconfig.app.json（任务 typecheck）`;
    const scriptPath = `${packagePath}/scripts/sfc-probe.ts`;
    const scriptSpecifier = "../scripts/sfc-probe.ts";
    const appVuePath = `${packagePath}/src/App.vue`;

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      // browser 形态在根 manifest 以 catalog 引用显式声明 SFC 解析依赖。
      const rootManifest = JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string> };
      expect(rootManifest.devDependencies).toMatchObject({
        "@vue/compiler-sfc": "catalog:",
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
      // 诊断锚定说明符字面量起点，期望位置由实际 fixture 推出，而不是反向锁定文案。
      const specifierColumn = (line: string) => String(line.indexOf('"') + 1);
      const originalAppVue = await readText(appVuePath);
      // 生成的 App.vue 首行即 <script setup lang="ts">，插入行落在真实第 2 行。
      const importInAppSetup = async (line: string) => {
        const lines = originalAppVue.split("\n");
        lines.splice(1, 0, line);
        await writeText(appVuePath, lines.join("\n"));
      };
      const restoreAppVue = () => writeText(appVuePath, originalAppVue);
      const mainTsPath = `${packagePath}/src/main.ts`;
      const originalMainTs = await readText(mainTsPath);
      // 追加到 main.ts 末尾的 import 仍是真实静态边，位置不依赖生成文件的行结构。
      const importInMainTs = async (line: string) => {
        await writeText(mainTsPath, `${originalMainTs}${line}\n`);
      };
      const webTsconfigPath = `${packagePath}/tsconfig.json`;
      const originalWebTsconfig = await readText(webTsconfigPath);
      const pagesProjectPath = `${packagePath}/tsconfig.pages.json`;
      const pagesProject = `${pagesProjectPath}（任务 typecheck）`;
      // 只纳入 SFC 的合法 leaf 项目走既定 references 协议，不引入新配置方言。
      const writePagesLeafProject = async () => {
        await writeRepositoryFile(pagesProjectPath, [
          "{",
          '  "extends": "./tsconfig.app.json",',
          '  "compilerOptions": {',
          '    "composite": true,',
          '    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.pages.tsbuildinfo"',
          "  },",
          '  "include": ["pages/**/*.vue"]',
          "}",
        ]);
        await writeText(
          webTsconfigPath,
          originalWebTsconfig.replace(
            '    { "path": "./tsconfig.node.json" }',
            '    { "path": "./tsconfig.node.json" },\n    { "path": "./tsconfig.pages.json" }',
          ),
        );
      };
      const restoreSfcInputs = async () => {
        await restoreAppVue();
        await writeText(mainTsPath, originalMainTs);
        await writeText(webTsconfigPath, originalWebTsconfig);
        for (const relativePath of [
          `${packagePath}/src/Child.vue`,
          `${packagePath}/src/SrcOnly.vue`,
          `${packagePath}/src/Broken.vue`,
          `${packagePath}/src/SetupSrc.vue`,
          `${packagePath}/src/SrcDirect.vue`,
          `${packagePath}/src/SrcViaBlock.vue`,
          `${packagePath}/src/Order.vue`,
          `${packagePath}/src/SrcSpacedLegal.vue`,
          `${packagePath}/src/SrcSpacedEq.vue`,
          `${packagePath}/src/SrcTabbedEq.vue`,
          `${packagePath}/src/SrcMultilineEq.vue`,
          `${packagePath}/src/NonBmpSameLine.vue`,
          `${packagePath}/src/NonBmpLegal.vue`,
          `${packagePath}/src/SrcFakeBefore.vue`,
          `${packagePath}/src/SrcFakeBeforeSingleQuote.vue`,
          `${packagePath}/src/SrcFakeTight.vue`,
          `${packagePath}/src/SrcFakeNonBmp.vue`,
          `${packagePath}/src/SrcBoolBeforeReal.vue`,
          `${packagePath}/src/SrcUnquotedRealValue.vue`,
          `${packagePath}/src/SrcFakeAfter.vue`,
          `${packagePath}/src/SrcFakePointsScriptLegal.vue`,
          `${packagePath}/pages/Home.vue`,
          `${packagePath}/pages/OutInclude.vue`,
          pagesProjectPath,
          `${packagePath}/tooling/block.ts`,
        ]) {
          await rm(path.join(targetDir, relativePath), { force: true });
        }
        await rm(path.join(targetDir, `${packagePath}/tooling`), {
          recursive: true,
          force: true,
        });
        await rm(path.join(targetDir, `${packagePath}/pages`), {
          recursive: true,
          force: true,
        });
      };

      await writeRepositoryFile(scriptPath, [
        'export const sfcProbeValue = "维护脚本";',
      ]);
      expect((await gateProbe()).exitCode).toBe(0);

      // <script setup> 直接导入本包维护脚本：诊断映射真实 SFC，而不是虚拟文件。
      const setupImport = `import { sfcProbeValue } from "${scriptSpecifier}";`;
      await importInAppSetup(setupImport);
      const fromSetup = await gateProbe();
      expect(fromSetup.exitCode).not.toBe(0);
      const fromSetupText = checkText(fromSetup);
      expect(fromSetupText).toContain(`${scriptPath} 开发自动化归属[构建泄漏]`);
      expect(fromSetupText).toContain(
        `非 owner 执行项目 ${appProject}的产品闭包经 import 边`,
      );
      expect(fromSetupText).toContain(
        `${appVuePath}:2:${specifierColumn(setupImport)} → ${scriptSpecifier}`,
      );
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 显式跨 SFC 链：App.vue → Child.vue → 维护脚本。
      await writeRepositoryFile(`${packagePath}/src/Child.vue`, [
        '<script setup lang="ts">',
        setupImport,
        "",
        "const label = sfcProbeValue;",
        "</script>",
        "",
        "<template>",
        "  <p>{{ label }}</p>",
        "</template>",
      ]);
      await importInAppSetup('import Child from "./Child.vue";');
      const acrossSfc = await gateProbe();
      expect(acrossSfc.exitCode).not.toBe(0);
      const acrossSfcText = checkText(acrossSfc);
      expect(acrossSfcText).toContain(`${scriptPath} 开发自动化归属[构建泄漏]`);
      expect(acrossSfcText).toContain(
        `${packagePath}/src/Child.vue:2:${specifierColumn(setupImport)} → ${scriptSpecifier}`,
      );
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 合法 <script src> 链按真实 src 文件身份观察：src 落在项目 include 之外也构成边。
      const blockImport = `import { sfcProbeValue } from "${scriptSpecifier}";`;
      await writeRepositoryFile(`${packagePath}/tooling/block.ts`, [
        blockImport,
        "",
        "export const blocked = sfcProbeValue;",
      ]);
      await writeRepositoryFile(`${packagePath}/src/SrcOnly.vue`, [
        '<script src="./../tooling/block.ts" lang="ts"></script>',
        "",
        "<template>",
        "  <p>ok</p>",
        "</template>",
      ]);
      await importInAppSetup('import "./SrcOnly.vue";');
      const throughScriptSrc = await gateProbe();
      expect(throughScriptSrc.exitCode).not.toBe(0);
      const throughScriptSrcText = checkText(throughScriptSrc);
      expect(throughScriptSrcText).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      expect(throughScriptSrcText).toContain(
        `${packagePath}/tooling/block.ts:1:${specifierColumn(blockImport)} → ${scriptSpecifier}`,
      );

      // 合法对照：同一 <script src> 链只引用产品源码时通过，证明合法链被观察而非误报。
      await writeRepositoryFile(`${packagePath}/tooling/block.ts`, [
        'import { useCounterStore } from "../src/stores/counter.ts";',
        "",
        "export const blocked = useCounterStore;",
      ]);
      const legalScriptSrc = await gateProbe();
      expect(legalScriptSrc.exitCode).toBe(0);
      expect(checkText(legalScriptSrc)).not.toContain("开发自动化归属");

      // 必要本地源码损坏不得静默按未发现违规处理。
      await writeRepositoryFile(`${packagePath}/src/Broken.vue`, [
        '<script setup lang="ts">',
        "const x = 1;",
        "</script>",
        "",
        "<template>",
        "  <div>{{ x </div>",
        "</template>",
      ]);
      await importInAppSetup('import "./Broken.vue";');
      const brokenSfc = await gateProbe();
      expect(brokenSfc.exitCode).not.toBe(0);
      const brokenSfcText = checkText(brokenSfc);
      expect(brokenSfcText).toContain(`${appProject}开发自动化归属[无法验证]`);
      expect(brokenSfcText).toContain(`坏 SFC：${packagePath}/src/Broken.vue`);
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // <script setup> 的 src 属非法用法，按 parser 诊断报告。
      await writeRepositoryFile(`${packagePath}/tooling/other.ts`, [
        "export const blocked = 1;",
      ]);
      await writeRepositoryFile(`${packagePath}/src/SetupSrc.vue`, [
        '<script setup src="./../tooling/other.ts" lang="ts"></script>',
        "",
        "<template>",
        "  <p>ok</p>",
        "</template>",
      ]);
      await importInAppSetup('import "./SetupSrc.vue";');
      const setupWithSrc = await gateProbe();
      expect(setupWithSrc.exitCode).not.toBe(0);
      const setupWithSrcText = checkText(setupWithSrc);
      expect(setupWithSrcText).toContain(
        `${appProject}开发自动化归属[无法验证]`,
      );
      expect(setupWithSrcText).toContain(
        `坏 SFC：${packagePath}/src/SetupSrc.vue`,
      );
      expect(setupWithSrcText).toContain("<script setup>");

      // 已知 TS 项目 import include 外的 SFC，该 SFC 再静态引用维护脚本时仍被捕获。
      await writeRepositoryFile(`${packagePath}/pages/OutInclude.vue`, [
        '<script setup lang="ts">',
        setupImport,
        "",
        "const label = sfcProbeValue;",
        "</script>",
        "",
        "<template>",
        "  <p>{{ label }}</p>",
        "</template>",
      ]);
      await importInMainTs('import "../pages/OutInclude.vue";');
      const fromOutsideInclude = await gateProbe();
      expect(fromOutsideInclude.exitCode).not.toBe(0);
      const fromOutsideIncludeText = checkText(fromOutsideInclude);
      expect(fromOutsideIncludeText).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      expect(fromOutsideIncludeText).toContain(
        `${packagePath}/pages/OutInclude.vue:2:${specifierColumn(setupImport)} → ${scriptSpecifier}`,
      );
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 普通 <script src> 直接指向维护脚本：静态源码依赖锚定真实 SFC 的 src 字面量。
      const srcDirectLine = `<script src="${scriptSpecifier}" lang="ts"></script>`;
      await writeRepositoryFile(`${packagePath}/src/SrcDirect.vue`, [
        srcDirectLine,
        "",
        "<template>",
        "  <p>ok</p>",
        "</template>",
      ]);
      await importInAppSetup('import "./SrcDirect.vue";');
      const directScriptSrc = await gateProbe();
      expect(directScriptSrc.exitCode).not.toBe(0);
      expect(checkText(directScriptSrc)).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      expect(checkText(directScriptSrc)).toContain(
        `${packagePath}/src/SrcDirect.vue:1:${srcDirectLine.indexOf(`"${scriptSpecifier}`) + 1} → ${scriptSpecifier}`,
      );
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 等号两侧空格、制表与 src/等号之间跨行都是合法 HTML 属性写法：合法产品 src 通过。
      await writeRepositoryFile(`${packagePath}/tooling/legal.ts`, [
        "export const legalValue = 1;",
      ]);
      await writeRepositoryFile(`${packagePath}/src/SrcSpacedLegal.vue`, [
        '<script src = "./../tooling/legal.ts" lang="ts"></script>',
        "",
        "<template>",
        "  <p>ok</p>",
        "</template>",
      ]);
      await importInAppSetup('import "./SrcSpacedLegal.vue";');
      const spacedLegalSrc = await gateProbe();
      expect(spacedLegalSrc.exitCode).toBe(0);
      expect(checkText(spacedLegalSrc)).not.toContain("开发自动化归属");

      // 同样写法指向维护脚本时按真实说明符引号行列捕获，不以「无法验证」冒充判定。
      const blankedForms: readonly {
        readonly file: string;
        readonly line: number;
        readonly lines: readonly string[];
      }[] = [
        {
          file: "SrcSpacedEq.vue",
          line: 1,
          lines: [
            `<script src = "${scriptSpecifier}" lang="ts"></script>`,
            "",
            "<template>",
            "  <p>ok</p>",
            "</template>",
          ],
        },
        {
          file: "SrcTabbedEq.vue",
          line: 1,
          lines: [
            `<script src\t=\t"${scriptSpecifier}" lang="ts"></script>`,
            "",
            "<template>",
            "  <p>ok</p>",
            "</template>",
          ],
        },
        {
          file: "SrcMultilineEq.vue",
          line: 2,
          lines: [
            "<script src",
            `\t = "${scriptSpecifier}" lang="ts"></script>`,
            "",
            "<template>",
            "  <p>ok</p>",
            "</template>",
          ],
        },
      ];
      for (const form of blankedForms) {
        const at =
          form.lines[form.line - 1]!.indexOf(`"${scriptSpecifier}`) + 1;
        await writeRepositoryFile(
          `${packagePath}/src/${form.file}`,
          form.lines,
        );
        await importInAppSetup(`import "./${form.file}";`);
        const blankedSrc = await gateProbe();
        expect(blankedSrc.exitCode).not.toBe(0);
        const blankedText = checkText(blankedSrc);
        expect(blankedText).toContain(`${scriptPath} 开发自动化归属[构建泄漏]`);
        expect(blankedText).toContain(
          `${packagePath}/src/${form.file}:${form.line}:${at} → ${scriptSpecifier}`,
        );
        await restoreSfcInputs();
        expect((await gateProbe()).exitCode).toBe(0);
      }

      // 前一个属性引号值里的 `src = '…'` 只是文本，不是属性：边必须锚真正的 src 属性引号，
      // 期望列由构造时的字面前缀长度推出（UTF-16 码元口径），不借用被测代码的扫描结果。
      const fakeNote = `data-note="see src = '${scriptSpecifier}' here"`;
      const fakeAttributeForms: readonly {
        readonly column: number;
        readonly expectLeak: boolean;
        readonly file: string;
        readonly openTag: string;
        readonly wrongColumn?: number;
      }[] = [
        {
          column: `<script ${fakeNote} src=`.length + 1,
          expectLeak: true,
          file: "SrcFakeBefore.vue",
          openTag: `<script ${fakeNote} src="${scriptSpecifier}" lang="ts"></script>`,
          wrongColumn: `<script data-note="see src = `.length + 1,
        },
        {
          column: `<script ${fakeNote} src=`.length + 1,
          expectLeak: true,
          file: "SrcFakeBeforeSingleQuote.vue",
          openTag: `<script ${fakeNote} src='${scriptSpecifier}' lang="ts"></script>`,
        },
        {
          column:
            `<script data-note="src = '${scriptSpecifier}'" src=`.length + 1,
          expectLeak: true,
          file: "SrcFakeTight.vue",
          openTag: `<script data-note="src = '${scriptSpecifier}'" src="${scriptSpecifier}" lang="ts"></script>`,
        },
        {
          column:
            `<script data-note="see 😀 src = '${scriptSpecifier}' here" src=`
              .length + 1,
          expectLeak: true,
          file: "SrcFakeNonBmp.vue",
          openTag: `<script data-note="see 😀 src = '${scriptSpecifier}' here" src="${scriptSpecifier}" lang="ts"></script>`,
        },
        {
          column: `<script inert src=`.length + 1,
          expectLeak: true,
          file: "SrcBoolBeforeReal.vue",
          openTag: `<script inert src="${scriptSpecifier}" lang="ts"></script>`,
        },
        {
          column: `<script src=`.length + 1,
          expectLeak: true,
          file: "SrcUnquotedRealValue.vue",
          openTag: `<script src=${scriptSpecifier} lang="ts"></script>`,
        },
        {
          column: `<script src=`.length + 1,
          expectLeak: true,
          file: "SrcFakeAfter.vue",
          openTag: `<script src="${scriptSpecifier}" ${fakeNote} lang="ts"></script>`,
        },
        {
          column: `<script ${fakeNote} src=`.length + 1,
          expectLeak: false,
          file: "SrcFakePointsScriptLegal.vue",
          openTag: `<script ${fakeNote} src="./stores/counter.ts" lang="ts"></script>`,
        },
      ];
      // 八个形态一次写入、一次闭包观察：每个违规边各自成条，逐形态位置断言共享同一次检查。
      for (const form of fakeAttributeForms) {
        await writeRepositoryFile(`${packagePath}/src/${form.file}`, [
          form.openTag,
          "",
          "<template>",
          "  <p>ok</p>",
          "</template>",
        ]);
      }
      await importInAppSetup(
        fakeAttributeForms.map((form) => `import "./${form.file}";`).join("\n"),
      );
      const anchored = await gateProbe();
      expect(anchored.exitCode).not.toBe(0);
      const anchoredText = checkText(anchored);
      expect(anchoredText).toContain(`${scriptPath} 开发自动化归属[构建泄漏]`);
      for (const form of fakeAttributeForms) {
        const shown = `${packagePath}/src/${form.file}`;
        if (form.expectLeak) {
          expect(anchoredText).toContain(
            `${shown}:1:${form.column} → ${scriptSpecifier}`,
          );
          if (form.wrongColumn !== undefined) {
            expect(anchoredText).not.toContain(
              `${shown}:1:${form.wrongColumn} →`,
            );
          }
        } else {
          // 伪文本指向脚本而真实 src 指向产品模块：该文件不应出现在任何归属诊断里。
          expect(anchoredText).not.toContain(`${shown}:`);
        }
      }
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 同一行非 BMP 前缀下，列仍是真实 UTF-16 码元位置；JS 索引口径即原生口径。
      const sameLineForms: readonly string[] = [
        "<!-- 😀 -->",
        "<!-- 😀 🌞 -->",
      ];
      for (const prefix of sameLineForms) {
        const setupLine = `${prefix}<script setup lang="ts">${setupImport}</script>`;
        await writeRepositoryFile(`${packagePath}/src/NonBmpSameLine.vue`, [
          setupLine,
          "",
          "<template>",
          "  <p>ok</p>",
          "</template>",
        ]);
        await importInAppSetup('import "./NonBmpSameLine.vue";');
        const sameLineNonBmp = await gateProbe();
        expect(sameLineNonBmp.exitCode).not.toBe(0);
        expect(checkText(sameLineNonBmp)).toContain(
          `${packagePath}/src/NonBmpSameLine.vue:1:${setupLine.indexOf(`"${scriptSpecifier}`) + 1} → ${scriptSpecifier}`,
        );
        await restoreSfcInputs();
        expect((await gateProbe()).exitCode).toBe(0);
      }

      // 同行非 BMP 前缀 + 合法产品 import 仍通过，修复不把合法输入强制拒绝。
      await writeRepositoryFile(`${packagePath}/src/NonBmpLegal.vue`, [
        '<!-- 😀 --><script setup lang="ts">import { useCounterStore } from "./stores/counter.ts";</script>',
        "",
        "<template>",
        "  <p>ok</p>",
        "</template>",
      ]);
      await importInAppSetup('import "./NonBmpLegal.vue";');
      const legalSameLineNonBmp = await gateProbe();
      expect(legalSameLineNonBmp.exitCode).toBe(0);
      expect(checkText(legalSameLineNonBmp)).not.toContain("开发自动化归属");
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 两个脚本块物理逆序时，诊断行列仍是真实 .vue 上的说明符位置。
      await writeRepositoryFile(`${packagePath}/src/Order.vue`, [
        "<!-- 😀 非 BMP 前置内容 -->",
        '<script setup lang="ts">',
        setupImport,
        "",
        "const label = sfcProbeValue;",
        "</script>",
        "",
        '<script lang="ts">',
        'export default { name: "OrderVue" };',
        "</script>",
        "",
        "<template>",
        "  <p>{{ label }}</p>",
        "</template>",
      ]);
      await importInAppSetup('import "./Order.vue";');
      const reversedBlocks = await gateProbe();
      expect(reversedBlocks.exitCode).not.toBe(0);
      expect(checkText(reversedBlocks)).toContain(
        `${packagePath}/src/Order.vue:3:${specifierColumn(setupImport)} → ${scriptSpecifier}`,
      );
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 只纳入 SFC 的合法 leaf 项目被官方扩展声明纳入，不再误判为没有输入。
      await writeRepositoryFile(`${packagePath}/pages/Home.vue`, [
        '<script setup lang="ts">',
        'const label = "home";',
        "</script>",
        "",
        "<template>",
        "  <p>{{ label }}</p>",
        "</template>",
      ]);
      await writePagesLeafProject();
      const legalSfcOnlyLeaf = await gateProbe();
      expect(legalSfcOnlyLeaf.exitCode).toBe(0);
      expect(checkText(legalSfcOnlyLeaf)).not.toContain("开发自动化归属");

      // 同一 leaf 形态引用维护脚本时，按该 leaf 项目与真实 SFC 边拒绝。
      await writeRepositoryFile(`${packagePath}/pages/Home.vue`, [
        '<script setup lang="ts">',
        setupImport,
        "",
        "const label = sfcProbeValue;",
        "</script>",
        "",
        "<template>",
        "  <p>{{ label }}</p>",
        "</template>",
      ]);
      const leakingSfcOnlyLeaf = await gateProbe();
      expect(leakingSfcOnlyLeaf.exitCode).not.toBe(0);
      const leakingSfcOnlyLeafText = checkText(leakingSfcOnlyLeaf);
      expect(leakingSfcOnlyLeafText).toContain(
        `非 owner 执行项目 ${pagesProject}`,
      );
      expect(leakingSfcOnlyLeafText).toContain(
        `${packagePath}/pages/Home.vue:2:${specifierColumn(setupImport)} → ${scriptSpecifier}`,
      );
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      // 解除全部违规输入后恢复 0，脚本仍可被 owner 项目执行。
      await restoreSfcInputs();
      const ownerOnly = await gateProbe();
      expect(ownerOnly.exitCode).toBe(0);
      await writeRepositoryFile(`${packagePath}/scripts/sfc-peer.ts`, [
        'import { sfcProbeValue } from "./sfc-probe.ts";',
        "",
        "export const peerValue = sfcProbeValue;",
      ]);
      expect((await gateProbe()).exitCode).toBe(0);
      await rm(path.join(targetDir, `${packagePath}/scripts/sfc-peer.ts`), {
        force: true,
      });

      // 经 Root 自定义入口（turbo boundaries 串联根检查器）证明同一变异被拒、解除后归零。
      await importInAppSetup(setupImport);
      const rootTaskLeak = await rootTask();
      expect(rootTaskLeak.exitCode).not.toBe(0);
      expect(checkText(rootTaskLeak)).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      await restoreAppVue();
      const rootTaskClean = await rootTask();
      expect(rootTaskClean.exitCode).toBe(0);
      expect(checkText(rootTaskClean)).not.toContain("开发自动化归属");

      // 必要 parser 不可达时按「闭包无法完成」拒绝，恢复 parser 后重新捕获同一泄漏。
      await writeRepositoryFile(`${packagePath}/tooling/block.ts`, [
        blockImport,
        "",
        "export const blocked = sfcProbeValue;",
      ]);
      await writeRepositoryFile(`${packagePath}/src/SrcViaBlock.vue`, [
        '<script src="../tooling/block.ts" lang="ts"></script>',
        "",
        "<template>",
        "  <p>ok</p>",
        "</template>",
      ]);
      await importInAppSetup('import "./SrcViaBlock.vue";');
      const parserDir = path.join(targetDir, "node_modules/@vue/compiler-sfc");
      const parserStash = path.join(
        targetDir,
        "node_modules/@vue/compiler-sfc.repair-stash",
      );
      await rename(parserDir, parserStash);
      try {
        // 宿主注入的 NODE_PATH 可能带一份仓库外的 hoisted parser 副本来掩盖本仓库缺失的依赖。
        // execa 默认在 process.env 之上合并 env，删除键会被宿主值带回，因此显式清空，
        // 让「生成仓库自身依赖面内 parser 不可达」成为本例真正成立的前提。
        const childEnv = { ...process.env, NODE_PATH: "" } as Record<
          string,
          string
        >;
        const parserUnreachable = await execa(
          "node",
          ["-e", "require.resolve('@vue/compiler-sfc')"],
          { cwd: targetDir, reject: false, env: childEnv },
        );
        expect(parserUnreachable.exitCode).not.toBe(0);
        const withoutParser = await execa(
          "node",
          ["--conditions=source", "scripts/check-package-boundaries.ts"],
          { cwd: targetDir, reject: false, env: childEnv },
        );
        expect(withoutParser.exitCode).not.toBe(0);
        const withoutParserText = checkText(withoutParser);
        expect(withoutParserText).toContain(
          `${appProject}开发自动化归属[无法验证]`,
        );
        expect(withoutParserText).toContain(
          "Cannot find module '@vue/compiler-sfc'",
        );
      } finally {
        await rename(parserStash, parserDir);
      }
      const parserRestored = await gateProbe();
      expect(parserRestored.exitCode).not.toBe(0);
      expect(checkText(parserRestored)).toContain(
        `${scriptPath} 开发自动化归属[构建泄漏]`,
      );
      await restoreSfcInputs();
      expect((await gateProbe()).exitCode).toBe(0);

      await rm(path.join(targetDir, `${packagePath}/scripts/sfc-probe.ts`), {
        force: true,
      });
      expect((await gateProbe()).exitCode).toBe(0);
      expect(await readText(appVuePath)).toBe(originalAppVue);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 900_000);
});
