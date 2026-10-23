import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { templateContent } from "@ykdz/template-content";
import {
  installContentCollection,
  prepareContentCollection,
  writeContentCollectionEvidence,
  writeNativeArchiveOverrides,
  type PackedArtifact,
  type PreparedContentCollection,
} from "@ykdz/template-content/artifact-builder";
import { contentIdentityKey } from "@ykdz/template-core/content-identity";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";
import { resolveReferenceDependencyIdentity } from "@ykdz/template-generator";
import { execa } from "execa";

import { createAuthoredContentFixture } from "../test-support/authored-content-fixture.ts";
import { unprivilegedProcessOptions } from "../test-support/unprivileged-process.ts";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const preparedCollections: PreparedContentCollection[] = [];
const authoredFixtures: Awaited<
  ReturnType<typeof createAuthoredContentFixture>
>[] = [];
let firstPartyPrepared: PreparedContentCollection | undefined;
let generatedEvidenceRoot: Promise<string> | undefined;

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

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

async function contentArtifactEvidenceRoot(): Promise<string> {
  const configuredRoot = process.env.TEMPLATE_CONTENT_ARTIFACT_EVIDENCE_DIR;
  if (configuredRoot !== undefined) {
    const root = path.resolve(configuredRoot);
    await mkdir(root, { recursive: true });
    return root;
  }
  generatedEvidenceRoot ??= temporaryRoot("template-content-evidence-");
  return generatedEvidenceRoot;
}

async function buildNativeAuthoredContent(
  fixture: Awaited<ReturnType<typeof createAuthoredContentFixture>>,
  namespace: string,
  sdkArchives: readonly PackedArtifact[],
) {
  await writeNativeArchiveOverrides(fixture.root, sdkArchives, [
    `${namespace}/authors/*`,
    `${namespace}/collection`,
  ]);
  await execa("pnpm", ["--dir", fixture.root, "install"], {
    cwd: workspaceRoot,
  });
  await execa(
    "pnpm",
    [
      "--dir",
      fixture.root,
      "-r",
      "--filter",
      "@fixture/preset...",
      "--filter",
      "@fixture/tooling-config",
      "--filter",
      "@fixture/addon",
      "--if-present",
      "run",
      "build:template",
    ],
    { cwd: workspaceRoot },
  );
  return await fixture.load(namespace);
}

async function textFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const childPath = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        await visit(childPath);
      } else if (child.isFile()) {
        files.push(await readFile(childPath, "utf8"));
      }
    }
  };
  await visit(root);
  return files;
}

type InstalledPackage = {
  readonly name?: string;
  readonly path?: string;
  readonly dependencies?: Readonly<Record<string, InstalledPackage>>;
  readonly devDependencies?: Readonly<Record<string, InstalledPackage>>;
  readonly optionalDependencies?: Readonly<Record<string, InstalledPackage>>;
  readonly peerDependencies?: Readonly<Record<string, InstalledPackage>>;
};

function installedPackages(value: unknown): readonly {
  readonly name: string;
  readonly path: string;
  readonly parentPath?: string;
}[] {
  const packages: { name: string; path: string; parentPath?: string }[] = [];
  const visit = (
    entry: unknown,
    fallbackName?: string,
    parentPath?: string,
  ): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, fallbackName, parentPath);
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    const node = entry as InstalledPackage;
    const name = node.name ?? fallbackName;
    if (name !== undefined && node.path !== undefined) {
      packages.push({
        name,
        path: node.path,
        ...(parentPath === undefined ? {} : { parentPath }),
      });
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      for (const [childName, child] of Object.entries(node[field] ?? {})) {
        visit(child, childName, node.path ?? parentPath);
      }
    }
  };
  visit(value);
  return packages;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function snapshotTree(
  root: string,
): Promise<readonly { readonly path: string; readonly state: string }[]> {
  const snapshot: { path: string; state: string }[] = [];
  const rootMetadata = await lstat(root, { bigint: true });
  snapshot.push({
    path: ".",
    state: `directory:${rootMetadata.mode & 0o7777n}`,
  });
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      const metadata = await lstat(absolutePath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        snapshot.push({
          path: relativePath,
          state: `symbolic-link:${await readlink(absolutePath)}`,
        });
      } else if (metadata.isDirectory()) {
        snapshot.push({
          path: relativePath,
          state: `directory:${metadata.mode & 0o7777n}`,
        });
        await visit(absolutePath);
      } else {
        const contents = await readFile(absolutePath);
        snapshot.push({
          path: relativePath,
          state: `file:${metadata.mode & 0o7777n}:${contents.toString("base64")}`,
        });
      }
    }
  };
  await visit(root);
  return snapshot.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

async function auditInstalledLinks(
  nodeModulesRoot: string,
): Promise<readonly { readonly path: string; readonly target: string }[]> {
  const root = await realpath(nodeModulesRoot);
  const links: { path: string; target: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolutePath);
        assert.ok(
          isWithin(root, target),
          `安装链接越出消费者node_modules：${absolutePath} -> ${target}`,
        );
        links.push({ path: absolutePath, target });
      } else if (entry.isDirectory()) {
        await visit(absolutePath);
      }
    }
  };
  await visit(root);
  return links;
}

async function auditInstalledClosure(
  consumerRoot: string,
  forbiddenPaths: readonly string[],
): Promise<{
  readonly tree: unknown;
  readonly packages: readonly {
    readonly name: string;
    readonly path: string;
  }[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
}> {
  const installedList = await execa(
    "pnpm",
    ["--dir", consumerRoot, "list", "--prod", "--depth", "Infinity", "--json"],
    { cwd: consumerRoot },
  );
  const tree: unknown = JSON.parse(installedList.stdout);
  const installedJson = JSON.stringify(tree);
  assert.doesNotMatch(installedJson, /link:/u);
  for (const forbiddenPath of forbiddenPaths) {
    assert.equal(installedJson.includes(forbiddenPath), false);
  }
  const packages = installedPackages(tree).filter(
    ({ name }) => name !== "content-consumer",
  );
  const nodeModulesRoot = path.join(consumerRoot, "node_modules");
  const nodeModulesRealRoot = await realpath(nodeModulesRoot);
  const auditedPackagePaths = new Set<string>();
  for (const installedPackage of packages) {
    let packagePath: string;
    try {
      packagePath = await realpath(installedPackage.path);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT" ||
        installedPackage.parentPath === undefined
      ) {
        throw error;
      }
      const parentManifest = JSON.parse(
        await readFile(
          path.join(installedPackage.parentPath, "package.json"),
          "utf8",
        ),
      ) as { readonly optionalDependencies?: Readonly<Record<string, string>> };
      if (
        !Object.hasOwn(
          parentManifest.optionalDependencies ?? {},
          installedPackage.name,
        )
      ) {
        throw error;
      }
      continue;
    }
    assert.ok(
      isWithin(nodeModulesRealRoot, packagePath),
      `实际安装包越出消费者node_modules：${installedPackage.name} -> ${packagePath}`,
    );
    if (auditedPackagePaths.has(packagePath)) continue;
    auditedPackagePaths.add(packagePath);
    const packageTexts = await textFiles(packagePath);
    assert.ok(
      packageTexts.every((text) =>
        forbiddenPaths.every((forbiddenPath) => !text.includes(forbiddenPath)),
      ),
      `安装运行/数据闭包包含作者路径：${installedPackage.name}`,
    );
  }
  const links = await auditInstalledLinks(nodeModulesRoot);
  assert.ok(links.length > 0);
  assert.ok(
    links.every(({ target }) =>
      forbiddenPaths.every((forbiddenPath) => !target.includes(forbiddenPath)),
    ),
  );
  return { tree, packages, links };
}

