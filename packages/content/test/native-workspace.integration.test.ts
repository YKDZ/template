import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  installContentCollection,
  prepareContentCollection,
} from "@ykdz/template-content/artifact-builder";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { execa } from "execa";

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
      specifier: "@ykdz/reference-ts-cli/template",
      load: () => import("@ykdz/reference-ts-cli/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/reference-vike-web/template",
      load: () => import("@ykdz/reference-vike-web/template"),
    },
    {
      specifier: "@ykdz/reference-vike-db/template",
      load: () => import("@ykdz/reference-vike-db/template"),
    },
    {
      specifier: "@ykdz/reference-vike-migrations/template",
      load: () => import("@ykdz/reference-vike-migrations/template"),
    },
    {
      specifier: "@ykdz/preset-ts-cli/template",
      load: () => import("@ykdz/preset-ts-cli/template"),
    },
    {
      specifier: "@ykdz/preset-ts-lib/template",
      load: () => import("@ykdz/preset-ts-lib/template"),
    },
    {
      specifier: "@ykdz/preset-vike-app/template",
      load: () => import("@ykdz/preset-vike-app/template"),
    },
  ],
});
const libraryPreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-lib",
);
const cliPreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-cli",
);
assert.ok(libraryPreset);
assert.ok(cliPreset);

