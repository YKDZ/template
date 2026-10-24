import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  installContentCollection,
  prepareContentCollection,
  type PreparedContentCollection,
} from "@ykdz/template-content-artifacts";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { execa } from "execa";

import { unprivilegedProcessOptions } from "../test-support/unprivileged-process.ts";

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@ykdz/reference-workspace-root/template",
      load: () => import("@ykdz/reference-workspace-root/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-hono-api/template",
      load: () => import("@ykdz/reference-hono-api/template"),
    },
    {
      specifier: "@ykdz/reference-vue-hono-web/template",
      load: () => import("@ykdz/reference-vue-hono-web/template"),
    },
    {
      specifier: "@ykdz/reference-vue-app/template",
      load: () => import("@ykdz/reference-vue-app/template"),
    },
    {
      specifier: "@ykdz/preset-vue-hono-app/template",
      load: () => import("@ykdz/preset-vue-hono-app/template"),
    },
    {
      specifier: "@ykdz/preset-vue-app/template",
      load: () => import("@ykdz/preset-vue-app/template"),
    },
  ],
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-vue-hono-app",
);
assert.ok(preset);
const vuePreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-vue-app",
);
assert.ok(vuePreset);

async function withUnreadableAuthorDirectories<Result>(
  directories: readonly { readonly path: string; readonly mode: number }[],
  action: () => Promise<Result>,
): Promise<Result> {
  const orderedDirectories = [...directories].sort(
    (left, right) => right.path.length - left.path.length,
  );
  try {
    for (const directory of orderedDirectories) {
      await chmod(directory.path, 0);
    }
    return await action();
  } finally {
    for (const directory of [...orderedDirectories].reverse()) {
      await chmod(directory.path, directory.mode);
    }
  }
}

