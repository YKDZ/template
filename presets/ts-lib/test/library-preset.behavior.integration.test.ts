import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";
import { execa } from "execa";

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

void describe("TypeScript 库公开预设安装行为", () => {
  void it(
    "源码链接即时生效，Turbo 按依赖构建后允许只用分发文件运行",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-lib-provider-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-library");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const generator = createDefaultGenerator({ content });
      const initialized = await generator.init({
        targetRoot,
        selection: {
          presets: [{ contentIdentity: preset.identity }],
        },
        conventions: {
          repositoryName: "demo-library",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );

      const added = await generator.add({
        repositoryRoot: targetRoot,
        preset: preset.identity,
        creationInput: {
          leafName: "provider",
          packagePath: "packages/provider",
          linkFrom: ["packages/lib"],
        },
      });
      assert.strictEqual(added.status, "success", JSON.stringify(added));

      const consumerRoot = path.join(targetRoot, "packages/lib");
      const providerSource = path.join(
        targetRoot,
        "packages/provider/src/index.ts",
      );
      await writeFile(
        path.join(consumerRoot, "src/observe-provider.ts"),
        [
          'import { greet } from "@demo/provider";',
          "",
          'console.log(greet("Ada").message);',
          "",
        ].join("\n"),
      );
      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });

      const runSource = () =>
        execa(
          process.execPath,
          ["--conditions=source", "src/observe-provider.ts"],
          { cwd: consumerRoot, cancelSignal: testContext.signal },
        ).then(({ stdout }) => stdout);
      assert.strictEqual(await runSource(), "Hello, Ada");
      await writeFile(
        providerSource,
        (await readFile(providerSource, "utf8")).replace(
          "Hello,",
          "Linked source:",
        ),
      );
      const sourceOutput = await runSource();
      assert.strictEqual(sourceOutput, "Linked source: Ada");

      const beforeProviderBuild = await execa(
        "pnpm",
        ["--filter", "./packages/lib", "run", "build"],
        { cwd: targetRoot, cancelSignal: testContext.signal, reject: false },
      );
      assert.notStrictEqual(beforeProviderBuild.exitCode, 0);

      const dryRun = await execa(
        "pnpm",
        ["exec", "turbo", "run", "typecheck", "build", "--dry-run=json"],
        { cwd: targetRoot, cancelSignal: testContext.signal },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          readonly tasks: readonly {
            readonly taskId: string;
            readonly dependencies: readonly string[];
          }[];
        }
      ).tasks;
      const consumerBuild = tasks.find(
        ({ taskId }) => taskId === "@demo/lib#build",
      );
      const consumerTypecheck = tasks.find(
        ({ taskId }) => taskId === "@demo/lib#typecheck",
      );
      assert.ok(consumerBuild);
      assert.ok(consumerTypecheck);
      assert.ok(consumerBuild.dependencies.includes("@demo/provider#build"));
      assert.ok(
        consumerTypecheck.dependencies.includes("@demo/provider#typecheck"),
      );
      assert.ok(
        !consumerTypecheck.dependencies.includes("@demo/provider#build"),
      );
      const obsoleteSource = path.join(consumerRoot, "src/obsolete.ts");
      const obsoleteOutput = path.join(consumerRoot, "dist/obsolete.js");
      await writeFile(obsoleteSource, "export const obsolete = true;\n");
      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      assert.match(await readFile(obsoleteOutput, "utf8"), /obsolete/u);
      await rm(obsoleteSource);
      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      await assert.rejects(readFile(obsoleteOutput), { code: "ENOENT" });
      await rm(path.join(targetRoot, "packages/provider/src"), {
        recursive: true,
        force: true,
      });
      assert.strictEqual(
        await execa(process.execPath, ["dist/observe-provider.js"], {
          cwd: consumerRoot,
          cancelSignal: testContext.signal,
        }).then(({ stdout }) => stdout),
        sourceOutput,
      );
      assert.match(
        await readFile(
          path.join(targetRoot, "packages/provider/dist/index.d.ts"),
          "utf8",
        ),
        /declare function greet/u,
      );
    },
  );
});
