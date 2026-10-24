import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DefaultPresetPackageEvaluation } from "@ykdz/default-content-authoring/preset-root-contribution";
import { honoApiDependencyKey } from "@ykdz/reference-vue-hono-web/template";
import type { CompositionPackage } from "@ykdz/template-core/composition";
import type { ContentIdentity } from "@ykdz/template-core/content-identity";
import type { PackageDefinitionId } from "@ykdz/template-core/project-blueprint";

import { preset } from "../template/definition.ts";

const { compose: composeVueHonoJointE2e, prepare: prepareJointE2eResources } =
  preset.rootContribution;

const ownerIdentity: ContentIdentity = {
  namespace: "ykdz",
  packageName: "@ykdz/preset-vue-hono-app",
  exportPath: "./template",
};

const rootId = "package-root" as PackageDefinitionId;
const webId = "package-web" as PackageDefinitionId;
const apiId = "package-api" as PackageDefinitionId;
const otherApiId = "package-other-api" as PackageDefinitionId;

async function resources() {
  return (await prepareJointE2eResources({ ownerIdentity })).ownerFacts
    .resources;
}

function packageInstance(options: {
  readonly id: PackageDefinitionId;
  readonly packageName: string;
  readonly name: string;
  readonly path: string;
  readonly role: string;
  readonly dependencyBindings?: Readonly<Record<string, PackageDefinitionId>>;
}): CompositionPackage {
  return {
    packageDefinitionId: options.id,
    contentIdentity: {
      namespace: "ykdz",
      packageName: options.packageName,
      exportPath: "./template",
    },
    definition: {
      packageDefinitionId: options.id,
      name: options.name,
      path: options.path,
      role: options.role,
    },
    createdBy: "initialization",
    creationInput: null,
    dependencyBindings: options.dependencyBindings ?? {},
  };
}

function evaluation(
  packageInstance: CompositionPackage,
): DefaultPresetPackageEvaluation {
  return {
    package: packageInstance,
    bindings: new Map(),
    contribution: {
      packageDefinitionId: packageInstance.packageDefinitionId,
      files: [],
      facts: {
        sourcePackageName: packageInstance.contentIdentity.packageName,
        manifest: {},
        exposure: { exports: {}, imports: {} },
        deferredNativeDocuments: [],
        packageInput: undefined,
        nativeDocuments: [],
        compositionFiles: [],
        dependencyUses: [],
        templateDependencies: [],
        foundation: {},
        environmentNeeds: [],
        ciDiagnosticArtifacts: [],
        referenceBindings: {},
        ownerFacts: {},
      },
    },
  };
}

function selectedPackages(
  ...entries: readonly (readonly [string, CompositionPackage])[]
): ReadonlyMap<string, DefaultPresetPackageEvaluation> {
  return new Map(
    entries.map(([nodeIdentity, packageInstance]) => [
      nodeIdentity,
      evaluation(packageInstance),
    ]),
  );
}

function validSelection() {
  const root = packageInstance({
    id: rootId,
    packageName: "@ykdz/reference-workspace-root",
    name: "demo",
    path: ".",
    role: "native-package",
  });
  const api = packageInstance({
    id: apiId,
    packageName: "@ykdz/reference-hono-api",
    name: "@demo/api",
    path: "apps/api",
    role: "runtime-service",
  });
  const web = packageInstance({
    id: webId,
    packageName: "@ykdz/reference-vue-hono-web",
    name: "@demo/web",
    path: "apps/web",
    role: "runtime-service",
    dependencyBindings: { [honoApiDependencyKey]: apiId },
  });
  return {
    root,
    api,
    web,
    selection: {
      selectionId: "selection-vue-hono",
      presetIdentity: ownerIdentity,
      nodes: { web: webId, api: apiId },
    },
  };
}