void it(
  "正式安装Vue与Vue-Hono内容后以新进程初始化、加包并运行生成项目任务",
  { timeout: 600_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "vue-vue-hono-installed-content-"),
    );
    await chmod(temporaryRoot, 0o755);
    const preparedRoot = path.join(temporaryRoot, "prepared");
    const consumerRoot = path.join(temporaryRoot, "consumer");
    const projectRoot = path.join(consumerRoot, "project");
    const targetRoot = path.join(projectRoot, "workspace");
    const vueTargetRoot = path.join(projectRoot, "vue-workspace");
    const temporaryDirectory = path.join(consumerRoot, "tmp");
    const resultPath = path.join(projectRoot, "result.json");
    const snapshotPath = path.join(projectRoot, "init-snapshot.json");
    const vueResultPath = path.join(projectRoot, "vue-result.json");
    const vueSnapshotPath = path.join(projectRoot, "vue-init-snapshot.json");
    const authorRootsPath = path.join(projectRoot, "author-roots.json");
    let prepared: PreparedContentCollection | undefined;
    let authorModes: readonly number[] = [];
    let workspaceMode = 0;
    let initialization: unknown;
    let addition: unknown;
    let vueInitialization: unknown;
    let vueAddition: unknown;
    let installStdout = "";
    let buildStdout = "";
    let e2eStdout = "";
    let vueInstallStdout = "";
    let vueBuildStdout = "";
    let vueE2eStdout = "";

    try {
      prepared = await prepareContentCollection({
        content,
        roots: [preset, vuePreset],
        packageName: "@ykdz/template-content",
        additionalSdkRoots: ["@ykdz/template-workspace"],
        workspaceRoot,
        root: preparedRoot,
      });
      assert.deepEqual(
        prepared.members
          .map((member) => member.identity.packageName)
          .toSorted(),
        [
          "@ykdz/preset-vue-hono-app",
          "@ykdz/preset-vue-app",
          "@ykdz/reference-hono-api",
          "@ykdz/reference-tooling-config",
          "@ykdz/reference-vue-app",
          "@ykdz/reference-vue-hono-web",
          "@ykdz/reference-workspace-root",
        ].toSorted(),
      );

      await installContentCollection(prepared, consumerRoot);
      const workspaceSdk = prepared.sdkPackages.find(
        ({ name }) => name === "@ykdz/template-workspace",
      );
      assert.ok(workspaceSdk);
      await execa("pnpm", ["add", workspaceSdk.tarball], {
        cwd: consumerRoot,
      });
      await chmod(consumerRoot, 0o755);
      await mkdir(projectRoot, { recursive: true });
      await mkdir(temporaryDirectory, { recursive: true });
      await chmod(projectRoot, 0o777);
      await chmod(temporaryDirectory, 0o777);
      const authorRoots = prepared.owners.map((owner) => owner.packageRoot);
      authorModes = await Promise.all(
        authorRoots.map(
          async (authorRoot) => (await stat(authorRoot)).mode & 0o777,
        ),
      );
      workspaceMode = (await stat(workspaceRoot)).mode & 0o777;
      await writeFile(
        authorRootsPath,
        JSON.stringify([...authorRoots, workspaceRoot]),
      );

      const driverPath = path.join(projectRoot, "vue-vue-hono-driver.mjs");
      await writeFile(
        driverPath,
        [
          'import assert from "node:assert/strict";',
          'import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          'import { templateContent } from "@ykdz/template-content";',
          "const [phase, targetRoot, snapshotPath, resultPath, authorRootsPath] = process.argv.slice(2);",
          'const vueOnly = phase.startsWith("vue-");',
          'const initialize = phase.endsWith("init");',
          'const presetName = vueOnly ? "@ykdz/preset-vue-app" : "@ykdz/preset-vue-hono-app";',
          'const additionName = vueOnly ? "@ykdz/reference-vue-app" : "@ykdz/reference-hono-api";',
          'const additionInput = vueOnly ? { leafName: "portal", packagePath: "apps/portal" } : { leafName: "support-api", packagePath: "apps/support-api" };',
          'for (const root of JSON.parse(await readFile(authorRootsPath, "utf8"))) await assert.rejects(readdir(root), { code: "EACCES" });',
          'const preset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === presetName);',
          'const additionContent = templateContent.find((member) => member.kind === "reference" && member.identity.packageName === additionName);',
          "assert.ok(preset && additionContent);",
          "const generator = createDefaultGenerator({ content: templateContent });",
          'const readText = async (relativePath) => await readFile(`${targetRoot}/${relativePath}`, "utf8");',
          "let customizedWeb;",
          "let customizedApi;",
          "if (!initialize) {",
          '  const webSourcePath = "apps/web/src/App.vue";',
          "  customizedWeb = `${await readText(webSourcePath)}\\n<!-- 用户页面定制 -->\\n`;",
          "  await writeFile(`${targetRoot}/${webSourcePath}`, customizedWeb);",
          "  await chmod(`${targetRoot}/${webSourcePath}`, 0o640);",
          "  if (!vueOnly) {",
          '    const apiSourcePath = "apps/api/src/server.ts";',
          "    customizedApi = `${await readText(apiSourcePath)}\\n// 用户 API 定制\\n`;",
          "    await writeFile(`${targetRoot}/${apiSourcePath}`, customizedApi);",
          "  }",
          '  const rootManifest = JSON.parse(await readText("package.json"));',
          '  rootManifest.scripts["custom:workspace"] = "echo retained";',
          "  await writeFile(`${targetRoot}/package.json`, `${JSON.stringify(rootManifest, null, 2)}\\n`);",
          "}",
          "const result = initialize",
          '  ? await generator.init({ targetRoot, selection: { presets: [{ contentIdentity: preset.identity }] }, conventions: { repositoryName: vueOnly ? "installed-vue" : "installed-vue-hono", defaultPackageScope: "demo" } })',
          "  : await generator.add({ repositoryRoot: targetRoot, contentIdentity: additionContent.identity, creationInput: additionInput });",
          'assert.equal(result.status, "success", JSON.stringify(result));',
          'const root = result.blueprint.packages.find(({ path }) => path === ".");',
          "assert.ok(root);",
          'const files = vueOnly ? {} : Object.fromEntries(await Promise.all(["playwright.config.ts", "test/e2e/app.spec.ts", "test/e2e/fixtures.ts"].map(async (path) => [path, await readText(path)])));',
          'const rootManifest = JSON.parse(await readText("package.json"));',
          'const turbo = JSON.parse(await readText("turbo.json"));',
          "const record = result.generationRecord;",
          "const selection = record.selections.find(({ presetIdentity }) => presetIdentity?.packageName === presetName);",
          "assert.ok(selection);",
          "const web = record.packages.find(({ packageDefinitionId }) => packageDefinitionId === selection.nodes.web);",
          "const apiInstance = vueOnly ? undefined : record.packages.find(({ packageDefinitionId }) => packageDefinitionId === selection.nodes.api);",
          "assert.ok(web && (vueOnly || apiInstance));",
          'if (!vueOnly) assert.equal(web.dependencyBindings["hono-api"], apiInstance.packageDefinitionId);',
          "const current = { packagePaths: result.blueprint.packages.map(({ path }) => path).toSorted(), packageDefinitionIds: record.packages.map(({ packageDefinitionId }) => packageDefinitionId).toSorted(), packageLinks: result.blueprint.packageLinkIntents, files, rootScripts: rootManifest.scripts, rootName: rootManifest.name, rootPath: root.path, apiId: apiInstance?.packageDefinitionId, webId: web.packageDefinitionId, turboTasks: turbo.tasks };",
          "if (initialize) {",
          "  const webDefinition = result.blueprint.packages.find(({ packageDefinitionId }) => packageDefinitionId === web.packageDefinitionId);",
          "  assert.ok(webDefinition);",
          "  const webManifest = JSON.parse(await readText(`${webDefinition.path}/package.json`));",
          "  if (vueOnly) {",
          '    assert.equal(webManifest.scripts["test:e2e"], "playwright test");',
          '    assert.equal(rootManifest.scripts["test:e2e"], undefined);',
          "    await writeFile(snapshotPath, JSON.stringify(current));",
          "  } else {",
          '    assert.equal(rootManifest.scripts["test:e2e"], "playwright test");',
          "    const apiDefinition = result.blueprint.packages.find(({ packageDefinitionId }) => packageDefinitionId === apiInstance.packageDefinitionId);",
          "    assert.ok(apiDefinition);",
          "    const apiManifest = JSON.parse(await readText(`${apiDefinition.path}/package.json`));",
          '    assert.equal(webManifest.dependencies[apiManifest.name], "workspace:*");',
          '    assert.ok(files["playwright.config.ts"].includes(`const apiPackageName = ${JSON.stringify(apiManifest.name)};`));',
          '    assert.ok(files["playwright.config.ts"].includes(`const webPackageName = ${JSON.stringify(webManifest.name)};`));',
          '    assert.deepEqual(turbo.tasks["//#test:e2e"].dependsOn, [`${apiManifest.name}#build`, `${webManifest.name}#build`, `${webManifest.name}#browser:prepare`]);',
          "    await writeFile(snapshotPath, JSON.stringify(current));",
          "  }",
          "} else {",
          '  const before = JSON.parse(await readFile(snapshotPath, "utf8"));',
          "  assert.ok(before.packageDefinitionIds.every((id) => record.packages.some((entry) => entry.packageDefinitionId === id)));",
          "  assert.deepEqual(current.files, before.files);",
          '  assert.equal(current.rootScripts["test:e2e"], before.rootScripts["test:e2e"]);',
          '  assert.equal(current.rootScripts["custom:workspace"], "echo retained");',
          "  assert.equal(current.rootName, before.rootName);",
          "  assert.deepEqual(current.turboTasks, before.turboTasks);",
          '  const customizedWebAfter = await readText("apps/web/src/App.vue");',
          "  assert.equal(customizedWebAfter, customizedWeb);",
          "  assert.equal((await stat(`${targetRoot}/apps/web/src/App.vue`)).mode & 0o777, 0o640);",
          "  if (!vueOnly) {",
          '    assert.equal(await readText("apps/api/src/server.ts"), customizedApi);',
          "    const supportApi = record.packages.find(({ contentIdentity, creationInput }) => contentIdentity.packageName === additionName && creationInput?.packagePath === additionInput.packagePath);",
          "    assert.ok(supportApi);",
          '    assert.equal(supportApi.createdBy, "addition");',
          "    assert.equal(result.blueprint.packages.find(({ packageDefinitionId }) => packageDefinitionId === supportApi.packageDefinitionId)?.path, additionInput.packagePath);",
          "  } else {",
          "    const addedApp = record.packages.find(({ contentIdentity, creationInput }) => contentIdentity.packageName === additionName && creationInput?.packagePath === additionInput.packagePath);",
          "    assert.ok(addedApp);",
          '    assert.equal(addedApp.createdBy, "addition");',
          "    assert.equal(result.blueprint.packages.find(({ packageDefinitionId }) => packageDefinitionId === addedApp.packageDefinitionId)?.path, additionInput.packagePath);",
          "  }",
          "}",
          "await writeFile(resultPath, JSON.stringify({ phase, status: result.status, current }));",
        ].join("\n"),
      );

      const paths = [...authorRoots, workspaceRoot];
      const modes = [...authorModes, workspaceMode];
      const runInstalledPhase = async (
        phase: "init" | "add" | "vue-init" | "vue-add",
        phaseTargetRoot: string,
        phaseSnapshotPath: string,
        phaseResultPath: string,
      ) => {
        await withUnreadableAuthorDirectories(
          paths.map((directory, index) => ({
            path: directory,
            mode: modes[index]!,
          })),
          async () =>
            await execa(
              process.execPath,
              [
                driverPath,
                phase,
                phaseTargetRoot,
                phaseSnapshotPath,
                phaseResultPath,
                authorRootsPath,
              ],
              {
                cwd: consumerRoot,
                env: {
                  ...process.env,
                  HOME: consumerRoot,
                  TMPDIR: temporaryDirectory,
                  NODE_OPTIONS: "--no-global-search-paths",
                  NODE_PATH: "",
                },
                ...unprivilegedProcessOptions,
              },
            ),
        );
        return JSON.parse(await readFile(phaseResultPath, "utf8")) as unknown;
      };
      initialization = await runInstalledPhase(
        "init",
        targetRoot,
        snapshotPath,
        resultPath,
      );
      addition = await runInstalledPhase(
        "add",
        targetRoot,
        snapshotPath,
        resultPath,
      );
      vueInitialization = await runInstalledPhase(
        "vue-init",
        vueTargetRoot,
        vueSnapshotPath,
        vueResultPath,
      );
      vueAddition = await runInstalledPhase(
        "vue-add",
        vueTargetRoot,
        vueSnapshotPath,
        vueResultPath,
      );

      const install = await execa("pnpm", ["install"], {
        cwd: targetRoot,
        env: { ...process.env, CI: "true" },
      });
      installStdout = install.stdout;
      const build = await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--force"],
        { cwd: targetRoot },
      );
      buildStdout = build.stdout;
      const e2e = await execa(
        "pnpm",
        ["exec", "turbo", "run", "test:e2e", "--force"],
        { cwd: targetRoot, env: { ...process.env, CI: "true" } },
      );
      e2eStdout = e2e.stdout;

      const vueInstall = await execa("pnpm", ["install"], {
        cwd: vueTargetRoot,
        env: { ...process.env, CI: "true" },
      });
      vueInstallStdout = vueInstall.stdout;
      const vueBuild = await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--force"],
        { cwd: vueTargetRoot },
      );
      vueBuildStdout = vueBuild.stdout;
      const vueE2e = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "test:e2e",
          "--filter=@demo/portal",
          "--force",
        ],
        { cwd: vueTargetRoot, env: { ...process.env, CI: "true" } },
      );
      vueE2eStdout = vueE2e.stdout;

      const evidenceRoot = process.env.TEMPLATE_CONTENT_ARTIFACT_EVIDENCE_DIR;
      if (evidenceRoot !== undefined) {
        await mkdir(evidenceRoot, { recursive: true });
        await writeFile(
          path.join(evidenceRoot, "vue-hono-installed-project.json"),
          `${JSON.stringify(
            {
              collection: {
                name: prepared.collection.name,
                version: prepared.collection.version,
                sha256: prepared.collection.sha256,
              },
              owners: prepared.owners.map(({ member, packed }) => ({
                contentIdentity: member.identity,
                name: packed.name,
                version: packed.version,
                sha256: packed.sha256,
              })),
              sdkPackages: prepared.sdkPackages.map(
                ({ name, version, sha256 }) => ({ name, version, sha256 }),
              ),
              initialization,
              addition,
              vueInitialization,
              vueAddition,
              generatedProject: {
                rootInstall: "pnpm install",
                rootInstallOutput: installStdout,
                build: "pnpm exec turbo run build --force",
                buildOutput: buildStdout,
                jointPlaywright: "pnpm exec turbo run test:e2e --force",
                jointPlaywrightOutput: e2eStdout,
                vueRootInstall: "pnpm install",
                vueRootInstallOutput: vueInstallStdout,
                vueBuild: "pnpm exec turbo run build --force",
                vueBuildOutput: vueBuildStdout,
                vuePlaywright:
                  "pnpm exec turbo run test:e2e --filter=@demo/portal --force",
                vuePlaywrightOutput: vueE2eStdout,
              },
            },
            null,
            2,
          )}\n`,
        );
      }
    } finally {
      await prepared?.cleanup();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
