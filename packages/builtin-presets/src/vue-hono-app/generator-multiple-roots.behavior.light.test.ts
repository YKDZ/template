import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as web } from "@ykdz/reference-vue-hono-web/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { createVueHonoProjectContent } from "@ykdz/template-builtin-presets";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type {
  GeneratorPackageCreatedBy,
  PackageCreationInput,
} from "@ykdz/template-core/workspace-strategy";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import type { ReferenceContributionOptions } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const configuration = defineReferencePackage(configurationDefinition);
type CreationInput = PackageCreationInput<"site" | "admin">;
const projectWeb = createVueHonoProjectContent<CreationInput>({
  web,
  apiNodeIdentity: "api",
});
const webContributions: {
  readonly createdBy?: GeneratorPackageCreatedBy;
  readonly creationInput?: CreationInput;
  readonly nodeInstances?: ReadonlyMap<string, PackageDefinition>;
}[] = [];
const sharedContributions: {
  readonly createdBy?: string;
  readonly nodeInstances?: ReadonlyMap<string, PackageDefinition>;
}[] = [];
const trackedWeb = {
  ...projectWeb,
  contribute(
    options: ReferenceContributionOptions & {
      readonly createdBy: GeneratorPackageCreatedBy;
      readonly creationInput?: CreationInput;
      readonly nodeInstances: ReadonlyMap<string, PackageDefinition>;
    },
  ) {
    webContributions.push(options);
    return projectWeb.contribute(options);
  },
};
const trackedShared = {
  ...vueShared,
  contribute(
    options: ReferenceContributionOptions & {
      readonly createdBy?: string;
      readonly creationInput?: CreationInput;
      readonly nodeInstances?: ReadonlyMap<string, PackageDefinition>;
    },
  ) {
    sharedContributions.push(options);
    return vueShared.contribute(options);
  },
};