void describe("Vue-Hono 预设联合验收组合", () => {
  void it("按持久选择的节点绑定生成根文件和共享声明", async () => {
    const { root, web, api, selection } = validSelection();
    const ownerFacts = { resources: await resources() };
    const result = composeVueHonoJointE2e({
      ownerIdentity,
      selection,
      rootPackage: root,
      selectedPackages: selectedPackages(["web", web], ["api", api]),
      ownerFacts,
    });

    assert.deepStrictEqual(
      result.rootDeclaration.files?.map(({ path, mode }) => [path, mode]),
      [
        ["playwright.config.ts", 0],
        ["test/e2e/app.spec.ts", 0],
        ["test/e2e/fixtures.ts", 0],
      ],
    );
    assert.strictEqual(result.rootPackageDefinitionId, rootId);
    const configuration = new TextDecoder().decode(
      result.rootDeclaration.files![0]!.content,
    );
    assert.match(configuration, /const apiPackageName = "@demo\/api";/u);
    assert.match(configuration, /const webPackageName = "@demo\/web";/u);
    assert.match(configuration, /--filter \$\{apiPackageName\}/u);
    assert.match(configuration, /--filter \$\{webPackageName\}/u);
    assert.deepStrictEqual(result.rootDeclaration.manifest, {
      scripts: { "test:e2e": "playwright test" },
      devDependencies: { "@playwright/test": "catalog:" },
    });
    assert.deepStrictEqual(result.rootDeclaration.turboTasks, {
      "//#test:e2e": {
        cache: false,
        tags: ["quality:heavy"],
        dependsOn: [
          "@demo/api#build",
          "@demo/web#build",
          "@demo/web#browser:prepare",
        ],
      },
    });
    assert.deepStrictEqual(result.rootDeclaration.typescript, {
      include: ["test/**/*.ts"],
    });
    assert.deepStrictEqual(result.rootDeclaration.environmentNeeds?.check, [
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: { kind: "workspace-orchestration", path: "." },
      },
    ]);
    assert.deepStrictEqual(result.rootDeclaration.ciDiagnosticArtifacts, [
      {
        kind: "playwright",
        owner: { kind: "workspace-orchestration", path: "." },
      },
    ]);
  });

  void it("拒绝身份、选择节点、服务角色或API绑定不匹配", async () => {
    const { root, web, api, selection } = validSelection();
    const validPackages = selectedPackages(["web", web], ["api", api]);
    const ownerFacts = { resources: await resources() };

    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity: { ...ownerIdentity, namespace: "other" },
          selection,
          rootPackage: root,
          selectedPackages: validPackages,
          ownerFacts,
        }),
      /预设身份/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection: { ...selection, nodes: { web: webId } },
          rootPackage: root,
          selectedPackages: validPackages,
          ownerFacts,
        }),
      /节点 api/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection,
          rootPackage: root,
          selectedPackages: selectedPackages(
            [
              "web",
              {
                ...web,
                definition: { ...web.definition, role: "shared-library" },
              },
            ],
            ["api", api],
          ),
          ownerFacts,
        }),
      /web.*runtime-service/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection,
          rootPackage: root,
          selectedPackages: selectedPackages(
            ["web", { ...web, dependencyBindings: { "hono-api": otherApiId } }],
            ["api", api],
          ),
          ownerFacts,
        }),
      /绑定.*API/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection,
          rootPackage: root,
          selectedPackages: selectedPackages(
            [
              "web",
              {
                ...web,
                contentIdentity: {
                  ...web.contentIdentity,
                  packageName: "@other/web",
                },
              },
            ],
            ["api", api],
          ),
          ownerFacts,
        }),
      /Web 原生包名/u,
    );
  });

  void it("外层准备联合配置与两个测试资源", async () => {
    const prepared = await resources();
    assert.match(
      new TextDecoder().decode(
        prepared.find(
          ({ path }) => path === "resources/joint-e2e/playwright.config.ts",
        )!.content,
      ),
      /@ykdz\/reference-hono-api/u,
    );
    assert.match(
      new TextDecoder().decode(
        prepared.find(
          ({ path }) => path === "resources/joint-e2e/test/e2e/app.spec.ts",
        )!.content,
      ),
      /calls the API/u,
    );
    assert.match(
      new TextDecoder().decode(
        prepared.find(
          ({ path }) => path === "resources/joint-e2e/test/e2e/fixtures.ts",
        )!.content,
      ),
      /PLAYWRIGHT_WEB_URL/u,
    );
    assert.deepStrictEqual(
      prepared.map(({ mode }) => mode),
      [0, 0, 0],
    );
  });
});
