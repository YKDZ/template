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

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import {
  templateContent,
  type TemplatePreset,
  type TemplateReferencePackage,
} from "@ykdz/template-content";
import type { ContentIdentity } from "@ykdz/template-core/content-identity";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

function presetMember(packageName: string): TemplatePreset {
  const member = templateContent.find(
    (candidate): candidate is TemplatePreset =>
      candidate.kind === "preset" &&
      candidate.identity.packageName === packageName,
  );
  assert.ok(member, `内容集合缺少预设：${packageName}`);
  return member;
}

function referenceIdentity(packageName: string): ContentIdentity {
  const member = templateContent.find(
    (candidate): candidate is TemplateReferencePackage =>
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
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    assert.ok(templateContent.includes(vueHonoPreset));
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: vueHonoPreset.identity }] },
      strategyInput: {
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
      [
        "apps/api",
        "apps/web",
        "packages/typescript-config",
        "packages/vue-shared",
      ].toSorted(),
    );
    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      { consumerPackagePath: "apps/web", providerPackagePath: "apps/api" },
    ]);
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "joint-e2e.json"), "utf8"),
      ),
      { apiPackageName: "@demo/api", webPackageName: "@demo/web" },
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
      readonly creationInput: TsCliCreationInput;
    }[] = [
      {
        contentIdentity: referenceIdentity("@ykdz/reference-ts-lib"),
        creationInput: {
          leafName: "extra-lib",
          packagePath: "packages/extra-lib",
        },
      },
      {
        contentIdentity: referenceIdentity("@ykdz/reference-ts-cli"),
        creationInput: { leafName: "tool", packagePath: "packages/tool" },
      },
      {
        contentIdentity: referenceIdentity("@ykdz/reference-rust-bin"),
        creationInput: { leafName: "native", packagePath: "packages/native" },
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
        "apps/api",
        "apps/portal",
        "apps/web",
        "packages/extra-lib",
        "packages/native",
        "packages/tool",
        "packages/typescript-config",
        "packages/vue-shared",
      ].toSorted(),
    );
    assert.deepStrictEqual(finalBlueprint.packageLinkIntents, [
      { consumerPackagePath: "apps/web", providerPackagePath: "apps/api" },
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
      finalWebManifest.dependencies["@demo/vue-shared"],
      "workspace:*",
    );
    assert.strictEqual(
      finalWebManifest.devDependencies["@demo/typescript-config"],
      "workspace:*",
    );
    const finalApiManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/api/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(
      finalApiManifest.dependencies["@demo/typescript-config"],
      "workspace:*",
    );
    const finalTurbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as { tasks: Record<string, { dependsOn: readonly string[] }> };
    assert.deepStrictEqual(finalTurbo.tasks["//#test:e2e"]?.dependsOn, [
      "@demo/api#build",
      "@demo/web#build",
      "@demo/web#browser:prepare",
    ]);
    assert.ok(
      (
        JSON.parse(
          await readFile(
            path.join(targetRoot, ".template/environment-needs.json"),
            "utf8",
          ),
        ) as { check: readonly { kind: string }[] }
      ).check.some((need) => need.kind === "playwright-browser-assets"),
    );
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
      vueManifest.dependencies["@demo/vue-shared"],
      "workspace:*",
    );
    assert.strictEqual(
      vueManifest.devDependencies["@demo/typescript-config"],
      "workspace:*",
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "joint-e2e.json"), "utf8"),
      `${JSON.stringify({ apiPackageName: "@demo/api", webPackageName: "@demo/web" }, null, 2)}\n`,
    );
  });
});
