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
} from "@ykdz/template-content/artifact-builder";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { execa } from "execa";

import { unprivilegedProcessOptions } from "../test-support/unprivileged-process.ts";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
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
      specifier: "@ykdz/preset-vue-hono-app/template",
      load: () => import("@ykdz/preset-vue-hono-app/template"),
    },
  ],
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-vue-hono-app",
);
assert.ok(preset);

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
  "正式安装Vue-Hono内容后以新进程初始化、加包并运行生成项目任务",
  { timeout: 600_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "vue-hono-installed-content-"),
    );
    await chmod(temporaryRoot, 0o755);
    const preparedRoot = path.join(temporaryRoot, "prepared");
    const consumerRoot = path.join(temporaryRoot, "consumer");
    const projectRoot = path.join(consumerRoot, "project");
    const targetRoot = path.join(projectRoot, "workspace");
    const temporaryDirectory = path.join(consumerRoot, "tmp");
    const resultPath = path.join(projectRoot, "result.json");
    const snapshotPath = path.join(projectRoot, "init-snapshot.json");
    const authorRootsPath = path.join(projectRoot, "author-roots.json");
    let prepared: PreparedContentCollection | undefined;
    let authorModes: readonly number[] = [];
    let workspaceMode = 0;
    let initialization: unknown;
    let addition: unknown;
    let installStdout = "";
    let buildStdout = "";
    let e2eStdout = "";

    try {
      prepared = await prepareContentCollection({
        content,
        roots: [preset],
        workspaceRoot,
        root: preparedRoot,
      });
      assert.deepEqual(
        prepared.members
          .map((member) => member.identity.packageName)
          .toSorted(),
        [
          "@ykdz/preset-vue-hono-app",
          "@ykdz/reference-hono-api",
          "@ykdz/reference-tooling-config",
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

      const driverPath = path.join(projectRoot, "vue-hono-driver.mjs");
      await writeFile(
        driverPath,
        [
          'import assert from "node:assert/strict";',
          'import { readFile, readdir, writeFile } from "node:fs/promises";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          'import { templateContent } from "@ykdz/template-content";',
          "const [phase, targetRoot, snapshotPath, resultPath, authorRootsPath] = process.argv.slice(2);",
          'for (const root of JSON.parse(await readFile(authorRootsPath, "utf8"))) await assert.rejects(readdir(root), { code: "EACCES" });',
          'const preset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-vue-hono-app");',
          'const api = templateContent.find((member) => member.kind === "reference" && member.identity.packageName === "@ykdz/reference-hono-api");',
          "assert.ok(preset && api);",
          "const generator = createDefaultGenerator({ content: templateContent });",
          'const result = phase === "init"',
          '  ? await generator.init({ targetRoot, selection: { presets: [{ contentIdentity: preset.identity }] }, conventions: { repositoryName: "installed-vue-hono", defaultPackageScope: "demo" } })',
          '  : await generator.add({ repositoryRoot: targetRoot, contentIdentity: api.identity, creationInput: { leafName: "support-api", packagePath: "apps/support-api" } });',
          'assert.equal(result.status, "success", JSON.stringify(result));',
          'const root = result.blueprint.packages.find(({ path }) => path === ".");',
          "assert.ok(root);",
          'const readText = async (relativePath) => await readFile(`${targetRoot}/${relativePath}`, "utf8");',
          'const files = Object.fromEntries(await Promise.all(["playwright.config.ts", "test/e2e/app.spec.ts", "test/e2e/fixtures.ts"].map(async (path) => [path, await readText(path)])));',
          'const rootManifest = JSON.parse(await readText("package.json"));',
          'const turbo = JSON.parse(await readText("turbo.json"));',
          "const record = result.generationRecord;",
          'const selection = record.selections.find(({ presetIdentity }) => presetIdentity?.packageName === "@ykdz/preset-vue-hono-app");',
          "assert.ok(selection);",
          "const web = record.packages.find(({ packageDefinitionId }) => packageDefinitionId === selection.nodes.web);",
          "const apiInstance = record.packages.find(({ packageDefinitionId }) => packageDefinitionId === selection.nodes.api);",
          "assert.ok(web && apiInstance);",
          'assert.equal(web.dependencyBindings["hono-api"], apiInstance.packageDefinitionId);',
          "const current = { packagePaths: result.blueprint.packages.map(({ path }) => path).toSorted(), packageDefinitionIds: record.packages.map(({ packageDefinitionId }) => packageDefinitionId).toSorted(), packageLinks: result.blueprint.packageLinkIntents, files, rootScripts: rootManifest.scripts, rootName: rootManifest.name, rootPath: root.path, apiId: apiInstance.packageDefinitionId, webId: web.packageDefinitionId, turboTasks: turbo.tasks };",
          'if (phase === "init") {',
          '  assert.equal(rootManifest.scripts["test:e2e"], "playwright test");',
          "  const apiDefinition = result.blueprint.packages.find(({ packageDefinitionId }) => packageDefinitionId === apiInstance.packageDefinitionId);",
          "  const webDefinition = result.blueprint.packages.find(({ packageDefinitionId }) => packageDefinitionId === web.packageDefinitionId);",
          "  assert.ok(apiDefinition && webDefinition);",
          "  const apiManifest = JSON.parse(await readText(`${apiDefinition.path}/package.json`));",
          "  const webManifest = JSON.parse(await readText(`${webDefinition.path}/package.json`));",
          '  assert.equal(webManifest.dependencies[apiManifest.name], "workspace:*");',
          '  assert.ok(files["playwright.config.ts"].includes(`const apiPackageName = ${JSON.stringify(apiManifest.name)};`));',
          '  assert.ok(files["playwright.config.ts"].includes(`const webPackageName = ${JSON.stringify(webManifest.name)};`));',
          '  assert.deepEqual(turbo.tasks["//#test:e2e"].dependsOn, [`${apiManifest.name}#build`, `${webManifest.name}#build`, `${webManifest.name}#browser:prepare`]);',
          "  await writeFile(snapshotPath, JSON.stringify(current));",
          "} else {",
          '  const before = JSON.parse(await readFile(snapshotPath, "utf8"));',
          "  assert.ok(before.packageDefinitionIds.every((id) => record.packages.some((entry) => entry.packageDefinitionId === id)));",
          "  assert.deepEqual(current.files, before.files);",
          "  assert.deepEqual(current.rootScripts, before.rootScripts);",
          "  assert.equal(current.rootName, before.rootName);",
          '  assert.deepEqual(current.turboTasks["//#test:e2e"], before.turboTasks["//#test:e2e"]);',
          '  const supportApi = record.packages.find(({ contentIdentity, creationInput }) => contentIdentity.packageName === "@ykdz/reference-hono-api" && creationInput?.packagePath === "apps/support-api");',
          "  assert.ok(supportApi);",
          '  assert.equal(supportApi.createdBy, "addition");',
          '  assert.equal(result.blueprint.packages.find(({ packageDefinitionId }) => packageDefinitionId === supportApi.packageDefinitionId)?.path, "apps/support-api");',
          "}",
          "await writeFile(resultPath, JSON.stringify({ phase, status: result.status, current }));",
        ].join("\n"),
      );

      const paths = [...authorRoots, workspaceRoot];
      const modes = [...authorModes, workspaceMode];
      const runInstalledPhase = async (phase: "init" | "add") => {
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
                targetRoot,
                snapshotPath,
                resultPath,
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
        return JSON.parse(await readFile(resultPath, "utf8")) as unknown;
      };
      initialization = await runInstalledPhase("init");
      addition = await runInstalledPhase("add");

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
              generatedProject: {
                rootInstall: "pnpm install",
                rootInstallOutput: installStdout,
                build: "pnpm exec turbo run build --force",
                buildOutput: buildStdout,
                jointPlaywright: "pnpm exec turbo run test:e2e --force",
                jointPlaywrightOutput: e2eStdout,
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