await it(
  "通过正式归档安装默认SDK，在普通Node进程中初始化库并新进程添加CLI",
  { timeout: 600_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "native-workspace-consumer-"),
    );
    const preparedRoot = path.join(temporaryRoot, "prepared");
    let prepared:
      | Awaited<ReturnType<typeof prepareContentCollection>>
      | undefined;
    try {
      await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build:template",
          "--filter=@ykdz/preset-ts-lib",
          "--filter=@ykdz/preset-ts-cli",
          "--force",
        ],
        { cwd: workspaceRoot },
      );
      await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          "--filter=@ykdz/template-workspace",
          "--force",
        ],
        { cwd: workspaceRoot },
      );
      prepared = await prepareContentCollection({
        content,
        roots: [libraryPreset, cliPreset],
        workspaceRoot,
        root: preparedRoot,
      });

      assert.deepEqual(
        prepared.members
          .map((member) => member.identity.packageName)
          .toSorted(),
        [
          "@ykdz/preset-ts-lib",
          "@ykdz/preset-ts-cli",
          "@ykdz/reference-ts-cli",
          "@ykdz/reference-npm-publication",
          "@ykdz/reference-ts-lib",
          "@ykdz/reference-tooling-config",
          "@ykdz/reference-workspace-root",
        ].toSorted(),
      );
      const workspaceSdk = prepared.sdkPackages.find(
        ({ name }) => name === "@ykdz/template-workspace",
      );
      assert.ok(workspaceSdk);
      assert.match(workspaceSdk.sha256, /^[0-9a-f]{64}$/u);
      for (const owner of prepared.owners) {
        assert.match(owner.packed.sha256, /^[0-9a-f]{64}$/u);
      }

      const consumerRoot = path.join(temporaryRoot, "consumer");
      await installContentCollection(prepared, consumerRoot);
      await execa("pnpm", ["add", workspaceSdk.tarball], {
        cwd: consumerRoot,
      });
      const projectRoot = path.join(consumerRoot, "project");
      const targetRoot = path.join(projectRoot, "workspace");
      await mkdir(projectRoot, { recursive: true });
      const driverPath = path.join(projectRoot, "default-sdk-driver.mjs");
      await writeFile(
        driverPath,
        [
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          'import { templateContent } from "@ykdz/template-content";',
          "const [phase, targetRoot] = process.argv.slice(2);",
          'const libraryPreset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-ts-lib");',
          'const cliPreset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-ts-cli");',
          "if (!libraryPreset || !cliPreset) throw new Error('已安装集合缺少ts-lib或ts-cli预设');",
          "const generator = createDefaultGenerator({ content: templateContent });",
          "const result = phase === 'init'",
          "  ? await generator.init({ targetRoot, selection: { presets: [{ contentIdentity: libraryPreset.identity }] }, conventions: { repositoryName: 'packed-native-demo', defaultPackageScope: 'demo' } })",
          "  : phase === 'add-cli'",
          "    ? await generator.add({ repositoryRoot: targetRoot, preset: cliPreset.identity, creationInput: { linkTo: { nodeIdentity: 'library' } } })",
          "    : await generator.add({ repositoryRoot: targetRoot, preset: libraryPreset.identity, creationInput: { leafName: 'next', linkFrom: ['packages/lib'] } });",
          "if (result.status !== 'success') throw new Error(JSON.stringify(result));",
          "console.log(JSON.stringify({ packagePaths: result.blueprint.packages.map(({ path }) => path).toSorted(), status: result.status }));",
          "",
        ].join("\n"),
      );

      const initialized = await execa(
        process.execPath,
        [driverPath, "init", targetRoot],
        { cwd: consumerRoot },
      );
      assert.deepEqual(JSON.parse(initialized.stdout), {
        packagePaths: [".", "packages/lib", "packages/tooling-config"],
        status: "success",
      });
      const rootManifest = JSON.parse(
        await readFile(path.join(targetRoot, "package.json"), "utf8"),
      ) as {
        readonly private: boolean;
        readonly devDependencies: Readonly<Record<string, string>>;
        readonly scripts: Readonly<Record<string, string>>;
      };
      assert.equal(rootManifest.private, true);
      assert.equal(
        rootManifest.devDependencies["@demo/tooling-config"],
        "workspace:./packages/tooling-config",
      );
      assert.equal(
        rootManifest.scripts["publication:pack"],
        "turbo run build && changeset pack --out-dir .changeset/packed",
      );
      const libraryManifest = JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/lib/package.json"),
          "utf8",
        ),
      ) as {
        readonly exports: Readonly<Record<string, unknown>>;
      };
      assert.deepEqual(Object.keys(libraryManifest.exports["."] as object), [
        "source",
        "types",
        "default",
      ]);
      await readFile(path.join(targetRoot, ".changeset/config.json"));
      await readFile(path.join(targetRoot, ".github/workflows/release.yml"));
      await readFile(
        path.join(targetRoot, "packages/tooling-config/tsconfig.json"),
      );

      const addedCli = await execa(
        process.execPath,
        [driverPath, "add-cli", targetRoot],
        { cwd: consumerRoot },
      );
      assert.deepEqual(JSON.parse(addedCli.stdout), {
        packagePaths: [
          ".",
          "packages/cli",
          "packages/lib",
          "packages/tooling-config",
        ],
        status: "success",
      });
      const cliManifest = JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/cli/package.json"),
          "utf8",
        ),
      ) as {
        readonly bin: Readonly<Record<string, string>>;
        readonly dependencies: Readonly<Record<string, string>>;
      };
      assert.deepEqual(cliManifest.bin, { cli: "./dist/cli.js" });
      assert.equal(cliManifest.dependencies["@demo/lib"], "workspace:*");

      await writeFile(
        path.join(targetRoot, "packages/cli/src/linked-library.ts"),
        [
          'import { greet } from "@demo/lib";',
          "",
          'console.log(greet("Ada").message);',
          "",
        ].join("\n"),
      );
      await execa("pnpm", ["install"], { cwd: targetRoot });
      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetRoot,
      });
      assert.equal(
        await execa(
          process.execPath,
          [
            "packages/cli/dist/cli.js",
            "lookup",
            "ada",
            "--output-format",
            "text",
          ],
          { cwd: targetRoot },
        ).then(({ stdout }) => stdout),
        "找到记录：Ada Lovelace（ada）",
      );
      assert.equal(
        await execa(process.execPath, ["dist/linked-library.js"], {
          cwd: path.join(targetRoot, "packages/cli"),
        }).then(({ stdout }) => stdout),
        "Hello, Ada",
      );

      const packedLibraryRoot = path.join(targetRoot, "packages/lib");
      await execa("pnpm", ["pack", "--pack-destination", temporaryRoot], {
        cwd: packedLibraryRoot,
      });
      const libraryArchiveName = (await readdir(temporaryRoot)).find(
        (name) => name.startsWith("demo-lib-") && name.endsWith(".tgz"),
      );
      assert.ok(libraryArchiveName);
      const libraryArchive = path.join(temporaryRoot, libraryArchiveName);
      const libraryArchiveSha256 = createHash("sha256")
        .update(await readFile(libraryArchive))
        .digest("hex");
      const libraryConsumerRoot = path.join(temporaryRoot, "library-consumer");
      await mkdir(libraryConsumerRoot);
      await writeFile(
        path.join(libraryConsumerRoot, "package.json"),
        JSON.stringify({ name: "native-library-consumer", private: true }),
      );
      await execa("pnpm", ["add", libraryArchive], {
        cwd: libraryConsumerRoot,
      });
      const consumerImport = await execa(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { greet } from "@demo/lib"; if (greet("Ada").message !== "Hello, Ada") throw new Error("生成库消费结果错误");',
        ],
        { cwd: libraryConsumerRoot },
      );
      assert.equal(consumerImport.stdout, "");

      const added = await execa(
        process.execPath,
        [driverPath, "add", targetRoot],
        { cwd: consumerRoot },
      );
      assert.deepEqual(JSON.parse(added.stdout), {
        packagePaths: [
          ".",
          "packages/cli",
          "packages/lib",
          "packages/next",
          "packages/tooling-config",
        ],
        status: "success",
      });
      const updatedLibraryManifest = JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/lib/package.json"),
          "utf8",
        ),
      ) as {
        readonly dependencies: Readonly<Record<string, string>>;
      };
      assert.equal(
        updatedLibraryManifest.dependencies["@demo/next"],
        "workspace:*",
      );

      await execa("pnpm", ["install"], { cwd: targetRoot });
      const dryRun = await execa(
        "pnpm",
        ["exec", "turbo", "run", "typecheck", "build", "--dry-run=json"],
        { cwd: targetRoot },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          readonly tasks: readonly {
            readonly taskId: string;
            readonly dependencies: readonly string[];
          }[];
        }
      ).tasks;
      const libraryBuild = tasks.find(
        ({ taskId }) => taskId === "@demo/lib#build",
      );
      const libraryTypecheck = tasks.find(
        ({ taskId }) => taskId === "@demo/lib#typecheck",
      );
      const cliBuild = tasks.find(({ taskId }) => taskId === "@demo/cli#build");
      const cliTypecheck = tasks.find(
        ({ taskId }) => taskId === "@demo/cli#typecheck",
      );
      assert.ok(libraryBuild);
      assert.ok(libraryTypecheck);
      assert.ok(cliBuild);
      assert.ok(cliTypecheck);
      assert.ok(libraryBuild.dependencies.includes("@demo/next#build"));
      assert.ok(libraryTypecheck.dependencies.includes("@demo/next#typecheck"));
      assert.ok(cliBuild.dependencies.includes("@demo/lib#build"));
      assert.ok(cliTypecheck.dependencies.includes("@demo/lib#typecheck"));
      assert.ok(
        tasks.some(({ taskId }) => taskId === "@demo/tooling-config#build"),
      );
      await execa("pnpm", ["run", "check"], { cwd: targetRoot });
      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetRoot,
      });

      console.log(
        JSON.stringify({
          collection: {
            name: prepared.collection.name,
            version: prepared.collection.version,
            sha256: prepared.collection.sha256,
            tarball: prepared.collection.tarball,
          },
          owners: prepared.owners.map(({ member, packed }) => ({
            namespace: member.identity.namespace,
            name: packed.name,
            version: packed.version,
            sha256: packed.sha256,
            tarball: packed.tarball,
          })),
          workspaceSdk: {
            name: workspaceSdk.name,
            version: workspaceSdk.version,
            sha256: workspaceSdk.sha256,
            tarball: workspaceSdk.tarball,
          },
          generatedLibrary: {
            name: "@demo/lib",
            version: "0.0.0",
            sha256: libraryArchiveSha256,
            tarball: libraryArchive,
            consumerImport: "greet('Ada') => Hello, Ada",
          },
        }),
      );
    } finally {
      await prepared?.cleanup();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

await it(
  "通过正式归档初始化Vike并在新进程加库后保留数据库部署",
  { timeout: 300_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "native-vike-consumer-"),
    );
    const preparedRoot = path.join(temporaryRoot, "prepared");
    let prepared:
      | Awaited<ReturnType<typeof prepareContentCollection>>
      | undefined;
    try {
      await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build:template",
          "--filter=@ykdz/preset-vike-app",
          "--filter=@ykdz/preset-ts-lib",
          "--force",
        ],
        { cwd: workspaceRoot },
      );
      await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          "--filter=@ykdz/template-workspace",
          "--force",
        ],
        { cwd: workspaceRoot },
      );

      const vikePreset = content.find(
        (member) =>
          member.kind === "preset" &&
          member.identity.packageName === "@ykdz/preset-vike-app",
      );
      const libraryPreset = content.find(
        (member) =>
          member.kind === "preset" &&
          member.identity.packageName === "@ykdz/preset-ts-lib",
      );
      assert.ok(vikePreset && libraryPreset);
      prepared = await prepareContentCollection({
        content,
        roots: [vikePreset, libraryPreset],
        workspaceRoot,
        root: preparedRoot,
      });
      const webOwner = prepared.owners.find(
        ({ member }) =>
          member.kind === "reference" &&
          member.identity.packageName === "@ykdz/reference-vike-web",
      );
      assert.ok(webOwner);
      assert.deepEqual(
        webOwner.artifact.dependencies.find(({ name }) => name === "vike")
          ?.purposes,
        ["target"],
      );
      const webArchiveManifest = JSON.parse(
        await readFile(path.join(webOwner.installRoot, "package.json"), "utf8"),
      ) as { readonly dependencies?: Readonly<Record<string, string>> };
      assert.equal(webArchiveManifest.dependencies?.vike, undefined);
      assert.ok(!prepared.sdkPackages.some(({ name }) => name === "vike"));
      const workspaceSdk = prepared.sdkPackages.find(
        ({ name }) => name === "@ykdz/template-workspace",
      );
      assert.ok(workspaceSdk);

      const consumerRoot = path.join(temporaryRoot, "consumer");
      await installContentCollection(prepared, consumerRoot);
      await execa("pnpm", ["add", workspaceSdk.tarball], {
        cwd: consumerRoot,
      });
      const targetRoot = path.join(consumerRoot, "project", "vike-demo");
      const installedCollection = path.join(
        consumerRoot,
        "node_modules",
        ...prepared.collection.name.split("/"),
      );
      const initDriverPath = path.join(
        installedCollection,
        "vike-init-driver.mjs",
      );
      const addDriverPath = path.join(
        installedCollection,
        "vike-add-driver.mjs",
      );
      const baselinePath = path.join(consumerRoot, "vike-init.json");
      await writeFile(
        initDriverPath,
        [
          'import assert from "node:assert/strict";',
          'import { writeFile } from "node:fs/promises";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          'import { templateContent } from "@ykdz/template-content";',
          'const preset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-vike-app");',
          "assert.ok(preset);",
          'const result = await createDefaultGenerator({ content: templateContent }).init({ targetRoot: process.argv[2], selection: { presets: [{ contentIdentity: preset.identity }] }, conventions: { repositoryName: "packed-vike-demo", defaultPackageScope: "demo" } });',
          'assert.equal(result.status, "success", JSON.stringify(result));',
          'if (result.status !== "success") process.exit(2);',
          "const selection = result.generationRecord.selections.find((item) => item.presetIdentity?.packageName === preset.identity.packageName);",
          "assert.ok(selection);",
          "const packages = new Map(result.generationRecord.packages.map((item) => [item.packageDefinitionId, item]));",
          "const web = packages.get(selection.nodes.web);",
          "const database = packages.get(selection.nodes.database);",
          "const migrations = packages.get(selection.nodes.migrations);",
          "assert.ok(web && database && migrations);",
          'assert.equal(database.createdBy, "initialization");',
          "assert.equal(web.dependencyBindings.database, database.packageDefinitionId);",
          "assert.equal(migrations.dependencyBindings.database, database.packageDefinitionId);",
          "await writeFile(process.argv[3], JSON.stringify({ selection, packages: [web, database, migrations] }));",
          "console.log(JSON.stringify({ status: result.status }));",
        ].join("\n"),
      );
      await writeFile(
        addDriverPath,
        [
          'import assert from "node:assert/strict";',
          'import { readFile } from "node:fs/promises";',
          'import { contentIdentityKey } from "@ykdz/template-core/content-identity";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          'import { templateContent } from "@ykdz/template-content";',
          'const vikePreset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-vike-app");',
          'const libraryPreset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-ts-lib");',
          "assert.ok(vikePreset && libraryPreset);",
          'const baseline = JSON.parse(await readFile(process.argv[3], "utf8"));',
          'const result = await createDefaultGenerator({ content: templateContent }).add({ repositoryRoot: process.argv[2], preset: libraryPreset.identity, creationInput: { leafName: "extra-library" } });',
          'assert.equal(result.status, "success", JSON.stringify(result));',
          'if (result.status !== "success") process.exit(3);',
          "assert.ok(result.generationRecord.selections.some((item) => item.presetIdentity !== null && contentIdentityKey(item.presetIdentity) === contentIdentityKey(vikePreset.identity)));",
          "assert.ok(result.generationRecord.selections.some((item) => item.presetIdentity !== null && contentIdentityKey(item.presetIdentity) === contentIdentityKey(libraryPreset.identity)));",
          "for (const previous of baseline.packages) { const current = result.generationRecord.packages.find((item) => item.packageDefinitionId === previous.packageDefinitionId); assert.ok(current); assert.deepEqual(current.dependencyBindings, previous.dependencyBindings); }",
          'const workflow = await readFile(`${process.argv[2]}/.github/workflows/check.yml`, "utf8");',
          "assert.match(workflow, /name: Full Check/);",
          "assert.match(workflow, /id: prepare-deployment/);",
          "assert.match(workflow, /uses: docker\\/setup-buildx-action@/);",
          'const manifest = JSON.parse(await readFile(`${process.argv[2]}/package.json`, "utf8"));',
          'assert.match(manifest.scripts["database:prepare:e2e"], /DATABASE_PROFILE=e2e/);',
          "assert.match(manifest.scripts.deployment, /check-standalone-deployment/);",
          'for (const path of ["Dockerfile", ".dockerignore", "scripts/container-entrypoint.sh", "scripts/check-standalone-deployment.ts"]) await readFile(`${process.argv[2]}/${path}`);',
          "console.log(JSON.stringify({ status: result.status }));",
        ].join("\n"),
      );

      const driverOptions = {
        cwd: consumerRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: "--no-global-search-paths",
          NODE_PATH: "",
        },
      };
      const initialized = await execa(
        process.execPath,
        [initDriverPath, targetRoot, baselinePath],
        driverOptions,
      );
      assert.equal(JSON.parse(initialized.stdout).status, "success");
      const retainedPaths = [
        "Dockerfile",
        ".dockerignore",
        "scripts/container-entrypoint.sh",
        "scripts/check-standalone-deployment.ts",
        ".github/workflows/check.yml",
      ] as const;
      const retainedBeforeAdd = await Promise.all(
        retainedPaths.map(
          async (relativePath) =>
            await readFile(path.join(targetRoot, relativePath), "utf8"),
        ),
      );
      const initialManifest = JSON.parse(
        await readFile(path.join(targetRoot, "package.json"), "utf8"),
      ) as { readonly scripts: Readonly<Record<string, string>> };

      const added = await execa(
        process.execPath,
        [addDriverPath, targetRoot, baselinePath],
        driverOptions,
      );
      assert.equal(JSON.parse(added.stdout).status, "success");
      assert.deepEqual(
        await Promise.all(
          retainedPaths.map(
            async (relativePath) =>
              await readFile(path.join(targetRoot, relativePath), "utf8"),
          ),
        ),
        retainedBeforeAdd,
      );
      const addedManifest = JSON.parse(
        await readFile(path.join(targetRoot, "package.json"), "utf8"),
      ) as { readonly scripts: Readonly<Record<string, string>> };
      for (const script of [
        "database:prepare:dev",
        "database:prepare:test",
        "database:prepare:e2e",
        "deployment",
      ]) {
        assert.equal(
          addedManifest.scripts[script],
          initialManifest.scripts[script],
        );
      }
      console.log(
        JSON.stringify({
          collection: {
            name: prepared.collection.name,
            version: prepared.collection.version,
            sha256: prepared.collection.sha256,
          },
          owners: prepared.owners.map(({ member, packed }) => ({
            identity: member.identity,
            name: packed.name,
            version: packed.version,
            sha256: packed.sha256,
          })),
          sdkPackages: prepared.sdkPackages.map(
            ({ name, version, sha256 }) => ({ name, version, sha256 }),
          ),
        }),
      );
    } finally {
      await prepared?.cleanup();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
