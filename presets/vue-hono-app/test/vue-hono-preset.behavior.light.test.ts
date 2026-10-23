import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { honoApiDependencyKey } from "@ykdz/reference-vue-hono-web/template";
import {
  contentIdentityKey,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
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
      specifier: "@ykdz/reference-hono-api/template",
      load: () => import("@ykdz/reference-hono-api/template"),
    },
    {
      specifier: "@ykdz/reference-vue-hono-web/template",
      load: () => import("@ykdz/reference-vue-hono-web/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/preset-vue-hono-app/template",
      load: () => import("@ykdz/preset-vue-hono-app/template"),
    },
  ],
});

function member(
  kind: "preset" | "reference",
  packageName: string,
): LoadedContentMember {
  const found = content.find(
    (item) => item.kind === kind && item.identity.packageName === packageName,
  );
  assert.ok(found, `显式内容集合缺少 ${kind} ${packageName}`);
  return found;
}

const root = member("reference", "@ykdz/reference-workspace-root");
const api = member("reference", "@ykdz/reference-hono-api");
const web = member("reference", "@ykdz/reference-vue-hono-web");
const library = member("reference", "@ykdz/reference-ts-lib");
const preset = member("preset", "@ykdz/preset-vue-hono-app");

const conventions = {
  repositoryName: "demo",
  defaultPackageScope: "demo",
};

const temporaryRoots = new Set<string>();

async function createTargetRoot(prefix: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, "demo");
}

async function snapshotTree(targetRoot: string): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly bytes: string;
  }[]
> {
  const entries: { path: string; mode: number; bytes: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const entryPath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, entryPath);
      } else {
        entries.push({
          path: entryPath,
          mode: (await stat(absolutePath)).mode & 0o777,
          bytes: (await readFile(absolutePath)).toString("base64"),
        });
      }
    }
  }
  await visit(targetRoot);
  return entries;
}

function generator() {
  return createDefaultGenerator({ content });
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("Vue-Hono 组合预设公开行为", () => {
  void it("初始化原生包、绑定、联合验收资源与根声明，并在新generator回放后保留", async () => {
    const targetRoot = await createTargetRoot("template-vue-hono-preset-");
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    const packages = initialized.blueprint.packages;
    const rootPackage = packages.find(
      ({ path: packagePath }) => packagePath === ".",
    );
    const apiPackage = packages.find(
      ({ path: packagePath }) => packagePath === "apps/api",
    );
    const webPackage = packages.find(
      ({ path: packagePath }) => packagePath === "apps/web",
    );
    assert.ok(rootPackage);
    assert.ok(apiPackage);
    assert.ok(webPackage);
    assert.ok(
      packages.some(
        ({ path: packagePath }) => packagePath === "packages/tooling-config",
      ),
    );
    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      {
        consumerId: webPackage.packageDefinitionId,
        providerId: apiPackage.packageDefinitionId,
      },
    ]);
    assert.deepStrictEqual(
      initialized.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [preset.identity],
    );

    const playwrightPath = path.join(targetRoot, "playwright.config.ts");
    const playwrightBeforeAdd = await readFile(playwrightPath, "utf8");
    assert.match(playwrightBeforeAdd, /const apiPackageName = "@demo\/api";/u);
    assert.match(playwrightBeforeAdd, /const webPackageName = "@demo\/web";/u);

    const webManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(webManifest.dependencies["@demo/api"], "workspace:*");

    const rootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(rootManifest.scripts["test:e2e"], "playwright test");
    const turbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as { tasks: Record<string, { dependsOn: readonly string[] }> };
    assert.deepStrictEqual(turbo.tasks["//#test:e2e"]?.dependsOn, [
      "@demo/api#build",
      "@demo/web#build",
      "@demo/web#browser:prepare",
    ]);
    const typeScriptConfiguration = JSON.parse(
      await readFile(path.join(targetRoot, "tsconfig.config.json"), "utf8"),
    ) as { include: readonly string[] };
    assert.ok(typeScriptConfiguration.include.includes("test/**/*.ts"));

    assert.ok(
      initialized.ownerFacts.environmentNeeds.check.some(
        (need) =>
          need.kind === "playwright-browser-assets" &&
          need.owner?.kind === "workspace-orchestration" &&
          need.owner.path === ".",
      ),
    );
    assert.match(
      await readFile(
        path.join(targetRoot, ".github/workflows/check.yml"),
        "utf8",
      ),
      /PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS:[^\n]*\n\s+\./u,
    );

    const beforeUnsupportedAdd = await snapshotTree(targetRoot);
    const unsupportedAdd = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
    });
    assert.strictEqual(
      unsupportedAdd.status,
      "operation-failure",
      JSON.stringify(unsupportedAdd),
    );
    assert.deepStrictEqual(
      await snapshotTree(targetRoot),
      beforeUnsupportedAdd,
    );

    const added = await generator().add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "extra" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.strictEqual(
      await readFile(playwrightPath, "utf8"),
      playwrightBeforeAdd,
    );
    const updatedRecord = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
      selections: {
        presetIdentity: ContentIdentity | null;
        nodes: Record<string, string>;
      }[];
    };
    assert.strictEqual(
      updatedRecord.packages.find(
        ({ contentIdentity }) =>
          contentIdentityKey(contentIdentity) ===
          contentIdentityKey(root.identity),
      )?.packageDefinitionId,
      rootPackage.packageDefinitionId,
    );
    assert.strictEqual(
      updatedRecord.selections[0]?.presetIdentity?.packageName,
      preset.identity.packageName,
    );
    assert.ok(
      updatedRecord.packages.some(
        ({ contentIdentity }) =>
          contentIdentityKey(contentIdentity) ===
          contentIdentityKey(library.identity),
      ),
    );
  });

  void it("通过公开内容身份直接绑定web与API实例", async () => {
    const targetRoot = await createTargetRoot("template-vue-hono-direct-");
    const initialized = await generator().init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "web",
            contentIdentity: web.identity,
            dependencyBindings: { [honoApiDependencyKey]: "api" },
          },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    const webRecord = initialized.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(web.identity),
    );
    const apiPackageId = webRecord?.dependencyBindings[honoApiDependencyKey];
    const apiPackage = initialized.blueprint.packages.find(
      ({ packageDefinitionId }) => packageDefinitionId === apiPackageId,
    );
    const webPackage = initialized.blueprint.packages.find(
      ({ path: packagePath }) => packagePath === "apps/web",
    );
    assert.ok(apiPackage);
    assert.ok(webPackage);
    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      {
        consumerId: webPackage.packageDefinitionId,
        providerId: apiPackage.packageDefinitionId,
      },
    ]);
    const manifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(manifest.dependencies["@demo/api"], "workspace:*");
  });

  void it("联合根文件冲突时不提交任何生成内容", async () => {
    const targetRoot = await createTargetRoot("template-vue-hono-conflict-");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(
      path.join(targetRoot, "playwright.config.ts"),
      "export default {};\n",
    );
    const before = await snapshotTree(targetRoot);
    const result = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.strictEqual(result.status, "conflict", JSON.stringify(result));
    assert.deepStrictEqual(await snapshotTree(targetRoot), before);
  });
});
