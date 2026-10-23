import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ContentIdentity } from "@ykdz/template-core/content-identity";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

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
  ],
});

function presetMember(packageName: string) {
  const member = content.find(
    (candidate) =>
      candidate.kind === "preset" &&
      candidate.identity.packageName === packageName,
  );
  assert.ok(member, `内容集合缺少预设：${packageName}`);
  return member;
}

function referenceIdentity(packageName: string): ContentIdentity {
  const member = content.find(
    (candidate) =>
      candidate.kind === "reference" &&
      candidate.identity.packageName === packageName,
  );
  assert.ok(member, `内容集合缺少参考包：${packageName}`);
  return member.identity;
}

const vueHonoPreset = presetMember("@ykdz/preset-vue-hono-app");

void describe("公开内容集合中的 Vue-Hono 预设", () => {
  void it("初始化页面、API、共享依赖及联合验收配置", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-content-vue-hono-preset-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createDefaultGenerator({ content });

    assert.ok(content.includes(vueHonoPreset));
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: vueHonoPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    assert.deepStrictEqual(
      initialized.blueprint.packages
        .map(({ path: packagePath }) => packagePath)
        .toSorted(),
      [".", "apps/api", "apps/web", "packages/tooling-config"].toSorted(),
    );
    const initializedWeb = initialized.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentity.packageName === "@ykdz/reference-vue-hono-web",
    );
    const initializedApi = initialized.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentity.packageName === "@ykdz/reference-hono-api",
    );
    assert.ok(initializedWeb && initializedApi);
    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      {
        consumerId: initializedWeb.packageDefinitionId,
        providerId: initializedApi.packageDefinitionId,
      },
    ]);
    const playwrightConfiguration = await readFile(
      path.join(targetRoot, "playwright.config.ts"),
      "utf8",
    );
    assert.match(
      playwrightConfiguration,
      /const apiPackageName = "@demo\/api";/u,
    );
    assert.match(
      playwrightConfiguration,
      /const webPackageName = "@demo\/web";/u,
    );

    const webSourcePath = path.join(targetRoot, "apps/web/src/App.vue");
    const apiSourcePath = path.join(targetRoot, "apps/api/src/server.ts");
    const customizedWeb =
      (await readFile(webSourcePath, "utf8")) + "\n<!-- 用户页面定制 -->\n";
    const customizedApi =
      (await readFile(apiSourcePath, "utf8")) + "\n// 用户 API 定制\n";
    await writeFile(webSourcePath, customizedWeb);
    await writeFile(apiSourcePath, customizedApi);
    await chmod(webSourcePath, 0o640);
    const rootManifestPath = path.join(targetRoot, "package.json");
    const rootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    rootManifest.scripts["custom:workspace"] = "echo retained";
    await writeFile(
      rootManifestPath,
      JSON.stringify(rootManifest, null, 2) + "\n",
    );

    const additions: {
      readonly contentIdentity: ContentIdentity;
      readonly creationInput: {
        readonly leafName: string;
        readonly packagePath: string;
      };
    }[] = [
      {
        contentIdentity: referenceIdentity("@ykdz/reference-hono-api"),
        creationInput: {
          leafName: "support-api",
          packagePath: "apps/support-api",
        },
      },
      {
        contentIdentity: referenceIdentity("@ykdz/reference-vue-app"),
        creationInput: { leafName: "portal", packagePath: "apps/portal" },
      },
    ];
    for (const addition of additions) {
      const added = await generator.add({
        repositoryRoot: targetRoot,
        ...addition,
      });
      assert.strictEqual(added.status, "success", JSON.stringify(added));
    }

    const finalBlueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[]; packageLinkIntents: unknown[] };
    assert.deepStrictEqual(
      finalBlueprint.packages
        .map(({ path: packagePath }) => packagePath)
        .toSorted(),
      [
        ".",
        "apps/api",
        "apps/portal",
        "apps/support-api",
        "apps/web",
        "packages/tooling-config",
      ].toSorted(),
    );
    assert.deepStrictEqual(finalBlueprint.packageLinkIntents, [
      {
        consumerId: initializedWeb.packageDefinitionId,
        providerId: initializedApi.packageDefinitionId,
      },
    ]);
    assert.strictEqual(await readFile(webSourcePath, "utf8"), customizedWeb);
    assert.strictEqual(await readFile(apiSourcePath, "utf8"), customizedApi);
    assert.strictEqual((await stat(webSourcePath)).mode & 0o777, 0o640);
    const finalRootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(
      finalRootManifest.scripts["custom:workspace"],
      "echo retained",
    );
    assert.strictEqual(
      finalRootManifest.scripts["test:e2e"],
      "playwright test",
    );
    const finalWebManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.strictEqual(
      finalWebManifest.dependencies["@demo/api"],
      "workspace:*",
    );
    assert.strictEqual(
      finalWebManifest.devDependencies["@demo/tooling-config"],
      "workspace:../../packages/tooling-config",
    );
    const finalApiManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/api/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(
      finalApiManifest.dependencies["@demo/tooling-config"],
      "workspace:../../packages/tooling-config",
    );
    const finalTurbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as { tasks: Record<string, { dependsOn: readonly string[] }> };
    assert.deepStrictEqual(finalTurbo.tasks["//#test:e2e"]?.dependsOn, [
      "@demo/api#build",
      "@demo/web#build",
      "@demo/web#browser:prepare",
    ]);
    assert.match(
      await readFile(
        path.join(targetRoot, ".github/workflows/check.yml"),
        "utf8",
      ),
      /PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS:[^\n]*\n\s+\./u,
    );
    const vueManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/portal/package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.strictEqual(
      vueManifest.devDependencies["@demo/tooling-config"],
      "workspace:../../packages/tooling-config",
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "playwright.config.ts"), "utf8"),
      playwrightConfiguration,
    );
  });
});