void it("Vue-Hono 初始化先分配所有显式独立根再解析原生依赖", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-generator-vue-hono-roots-"),
  );
  const targetRoot = path.join(temporaryRoot, "demo");
  try {
    const generator = createGenerator({
      content: [trackedWeb, api, trackedShared, configuration],
      strategy: createDefaultWorkspaceStrategy<CreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "web",
            contentIdentity: web.identity,
            creationInput: { variant: "site" },
          },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
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
    assert.ok(
      webContributions.some(
        (contribution) =>
          contribution.createdBy === "initialization" &&
          contribution.creationInput?.variant === "site" &&
          contribution.nodeInstances?.get("api")?.path === "apps/api",
      ),
    );
    assert.ok(
      sharedContributions.some(
        (contribution) =>
          contribution.createdBy === "shared-dependency" &&
          contribution.nodeInstances?.get("web")?.path === "apps/web" &&
          contribution.nodeInstances.get("api")?.path === "apps/api",
      ),
    );

    assert.deepStrictEqual(
      initialized.blueprint.packages.map((definition) => definition.path),
      [
        "apps/web",
        "apps/api",
        "packages/typescript-config",
        "packages/vue-shared",
      ],
    );
    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      { consumerPackagePath: "apps/web", providerPackagePath: "apps/api" },
    ]);
    const rootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.strictEqual(rootManifest.scripts["test:e2e"], "playwright test");
    assert.strictEqual(
      rootManifest.devDependencies["@playwright/test"],
      "catalog:",
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "joint-e2e.json"), "utf8"),
      ).apiPackageName,
      "@demo/api",
    );
    assert.match(
      await readFile(path.join(targetRoot, "playwright.config.ts"), "utf8"),
      /pnpm --filter \$\{apiPackageName\}/u,
    );
    assert.match(
      await readFile(path.join(targetRoot, "test/e2e/app.spec.ts"), "utf8"),
      /API 状态：正常/u,
    );
    assert.ok(
      (
        JSON.parse(
          await readFile(
            path.join(targetRoot, ".template/environment-needs.json"),
            "utf8",
          ),
        ) as { check: { kind: string }[] }
      ).check.some((need) => need.kind === "playwright-browser-assets"),
    );
    const webManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(webManifest.dependencies["@demo/api"], "workspace:*");
    const generation = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      nodeInstances: Record<string, string>;
      packages: {
        contentIdentity: string;
        definition: { packageDefinitionId: string };
      }[];
    };
    const webRecord = generation.packages.find(
      (record) => record.contentIdentity === web.identity,
    );
    const apiRecord = generation.packages.find(
      (record) => record.contentIdentity === api.identity,
    );
    assert.strictEqual(
      generation.nodeInstances.web,
      webRecord?.definition.packageDefinitionId,
    );
    assert.strictEqual(
      generation.nodeInstances.api,
      apiRecord?.definition.packageDefinitionId,
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: web.identity,
      creationInput: { leafName: "admin", variant: "admin" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.ok(
      webContributions.some(
        (contribution) =>
          contribution.createdBy === "addition" &&
          contribution.creationInput?.leafName === "admin" &&
          contribution.creationInput.variant === "admin" &&
          contribution.nodeInstances?.get("api")?.path === "apps/api",
      ),
    );
    const afterAdd = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      packages: {
        contentIdentity: string;
        createdBy: string;
        creationInput?: CreationInput;
      }[];
    };
    assert.ok(
      afterAdd.packages.some(
        (record) =>
          record.contentIdentity === web.identity &&
          record.createdBy === "addition" &&
          record.creationInput?.leafName === "admin" &&
          record.creationInput.variant === "admin",
      ),
    );
    assert.deepStrictEqual(
      added.status === "success" ? added.blueprint.packageLinkIntents : [],
      [{ consumerPackagePath: "apps/web", providerPackagePath: "apps/api" }],
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "joint-e2e.json"), "utf8"),
      ).webPackageName,
      "@demo/web",
    );
    assert.ok(
      afterAdd.packages.some(
        (record) =>
          record.contentIdentity === vueShared.identity &&
          record.createdBy === "shared-dependency",
      ),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

void it("公开生成器拒绝包贡献写入未拥有的根路径且不留下部分产物", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-generator-package-boundary-"),
  );
  const targetRoot = path.join(temporaryRoot, "demo");
  let writeOutsidePackage: "direct" | "traversal" | false = false;
  const guardedWeb = {
    ...web,
    contribute(options: ReferenceContributionOptions) {
      const contribution = web.contribute(options);
      return writeOutsidePackage !== false
        ? {
            ...contribution,
            operations: [
              ...contribution.operations,
              {
                kind: "writeText" as const,
                to:
                  writeOutsidePackage === "direct"
                    ? "unowned-root.txt"
                    : `${options.definition.path}/../../unowned-root.txt`,
                text: "must not be rendered",
              },
            ],
          }
        : contribution;
    },
  };
  const generator = createGenerator({
    content: [guardedWeb, api, vueShared, configuration],
    strategy: createDefaultWorkspaceStrategy<CreationInput>(),
  });
  try {
    writeOutsidePackage = "direct";
    const invalidInitialization = await generator.init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "web", contentIdentity: web.identity },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(invalidInitialization.status, "operation-failure");
    await assert.rejects(access(targetRoot), { code: "ENOENT" });

    writeOutsidePackage = "traversal";
    const invalidTraversal = await generator.init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "web", contentIdentity: web.identity },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(invalidTraversal.status, "operation-failure");
    await assert.rejects(access(targetRoot), { code: "ENOENT" });

    writeOutsidePackage = false;
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "web", contentIdentity: web.identity },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
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
    assert.strictEqual(
      await readFile(
        path.join(targetRoot, "apps/web/package.json"),
        "utf8",
      ).then(() => true),
      true,
    );
    const generationBeforeAdd = await readFile(
      path.join(targetRoot, ".template/generation.json"),
      "utf8",
    );

    writeOutsidePackage = "traversal";
    const invalidAddition = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: web.identity,
      creationInput: { leafName: "admin", variant: "admin" },
    });
    assert.strictEqual(invalidAddition.status, "operation-failure");
    assert.strictEqual(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
      generationBeforeAdd,
    );
    await assert.rejects(access(path.join(targetRoot, "unowned-root.txt")), {
      code: "ENOENT",
    });
    await assert.rejects(access(path.join(targetRoot, "apps/admin")), {
      code: "ENOENT",
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
