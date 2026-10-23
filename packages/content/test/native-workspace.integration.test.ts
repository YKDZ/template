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
      specifier: "@ykdz/preset-ts-lib/template",
      load: () => import("@ykdz/preset-ts-lib/template"),
    },
  ],
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-lib",
);
assert.ok(preset);

await it(
  "通过正式归档安装默认SDK，在普通Node进程中初始化并新进程连续加包",
  { timeout: 300_000 },
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
        roots: [preset],
        workspaceRoot,
        root: preparedRoot,
      });

      assert.deepEqual(
        prepared.members
          .map((member) => member.identity.packageName)
          .toSorted(),
        [
          "@ykdz/preset-ts-lib",
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
          'import { readFile, writeFile } from "node:fs/promises";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          'import { templateContent } from "@ykdz/template-content";',
          "const [phase, targetRoot] = process.argv.slice(2);",
          'const preset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-ts-lib");',
          "if (!preset) throw new Error('已安装集合缺少ts-lib预设');",
          "const generator = createDefaultGenerator({ content: templateContent });",
          "const result = phase === 'init'",
          "  ? await generator.init({ targetRoot, selection: { presets: [{ contentIdentity: preset.identity }] }, conventions: { repositoryName: 'packed-native-demo', defaultPackageScope: 'demo' } })",
          "  : await generator.add({ repositoryRoot: targetRoot, preset: preset.identity, creationInput: { leafName: 'next', linkFrom: ['packages/lib'] } });",
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
      await execa("pnpm", ["install"], { cwd: targetRoot });
      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetRoot,
      });

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
      assert.ok(libraryBuild);
      assert.ok(libraryTypecheck);
      assert.ok(libraryBuild.dependencies.includes("@demo/next#build"));
      assert.ok(libraryTypecheck.dependencies.includes("@demo/next#typecheck"));
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
