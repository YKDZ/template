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
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { execa } from "execa";

import {
  installContentCollection,
  prepareContentCollection,
  writeContentCollectionEvidence,
  writeNativeArchiveOverrides,
  type PreparedContentCollection,
} from "../scripts/build-content-artifacts.ts";
import { createAuthoredContentFixture } from "../test-support/authored-content-fixture.ts";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const preparedCollections: PreparedContentCollection[] = [];
const protectedAuthorDirectories: {
  readonly path: string;
  readonly mode: number;
}[] = [];
const authoredFixtures: Awaited<
  ReturnType<typeof createAuthoredContentFixture>
>[] = [];
let firstPartyPrepared: PreparedContentCollection | undefined;

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
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
}[] {
  const packages: { name: string; path: string }[] = [];
  const visit = (entry: unknown, fallbackName?: string): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, fallbackName);
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    const node = entry as InstalledPackage;
    const name = node.name ?? fallbackName;
    if (name !== undefined && node.path !== undefined) {
      packages.push({ name, path: node.path });
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      for (const [childName, child] of Object.entries(node[field] ?? {})) {
        visit(child, childName);
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
    const packagePath = await realpath(installedPackage.path);
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
  await Promise.all(
    protectedAuthorDirectories.map(
      async ({ path: authorPath, mode }) => await chmod(authorPath, mode),
    ),
  );
  await Promise.all([
    ...preparedCollections.map((prepared) => prepared.cleanup()),
    ...authoredFixtures.map((fixture) => fixture.close()),
    ...temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

void describe("原生内容制品安装链", () => {
  void it("安装TS库最小集合后由普通Node init并读取原生配置绑定", async () => {
    const buildRoot = await temporaryRoot("preset-content-");
    const prepared = await prepareContentCollection({
      content: templateContent,
      presetAlias: "ts-lib",
      strategy: createDefaultWorkspaceStrategy(),
      workspaceRoot,
      root: buildRoot,
    });
    preparedCollections.push(prepared);
    firstPartyPrepared = prepared;

    assert.deepEqual(
      prepared.members.map((member) => member.identity.packageName).sort(),
      [
        "@ykdz/preset-ts-lib",
        "@ykdz/reference-ts-lib",
        "@ykdz/reference-typescript-config",
      ].sort(),
    );

    const authorRoots = prepared.owners.map((owner) => owner.packageRoot);
    for (const authorRoot of authorRoots) {
      protectedAuthorDirectories.push({
        path: authorRoot,
        mode: (await stat(authorRoot)).mode & 0o777,
      });
    }
    const authorTimes = await Promise.all(
      authorRoots.map(async (authorRoot) => (await stat(authorRoot)).mtimeMs),
    );
    await Promise.all(
      authorRoots.map(async (authorRoot) => await chmod(authorRoot, 0)),
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
    await writeFile(authorRootsPath, JSON.stringify(authorRoots));
    const driverPath = path.join(installedPackage, "integration-driver.mjs");
    await writeFile(
      driverPath,
      [
        'import assert from "node:assert/strict";',
        'import { readdir, readFile, writeFile } from "node:fs/promises";',
        'import { contentIdentityKey } from "@ykdz/template-core/content-identity";',
        'import { createGenerator } from "@ykdz/template-generator";',
        'import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";',
        'import { templateContent } from "@ykdz/template-content";',
        "",
        "const targetRoot = process.argv[2];",
        "const resultPath = process.argv[3];",
        'const authorRoots = JSON.parse(await readFile(process.argv[4], "utf8"));',
        'for (const root of authorRoots) await assert.rejects(readdir(root), { code: "EACCES" });',
        "const generator = createGenerator({",
        "  content: templateContent,",
        "  strategy: createDefaultWorkspaceStrategy(),",
        "});",
        "const initialized = await generator.init({",
        "  targetRoot,",
        '  selection: { roots: [{ preset: { alias: "ts-lib", namespace: "ykdz" } }] },',
        '  strategyInput: { repositoryName: "packed-library", defaultPackageScope: "packed-library" },',
        "});",
        'assert.equal(initialized.status, "success", JSON.stringify(initialized));',
        'if (initialized.status !== "success") process.exit(2);',
        'const library = templateContent.find((member) => member.kind === "reference" && member.identity.packageName === "@ykdz/reference-ts-lib");',
        'const configuration = templateContent.find((member) => member.kind === "reference" && member.identity.packageName === "@ykdz/reference-typescript-config");',
        'const libraryRecord = initialized.generationRecord.packages.find((record) => record.contentIdentity.packageName === "@ykdz/reference-ts-lib");',
        'const configurationRecord = initialized.generationRecord.packages.find((record) => record.contentIdentity.packageName === "@ykdz/reference-typescript-config");',
        "assert.ok(library && configuration && libraryRecord && configurationRecord);",
        "assert.equal(library.source.moduleURL.includes(process.argv[5]), false);",
        "assert.equal(library.source.manifestURL.includes(process.argv[5]), false);",
        "assert.equal(configuration.source.moduleURL.includes(process.argv[5]), false);",
        "assert.equal(configuration.source.manifestURL.includes(process.argv[5]), false);",
        "assert.equal(libraryRecord.bindings[contentIdentityKey(configuration.identity)], configurationRecord.packageDefinitionId);",
        "const libraryDefinition = initialized.blueprint.packages.find((definition) => definition.packageDefinitionId === libraryRecord.packageDefinitionId);",
        "assert.ok(libraryDefinition);",
        'const generated = await readFile(`${targetRoot}/${libraryDefinition.path}/src/index.ts`, "utf8");',
        "await writeFile(resultPath, JSON.stringify({ generationRecord: initialized.generationRecord, blueprint: initialized.blueprint, generated }));",
      ].join("\n"),
    );

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
        uid: 65534,
        gid: 65534,
      },
    );

    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      readonly generationRecord: {
        readonly presetSelections: readonly { readonly packageName: string }[];
      };
      readonly blueprint: {
        readonly packages: readonly {
          readonly name: string;
          readonly path: string;
        }[];
      };
      readonly generated: string;
    };
    assert.deepEqual(
      result.generationRecord.presetSelections.map(
        ({ packageName }) => packageName,
      ),
      ["@ykdz/preset-ts-lib"],
    );
    assert.ok(
      result.blueprint.packages.some(
        (definition) => definition.path === "packages/typescript-config",
      ),
    );
    assert.match(result.generated, /export function/u);
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(async (authorRoot) => (await stat(authorRoot)).mtimeMs),
      ),
      authorTimes,
    );
    assert.ok(
      (
        await Promise.all(
          authorRoots.map(
            async (authorRoot) => (await stat(authorRoot)).mode & 0o777,
          ),
        )
      ).every((mode) => mode === 0),
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
    const evidenceRoot = path.join(tmpdir(), "preset-migration-17-evidence");
    await mkdir(evidenceRoot, { recursive: true });
    await writeContentCollectionEvidence(
      prepared,
      path.join(evidenceRoot, "typescript-library-build.md"),
    );
    await writeFile(
      path.join(evidenceRoot, "typescript-library-consumer.json"),
      `${JSON.stringify(
        {
          command: `pnpm --dir ${consumerRoot} add ${prepared.collection.tarball}`,
          authorDirectories: authorRoots.map((authorPath) => ({
            path: authorPath,
            mode: 0,
            readableByConsumer: false,
          })),
          providers: closure.packages,
          links: closure.links,
          initialized: {
            presetSelections: result.generationRecord.presetSelections,
            packagePaths: result.blueprint.packages.map(
              ({ path: packagePath }) => packagePath,
            ),
            generated: result.generated,
          },
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
      nativeWorkspace: true,
      deferLoad: true,
      collectionPackageName: "@fixture/authored-content",
      sdkVersions,
      toolVersions: {
        typescript: typescriptVersion,
        nodeTypes: nodeTypesVersion,
      },
    });
    authoredFixtures.push(fixture);
    await writeNativeArchiveOverrides(
      fixture.root,
      firstPartyPrepared.sdkPackages,
      [`${namespace}/authors/*`, `${namespace}/collection`],
    );
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
        "@fixture/addon",
        "--if-present",
        "run",
        "build:template",
      ],
      { cwd: workspaceRoot },
    );

    const content = await fixture.load(namespace);
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
    const featureSource = featureDefinition.source("src/content.ts");
    const authoringSdkRoot = await realpath(
      path.join(
        fixture.root,
        namespace,
        "authors",
        "feature",
        "node_modules",
        "@ykdz",
        "template-workspace-authoring",
      ),
    );
    const workspaceCoreEntry = import.meta
      .resolve("@ykdz/template-core/renderer");
    const workspaceAuthoringEntry = import.meta
      .resolve("@ykdz/template-workspace-authoring/reference-package");
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
      ({ path: resourcePath }) => resourcePath === "src/content.ts",
    );
    assert.ok(preparedFeatureSource);
    assert.equal(
      Buffer.from(preparedFeatureSource.data).toString("utf8"),
      'export const fixtureOrigin = "native-authored:feature";\n',
    );
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
    assert.ok(addon);
    const collectionManifest = JSON.parse(
      await readFile(
        path.join(fixture.root, namespace, "collection", "package.json"),
        "utf8",
      ),
    ) as { readonly version: string };
    const buildRoot = await temporaryRoot("preset-authored-content-");
    const prepared = await prepareContentCollection({
      content: content as unknown as typeof templateContent,
      additionalMembers: [addon] as unknown as typeof templateContent,
      presetAlias: "authored",
      strategy: createDefaultWorkspaceStrategy(),
      workspaceRoot,
      namespace,
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
        "@fixture/typescript-config",
      ].sort(),
    );
    for (const owner of prepared.owners) {
      assert.deepEqual(owner.packed.provider?.identity, owner.member.identity);
      assert.equal(owner.packed.version, "1.0.0");
      assert.ok(owner.packed.provider?.specifier.endsWith("/template"));
    }

    const authorRoots = ["feature", "typescript-config", "addon", "preset"].map(
      (name) => path.join(fixture.root, namespace, "authors", name),
    );
    const authorTimes = await Promise.all(
      authorRoots.map(async (root) => (await stat(root)).mtimeMs),
    );
    await Promise.all(authorRoots.map(async (root) => await chmod(root, 0)));

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
    await writeFile(authorRootsPath, JSON.stringify(authorRoots));
    const driverPath = path.join(installedCollection, "integration-driver.mjs");
    await writeFile(
      driverPath,
      [
        'import assert from "node:assert/strict";',
        'import { lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";',
        'import { contentIdentityKey } from "@ykdz/template-core/content-identity";',
        'import { createGenerator } from "@ykdz/template-generator";',
        'import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";',
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
        "const generator = createGenerator({ content: templateContent, strategy: createDefaultWorkspaceStrategy() });",
        "const initialized = await generator.init({",
        "  targetRoot,",
        '  selection: { roots: [{ preset: { alias: "authored", namespace: "native-authored" } }] },',
        '  strategyInput: { repositoryName: "authored-library", defaultPackageScope: "authored" },',
        "});",
        'assert.equal(initialized.status, "success", JSON.stringify(initialized));',
        'if (initialized.status !== "success") process.exit(2);',
        'const featureIdentity = { namespace: "native-authored", packageName: "@fixture/feature", exportPath: "./template" };',
        'const themeIdentity = { namespace: "native-authored", packageName: "@fixture/typescript-config", exportPath: "./template" };',
        "const featureRecord = initialized.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(featureIdentity));",
        "const themeRecord = initialized.generationRecord.packages.find((record) => contentIdentityKey(record.contentIdentity) === contentIdentityKey(themeIdentity));",
        "assert.ok(featureRecord && themeRecord);",
        "assert.equal(featureRecord.bindings[contentIdentityKey(themeIdentity)], themeRecord.packageDefinitionId);",
        "const featureDefinition = initialized.blueprint.packages.find((definition) => definition.packageDefinitionId === featureRecord.packageDefinitionId);",
        "const themeDefinition = initialized.blueprint.packages.find((definition) => definition.packageDefinitionId === themeRecord.packageDefinitionId);",
        "assert.ok(featureDefinition && themeDefinition);",
        'assert.equal(await readFile(`${targetRoot}/${featureDefinition.path}/src/content.ts`, "utf8"), \'export const fixtureOrigin = "native-authored:feature";\\n\');',
        'assert.equal(await readFile(`${targetRoot}/${themeDefinition.path}/src/theme.ts`, "utf8"), \'export const fixtureOrigin = "native-authored:theme";\\n\');',
        "const generationPath = `${targetRoot}/.template/generation.json`;",
        'await writeFile(`${targetRoot}/user-owned.txt`, "keep this file\\n", { mode: 0o640 });',
        'const beforeWrongKind = await readFile(generationPath, "utf8");',
        "const beforeWrongKindTree = await snapshotTree(targetRoot);",
        "const presetIdentity = initialized.generationRecord.presetSelections[0];",
        "const wrongKind = await generator.add({ repositoryRoot: targetRoot, contentIdentity: presetIdentity });",
        'assert.equal(wrongKind.status, "operation-failure", JSON.stringify(wrongKind));',
        'assert.equal(await readFile(generationPath, "utf8"), beforeWrongKind);',
        "const afterWrongKindTree = await snapshotTree(targetRoot);",
        "assert.deepEqual(afterWrongKindTree, beforeWrongKindTree);",
        'const addition = await generator.add({ repositoryRoot: targetRoot, contentIdentity: { alias: "addon", namespace: "native-authored" }, creationInput: { leafName: "fresh-addon" } });',
        'assert.equal(addition.status, "success", JSON.stringify(addition));',
        'if (addition.status !== "success") process.exit(3);',
        'const addonDefinition = addition.blueprint.packages.find((definition) => definition.path === "packages/fresh-addon");',
        "assert.ok(addonDefinition);",
        'const generatedAddon = await readFile(`${targetRoot}/${addonDefinition.path}/src/addon.ts`, "utf8");',
        "assert.equal(generatedAddon, 'export const fixtureOrigin = \"native-authored:addon\";\\n');",
        "await writeFile(resultPath, JSON.stringify({ templateContent, initialized, addition, generatedAddon, beforeWrongKindTree, afterWrongKindTree }));",
      ].join("\n"),
    );
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
        uid: 65534,
        gid: 65534,
      },
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
          readonly presetSelections: readonly {
            readonly packageName: string;
          }[];
        };
      };
      readonly addition: { readonly status: string };
      readonly generatedAddon: string;
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
      result.initialized.generationRecord.presetSelections.map(
        ({ packageName }) => packageName,
      ),
      ["@fixture/preset"],
    );
    assert.equal(result.addition.status, "success");
    assert.match(result.generatedAddon, /native-authored:addon/u);
    assert.deepEqual(result.afterWrongKindTree, result.beforeWrongKindTree);
    assert.deepEqual(
      await Promise.all(
        authorRoots.map(async (root) => (await stat(root)).mtimeMs),
      ),
      authorTimes,
    );

    const closure = await auditInstalledClosure(consumerRoot, [
      fixture.root,
      workspaceRoot,
      ...authorRoots,
    ]);
    const installed = closure.packages;
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
      'await import("@fixture/authored-content");\n',
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
      missingDependencyResult = await execa(
        process.execPath,
        [missingDependencyDriverPath],
        {
          cwd: installedCollection,
          env: {
            ...process.env,
            HOME: consumerRoot,
            TMPDIR: temporaryDirectory,
            NODE_OPTIONS: "--no-global-search-paths",
            NODE_PATH: "",
          },
          uid: 65534,
          gid: 65534,
          reject: false,
        },
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
      /Cannot find package '@ykdz\/template-generator'.*@fixture\+authored-content/u,
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
        'import { writeFile } from "node:fs/promises";',
        'import { createGenerator } from "@ykdz/template-generator";',
        'import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";',
        'import { templateContent } from "@fixture/authored-content";',
        "const generator = createGenerator({ content: templateContent, strategy: createDefaultWorkspaceStrategy() });",
        'const existing = await generator.add({ repositoryRoot: process.argv[2], contentIdentity: { alias: "addon", namespace: "native-authored" }, creationInput: { leafName: "second-addon" } });',
        'const fresh = await generator.init({ targetRoot: process.argv[3], selection: { roots: [{ preset: { alias: "authored", namespace: "native-authored" } }] }, strategyInput: { repositoryName: "authored-library", defaultPackageScope: "authored" } });',
        "const summarize = (result) => ({ status: result.status, phase: result.phase, errorMessage: result.error?.message });",
        "await writeFile(process.argv[4], JSON.stringify({ existing: summarize(existing), fresh: summarize(fresh) }));",
        "",
      ].join("\n"),
    );
    const featurePackagePath = installed.find(
      ({ name }) => name === "@fixture/feature",
    )?.path;
    assert.ok(featurePackagePath);
    const featureResourceRoot = path.join(featurePackagePath, "native", "src");
    const hiddenFeatureResourceRoot = path.join(
      featurePackagePath,
      "native",
      "temporarily-missing-src",
    );
    const existingTargetBeforeMissingResource = await snapshotTree(targetRoot);
    await rename(featureResourceRoot, hiddenFeatureResourceRoot);
    let missingResourceExecution;
    try {
      missingResourceExecution = await execa(
        process.execPath,
        [
          missingResourceDriverPath,
          targetRoot,
          missingResourceTarget,
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
          uid: 65534,
          gid: 65534,
        },
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
        /@fixture\/feature.*prepare 阶段失败.*参考资源不存在：src/u,
      );
    }
    assert.deepEqual(
      await snapshotTree(targetRoot),
      existingTargetBeforeMissingResource,
    );
    await assert.rejects(stat(missingResourceTarget), { code: "ENOENT" });

    const evidenceRoot = path.join(tmpdir(), "preset-migration-17-evidence");
    await mkdir(evidenceRoot, { recursive: true });
    await writeContentCollectionEvidence(
      prepared,
      path.join(evidenceRoot, "authored-content-build.md"),
    );
    await writeFile(
      path.join(evidenceRoot, "authored-content-consumer.json"),
      `${JSON.stringify(
        {
          command: `pnpm --dir ${consumerRoot} add ${prepared.collection.tarball}`,
          authorDirectories: authorRoots.map((authorPath) => ({
            path: authorPath,
            mode: 0,
            readableByConsumer: false,
          })),
          providers: closure.packages,
          links: closure.links,
          initialized: {
            presetSelections:
              result.initialized.generationRecord.presetSelections,
            generatedAddon: result.generatedAddon,
            freshAdd: result.addition.status,
          },
          wrongKind: {
            before: result.beforeWrongKindTree,
            after: result.afterWrongKindTree,
          },
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
});