after(async () => {
  await Promise.all([
    ...preparedCollections.map((prepared) => prepared.cleanup()),
    ...authoredFixtures.map((fixture) => fixture.close()),
    ...temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

void describe("原生内容制品安装链", () => {
  void it("安装TS库最小集合后由普通Node init并在新引擎中add和回放", async () => {
    const buildRoot = await temporaryRoot("preset-content-");
    const preset = templateContent.find(
      (member) => member.kind === "preset" && member.alias === "ts-lib",
    );
    assert.ok(preset);
    const prepared = await prepareContentCollection({
      content: templateContent,
      roots: [preset],

      workspaceRoot,
      root: buildRoot,
    });
    preparedCollections.push(prepared);
    firstPartyPrepared = prepared;

    assert.deepEqual(
      prepared.members.map((member) => member.identity.packageName).sort(),
      [
        "@ykdz/preset-ts-lib",
        "@ykdz/reference-npm-publication",
        "@ykdz/reference-ts-lib",
        "@ykdz/reference-tooling-config",
      ].sort(),
    );

    const workspaceRootMetadata = await stat(workspaceRoot);
    const workspaceRootMode = workspaceRootMetadata.mode & 0o777;
    const workspaceRootTime = workspaceRootMetadata.mtimeMs;
    const authorRoots = prepared.owners.map((owner) => owner.packageRoot);
    const authorModes = await Promise.all(
      authorRoots.map(
        async (authorRoot) => (await stat(authorRoot)).mode & 0o777,
      ),
    );
    const authorTimes = await Promise.all(
      authorRoots.map(async (authorRoot) => (await stat(authorRoot)).mtimeMs),
    );

    const consumerRoot = await temporaryRoot("template-content-consumer-");
    await installContentCollection(prepared, consumerRoot);
    const projectRoot = path.join(consumerRoot, "project");
    const targetRoot = path.join(projectRoot, "workspace");
    const temporaryDirectory = path.join(consumerRoot, "tmp");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    await chmod(projectRoot, 0o777);
    await chmod(temporaryDirectory, 0o777);
    const installedPackage = path.join(
      consumerRoot,
      "node_modules",
      "@ykdz",
      "template-content",
    );
    const resultPath = path.join(projectRoot, "result.json");
    const authorRootsPath = path.join(projectRoot, "author-roots.json");
    await writeFile(
      authorRootsPath,
      JSON.stringify([...authorRoots, workspaceRoot]),
    );
    const driverPath = path.join(installedPackage, "integration-driver.mjs");
    await writeFile(
      driverPath,
      [
        'import assert from "node:assert/strict";',
        'import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";',
        'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
        "",
        'import { templateContent } from "@ykdz/template-content";',
        "",
        "const targetRoot = process.argv[2];",
        "const resultPath = process.argv[3];",
        'const authorRoots = JSON.parse(await readFile(process.argv[4], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        "const generator = createDefaultGenerator({ content: templateContent });",
        "const initialized = await generator.init({",
        "  targetRoot,",
        '  selection: { presets: [{ contentIdentity: { alias: "ts-lib", namespace: "ykdz" } }] },',
        '  conventions: { repositoryName: "packed-library", defaultPackageScope: "packed-library" },',
        "});",
        'assert.equal(initialized.status, "success", JSON.stringify(initialized));',
        'if (initialized.status !== "success") process.exit(2);',
        "const initializedPackages = initialized.generationRecord.packages.map((record) => ({ packageDefinitionId: record.packageDefinitionId, dependencyBindings: record.dependencyBindings }));",
        "const initializedSelections = initialized.generationRecord.selections;",
        "const initializedDefinitions = initialized.blueprint.packages.map(({ packageDefinitionId, path }) => ({ packageDefinitionId, path }));",
        "const userFile = `${targetRoot}/user-owned.txt`;",
        'await writeFile(userFile, "keep the initialized workspace\\n", { mode: 0o640 });',
        "await chmod(userFile, 0o640);",
        'const library = templateContent.find((member) => member.kind === "reference" && member.identity.packageName === "@ykdz/reference-ts-lib");',
        'const configuration = templateContent.find((member) => member.kind === "reference" && member.identity.packageName === "@ykdz/reference-tooling-config");',
        'const libraryRecord = initialized.generationRecord.packages.find((record) => record.contentIdentity.packageName === "@ykdz/reference-ts-lib");',
        'const configurationRecord = initialized.generationRecord.packages.find((record) => record.contentIdentity.packageName === "@ykdz/reference-tooling-config");',
        "assert.ok(library && configuration && libraryRecord && configurationRecord);",
        "assert.equal(library.source.moduleURL.includes(process.argv[5]), false);",
        "assert.equal(library.source.manifestURL.includes(process.argv[5]), false);",
        "assert.equal(configuration.source.moduleURL.includes(process.argv[5]), false);",
        "assert.equal(configuration.source.manifestURL.includes(process.argv[5]), false);",
        'assert.equal(libraryRecord.dependencyBindings["tooling-config"], configurationRecord.packageDefinitionId);',
        "const libraryDefinition = initialized.blueprint.packages.find((definition) => definition.packageDefinitionId === libraryRecord.packageDefinitionId);",
        "assert.ok(libraryDefinition);",
        'const generated = await readFile(`${targetRoot}/${libraryDefinition.path}/src/index.ts`, "utf8");',
        "const replayGenerator = createDefaultGenerator({ content: templateContent });",
        "assert.notStrictEqual(replayGenerator, generator);",
        'const addition = await replayGenerator.add({ repositoryRoot: targetRoot, contentIdentity: { alias: "library", namespace: "ykdz" }, creationInput: { leafName: "fresh-library" } });',
        'assert.equal(addition.status, "success", JSON.stringify(addition));',
        'if (addition.status !== "success") process.exit(3);',
        "for (const previous of initializedPackages) { const current = addition.generationRecord.packages.find((record) => record.packageDefinitionId === previous.packageDefinitionId); assert.ok(current); assert.deepEqual(current.dependencyBindings, previous.dependencyBindings); }",
        "for (const previous of initializedSelections) assert.deepEqual(addition.generationRecord.selections.find(({ selectionId }) => selectionId === previous.selectionId), previous);",
        "for (const previous of initializedDefinitions) assert.ok(addition.blueprint.packages.some(({ packageDefinitionId, path }) => packageDefinitionId === previous.packageDefinitionId && path === previous.path));",
        'assert.equal(await readFile(userFile, "utf8"), "keep the initialized workspace\\n");',
        "assert.equal((await stat(userFile)).mode & 0o777, 0o640);",
        'const freshLibrary = addition.blueprint.packages.find((definition) => definition.path === "packages/fresh-library");',
        "assert.ok(freshLibrary);",
        'const freshGenerated = await readFile(`${targetRoot}/${freshLibrary.path}/src/index.ts`, "utf8");',
        'await writeFile(resultPath, JSON.stringify({ generationRecord: initialized.generationRecord, blueprint: initialized.blueprint, generated, addition, freshLibrary, freshGenerated, userCustomization: { text: await readFile(userFile, "utf8"), mode: (await stat(userFile)).mode & 0o777 } }));',
      ].join("\n"),
    );

    await withUnreadableAuthorDirectories(
      [
        ...authorRoots.map((authorPath, index) => ({
          path: authorPath,
          mode: authorModes[index]!,
        })),
        { path: workspaceRoot, mode: workspaceRootMode },
      ],
      async () =>
        await execa(
          process.execPath,
          [driverPath, targetRoot, resultPath, authorRootsPath, workspaceRoot],
          {
            cwd: installedPackage,
            env: {
              ...process.env,
              HOME: consumerRoot,
              TMPDIR: path.join(consumerRoot, "tmp"),
              NODE_OPTIONS: "--no-global-search-paths",
              NODE_PATH: "",
            },
            ...unprivilegedProcessOptions,
          },
        ),
    );

    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      readonly generationRecord: {
        readonly selections: readonly {
          readonly presetIdentity: { readonly packageName: string } | null;
        }[];
      };
      readonly blueprint: {
        readonly packages: readonly {
          readonly name: string;
          readonly path: string;
        }[];
      };
      readonly generated: string;
      readonly addition: {
        readonly status: string;
        readonly generationRecord: {
          readonly packages: readonly {
            readonly contentIdentity: { readonly packageName: string };
            readonly packageDefinitionId: string;
          }[];
        };
        readonly blueprint: {
          readonly packages: readonly {
            readonly name: string;
            readonly path: string;
          }[];
        };
      };
      readonly freshLibrary: { readonly path: string };
      readonly freshGenerated: string;
      readonly userCustomization: {
        readonly text: string;
        readonly mode: number;
      };
    };
    assert.deepEqual(
      result.generationRecord.selections.flatMap(({ presetIdentity }) =>
        presetIdentity === null ? [] : [presetIdentity.packageName],
      ),
      ["@ykdz/preset-ts-lib"],
    );
    assert.equal(result.addition.status, "success");
    assert.ok(
      result.addition.generationRecord.packages.filter(
        ({ contentIdentity }) =>
          contentIdentity.packageName === "@ykdz/reference-ts-lib",
      ).length >= 2,
    );
    assert.ok(
      result.addition.blueprint.packages.some(
        ({ path: packagePath }) => packagePath === "packages/fresh-library",
      ),
    );
    assert.ok(
      result.blueprint.packages.some(
        (definition) => definition.path === "packages/tooling-config",
      ),
    );
    assert.match(result.generated, /export function/u);
    assert.match(result.freshGenerated, /export function/u);
    assert.deepEqual(result.userCustomization, {
      text: "keep the initialized workspace\n",
      mode: 0o640,
    });
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(async (authorRoot) => (await stat(authorRoot)).mtimeMs),
      ),
      authorTimes,
    );
    const restoredWorkspaceRoot = await stat(workspaceRoot);
    assert.equal(restoredWorkspaceRoot.mtimeMs, workspaceRootTime);
    assert.equal(restoredWorkspaceRoot.mode & 0o777, workspaceRootMode);
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(
          async (authorRoot) => (await stat(authorRoot)).mode & 0o777,
        ),
      ),
      authorModes,
    );
    const closure = await auditInstalledClosure(consumerRoot, [
      ...authorRoots,
      workspaceRoot,
    ]);
    for (const archive of [
      ...prepared.sdkPackages,
      ...prepared.owners.map((owner) => owner.packed),
      prepared.collection,
    ]) {
      assert.ok(
        closure.packages.some(({ name }) => name === archive.name),
        `TS库集合安装闭包缺少制品：${archive.name}@${archive.version}`,
      );
    }
    const missingSdkDriverPath = path.join(
      installedPackage,
      "missing-generator-dependency-driver.mjs",
    );
    await writeFile(
      missingSdkDriverPath,
      [
        'import assert from "node:assert/strict";',
        'import { readFile, readdir } from "node:fs/promises";',
        'const authorRoots = JSON.parse(await readFile(process.argv[2], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        'await import("@ykdz/template-content");',
      ].join("\n"),
    );
    const targetBeforeMissingSdk = await snapshotTree(targetRoot);
    const projectBeforeMissingSdk = await snapshotTree(projectRoot);
    const missingSdkTarget = path.join(projectRoot, "missing-sdk-workspace");
    const generatorPackagePaths = [
      ...new Set(
        await Promise.all(
          closure.packages
            .filter(({ name }) => name === "@ykdz/template-generator")
            .map(async ({ path: packagePath }) => await realpath(packagePath)),
        ),
      ),
    ];
    assert.ok(generatorPackagePaths.length > 0);
    const hiddenGeneratorPackagePaths = generatorPackagePaths.map(
      (packagePath) => `${packagePath}.temporarily-missing`,
    );
    await Promise.all(
      generatorPackagePaths.map(
        async (packagePath, index) =>
          await rename(packagePath, hiddenGeneratorPackagePaths[index]!),
      ),
    );
    let missingSdkExecution;
    try {
      missingSdkExecution = await withUnreadableAuthorDirectories(
        [
          ...authorRoots.map((authorPath, index) => ({
            path: authorPath,
            mode: authorModes[index]!,
          })),
          { path: workspaceRoot, mode: workspaceRootMode },
        ],
        async () =>
          await execa(
            process.execPath,
            [missingSdkDriverPath, authorRootsPath],
            {
              cwd: installedPackage,
              env: {
                ...process.env,
                HOME: consumerRoot,
                TMPDIR: temporaryDirectory,
                NODE_OPTIONS: "--no-global-search-paths",
                NODE_PATH: "",
              },
              ...unprivilegedProcessOptions,
              reject: false,
            },
          ),
      );
    } finally {
      await Promise.all(
        generatorPackagePaths.map(
          async (packagePath, index) =>
            await rename(hiddenGeneratorPackagePaths[index]!, packagePath),
        ),
      );
    }
    assert.notEqual(missingSdkExecution.exitCode, 0);
    assert.match(missingSdkExecution.stderr, /ERR_MODULE_NOT_FOUND/u);
    assert.match(
      missingSdkExecution.stderr,
      /Cannot find package '@ykdz\/template-generator' imported from .*template-content-provider/su,
    );
    assert.deepEqual(await snapshotTree(targetRoot), targetBeforeMissingSdk);
    assert.deepEqual(await snapshotTree(projectRoot), projectBeforeMissingSdk);
    const evidenceRoot = await contentArtifactEvidenceRoot();
    await writeContentCollectionEvidence(
      prepared,
      path.join(evidenceRoot, "typescript-library-build.md"),
    );
    await writeFile(
      path.join(evidenceRoot, "typescript-library-consumer.json"),
      `${JSON.stringify(
        {
          command: `pnpm --dir ${consumerRoot} add ${prepared.collection.tarball}`,
          authorDirectories: [
            ...authorRoots.map((authorPath) => ({
              path: authorPath,
              mode: 0,
              readableByConsumer: false,
            })),
            { path: workspaceRoot, mode: 0, readableByConsumer: false },
          ],
          providers: closure.packages,
          links: closure.links,
          initialized: {
            selections: result.generationRecord.selections,
            packagePaths: result.blueprint.packages.map(
              ({ path: packagePath }) => packagePath,
            ),
            generated: result.generated,
            freshAdd: result.addition.status,
            freshReplayPackagePaths: result.addition.blueprint.packages.map(
              ({ path: packagePath }) => packagePath,
            ),
            freshGenerated: result.freshGenerated,
            userCustomization: result.userCustomization,
          },
          missingGeneratorDependency: {
            exitCode: missingSdkExecution.exitCode,
            stderr: missingSdkExecution.stderr,
            targetPath: missingSdkTarget,
            initializedTargetUnchanged: true,
            missingTargetCreated: false,
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  void it("其余五个预设分别从独立最小原生集合安装并初始化", async () => {
    assert.ok(firstPartyPrepared);
    const sdkArchives = firstPartyPrepared.sdkPackages;
    const presets = templateContent.filter(
      (member) => member.kind === "preset" && member.alias !== "ts-lib",
    );
    assert.equal(presets.length, 5);

    for (const preset of presets) {
      assert.equal(preset.kind, "preset");
      const prepared = await prepareContentCollection({
        content: templateContent,
        roots: [preset],

        workspaceRoot,
        root: await temporaryRoot(`preset-${preset.alias}-`),
        sdkArchives,
      });
      preparedCollections.push(prepared);
      assert.deepEqual(
        prepared.presets.map(({ alias }) => alias),
        [preset.alias],
      );
      assert.ok(
        prepared.members.every(
          (member) =>
            member.kind !== "preset" || member.identity === preset.identity,
        ),
        `${preset.alias} 的最小闭包包含了其他预设`,
      );

      const authorRoots = prepared.owners.map((owner) => owner.packageRoot);
      const authorModes = await Promise.all(
        authorRoots.map(
          async (authorPath) => (await stat(authorPath)).mode & 0o777,
        ),
      );
      const authorTimes = await Promise.all(
        authorRoots.map(async (authorPath) => (await stat(authorPath)).mtimeMs),
      );
      const workspaceMetadata = await stat(workspaceRoot);
      const workspaceMode = workspaceMetadata.mode & 0o777;
      const workspaceTime = workspaceMetadata.mtimeMs;

      const consumerRoot = await temporaryRoot(
        `preset-${preset.alias}-consumer-`,
      );
      await installContentCollection(prepared, consumerRoot);
      const projectRoot = path.join(consumerRoot, "project");
      const targetRoot = path.join(projectRoot, "workspace");
      const temporaryDirectory = path.join(consumerRoot, "tmp");
      await mkdir(projectRoot, { recursive: true });
      await mkdir(temporaryDirectory, { recursive: true });
      await chmod(projectRoot, 0o777);
      await chmod(temporaryDirectory, 0o777);
      const installedCollection = path.join(
        consumerRoot,
        "node_modules",
        "@ykdz",
        "template-content",
      );
      const driverPath = path.join(installedCollection, "preset-driver.mjs");
      const authorRootsPath = path.join(projectRoot, "author-roots.json");
      const resultPath = path.join(projectRoot, "result.json");
      await writeFile(
        authorRootsPath,
        JSON.stringify([...authorRoots, workspaceRoot]),
      );
      await writeFile(
        driverPath,
        [
          'import assert from "node:assert/strict";',
          'import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          "",
          'import { templateContent } from "@ykdz/template-content";',
          "",
          'const authorRoots = JSON.parse(await readFile(process.argv[3], "utf8"));',
          'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
          'const preset = templateContent.find((member) => member.kind === "preset" && member.alias === process.argv[4]);',
          "assert.ok(preset);",
          "const generator = createDefaultGenerator({ content: templateContent });",
          "const initialized = await generator.init({ targetRoot: process.argv[2], selection: { presets: [{ contentIdentity: preset.identity }] }, conventions: { repositoryName: `installed-${preset.alias}`, defaultPackageScope: `installed-${preset.alias}`, todo: false } });",
          'assert.equal(initialized.status, "success", JSON.stringify(initialized));',
          'if (initialized.status !== "success") process.exit(2);',
          "assert.deepEqual(initialized.generationRecord.selections.flatMap(({ presetIdentity }) => presetIdentity === null ? [] : [presetIdentity.packageName]), [preset.identity.packageName]);",
          "const initializedPackages = initialized.generationRecord.packages.map((record) => ({ packageDefinitionId: record.packageDefinitionId, dependencyBindings: record.dependencyBindings }));",
          "const initializedSelections = initialized.generationRecord.selections;",
          "const initializedDefinitions = initialized.blueprint.packages.map(({ packageDefinitionId, path }) => ({ packageDefinitionId, path }));",
          "const userFile = `${process.argv[2]}/user-owned.txt`;",
          'await writeFile(userFile, "keep the initialized workspace\\n", { mode: 0o640 });',
          "await chmod(userFile, 0o640);",
          "await writeFile(process.argv[5], JSON.stringify({ initialized: { selections: initializedSelections, packages: initializedPackages, definitions: initializedDefinitions, packagePaths: initialized.blueprint.packages.map(({ path }) => path) } }));",
        ].join("\n"),
      );

      await withUnreadableAuthorDirectories(
        [
          ...authorRoots.map((authorPath, index) => ({
            path: authorPath,
            mode: authorModes[index]!,
          })),
          { path: workspaceRoot, mode: workspaceMode },
        ],
        async () =>
          await execa(
            process.execPath,
            [driverPath, targetRoot, authorRootsPath, preset.alias, resultPath],
            {
              cwd: installedCollection,
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

      const result = JSON.parse(await readFile(resultPath, "utf8")) as {
        readonly initialized: {
          readonly selections: readonly {
            readonly selectionId: string;
            readonly presetIdentity: { readonly packageName: string } | null;
            readonly nodes: Readonly<Record<string, string>>;
          }[];
          readonly packages: readonly {
            readonly packageDefinitionId: string;
            readonly dependencyBindings: Readonly<Record<string, string>>;
          }[];
          readonly definitions: readonly {
            readonly packageDefinitionId: string;
            readonly path: string;
          }[];
          readonly packagePaths: readonly string[];
        };
      };
      assert.deepEqual(
        result.initialized.selections.flatMap(({ presetIdentity }) =>
          presetIdentity === null ? [] : [presetIdentity.packageName],
        ),
        [preset.identity.packageName],
      );
      assert.ok(result.initialized.packagePaths.length > 0);
      const closure = await auditInstalledClosure(consumerRoot, [
        ...authorRoots,
        workspaceRoot,
      ]);
      for (const archive of [
        ...prepared.sdkPackages,
        ...prepared.owners.map((owner) => owner.packed),
        ...prepared.providers,
        prepared.collection,
      ]) {
        assert.ok(
          closure.packages.some(({ name }) => name === archive.name),
          `${preset.alias} 安装闭包缺少制品：${archive.name}@${archive.version}`,
        );
      }
      assert.deepEqual(
        await Promise.all(
          authorRoots.map(
            async (authorPath) => (await stat(authorPath)).mtimeMs,
          ),
        ),
        authorTimes,
      );
      assert.deepEqual(
        await Promise.all(
          authorRoots.map(
            async (authorPath) => (await stat(authorPath)).mode & 0o777,
          ),
        ),
        authorModes,
      );
      const afterInitWorkspace = await stat(workspaceRoot);
      assert.equal(afterInitWorkspace.mode & 0o777, workspaceMode);
      assert.equal(afterInitWorkspace.mtimeMs, workspaceTime);

      const replayPackageByPreset = new Map([
        ["ts-cli", "@ykdz/reference-ts-cli"],
        ["rust-bin", "@ykdz/reference-rust-bin"],
        ["vue-app", "@ykdz/reference-vue-app"],
        ["vue-hono-app", "@ykdz/reference-vue-app"],
        ["vike-app", "@ykdz/reference-vue-app"],
      ]);
      const replayPackageName = replayPackageByPreset.get(preset.alias);
      assert.ok(replayPackageName, `${preset.alias} 缺少受支持的单包回放选择`);
      const replayMember = templateContent.find(
        (member) =>
          member.kind === "reference" &&
          member.identity.packageName === replayPackageName,
      );
      assert.ok(replayMember);
      const alreadyPrepared = prepared.members.some(
        (member) =>
          contentIdentityKey(member.identity) ===
          contentIdentityKey(replayMember.identity),
      );
      let replayPrepared = prepared;
      let replayConsumerRoot = consumerRoot;
      if (!alreadyPrepared) {
        replayPrepared = await prepareContentCollection({
          content: templateContent,
          roots: [preset, replayMember],

          workspaceRoot,
          packageName: `@fixture/replay-${preset.alias}`,
          collectionVersion: prepared.collection.version,
          root: await temporaryRoot(`preset-${preset.alias}-replay-build-`),
          sdkArchives,
        });
        preparedCollections.push(replayPrepared);
        assert.deepEqual(
          replayPrepared.presets.map(({ alias }) => alias),
          [preset.alias],
        );
        replayConsumerRoot = await temporaryRoot(
          `preset-${preset.alias}-replay-consumer-`,
        );
        await installContentCollection(replayPrepared, replayConsumerRoot);
      }
      const replayInstalledCollection = path.join(
        replayConsumerRoot,
        "node_modules",
        alreadyPrepared ? "@ykdz" : "@fixture",
        alreadyPrepared ? "template-content" : `replay-${preset.alias}`,
      );
      const replayDriverPath = path.join(
        replayInstalledCollection,
        "preset-add-driver.mjs",
      );
      const replayAuthorRoots = replayPrepared.owners.map(
        (owner) => owner.packageRoot,
      );
      const replayAuthorModes = await Promise.all(
        replayAuthorRoots.map(
          async (authorPath) => (await stat(authorPath)).mode & 0o777,
        ),
      );
      const replayAuthorTimes = await Promise.all(
        replayAuthorRoots.map(
          async (authorPath) => (await stat(authorPath)).mtimeMs,
        ),
      );
      const replayWorkspaceMetadata = await stat(workspaceRoot);
      const replayWorkspaceMode = replayWorkspaceMetadata.mode & 0o777;
      const replayWorkspaceTime = replayWorkspaceMetadata.mtimeMs;
      const replayAuthorRootsPath = path.join(
        projectRoot,
        `${preset.alias}-replay-author-roots.json`,
      );
      const replayResultPath = path.join(
        projectRoot,
        `${preset.alias}-replay-result.json`,
      );
      const replayTemporaryDirectory = path.join(replayConsumerRoot, "tmp");
      await mkdir(replayTemporaryDirectory, { recursive: true });
      await chmod(replayTemporaryDirectory, 0o777);
      await writeFile(
        replayAuthorRootsPath,
        JSON.stringify([...replayAuthorRoots, workspaceRoot]),
      );
      const replayCreationInput = {
        leafName: `replayed-${preset.alias}`,
        packagePath: `packages/replayed-${preset.alias}`,
        ...(preset.alias === "ts-cli" ? { variant: "private" } : {}),
      };
      await writeFile(
        replayDriverPath,
        [
          'import assert from "node:assert/strict";',
          'import { readdir, readFile, stat, writeFile } from "node:fs/promises";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          "",
          `import { templateContent } from "${replayPrepared.collection.name}";`,
          "",
          "const targetRoot = process.argv[2];",
          'const authorRoots = JSON.parse(await readFile(process.argv[3], "utf8"));',
          'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
          'const baseline = JSON.parse(await readFile(process.argv[4], "utf8")).initialized;',
          'const member = templateContent.find((candidate) => candidate.kind === "reference" && candidate.identity.packageName === process.argv[5]);',
          "assert.ok(member);",
          "const creationInput = JSON.parse(process.argv[6]);",
          "const generator = createDefaultGenerator({ content: templateContent });",
          "const addition = await generator.add({ repositoryRoot: targetRoot, contentIdentity: member.identity, creationInput });",
          'assert.equal(addition.status, "success", JSON.stringify(addition));',
          'if (addition.status !== "success") process.exit(3);',
          "for (const previous of baseline.packages) { const current = addition.generationRecord.packages.find((record) => record.packageDefinitionId === previous.packageDefinitionId); assert.ok(current); assert.deepEqual(current.dependencyBindings, previous.dependencyBindings); }",
          "for (const previous of baseline.definitions) assert.ok(addition.blueprint.packages.some(({ packageDefinitionId, path }) => packageDefinitionId === previous.packageDefinitionId && path === previous.path));",
          "for (const previous of baseline.selections) assert.deepEqual(addition.generationRecord.selections.find(({ selectionId }) => selectionId === previous.selectionId), previous);",
          "const userFile = `${targetRoot}/user-owned.txt`;",
          'assert.equal(await readFile(userFile, "utf8"), "keep the initialized workspace\\n");',
          "assert.equal((await stat(userFile)).mode & 0o777, 0o640);",
          "const newRecord = addition.generationRecord.packages.find((record) => record.contentIdentity.packageName === member.identity.packageName && !baseline.packages.some((previous) => previous.packageDefinitionId === record.packageDefinitionId));",
          "assert.ok(newRecord);",
          "assert.ok(addition.blueprint.packages.some((definition) => definition.packageDefinitionId === newRecord.packageDefinitionId && definition.path === creationInput.packagePath));",
          'await writeFile(process.argv[7], JSON.stringify({ status: addition.status, identity: member.identity, packageDefinitionId: newRecord.packageDefinitionId, path: creationInput.packagePath, retainedPackages: baseline.packages.length, retainedDefinitions: baseline.definitions.length, retainedSelectionNodes: baseline.selections.reduce((count, selection) => count + Object.keys(selection.nodes).length, 0), userCustomization: { text: await readFile(userFile, "utf8"), mode: (await stat(userFile)).mode & 0o777 } }));',
        ].join("\n"),
      );
      await withUnreadableAuthorDirectories(
        [
          ...replayAuthorRoots.map((authorPath, index) => ({
            path: authorPath,
            mode: replayAuthorModes[index]!,
          })),
          { path: workspaceRoot, mode: replayWorkspaceMode },
        ],
        async () =>
          await execa(
            process.execPath,
            [
              replayDriverPath,
              targetRoot,
              replayAuthorRootsPath,
              resultPath,
              replayPackageName,
              JSON.stringify(replayCreationInput),
              replayResultPath,
            ],
            {
              cwd: replayInstalledCollection,
              env: {
                ...process.env,
                HOME: replayConsumerRoot,
                TMPDIR: replayTemporaryDirectory,
                NODE_OPTIONS: "--no-global-search-paths",
                NODE_PATH: "",
              },
              ...unprivilegedProcessOptions,
            },
          ),
      );
      const replayResult = JSON.parse(
        await readFile(replayResultPath, "utf8"),
      ) as {
        readonly status: string;
        readonly identity: { readonly packageName: string };
        readonly packageDefinitionId: string;
        readonly path: string;
        readonly retainedPackages: number;
        readonly retainedDefinitions: number;
        readonly retainedSelectionNodes: number;
        readonly userCustomization: {
          readonly text: string;
          readonly mode: number;
        };
      };
      assert.equal(replayResult.status, "success");
      assert.equal(replayResult.identity.packageName, replayPackageName);
      assert.equal(replayResult.path, replayCreationInput.packagePath);
      assert.equal(
        replayResult.userCustomization.text,
        "keep the initialized workspace\n",
      );
      assert.equal(replayResult.userCustomization.mode, 0o640);
      assert.deepEqual(
        await Promise.all(
          replayAuthorRoots.map(
            async (authorPath) => (await stat(authorPath)).mtimeMs,
          ),
        ),
        replayAuthorTimes,
      );
      assert.deepEqual(
        await Promise.all(
          replayAuthorRoots.map(
            async (authorPath) => (await stat(authorPath)).mode & 0o777,
          ),
        ),
        replayAuthorModes,
      );
      const afterReplayWorkspace = await stat(workspaceRoot);
      assert.equal(afterReplayWorkspace.mode & 0o777, replayWorkspaceMode);
      assert.equal(afterReplayWorkspace.mtimeMs, replayWorkspaceTime);
      const replayClosure = await auditInstalledClosure(replayConsumerRoot, [
        ...replayAuthorRoots,
        workspaceRoot,
      ]);
      for (const archive of [
        ...replayPrepared.sdkPackages,
        ...replayPrepared.owners.map((owner) => owner.packed),
        ...replayPrepared.providers,
        replayPrepared.collection,
      ]) {
        assert.ok(
          replayClosure.packages.some(({ name }) => name === archive.name),
          `${preset.alias} 回放闭包缺少制品：${archive.name}@${archive.version}`,
        );
      }
      let missingResourceEvidence:
        | {
            readonly status: string;
            readonly phase: string;
            readonly errorMessage: string;
          }
        | undefined;
      if (preset.alias === "rust-bin") {
        const rustOwner = prepared.owners.find(
          (owner) =>
            owner.member.identity.packageName === "@ykdz/reference-rust-bin",
        );
        const installedRust = closure.packages.find(
          ({ name }) => name === "@ykdz/reference-rust-bin",
        );
        assert.ok(rustOwner && installedRust);
        assert.ok(
          rustOwner.artifact.resources.some(
            ({ path: resourcePath }) => resourcePath === "Cargo.toml",
          ),
          "Rust reference 的原生执行事实必须进入正式制品",
        );
        const installedCargoManifest = path.join(
          installedRust.path,
          "native",
          "Cargo.toml",
        );
        const hiddenCargoManifest = `${installedCargoManifest}.temporarily-missing`;
        const missingResourceResultPath = path.join(
          projectRoot,
          "missing-rust-resource.json",
        );
        const missingResourceDriverPath = path.join(
          installedCollection,
          "missing-rust-resource-driver.mjs",
        );
        await writeFile(
          missingResourceDriverPath,
          [
            'import assert from "node:assert/strict";',
            'import { readdir, readFile, writeFile } from "node:fs/promises";',
            'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
            "",
            'import { templateContent } from "@ykdz/template-content";',
            'const authorRoots = JSON.parse(await readFile(process.argv[3], "utf8"));',
            'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
            "const generator = createDefaultGenerator({ content: templateContent });",
            'const result = await generator.add({ repositoryRoot: process.argv[2], contentIdentity: { alias: "binary", namespace: "ykdz" }, creationInput: { leafName: "second-app" } });',
            "await writeFile(process.argv[4], JSON.stringify({ status: result.status, phase: result.phase, errorMessage: result.error?.message }));",
          ].join("\n"),
        );
        const existingTargetBeforeFailure = await snapshotTree(targetRoot);
        await rename(installedCargoManifest, hiddenCargoManifest);
        let missingResourceExecution;
        try {
          missingResourceExecution = await withUnreadableAuthorDirectories(
            [
              ...authorRoots.map((authorPath, index) => ({
                path: authorPath,
                mode: authorModes[index]!,
              })),
              { path: workspaceRoot, mode: workspaceMode },
            ],
            async () =>
              await execa(
                process.execPath,
                [
                  missingResourceDriverPath,
                  targetRoot,
                  authorRootsPath,
                  missingResourceResultPath,
                ],
                {
                  cwd: installedCollection,
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
        } finally {
          await rename(hiddenCargoManifest, installedCargoManifest);
        }
        assert.equal(missingResourceExecution.exitCode, 0);
        missingResourceEvidence = JSON.parse(
          await readFile(missingResourceResultPath, "utf8"),
        ) as {
          readonly status: string;
          readonly phase: string;
          readonly errorMessage: string;
        };
        assert.equal(missingResourceEvidence.status, "operation-failure");
        assert.equal(missingResourceEvidence.phase, "planning");
        assert.match(
          missingResourceEvidence.errorMessage,
          /@ykdz\/reference-rust-bin.*prepare 阶段失败.*模板执行数据未包含/u,
        );
        assert.deepEqual(
          await snapshotTree(targetRoot),
          existingTargetBeforeFailure,
        );
        await assert.rejects(
          stat(path.join(targetRoot, "packages", "second-app")),
          { code: "ENOENT" },
        );
      }
      const evidenceRoot = await contentArtifactEvidenceRoot();
      await writeContentCollectionEvidence(
        prepared,
        path.join(evidenceRoot, `${preset.alias}-build.md`),
      );
      if (!alreadyPrepared) {
        await writeContentCollectionEvidence(
          replayPrepared,
          path.join(evidenceRoot, `${preset.alias}-replay-build.md`),
        );
      }
      await writeFile(
        path.join(evidenceRoot, `${preset.alias}-consumer.json`),
        `${JSON.stringify(
          {
            command: `pnpm --dir ${consumerRoot} add ${prepared.collection.tarball}`,
            authorDirectories: [
              ...authorRoots.map((authorPath) => ({
                path: authorPath,
                mode: 0,
              })),
              { path: workspaceRoot, mode: 0 },
            ],
            links: closure.links,
            providers: closure.packages,
            preset: preset.identity,
            packages: result.initialized.packagePaths,
            replay: {
              collectionRoot: alreadyPrepared
                ? [preset.identity]
                : [preset.identity, replayMember.identity],
              package: replayResult.identity,
              packageDefinitionId: replayResult.packageDefinitionId,
              path: replayResult.path,
              retainedPackages: replayResult.retainedPackages,
              retainedDefinitions: replayResult.retainedDefinitions,
              retainedSelectionNodes: replayResult.retainedSelectionNodes,
              userCustomization: replayResult.userCustomization,
              authorDirectories: [
                ...replayAuthorRoots.map((authorPath) => ({
                  path: authorPath,
                  mode: 0,
                  readableByConsumer: false,
                })),
                {
                  path: workspaceRoot,
                  mode: 0,
                  readableByConsumer: false,
                },
              ],
              providers: replayClosure.packages,
              links: replayClosure.links,
            },
            missingResource: missingResourceEvidence,
          },
          null,
          2,
        )}\n`,
      );
    }
  });

  void it("全部参考入口按声明绑定原生根并安装生成", async () => {
    assert.ok(firstPartyPrepared);
    const references = templateContent.filter(
      (member) => member.kind === "reference",
    );
    const contentByIdentity = new Map(
      references.map((member) => [contentIdentityKey(member.identity), member]),
    );
    const dependencyIdentities = (member: (typeof references)[number]) =>
      (member.definition.dependencies ?? []).map((dependency) =>
        resolveReferenceDependencyIdentity({
          consumerIdentity: member.identity,
          dependency,
          members: templateContent,
        }),
      );
    const entries = references.map((member) => {
      const dependencies = dependencyIdentities(member);
      return {
        member,
        independentDependencies: dependencies
          .map((identity) =>
            contentByIdentity.get(contentIdentityKey(identity)),
          )
          .flatMap((dependency) =>
            dependency?.definition.instance === "independent"
              ? [dependency]
              : [],
          ),
      };
    });
    const vueHonoWeb = references.find(
      (member) =>
        member.identity.packageName === "@ykdz/reference-vue-hono-web",
    );
    const honoApi = references.find(
      (member) => member.identity.packageName === "@ykdz/reference-hono-api",
    );
    const vikeWeb = references.find(
      (member) => member.identity.packageName === "@ykdz/reference-vike-web",
    );
    const vikeDatabase = references.find(
      (member) => member.identity.packageName === "@ykdz/reference-vike-db",
    );
    const vikeMigrations = references.find(
      (member) =>
        member.identity.packageName === "@ykdz/reference-vike-migrations",
    );
    assert.ok(
      vueHonoWeb && honoApi && vikeWeb && vikeDatabase && vikeMigrations,
    );
    assert.ok(
      dependencyIdentities(vueHonoWeb).some(
        (identity) =>
          contentIdentityKey(identity) === contentIdentityKey(honoApi.identity),
      ),
      "Vue-Hono web 的真实依赖声明应指向 Hono API",
    );
    assert.ok(
      dependencyIdentities(vikeWeb).some(
        (identity) =>
          contentIdentityKey(identity) ===
          contentIdentityKey(vikeDatabase.identity),
      ),
      "Vike web 的真实依赖声明应指向 Vike DB",
    );
    assert.ok(
      dependencyIdentities(vikeMigrations).some(
        (identity) =>
          contentIdentityKey(identity) ===
          contentIdentityKey(vikeDatabase.identity),
      ),
      "Vike migrations 的真实依赖声明应指向 Vike DB",
    );

    const prepared = await prepareContentCollection({
      content: templateContent,
      roots: references,
      workspaceRoot,
      root: await temporaryRoot("reference-content-"),
      sdkArchives: firstPartyPrepared.sdkPackages,
    });
    preparedCollections.push(prepared);
    assert.equal(prepared.presets.length, 0);
    assert.equal(prepared.members.length, references.length);
    assert.deepEqual(
      prepared.members
        .map((member) => contentIdentityKey(member.identity))
        .sort(),
      references.map((member) => contentIdentityKey(member.identity)).sort(),
    );
    assert.equal(prepared.owners.length, 11);
    const vueAppOwner = prepared.owners.find(
      (owner) =>
        owner.member.identity.packageName === "@ykdz/reference-vue-app",
    );
    assert.ok(vueAppOwner);
    const vueAppNativeList = await execa(
      "pnpm",
      ["--dir", vueAppOwner.packageRoot, "list", "--depth", "0", "--json"],
      { cwd: workspaceRoot },
    );
    const vueAppNativeProject = (
      JSON.parse(vueAppNativeList.stdout) as readonly {
        readonly devDependencies?: Readonly<
          Record<string, { readonly from?: string; readonly version?: string }>
        >;
      }[]
    )[0];
    const nativeTypeScript =
      vueAppNativeProject?.devDependencies?.["typescript-7"];
    assert.ok(nativeTypeScript?.from && nativeTypeScript.version);
    const vueAppArchiveManifest = JSON.parse(
      await readFile(
        path.join(vueAppOwner.installRoot, "package.json"),
        "utf8",
      ),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    assert.equal(
      vueAppArchiveManifest.dependencies?.["typescript-7"],
      nativeTypeScript.from === "typescript-7"
        ? nativeTypeScript.version
        : `npm:${nativeTypeScript.from}@${nativeTypeScript.version}`,
      "第一方归档应保留原生包别名实际指向的包身份与版本",
    );

    const authorRoots = prepared.owners.map((owner) => owner.packageRoot);
    const authorModes = await Promise.all(
      authorRoots.map(
        async (authorPath) => (await stat(authorPath)).mode & 0o777,
      ),
    );
    const authorTimes = await Promise.all(
      authorRoots.map(async (authorPath) => (await stat(authorPath)).mtimeMs),
    );
    const workspaceMetadata = await stat(workspaceRoot);
    const workspaceMode = workspaceMetadata.mode & 0o777;
    const workspaceTime = workspaceMetadata.mtimeMs;
    const consumerRoot = await temporaryRoot("reference-content-consumer-");
    await installContentCollection(prepared, consumerRoot);
    const projectRoot = path.join(consumerRoot, "project");
    const temporaryDirectory = path.join(consumerRoot, "tmp");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    await chmod(projectRoot, 0o777);
    await chmod(temporaryDirectory, 0o777);
    const publicTypesPath = path.join(projectRoot, "public-types.mts");
    await writeFile(
      publicTypesPath,
      [
        'import { templateContent, templatePresets, templateReferencePackages, type ContentKind, type TemplateContentMember, type TemplatePreset, type TemplateReferencePackage } from "@ykdz/template-content";',
        "const kind: ContentKind = templateContent[0]!.kind;",
        "const members: readonly TemplateContentMember[] = templateContent;",
        "const presets: readonly TemplatePreset[] = templatePresets;",
        "const references: readonly TemplateReferencePackage[] = templateReferencePackages;",
        'const preset = templateContent.find((member): member is TemplatePreset => member.kind === "preset");',
        'const reference = templateContent.find((member): member is TemplateReferencePackage => member.kind === "reference");',
        "void [kind, members, presets, references, preset, reference];",
      ].join("\n"),
    );
    await execa(
      path.join(workspaceRoot, "node_modules", ".bin", "tsc"),
      [
        "--noEmit",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--skipLibCheck",
        publicTypesPath,
      ],
      { cwd: projectRoot },
    );
    const installedCollection = path.join(
      consumerRoot,
      "node_modules",
      "@ykdz",
      "template-content",
    );
    const driverPath = path.join(installedCollection, "references-driver.mjs");
    const authorRootsPath = path.join(projectRoot, "author-roots.json");
    const entriesPath = path.join(projectRoot, "entries.json");
    const resultPath = path.join(projectRoot, "result.json");
    const productAuthorRoot = workspaceRoot;
    await writeFile(
      authorRootsPath,
      JSON.stringify([...authorRoots, productAuthorRoot]),
    );
    await writeFile(
      entriesPath,
      JSON.stringify(
        entries.map(({ member, independentDependencies }) => ({
          identity: member.identity,
          independentDependencies: independentDependencies.map(
            (dependency) => dependency.identity,
          ),
        })),
      ),
    );
    await writeFile(
      driverPath,
      [
        'import assert from "node:assert/strict";',
        'import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";',
        'import { contentIdentityKey } from "@ykdz/template-core/content-identity";',
        'import { resolveReferenceDependencyIdentity } from "@ykdz/template-generator";',
        'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
        "",
        'import { deriveTemplateMembers, templateContent } from "@ykdz/template-content";',
        "const targetBase = process.argv[2];",
        'const authorRoots = JSON.parse(await readFile(process.argv[3], "utf8"));',
        'const entries = JSON.parse(await readFile(process.argv[4], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        'const contentByIdentity = new Map(templateContent.filter((member) => member.kind === "reference").map((member) => [contentIdentityKey(member.identity), member]));',
        "const derivedMembers = deriveTemplateMembers(templateContent);",
        "assert.equal(derivedMembers.presets.length, 0);",
        "assert.equal(derivedMembers.referencePackages.length, entries.length);",
        "const results = [];",
        "for (const [index, entry] of entries.entries()) {",
        '  const roots = [{ nodeIdentity: "entry", contentIdentity: entry.identity }, ...entry.independentDependencies.map((contentIdentity, providerIndex) => ({ nodeIdentity: `provider-${providerIndex}`, contentIdentity }))];',
        "  const targetRoot = `${targetBase}/entry-${index}`;",
        "  const generator = createDefaultGenerator({ content: templateContent });",
        "  const initialized = await generator.init({ targetRoot, selection: { roots }, conventions: { repositoryName: `reference-${index}`, defaultPackageScope: `reference-${index}`, todo: false } });",
        '  assert.equal(initialized.status, "success", `${entry.identity.packageName}: ${JSON.stringify(initialized)}`);',
        '  if (initialized.status !== "success") process.exit(2);',
        "  const entryRecord = initialized.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(entry.identity));",
        "  assert.ok(entryRecord, `generation record missing ${entry.identity.packageName}`);",
        "  const entryContent = contentByIdentity.get(contentIdentityKey(entry.identity));",
        "  assert.ok(entryContent);",
        "  for (const dependency of entryContent.definition.dependencies ?? []) {",
        "    const dependencyIdentity = resolveReferenceDependencyIdentity({ consumerIdentity: entry.identity, dependency, members: templateContent });",
        "    const providerRecord = initialized.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(dependencyIdentity));",
        "    assert.ok(providerRecord, `binding provider missing ${dependencyIdentity.packageName}`);",
        "    assert.equal(entryRecord.dependencyBindings[dependency.key], providerRecord.packageDefinitionId, `invalid binding ${entry.identity.packageName} -> ${dependencyIdentity.packageName}`);",
        "  }",
        "  await access(targetRoot);",
        "  results.push({ identity: entry.identity, roots, generationRecord: initialized.generationRecord, packagePaths: initialized.blueprint.packages.map(({ path }) => path) });",
        "}",
        'const web = entries.find((entry) => entry.identity.packageName === "@ykdz/reference-vue-hono-web");',
        "assert.ok(web);",
        "const missingBindingTarget = `${targetBase}/missing-independent-provider`;",
        'const missingBinding = await createDefaultGenerator({ content: templateContent }).init({ targetRoot: missingBindingTarget, selection: { roots: [{ nodeIdentity: "entry", contentIdentity: web.identity }] }, conventions: { repositoryName: "missing-binding", defaultPackageScope: "missing-binding", todo: false } });',
        'assert.equal(missingBinding.status, "operation-failure");',
        'assert.equal(missingBinding.phase, "planning");',
        "assert.match(missingBinding.error.message, /缺少明确的独立依赖实例/u);",
        'await assert.rejects(access(missingBindingTarget), { code: "ENOENT" });',
        "const missingContentTarget = `${targetBase}/missing-content-provider`;",
        'const missingContent = templateContent.filter((member) => member.identity.packageName !== "@ykdz/reference-hono-api");',
        'const missingProvider = await createDefaultGenerator({ content: missingContent }).init({ targetRoot: missingContentTarget, selection: { roots: [{ nodeIdentity: "entry", contentIdentity: web.identity }] }, conventions: { repositoryName: "missing-content", defaultPackageScope: "missing-content", todo: false } });',
        'assert.equal(missingProvider.status, "operation-failure");',
        'assert.equal(missingProvider.phase, "planning");',
        'assert.ok(missingProvider.error.message.includes("必要模板依赖未登记") && missingProvider.error.message.includes("@ykdz/reference-hono-api"));',
        'await assert.rejects(access(missingContentTarget), { code: "ENOENT" });',
        "await writeFile(process.argv[5], JSON.stringify({ results, missingBinding: { status: missingBinding.status, phase: missingBinding.phase, error: missingBinding.error.message }, missingProvider: { status: missingProvider.status, phase: missingProvider.phase, error: missingProvider.error.message } }));",
      ].join("\n"),
    );
    await withUnreadableAuthorDirectories(
      [
        ...authorRoots.map((authorPath, index) => ({
          path: authorPath,
          mode: authorModes[index]!,
        })),
        { path: workspaceRoot, mode: workspaceMode },
      ],
      async () =>
        await execa(
          process.execPath,
          [driverPath, projectRoot, authorRootsPath, entriesPath, resultPath],
          {
            cwd: installedCollection,
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

    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      readonly results: readonly {
        readonly identity: {
          readonly packageName: string;
          readonly namespace: string;
          readonly exportPath: string;
        };
        readonly roots: readonly {
          readonly nodeIdentity: string;
          readonly contentIdentity: { readonly packageName: string };
        }[];
        readonly generationRecord: {
          readonly packages: readonly {
            readonly contentIdentity: { readonly packageName: string };
            readonly dependencyBindings: Readonly<Record<string, string>>;
          }[];
        };
        readonly packagePaths: readonly string[];
      }[];
      readonly missingBinding: {
        readonly status: string;
        readonly phase: string;
        readonly error: string;
      };
      readonly missingProvider: {
        readonly status: string;
        readonly phase: string;
        readonly error: string;
      };
    };
    assert.equal(result.results.length, entries.length);
    for (const { member } of entries) {
      assert.ok(
        result.results.some(
          ({ identity }) =>
            contentIdentityKey(identity) ===
            contentIdentityKey(member.identity),
        ),
        `未实际初始化 reference ${member.identity.packageName}`,
      );
    }
    const vueHonoResult = result.results.find(
      ({ identity }) => identity.packageName === "@ykdz/reference-vue-hono-web",
    );
    assert.ok(vueHonoResult);
    assert.ok(
      vueHonoResult.roots.some(
        ({ contentIdentity }) =>
          contentIdentity.packageName === "@ykdz/reference-hono-api",
      ),
      "Vue-Hono web init 必须把独立 Hono API 作为合法根实例绑定",
    );
    for (const packageName of [
      "@ykdz/reference-vike-web",
      "@ykdz/reference-vike-migrations",
    ]) {
      const vikeResult = result.results.find(
        ({ identity }) => identity.packageName === packageName,
      );
      assert.ok(vikeResult);
      assert.ok(
        vikeResult.roots.some(
          ({ contentIdentity }) =>
            contentIdentity.packageName === "@ykdz/reference-vike-db",
        ),
        `${packageName} init 必须把独立 Vike DB 作为合法根实例绑定`,
      );
    }
    assert.equal(result.missingBinding.status, "operation-failure");
    assert.equal(result.missingBinding.phase, "planning");
    assert.equal(result.missingProvider.status, "operation-failure");
    assert.equal(result.missingProvider.phase, "planning");
    const closure = await auditInstalledClosure(consumerRoot, [
      ...authorRoots,
      workspaceRoot,
    ]);
    const installedVueApp = closure.packages.find(
      ({ name }) => name === "@ykdz/reference-vue-app",
    );
    assert.ok(installedVueApp);
    const installedTypeScript = createRequire(
      path.join(installedVueApp.path, "package.json"),
    )("typescript-7") as { readonly version: string };
    assert.equal(installedTypeScript.version, nativeTypeScript.version);
    for (const archive of [
      ...prepared.sdkPackages,
      ...prepared.owners.map((owner) => owner.packed),
      ...prepared.providers,
      prepared.collection,
    ]) {
      assert.ok(
        closure.packages.some(({ name }) => name === archive.name),
        `全部参考集合安装闭包缺少制品：${archive.name}@${archive.version}`,
      );
    }
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(async (authorPath) => (await stat(authorPath)).mtimeMs),
      ),
      authorTimes,
    );
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(
          async (authorPath) => (await stat(authorPath)).mode & 0o777,
        ),
      ),
      authorModes,
    );
    const restoredWorkspace = await stat(workspaceRoot);
    assert.equal(restoredWorkspace.mode & 0o777, workspaceMode);
    assert.equal(restoredWorkspace.mtimeMs, workspaceTime);
    const evidenceRoot = await contentArtifactEvidenceRoot();
    await writeContentCollectionEvidence(
      prepared,
      path.join(evidenceRoot, "all-references-build.md"),
    );
    await writeFile(
      path.join(evidenceRoot, "all-references-consumer.json"),
      `${JSON.stringify(
        {
          command: `pnpm --dir ${consumerRoot} add ${prepared.collection.tarball}`,
          authorDirectories: [
            ...authorRoots.map((authorPath) => ({ path: authorPath, mode: 0 })),
            { path: workspaceRoot, mode: 0 },
          ],
          providers: closure.packages,
          links: closure.links,
          references: result.results,
          missingBinding: result.missingBinding,
          missingProvider: result.missingProvider,
        },
        null,
        2,
      )}\n`,
    );
  });

  void it("同一原创TypeScript工厂经原生安装后init、fresh add并隔离作者目录", async () => {
    assert.ok(firstPartyPrepared);
    const sdkVersions = new Map(
      firstPartyPrepared.sdkPackages.map(({ name, version }) => [
        name,
        version,
      ]),
    );
    const typescriptVersion =
      firstPartyPrepared.resolvedVersions.get("typescript-7");
    const nodeTypesVersion =
      firstPartyPrepared.resolvedVersions.get("@types/node");
    assert.ok(typescriptVersion);
    assert.ok(nodeTypesVersion);

    const namespace = "native-authored";
    const fixture = await createAuthoredContentFixture({
      namespace,
      marker: namespace,
      addonDependsOnTheme: true,
      nativeWorkspace: true,
      deferLoad: true,
      collectionPackageName: "@fixture/authored-content",
      sdkVersions,
      toolVersions: {
        typescript: typescriptVersion,
        nodeTypes: nodeTypesVersion,
      },
      featureNativeDevDependencies: { typescript: "6.0.3" },
      featureTemplatePrelude: [
        'import ts from "typescript";',
        "export const fixtureTypescriptVersion = ts.version;",
        'if (ts.version !== "6.0.3") throw new Error(`所属包解析出 TypeScript ${ts.version}`);',
      ],
      featureTemplateDependencies: [
        {
          name: "@ykdz/template-workspace",
          purpose: "template-execution",
        },
        { name: "typescript", purpose: "template-execution" },
      ],
    });
    authoredFixtures.push(fixture);
    const featureAuthorRoot = path.join(
      fixture.root,
      namespace,
      "authors",
      "feature",
    );
    const featureDefinitionPath = path.join(
      featureAuthorRoot,
      "template",
      "definition.ts",
    );
    const originalFeatureDefinition = await readFile(
      featureDefinitionPath,
      "utf8",
    );
    assert.ok(originalFeatureDefinition.includes('resources: ["src"],'));
    await mkdir(path.join(featureAuthorRoot, "lib"), { recursive: true });
    await rename(
      path.join(featureAuthorRoot, "src", "content.ts"),
      path.join(featureAuthorRoot, "lib", "content.ts"),
    );
    await rm(path.join(featureAuthorRoot, "src"), {
      recursive: true,
      force: true,
    });
    await writeFile(
      featureDefinitionPath,
      originalFeatureDefinition.replace(
        'resources: ["src"],',
        'resources: ["lib"],',
      ),
    );
    const content = await buildNativeAuthoredContent(
      fixture,
      namespace,
      firstPartyPrepared.sdkPackages,
    );
    const feature = content.find(
      (member) => member.identity.packageName === "@fixture/feature",
    );
    assert.ok(feature);
    assert.equal(feature.kind, "reference");
    const featureDefinition = feature.definition as {
      readonly source: (resourcePath: string) => TemplateSourceHandle;
      readonly prepareArtifact: () => {
        readonly resources: readonly {
          readonly path: string;
          readonly data: Uint8Array;
        }[];
      };
    };
    const featureSource = featureDefinition.source("lib/content.ts");
    const authoringSdkRoot = await realpath(
      path.join(
        fixture.root,
        namespace,
        "authors",
        "feature",
        "node_modules",
        "@ykdz",
        "template-workspace",
      ),
    );
    const workspaceCoreEntry = import.meta
      .resolve("@ykdz/template-core/renderer");
    const workspaceAuthoringEntry = import.meta
      .resolve("@ykdz/template-workspace/reference-package");
    const authoringRequire = createRequire(
      path.join(authoringSdkRoot, "dist", "reference-package.js"),
    );
    const archiveCoreEntry = pathToFileURL(
      authoringRequire.resolve("@ykdz/template-core/renderer"),
    ).href;
    const archiveAuthoringEntry = pathToFileURL(
      path.join(authoringSdkRoot, "dist", "reference-package.js"),
    ).href;
    assert.notEqual(archiveCoreEntry, workspaceCoreEntry);
    assert.notEqual(archiveAuthoringEntry, workspaceAuthoringEntry);
    let crossSdkHandleFailure: unknown;
    try {
      resolveTemplateSource(featureSource, ".");
    } catch (error) {
      crossSdkHandleFailure = error;
    }
    assert.ok(crossSdkHandleFailure instanceof Error);
    assert.match(
      crossSdkHandleFailure.message,
      /unknown Template Source handle/u,
    );
    const preparedFeature = featureDefinition.prepareArtifact();
    const preparedFeatureSource = preparedFeature.resources.find(
      ({ path: resourcePath }) => resourcePath === "lib/content.ts",
    );
    assert.ok(preparedFeatureSource);
    assert.equal(
      Buffer.from(preparedFeatureSource.data).toString("utf8"),
      'export const fixtureOrigin = "native-authored:feature";\n',
    );
    assert.equal(preparedFeatureSource.path, "lib/content.ts");
    const sdkBoundaryEvidence = {
      archiveCoreEntry,
      workspaceCoreEntry,
      archiveAuthoringEntry,
      workspaceAuthoringEntry,
      red: crossSdkHandleFailure.message,
      green: {
        owner: feature.identity,
        path: preparedFeatureSource.path,
        text: Buffer.from(preparedFeatureSource.data).toString("utf8"),
      },
    };
    const addon = content.find(
      (member) => member.identity.packageName === "@fixture/addon",
    );
    const preset = content.find(
      (member) => member.kind === "preset" && member.alias === "authored",
    );
    assert.ok(addon && preset);
    const collectionManifest = JSON.parse(
      await readFile(
        path.join(fixture.root, namespace, "collection", "package.json"),
        "utf8",
      ),
    ) as { readonly version: string };
    const buildRoot = await temporaryRoot("preset-authored-content-");
    const prepared = await prepareContentCollection({
      content: content as unknown as typeof templateContent,
      roots: [preset, addon] as unknown as typeof templateContent,

      workspaceRoot,
      packageName: "@fixture/authored-content",
      collectionVersion: collectionManifest.version,
      root: buildRoot,
      sdkArchives: firstPartyPrepared.sdkPackages,
    });
    preparedCollections.push(prepared);

    assert.deepEqual(
      prepared.members.map((member) => member.identity.packageName).sort(),
      [
        "@fixture/addon",
        "@fixture/feature",
        "@fixture/preset",
        "@fixture/tooling-config",
      ].sort(),
    );
    const featureOwner = prepared.owners.find(
      (owner) => owner.member.identity.packageName === "@fixture/feature",
    );
    assert.ok(featureOwner);
    const featureArchiveManifest = JSON.parse(
      await readFile(
        path.join(featureOwner.installRoot, "package.json"),
        "utf8",
      ),
    ) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    assert.equal(
      featureArchiveManifest.dependencies?.typescript,
      "6.0.3",
      "原创 owner 的普通原生依赖应使用该 owner 自己解析出的 TypeScript 坐标",
    );
    const presetOwner = prepared.owners.find(
      (owner) => owner.member.identity.packageName === "@fixture/preset",
    );
    assert.ok(presetOwner);
    assert.ok(
      presetOwner.artifact.dependencies.some(
        (dependency) =>
          dependency.name === "@ykdz/template-workspace-authoring" &&
          dependency.purposes.includes("template-execution"),
      ),
      "原创预设制品应声明其运行definition所需的authoring SDK",
    );
    for (const owner of prepared.owners) {
      assert.deepEqual(owner.packed.provider?.identity, owner.member.identity);
      assert.equal(owner.packed.version, "1.0.0");
      assert.ok(owner.packed.provider?.specifier.endsWith("/template"));
    }

    const fixtureRootMetadata = await stat(fixture.root);
    const fixtureRootMode = fixtureRootMetadata.mode & 0o777;
    const fixtureRootTime = fixtureRootMetadata.mtimeMs;
    const workspaceRootMetadata = await stat(workspaceRoot);
    const workspaceRootMode = workspaceRootMetadata.mode & 0o777;
    const workspaceRootTime = workspaceRootMetadata.mtimeMs;
    const authorRoots = ["feature", "tooling-config", "addon", "preset"].map(
      (name) => path.join(fixture.root, namespace, "authors", name),
    );
    const authorModes = await Promise.all(
      authorRoots.map(async (root) => (await stat(root)).mode & 0o777),
    );
    const authorTimes = await Promise.all(
      authorRoots.map(async (root) => (await stat(root)).mtimeMs),
    );
    const unreadableAuthorDirectories = [
      ...authorRoots.map((authorPath, index) => ({
        path: authorPath,
        mode: authorModes[index]!,
      })),
      { path: fixture.root, mode: fixtureRootMode },
      { path: workspaceRoot, mode: workspaceRootMode },
    ];

    const consumerRoot = await temporaryRoot("authored-content-consumer-");
    await installContentCollection(prepared, consumerRoot);
    const projectRoot = path.join(consumerRoot, "project");
    const targetRoot = path.join(projectRoot, "workspace");
    const temporaryDirectory = path.join(consumerRoot, "tmp");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    await chmod(projectRoot, 0o777);
    await chmod(temporaryDirectory, 0o777);
    const installedCollection = path.join(
      consumerRoot,
      "node_modules",
      "@fixture",
      "authored-content",
    );
    const resultPath = path.join(projectRoot, "result.json");
    const authorRootsPath = path.join(projectRoot, "author-roots.json");
    await writeFile(
      authorRootsPath,
      JSON.stringify([...authorRoots, fixture.root, workspaceRoot]),
    );
    const driverPath = path.join(installedCollection, "integration-driver.mjs");
    await writeFile(
      driverPath,
      [
        'import assert from "node:assert/strict";',
        'import { chmod, lstat, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";',
        'import { contentIdentityKey } from "@ykdz/template-core/content-identity";',
        'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
        "",
        'import { templateContent } from "@fixture/authored-content";',
        "",
        "const targetRoot = process.argv[2];",
        "const resultPath = process.argv[3];",
        "async function snapshotTree(root) {",
        '  const entries = [{ path: ".", state: `directory:${(await lstat(root, { bigint: true })).mode & 0o7777n}` }];',
        "  async function visit(directory) {",
        "    for (const entry of await readdir(directory, { withFileTypes: true })) {",
        "      const file = `${directory}/${entry.name}`;",
        "      const relative = file.slice(root.length + 1);",
        "      const metadata = await lstat(file, { bigint: true });",
        "      if (metadata.isSymbolicLink()) entries.push({ path: relative, state: `symbolic-link:${await readlink(file)}` });",
        "      else if (metadata.isDirectory()) { entries.push({ path: relative, state: `directory:${metadata.mode & 0o7777n}` }); await visit(file); }",
        '      else entries.push({ path: relative, state: `file:${metadata.mode & 0o7777n}:${(await readFile(file)).toString("base64")}` });',
        "    }",
        "  }",
        "  await visit(root);",
        "  return entries.sort((left, right) => left.path.localeCompare(right.path));",
        "}",
        'const authorRoots = JSON.parse(await readFile(process.argv[4], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        "for (const member of templateContent) {",
        "  assert.equal(member.source.moduleURL.includes(process.argv[5]), false);",
        "  assert.equal(member.source.manifestURL.includes(process.argv[5]), false);",
        "}",
        "const generator = createDefaultGenerator({ content: templateContent });",
        "const initialized = await generator.init({",
        "  targetRoot,",
        '  selection: { presets: [{ contentIdentity: { alias: "authored", namespace: "native-authored" } }] },',
        '  conventions: { repositoryName: "authored-library", defaultPackageScope: "authored" },',
        "});",
        'assert.equal(initialized.status, "success", JSON.stringify(initialized));',
        'if (initialized.status !== "success") process.exit(2);',
        'const featureIdentity = { namespace: "native-authored", packageName: "@fixture/feature", exportPath: "./template" };',
        'const themeIdentity = { namespace: "native-authored", packageName: "@fixture/tooling-config", exportPath: "./template" };',
        "const featureRecord = initialized.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(featureIdentity));",
        "const themeRecord = initialized.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(themeIdentity));",
        "assert.ok(featureRecord && themeRecord);",
        'assert.equal(featureRecord.dependencyBindings["tooling-config"], themeRecord.packageDefinitionId);',
        "const featureDefinition = initialized.blueprint.packages.find((definition) => definition.packageDefinitionId === featureRecord.packageDefinitionId);",
        "const themeDefinition = initialized.blueprint.packages.find((definition) => definition.packageDefinitionId === themeRecord.packageDefinitionId);",
        "assert.ok(featureDefinition && themeDefinition);",
        'assert.equal(await readFile(`${targetRoot}/${featureDefinition.path}/lib/content.ts`, "utf8"), \'export const fixtureOrigin = "native-authored:feature";\\n\');',
        'assert.equal(await readFile(`${targetRoot}/${themeDefinition.path}/src/theme.ts`, "utf8"), \'export const fixtureOrigin = "native-authored:theme";\\n\');',
        "const featureSourcePath = `${targetRoot}/${featureDefinition.path}/lib/content.ts`;",
        "const customizedFeatureSource = 'export const fixtureOrigin = \"native-authored:feature\";\\n// preserved user edit\\n';",
        "await writeFile(featureSourcePath, customizedFeatureSource, { mode: 0o640 });",
        "await chmod(featureSourcePath, 0o640);",
        "const generationPath = `${targetRoot}/.template/generation.json`;",
        'await writeFile(`${targetRoot}/user-owned.txt`, "keep this file\\n", { mode: 0o640 });',
        "await chmod(`${targetRoot}/user-owned.txt`, 0o640);",
        "const rootManifestPath = `${targetRoot}/package.json`;",
        'const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));',
        'rootManifest.scripts["user:retained"] = "node --version";',
        'rootManifest.userMetadata = { owner: "human", ticket: "18" };',
        "await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\\n`);",
        'const beforeWrongKind = await readFile(generationPath, "utf8");',
        "const beforeWrongKindTree = await snapshotTree(targetRoot);",
        "const presetIdentity = initialized.generationRecord.selections.find(({ presetIdentity }) => presetIdentity !== null)?.presetIdentity;",
        "assert.ok(presetIdentity);",
        "const wrongKind = await generator.add({ repositoryRoot: targetRoot, contentIdentity: presetIdentity });",
        'assert.equal(wrongKind.status, "operation-failure", JSON.stringify(wrongKind));',
        'assert.equal(await readFile(generationPath, "utf8"), beforeWrongKind);',
        "const afterWrongKindTree = await snapshotTree(targetRoot);",
        "assert.deepEqual(afterWrongKindTree, beforeWrongKindTree);",
        "const freshGenerator = createDefaultGenerator({ content: templateContent });",
        'const addition = await freshGenerator.add({ repositoryRoot: targetRoot, contentIdentity: { alias: "addon", namespace: "native-authored" }, creationInput: { leafName: "fresh-addon" } });',
        'assert.equal(addition.status, "success", JSON.stringify(addition));',
        'if (addition.status !== "success") process.exit(3);',
        'const addonDefinition = addition.blueprint.packages.find((definition) => definition.path === "packages/fresh-addon");',
        "assert.ok(addonDefinition);",
        'const generatedAddon = await readFile(`${targetRoot}/${addonDefinition.path}/src/addon.ts`, "utf8");',
        "assert.equal(generatedAddon, 'export const fixtureOrigin = \"native-authored:addon\";\\n');",
        'assert.equal(await readFile(`${targetRoot}/user-owned.txt`, "utf8"), "keep this file\\n");',
        "assert.equal((await stat(`${targetRoot}/user-owned.txt`)).mode & 0o777, 0o640);",
        'assert.equal(await readFile(featureSourcePath, "utf8"), customizedFeatureSource);',
        "assert.equal((await stat(featureSourcePath)).mode & 0o777, 0o640);",
        'assert.equal(JSON.parse(await readFile(rootManifestPath, "utf8")).scripts["user:retained"], "node --version");',
        'assert.deepEqual(JSON.parse(await readFile(rootManifestPath, "utf8")).userMetadata, { owner: "human", ticket: "18" });',
        "const afterFeatureRecord = addition.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(featureIdentity));",
        "const afterThemeRecords = addition.generationRecord.packages.filter((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(themeIdentity));",
        'const addonIdentity = { namespace: "native-authored", packageName: "@fixture/addon", exportPath: "./template" };',
        "const addonRecord = addition.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(addonIdentity));",
        "assert.ok(afterFeatureRecord && addonRecord);",
        "assert.equal(afterFeatureRecord.packageDefinitionId, featureRecord.packageDefinitionId);",
        "assert.equal(afterThemeRecords.length, 1);",
        "assert.equal(afterThemeRecords[0].packageDefinitionId, themeRecord.packageDefinitionId);",
        'assert.equal(addonRecord.dependencyBindings["tooling-config"], themeRecord.packageDefinitionId);',
        "for (const previous of initialized.generationRecord.selections) assert.deepEqual(addition.generationRecord.selections.find(({ selectionId }) => selectionId === previous.selectionId), previous);",
        "const secondFreshGenerator = createDefaultGenerator({ content: templateContent });",
        'const secondAddition = await secondFreshGenerator.add({ repositoryRoot: targetRoot, contentIdentity: { alias: "addon", namespace: "native-authored" }, creationInput: { leafName: "second-addon" } });',
        'assert.equal(secondAddition.status, "success", JSON.stringify(secondAddition));',
        'if (secondAddition.status !== "success") process.exit(4);',
        'const secondAddonDefinition = secondAddition.blueprint.packages.find((definition) => definition.path === "packages/second-addon");',
        "assert.ok(secondAddonDefinition);",
        'const secondGeneratedAddon = await readFile(`${targetRoot}/${secondAddonDefinition.path}/src/addon.ts`, "utf8");',
        "assert.equal(secondGeneratedAddon, 'export const fixtureOrigin = \"native-authored:addon\";\\n');",
        "const secondFeatureRecord = secondAddition.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(featureIdentity));",
        "const secondThemeRecords = secondAddition.generationRecord.packages.filter((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(themeIdentity));",
        "const secondAddonRecords = secondAddition.generationRecord.packages.filter((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(addonIdentity));",
        "const secondAddonRecord = secondAddonRecords.find((record) => record.packageDefinitionId !== addonRecord.packageDefinitionId);",
        "assert.ok(secondFeatureRecord && secondAddonRecord);",
        "assert.equal(secondFeatureRecord.packageDefinitionId, featureRecord.packageDefinitionId);",
        "assert.equal(secondThemeRecords.length, 1);",
        "assert.equal(secondThemeRecords[0].packageDefinitionId, themeRecord.packageDefinitionId);",
        'assert.equal(addonRecord.dependencyBindings["tooling-config"], themeRecord.packageDefinitionId);',
        'assert.equal(secondAddonRecord.dependencyBindings["tooling-config"], themeRecord.packageDefinitionId);',
        "for (const record of addition.generationRecord.packages) { const retained = secondAddition.generationRecord.packages.find((candidate) => candidate.packageDefinitionId === record.packageDefinitionId); assert.ok(retained); assert.deepEqual(retained.dependencyBindings, record.dependencyBindings); }",
        "for (const previous of addition.generationRecord.selections) assert.deepEqual(secondAddition.generationRecord.selections.find(({ selectionId }) => selectionId === previous.selectionId), previous);",
        'assert.equal(await readFile(`${targetRoot}/user-owned.txt`, "utf8"), "keep this file\\n");',
        "assert.equal((await stat(`${targetRoot}/user-owned.txt`)).mode & 0o777, 0o640);",
        'assert.equal(await readFile(featureSourcePath, "utf8"), customizedFeatureSource);',
        "assert.equal((await stat(featureSourcePath)).mode & 0o777, 0o640);",
        'assert.equal(JSON.parse(await readFile(rootManifestPath, "utf8")).scripts["user:retained"], "node --version");',
        'assert.deepEqual(JSON.parse(await readFile(rootManifestPath, "utf8")).userMetadata, { owner: "human", ticket: "18" });',
        'const validGenerationRecordText = await readFile(generationPath, "utf8");',
        "const invalidGenerationRecord = JSON.parse(validGenerationRecordText);",
        "const invalidFeatureRecord = invalidGenerationRecord.packages.find((record) => record.packageDefinitionId === featureRecord.packageDefinitionId);",
        "assert.ok(invalidFeatureRecord);",
        'invalidFeatureRecord.dependencyBindings["tooling-config"] = "missing-theme-instance";',
        "await writeFile(generationPath, `${JSON.stringify(invalidGenerationRecord, null, 2)}\\n`);",
        "const beforeInvalidBindingTree = await snapshotTree(targetRoot);",
        "const invalidBindingGenerator = createDefaultGenerator({ content: templateContent });",
        'const invalidBinding = await invalidBindingGenerator.add({ repositoryRoot: targetRoot, contentIdentity: { alias: "addon", namespace: "native-authored" }, creationInput: { leafName: "rejected-addon" } });',
        'assert.equal(invalidBinding.status, "operation-failure", JSON.stringify(invalidBinding));',
        'if (invalidBinding.status !== "operation-failure") process.exit(5);',
        'assert.equal(invalidBinding.phase, "metadata");',
        "assert.match(invalidBinding.error.message, /binding|绑定|实例/u);",
        "const afterInvalidBindingTree = await snapshotTree(targetRoot);",
        "assert.deepEqual(afterInvalidBindingTree, beforeInvalidBindingTree);",
        "await writeFile(generationPath, validGenerationRecordText);",
        'await writeFile(resultPath, JSON.stringify({ templateContent, initialized, addition, secondAddition, invalidBinding: { status: invalidBinding.status, phase: invalidBinding.phase, errorMessage: invalidBinding.error.message, before: beforeInvalidBindingTree, after: afterInvalidBindingTree }, generatedAddon, secondGeneratedAddon, beforeWrongKindTree, afterWrongKindTree, userCustomization: { text: await readFile(`${targetRoot}/user-owned.txt`, "utf8"), mode: (await stat(`${targetRoot}/user-owned.txt`)).mode & 0o777, featureSource: await readFile(featureSourcePath, "utf8"), featureMode: (await stat(featureSourcePath)).mode & 0o777, rootScript: JSON.parse(await readFile(rootManifestPath, "utf8")).scripts["user:retained"], rootMetadata: JSON.parse(await readFile(rootManifestPath, "utf8")).userMetadata } }));',
      ].join("\n"),
    );
    await withUnreadableAuthorDirectories(
      unreadableAuthorDirectories,
      async () =>
        await execa(
          process.execPath,
          [driverPath, targetRoot, resultPath, authorRootsPath, fixture.root],
          {
            cwd: installedCollection,
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

    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      readonly templateContent: readonly {
        readonly source: {
          readonly moduleURL: string;
          readonly manifestURL: string;
        };
      }[];
      readonly initialized: {
        readonly generationRecord: {
          readonly selections: readonly {
            readonly presetIdentity: { readonly packageName: string } | null;
          }[];
        };
      };
      readonly addition: { readonly status: string };
      readonly secondAddition: { readonly status: string };
      readonly invalidBinding: {
        readonly status: string;
        readonly phase: string;
        readonly errorMessage: string;
        readonly before: readonly {
          readonly path: string;
          readonly state: string;
        }[];
        readonly after: readonly {
          readonly path: string;
          readonly state: string;
        }[];
      };
      readonly generatedAddon: string;
      readonly secondGeneratedAddon: string;
      readonly userCustomization: {
        readonly text: string;
        readonly mode: number;
        readonly featureSource: string;
        readonly featureMode: number;
        readonly rootScript: string;
        readonly rootMetadata: {
          readonly owner: string;
          readonly ticket: string;
        };
      };
      readonly beforeWrongKindTree: readonly {
        readonly path: string;
        readonly state: string;
      }[];
      readonly afterWrongKindTree: readonly {
        readonly path: string;
        readonly state: string;
      }[];
    };
    assert.equal(result.templateContent.length, prepared.members.length);
    assert.ok(
      result.templateContent.every(
        ({ source }) =>
          source.moduleURL.startsWith("file:") &&
          source.manifestURL.startsWith("file:") &&
          !source.moduleURL.includes(fixture.root) &&
          !source.manifestURL.includes(fixture.root) &&
          !source.moduleURL.includes(workspaceRoot) &&
          !source.manifestURL.includes(workspaceRoot),
      ),
    );
    assert.deepEqual(
      result.initialized.generationRecord.selections.flatMap(
        ({ presetIdentity }) =>
          presetIdentity === null ? [] : [presetIdentity.packageName],
      ),
      ["@fixture/preset"],
    );
    assert.equal(result.addition.status, "success");
    assert.equal(result.secondAddition.status, "success");
    assert.equal(result.invalidBinding.status, "operation-failure");
    assert.equal(result.invalidBinding.phase, "metadata");
    assert.deepEqual(result.invalidBinding.after, result.invalidBinding.before);
    assert.match(result.generatedAddon, /native-authored:addon/u);
    assert.match(result.secondGeneratedAddon, /native-authored:addon/u);
    assert.deepEqual(result.userCustomization, {
      text: "keep this file\n",
      mode: 0o640,
      featureSource:
        'export const fixtureOrigin = "native-authored:feature";\n// preserved user edit\n',
      featureMode: 0o640,
      rootScript: "node --version",
      rootMetadata: { owner: "human", ticket: "18" },
    });
    assert.deepEqual(result.afterWrongKindTree, result.beforeWrongKindTree);
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(async (root) => (await stat(root)).mtimeMs),
      ),
      authorTimes,
    );
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(async (root) => (await stat(root)).mode & 0o777),
      ),
      authorModes,
    );
    const restoredFixtureRoot = await stat(fixture.root);
    assert.equal(restoredFixtureRoot.mtimeMs, fixtureRootTime);
    assert.equal(restoredFixtureRoot.mode & 0o777, fixtureRootMode);
    const restoredWorkspaceRoot = await stat(workspaceRoot);
    assert.equal(restoredWorkspaceRoot.mtimeMs, workspaceRootTime);
    assert.equal(restoredWorkspaceRoot.mode & 0o777, workspaceRootMode);

    const closure = await auditInstalledClosure(consumerRoot, [
      fixture.root,
      workspaceRoot,
      ...authorRoots,
    ]);
    const installed = closure.packages;
    const installedPreset = installed.find(
      ({ name }) => name === "@fixture/preset",
    );
    assert.ok(installedPreset);
    const installedFeature = installed.find(
      ({ name }) => name === "@fixture/feature",
    );
    assert.ok(installedFeature);
    const installedFeatureDefinition = await import(
      pathToFileURL(
        path.join(
          installedFeature.path,
          "native",
          "template-dist",
          "definition.js",
        ),
      ).href
    );
    assert.equal(installedFeatureDefinition.fixtureTypescriptVersion, "6.0.3");
    const presetManifest = JSON.parse(
      await readFile(path.join(installedPreset.path, "package.json"), "utf8"),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    assert.ok(
      Object.hasOwn(
        presetManifest.dependencies ?? {},
        "@ykdz/template-workspace-authoring",
      ),
    );
    for (const archive of [
      ...prepared.sdkPackages,
      ...prepared.owners.map((owner) => owner.packed),
      prepared.collection,
    ]) {
      assert.ok(
        installed.some(({ name }) => name === archive.name),
        `原生安装清单缺少制品：${archive.name}@${archive.version}`,
      );
    }
    const existingTargetBeforeFailure = await snapshotTree(targetRoot);
    const missingDependencyTarget = path.join(
      projectRoot,
      "missing-runtime-dependency",
    );
    const missingDependencyDriverPath = path.join(
      installedCollection,
      "missing-dependency-driver.mjs",
    );
    await writeFile(
      missingDependencyDriverPath,
      [
        'import assert from "node:assert/strict";',
        'import { readFile, readdir } from "node:fs/promises";',
        'const authorRoots = JSON.parse(await readFile(process.argv[2], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        'await import("@fixture/authored-content");',
        "",
      ].join("\n"),
    );
    const generatorPackagePaths = [
      ...new Set(
        await Promise.all(
          installed
            .filter(({ name }) => name === "@ykdz/template-generator")
            .map(async ({ path: packagePath }) => await realpath(packagePath)),
        ),
      ),
    ];
    assert.ok(generatorPackagePaths.length > 0);
    const hiddenGeneratorPackagePaths = generatorPackagePaths.map(
      (packagePath) => `${packagePath}.temporarily-missing`,
    );
    await Promise.all(
      generatorPackagePaths.map(
        async (packagePath, index) =>
          await rename(packagePath, hiddenGeneratorPackagePaths[index]!),
      ),
    );
    let missingDependencyResult;
    try {
      missingDependencyResult = await withUnreadableAuthorDirectories(
        unreadableAuthorDirectories,
        async () =>
          await execa(
            process.execPath,
            [missingDependencyDriverPath, authorRootsPath],
            {
              cwd: installedCollection,
              env: {
                ...process.env,
                HOME: consumerRoot,
                TMPDIR: temporaryDirectory,
                NODE_OPTIONS: "--no-global-search-paths",
                NODE_PATH: "",
              },
              ...unprivilegedProcessOptions,
              reject: false,
            },
          ),
      );
    } finally {
      await Promise.all(
        generatorPackagePaths.map(
          async (packagePath, index) =>
            await rename(hiddenGeneratorPackagePaths[index]!, packagePath),
        ),
      );
    }
    assert.ok(missingDependencyResult);
    assert.notEqual(missingDependencyResult.exitCode, 0);
    assert.match(missingDependencyResult.stderr, /ERR_MODULE_NOT_FOUND/u);
    assert.match(
      missingDependencyResult.stderr,
      /Cannot find package '@ykdz\/template-generator' imported from .*template-content-provider/su,
    );
    assert.deepEqual(
      await snapshotTree(targetRoot),
      existingTargetBeforeFailure,
    );
    await assert.rejects(stat(missingDependencyTarget), { code: "ENOENT" });

    const missingResourceResultPath = path.join(
      projectRoot,
      "missing-resource-result.json",
    );
    const missingResourceTarget = path.join(
      projectRoot,
      "missing-resource-workspace",
    );
    const missingResourceDriverPath = path.join(
      installedCollection,
      "missing-resource-driver.mjs",
    );
    await writeFile(
      missingResourceDriverPath,
      [
        'import assert from "node:assert/strict";',
        'import { readdir, readFile, writeFile } from "node:fs/promises";',
        'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
        "",
        'import { templateContent } from "@fixture/authored-content";',
        'const authorRoots = JSON.parse(await readFile(process.argv[5], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        "const generator = createDefaultGenerator({ content: templateContent });",
        'const existing = await generator.add({ repositoryRoot: process.argv[2], contentIdentity: { alias: "addon", namespace: "native-authored" }, creationInput: { leafName: "second-addon" } });',
        'const fresh = await generator.init({ targetRoot: process.argv[3], selection: { presets: [{ contentIdentity: { alias: "authored", namespace: "native-authored" } }] }, conventions: { repositoryName: "authored-library", defaultPackageScope: "authored" } });',
        "const summarize = (result) => ({ status: result.status, phase: result.phase, errorMessage: result.error?.message });",
        "await writeFile(process.argv[4], JSON.stringify({ existing: summarize(existing), fresh: summarize(fresh) }));",
        "",
      ].join("\n"),
    );
    const featurePackagePath = installed.find(
      ({ name }) => name === "@fixture/feature",
    )?.path;
    assert.ok(featurePackagePath);
    const featureResourceRoot = path.join(featurePackagePath, "native", "lib");
    const hiddenFeatureResourceRoot = path.join(
      featurePackagePath,
      "native",
      "temporarily-missing-src",
    );
    const existingTargetBeforeMissingResource = await snapshotTree(targetRoot);
    await rename(featureResourceRoot, hiddenFeatureResourceRoot);
    let missingResourceExecution;
    try {
      missingResourceExecution = await withUnreadableAuthorDirectories(
        unreadableAuthorDirectories,
        async () =>
          await execa(
            process.execPath,
            [
              missingResourceDriverPath,
              targetRoot,
              missingResourceTarget,
              missingResourceResultPath,
              authorRootsPath,
            ],
            {
              cwd: installedCollection,
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
    } finally {
      await rename(hiddenFeatureResourceRoot, featureResourceRoot);
    }
    assert.equal(missingResourceExecution.exitCode, 0);
    const missingResourceFailures = JSON.parse(
      await readFile(missingResourceResultPath, "utf8"),
    ) as {
      readonly existing: {
        readonly status: string;
        readonly phase: string;
        readonly errorMessage: string;
      };
      readonly fresh: {
        readonly status: string;
        readonly phase: string;
        readonly errorMessage: string;
      };
    };
    for (const failure of [
      missingResourceFailures.existing,
      missingResourceFailures.fresh,
    ]) {
      assert.equal(failure.status, "operation-failure");
      assert.equal(failure.phase, "planning");
      assert.match(
        failure.errorMessage,
        /@fixture\/feature.*prepare 阶段失败.*参考资源不存在：lib/u,
      );
    }
    assert.deepEqual(
      await snapshotTree(targetRoot),
      existingTargetBeforeMissingResource,
    );
    await assert.rejects(stat(missingResourceTarget), { code: "ENOENT" });

    const evidenceRoot = await contentArtifactEvidenceRoot();
    await writeContentCollectionEvidence(
      prepared,
      path.join(evidenceRoot, "authored-content-build.md"),
    );
    await writeFile(
      path.join(evidenceRoot, "authored-content-consumer.json"),
      `${JSON.stringify(
        {
          command: `pnpm --dir ${consumerRoot} add ${prepared.collection.tarball}`,
          authorDirectories: [
            ...authorRoots.map((authorPath) => ({
              path: authorPath,
              mode: 0,
              readableByConsumer: false,
            })),
            { path: fixture.root, mode: 0, readableByConsumer: false },
            { path: workspaceRoot, mode: 0, readableByConsumer: false },
          ],
          providers: closure.packages,
          links: closure.links,
          initialized: {
            selections: result.initialized.generationRecord.selections,
            generatedAddon: result.generatedAddon,
            freshAdd: result.addition.status,
            secondFreshAdd: result.secondAddition.status,
            secondGeneratedAddon: result.secondGeneratedAddon,
            userCustomization: result.userCustomization,
          },
          wrongKind: {
            before: result.beforeWrongKindTree,
            after: result.afterWrongKindTree,
          },
          invalidBinding: result.invalidBinding,
          missingDependency: {
            exitCode: missingDependencyResult.exitCode,
            stderr: missingDependencyResult.stderr,
            targetCreated: false,
          },
          missingResource: missingResourceFailures,
          ownerSdkBoundary: sdkBoundaryEvidence,
          existingTargetAfterMissingResource: await snapshotTree(targetRoot),
          missingResourceTargetCreated: false,
        },
        null,
        2,
      )}\n`,
    );
  });

  void it("原生安装按来源和真实版本消歧同名原创内容", async () => {
    assert.ok(firstPartyPrepared);
    const typescriptVersion =
      firstPartyPrepared.resolvedVersions.get("typescript-7");
    const nodeTypesVersion =
      firstPartyPrepared.resolvedVersions.get("@types/node");
    assert.ok(typescriptVersion && nodeTypesVersion);
    const fixtures = [
      {
        namespace: "native-alpha",
        version: "1.0.0",
        marker: "native-alpha",
      },
      {
        namespace: "native-beta",
        version: "2.0.0",
        marker: "native-beta",
      },
    ];
    const authored = [];
    for (const source of fixtures) {
      const fixture = await createAuthoredContentFixture({
        namespace: source.namespace,
        marker: source.marker,
        contentVersion: source.version,
        featureDependsOnTheme: false,
        nativeWorkspace: true,
        deferLoad: true,
        sdkVersions: new Map(
          firstPartyPrepared.sdkPackages.map(({ name, version }) => [
            name,
            version,
          ]),
        ),
        toolVersions: {
          typescript: typescriptVersion,
          nodeTypes: nodeTypesVersion,
        },
      });
      authoredFixtures.push(fixture);
      authored.push({
        ...source,
        fixture,
        members: await buildNativeAuthoredContent(
          fixture,
          source.namespace,
          firstPartyPrepared.sdkPackages,
        ),
      });
    }
    const members = authored.flatMap(({ members: sourceMembers }) => [
      ...sourceMembers,
    ]);
    const features = authored.map(({ namespace, members: sourceMembers }) => {
      const feature = sourceMembers.find(
        (member) => member.identity.packageName === "@fixture/feature",
      );
      assert.ok(feature);
      assert.equal(feature.kind, "reference");
      assert.equal(feature.identity.namespace, namespace);
      return feature;
    });
    const prepared = await prepareContentCollection({
      content: members as unknown as typeof templateContent,
      roots: features as unknown as typeof templateContent,

      workspaceRoot,
      packageName: "@fixture/multi-source-content",
      collectionVersion: "1.0.0",
      root: await temporaryRoot("multi-source-content-"),
      sdkArchives: firstPartyPrepared.sdkPackages,
    });
    preparedCollections.push(prepared);
    assert.equal(prepared.members.length, 2);
    assert.deepEqual(
      prepared.owners
        .map(({ artifact }) => artifact.coordinate)
        .sort((a, b) => a.version.localeCompare(b.version)),
      [
        { name: "@fixture/feature", version: "1.0.0" },
        { name: "@fixture/feature", version: "2.0.0" },
      ],
    );
    assert.equal(
      [...prepared.archives.values()].filter(
        ({ name }) => name === "@fixture/feature",
      ).length,
      2,
    );

    const consumerRoot = await temporaryRoot("multi-source-consumer-");
    await installContentCollection(prepared, consumerRoot);
    const projectRoot = path.join(consumerRoot, "project");
    const targetBase = path.join(projectRoot, "generated");
    const temporaryDirectory = path.join(consumerRoot, "tmp");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    await chmod(projectRoot, 0o777);
    await chmod(temporaryDirectory, 0o777);
    const installedCollection = path.join(
      consumerRoot,
      "node_modules",
      "@fixture",
      "multi-source-content",
    );
    const driverPath = path.join(
      installedCollection,
      "multi-source-driver.mjs",
    );
    const sourcePath = path.join(projectRoot, "sources.json");
    const authorRootsPath = path.join(projectRoot, "author-roots.json");
    const resultPath = path.join(projectRoot, "result.json");
    const targetRoot = path.join(targetBase, "selected-sources");
    const authorRoots = [
      workspaceRoot,
      ...authored.flatMap(({ fixture, namespace }) => [
        fixture.root,
        path.join(fixture.root, namespace, "authors"),
        ...["feature", "tooling-config", "addon", "preset"].map((owner) =>
          path.join(fixture.root, namespace, "authors", owner),
        ),
      ]),
    ];
    const authorDirectoryStates = await Promise.all(
      authorRoots.map(async (directory) => ({
        path: directory,
        mode: (await stat(directory)).mode & 0o777,
        mtimeMs: (await stat(directory)).mtimeMs,
      })),
    );
    await writeFile(
      sourcePath,
      JSON.stringify({
        targetRoot,
        identities: features.map(({ identity }) => identity),
        versions: fixtures.map(({ version }) => version),
        markers: fixtures.map(({ marker }) => `${marker}:feature`),
      }),
    );
    await writeFile(authorRootsPath, JSON.stringify(authorRoots));
    await writeFile(
      driverPath,
      [
        'import assert from "node:assert/strict";',
        'import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";',
        'import { contentIdentityKey } from "@ykdz/template-core/content-identity";',
        'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
        "",
        'import { templateContent } from "@fixture/multi-source-content";',
        'const { targetRoot, identities, versions, markers } = JSON.parse(await readFile(process.argv[2], "utf8"));',
        'const authorRoots = JSON.parse(await readFile(process.argv[3], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        "const generator = createDefaultGenerator({ content: templateContent });",
        "const ambiguousTarget = `${targetRoot}/ambiguous`;",
        'const ambiguous = await generator.init({ targetRoot: ambiguousTarget, selection: { roots: [{ nodeIdentity: "ambiguous", contentIdentity: { alias: "feature" } }] }, conventions: { repositoryName: "ambiguous", defaultPackageScope: "ambiguous", todo: false } });',
        'assert.equal(ambiguous.status, "operation-failure");',
        'assert.equal(ambiguous.phase, "planning");',
        "assert.match(ambiguous.error.message, /内容别名存在歧义：feature/u);",
        'await assert.rejects(readdir(ambiguousTarget), { code: "ENOENT" });',
        "await mkdir(targetRoot, { recursive: true });",
        'const initialized = await generator.init({ targetRoot, selection: { roots: identities.map((contentIdentity, index) => ({ nodeIdentity: `source-${index}`, contentIdentity, creationInput: { leafName: `source-${index}` } })) }, conventions: { repositoryName: "multi-source", defaultPackageScope: "multi-source", todo: false } });',
        'assert.equal(initialized.status, "success", JSON.stringify(initialized));',
        'if (initialized.status !== "success") process.exit(2);',
        "const results = identities.map((identity, index) => {",
        "  const record = initialized.generationRecord.packages.find((item) => contentIdentityKey(item.contentIdentity) === contentIdentityKey(identity));",
        "  assert.ok(record);",
        "  const definition = initialized.blueprint.packages.find((item) => item.packageDefinitionId === record.packageDefinitionId);",
        "  assert.ok(definition);",
        "  return { identity, packageDefinitionId: record.packageDefinitionId, path: definition.path, body: markers[index], version: versions[index] };",
        "});",
        "assert.notEqual(results[0].packageDefinitionId, results[1].packageDefinitionId);",
        "assert.notEqual(results[0].path, results[1].path);",
        'for (const result of results) assert.equal(await readFile(`${targetRoot}/${result.path}/src/content.ts`, "utf8"), `export const fixtureOrigin = ${JSON.stringify(result.body)};\\n`);',
        "await writeFile(process.argv[4], JSON.stringify({ ambiguous: { status: ambiguous.status, phase: ambiguous.phase, error: ambiguous.error.message }, results }));",
      ].join("\n"),
    );
    await withUnreadableAuthorDirectories(
      authorDirectoryStates,
      async () =>
        await execa(
          process.execPath,
          [driverPath, sourcePath, authorRootsPath, resultPath],
          {
            cwd: installedCollection,
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
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      readonly ambiguous: {
        readonly status: string;
        readonly phase: string;
        readonly error: string;
      };
      readonly results: readonly {
        readonly identity: { readonly namespace: string };
        readonly packageDefinitionId: string;
        readonly path: string;
        readonly body: string;
        readonly version: string;
      }[];
    };
    assert.equal(result.ambiguous.status, "operation-failure");
    assert.equal(result.results.length, 2);
    assert.deepEqual(
      result.results.map(({ identity, version }) => ({
        namespace: identity.namespace,
        version,
      })),
      fixtures.map(({ namespace, version }) => ({ namespace, version })),
    );
    const closure = await auditInstalledClosure(consumerRoot, [
      workspaceRoot,
      ...authored.flatMap(({ fixture }) => [fixture.root]),
    ]);
    const installedFeatures = closure.packages.filter(
      ({ name }) => name === "@fixture/feature",
    );
    const distinctFeaturePaths = [
      ...new Set(installedFeatures.map(({ path }) => path)),
    ];
    const installedVersions = await Promise.all(
      distinctFeaturePaths.map(async (packagePath) => {
        const manifest = JSON.parse(
          await readFile(path.join(packagePath, "package.json"), "utf8"),
        ) as { readonly version: string };
        return manifest.version;
      }),
    );
    assert.deepEqual(installedVersions.sort(), ["1.0.0", "2.0.0"]);
    const installedProviders = [
      ...new Map(
        closure.packages
          .filter(({ name }) =>
            name.startsWith("@ykdz/template-content-provider-"),
          )
          .map((provider) => [provider.path, provider]),
      ).values(),
    ];
    assert.equal(installedProviders.length, 2);
    const providerVersions = await Promise.all(
      installedProviders.map(async ({ path: providerPath }) => {
        const manifest = JSON.parse(
          await readFile(path.join(providerPath, "package.json"), "utf8"),
        ) as {
          readonly dependencies?: Readonly<Record<string, string>>;
        };
        return manifest.dependencies?.["@fixture/feature"];
      }),
    );
    assert.deepEqual(
      providerVersions.sort((left, right) =>
        (left ?? "").localeCompare(right ?? ""),
      ),
      ["1.0.0", "2.0.0"],
    );
    assert.ok(closure.links.length > 0);
    for (const directory of authorDirectoryStates) {
      const restored = await stat(directory.path);
      assert.equal(restored.mode & 0o777, directory.mode);
      assert.equal(restored.mtimeMs, directory.mtimeMs);
    }
    const evidenceRoot = await contentArtifactEvidenceRoot();
    await writeContentCollectionEvidence(
      prepared,
      path.join(evidenceRoot, "multi-source-build.md"),
    );
    await writeFile(
      path.join(evidenceRoot, "multi-source-consumer.json"),
      `${JSON.stringify(
        {
          command: `pnpm --dir ${consumerRoot} add ${prepared.collection.tarball}`,
          owners: prepared.owners.map(({ member, artifact, packed }) => ({
            identity: member.identity,
            coordinate: artifact.coordinate,
            sha256: packed.sha256,
          })),
          providerDependencies: providerVersions,
          results: result.results,
          ambiguous: result.ambiguous,
          packages: closure.packages,
          links: closure.links,
          authorDirectories: authorDirectoryStates.map(({ path }) => ({
            path,
            mode: 0,
          })),
        },
        null,
        2,
      )}\n`,
    );
  });
});
