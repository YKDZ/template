import type {
  DefaultCompositionFile,
  DefaultRootDeclarationData,
} from "@ykdz/default-content-authoring/contracts";
import type {
  DefaultPresetPackageEvaluation,
  DefaultPresetRootContributionResource,
} from "@ykdz/default-content-authoring/preset-root-contribution";
import { honoApiDependencyKey } from "@ykdz/reference-vue-hono-web/template";
import type { CompositionPackage } from "@ykdz/template-core/composition";
import {
  contentIdentityKey,
  contentIdentityLabel,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import type { GenerationRecordSelection } from "@ykdz/template-core/generation-record";

export const vueHonoJointE2eResourcePaths = Object.freeze({
  configuration: "resources/joint-e2e/playwright.config.ts",
  appSpec: "resources/joint-e2e/test/e2e/app.spec.ts",
  fixtures: "resources/joint-e2e/test/e2e/fixtures.ts",
});

export type VueHonoJointE2eResourceSnapshot =
  DefaultPresetRootContributionResource;

type PreparedResource = Readonly<{
  readonly content: Uint8Array;
  readonly mode: number;
}>;

export type PreparedVueHonoJointE2eResources = Readonly<{
  readonly configuration: PreparedResource;
  readonly appSpec: PreparedResource;
  readonly fixtures: PreparedResource;
}>;

export type VueHonoJointRootDeclaration = DefaultRootDeclarationData;

export type VueHonoJointE2eComposition = Readonly<{
  readonly rootPackageDefinitionId: CompositionPackage["packageDefinitionId"];
  readonly rootDeclaration: VueHonoJointRootDeclaration;
}>;

export type VueHonoJointE2eOwnerFacts = Readonly<{
  readonly resources: readonly VueHonoJointE2eResourceSnapshot[];
}>;

function requireResource(
  resources: readonly VueHonoJointE2eResourceSnapshot[],
  path: string,
): PreparedResource {
  const matches = resources.filter((resource) => resource.path === path);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `资源快照缺少联合验收文件：${path}`
        : `资源快照重复包含联合验收文件：${path}`,
    );
  }
  const resource = matches[0]!;
  return Object.freeze({
    content: resource.content.slice(),
    mode: resource.mode & 0o111,
  });
}

/** 从外层准备的不可变字节快照中选出联合验收所需资源。 */
export function prepareVueHonoJointE2eResources(
  resources: readonly VueHonoJointE2eResourceSnapshot[],
): PreparedVueHonoJointE2eResources {
  return Object.freeze({
    configuration: requireResource(
      resources,
      vueHonoJointE2eResourcePaths.configuration,
    ),
    appSpec: requireResource(resources, vueHonoJointE2eResourcePaths.appSpec),
    fixtures: requireResource(resources, vueHonoJointE2eResourcePaths.fixtures),
  });
}

function requireNode(
  selectedPackages: ReadonlyMap<string, DefaultPresetPackageEvaluation>,
  selection: GenerationRecordSelection,
  nodeName: "web" | "api",
): CompositionPackage {
  const packageDefinitionId = selection.nodes[nodeName];
  if (packageDefinitionId === undefined) {
    throw new Error(`Vue-Hono 预设缺少节点 ${nodeName}`);
  }
  const selectedEvaluation = selectedPackages.get(nodeName);
  const selectedPackage = selectedEvaluation?.package;
  if (
    selectedPackage === undefined ||
    selectedPackage.packageDefinitionId !== packageDefinitionId
  ) {
    throw new Error(
      `Vue-Hono 预设节点 ${nodeName} 未解析到本次选择的包实例 ${packageDefinitionId}`,
    );
  }
  return selectedPackage;
}

function sameIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return contentIdentityKey(left) === contentIdentityKey(right);
}

function rootDeclaration(
  api: CompositionPackage,
  web: CompositionPackage,
): VueHonoJointRootDeclaration {
  return Object.freeze({
    manifest: Object.freeze({
      scripts: Object.freeze({ "test:e2e": "playwright test" }),
      devDependencies: Object.freeze({ "@playwright/test": "catalog:" }),
    }),
    turboTasks: Object.freeze({
      "//#test:e2e": Object.freeze({
        cache: false,
        tags: Object.freeze(["quality:heavy"]),
        dependsOn: Object.freeze([
          `${api.definition.name}#build`,
          `${web.definition.name}#build`,
          `${web.definition.name}#browser:prepare`,
        ]),
      }),
    }),
    typescript: Object.freeze({ include: Object.freeze(["test/**/*.ts"]) }),
    ciDiagnosticArtifacts: Object.freeze([
      Object.freeze({
        kind: "playwright" as const,
        owner: Object.freeze({
          kind: "workspace-orchestration" as const,
          path: "." as const,
        }),
      }),
    ]),
    environmentNeeds: Object.freeze({
      check: Object.freeze([
        Object.freeze({
          kind: "playwright-browser-assets" as const,
          browser: "chromium" as const,
          owner: Object.freeze({
            kind: "workspace-orchestration" as const,
            path: "." as const,
          }),
        }),
      ]),
    }),
  });
}

function outputFiles(options: {
  readonly api: CompositionPackage;
  readonly web: CompositionPackage;
  readonly resources: PreparedVueHonoJointE2eResources;
}): readonly DefaultCompositionFile[] {
  let configuration: string;
  try {
    configuration = new TextDecoder("utf-8", { fatal: true }).decode(
      options.resources.configuration.content,
    );
  } catch (cause) {
    throw new Error("Vue-Hono Playwright 配置必须是有效 UTF-8 文本", {
      cause,
    });
  }

  const apiSourceName = options.api.contentIdentity.packageName;
  const webSourceName = options.web.contentIdentity.packageName;
  if (!configuration.includes(JSON.stringify(apiSourceName))) {
    throw new Error(
      `Vue-Hono Playwright 配置缺少 API 原生包名：${apiSourceName}`,
    );
  }
  if (!configuration.includes(JSON.stringify(webSourceName))) {
    throw new Error(
      `Vue-Hono Playwright 配置缺少 Web 原生包名：${webSourceName}`,
    );
  }
  const outputConfiguration = new TextEncoder().encode(
    configuration
      .replaceAll(
        JSON.stringify(apiSourceName),
        JSON.stringify(options.api.definition.name),
      )
      .replaceAll(
        JSON.stringify(webSourceName),
        JSON.stringify(options.web.definition.name),
      ),
  );
  return Object.freeze([
    {
      path: "playwright.config.ts",
      content: outputConfiguration,
      mode: options.resources.configuration.mode,
      sourcePath: vueHonoJointE2eResourcePaths.configuration,
    },
    {
      path: "test/e2e/app.spec.ts",
      content: options.resources.appSpec.content.slice(),
      mode: options.resources.appSpec.mode,
      sourcePath: vueHonoJointE2eResourcePaths.appSpec,
    },
    {
      path: "test/e2e/fixtures.ts",
      content: options.resources.fixtures.content.slice(),
      mode: options.resources.fixtures.mode,
      sourcePath: vueHonoJointE2eResourcePaths.fixtures,
    },
  ]);
}

/** 纯组合此预设本次selection内的web、API实例与owner附件。 */
export function composeVueHonoJointE2e(options: {
  readonly ownerIdentity: ContentIdentity;
  readonly selection: GenerationRecordSelection;
  /** 必须是本次已选择的两节点映射，不传入工作区全实例表。 */
  readonly selectedPackages: ReadonlyMap<
    string,
    DefaultPresetPackageEvaluation
  >;
  /** 默认组合器明确提供的根实例。 */
  readonly rootPackage: CompositionPackage;
  readonly ownerFacts: VueHonoJointE2eOwnerFacts;
}): VueHonoJointE2eComposition {
  if (
    options.selection.presetIdentity === null ||
    !sameIdentity(options.ownerIdentity, options.selection.presetIdentity)
  ) {
    throw new Error(
      `Vue-Hono 组合附件的预设身份与持久选择不匹配：${contentIdentityLabel(options.ownerIdentity)}`,
    );
  }
  if (
    options.rootPackage.definition.path !== "." ||
    options.rootPackage.definition.role !== "native-package"
  ) {
    throw new Error("Vue-Hono 组合必须接收明确的native-package根实例");
  }

  const web = requireNode(options.selectedPackages, options.selection, "web");
  const api = requireNode(options.selectedPackages, options.selection, "api");
  const nodeNames = Object.keys(options.selection.nodes).toSorted();
  if (nodeNames.join(",") !== "api,web") {
    throw new Error("Vue-Hono 持久选择必须只包含 api 与 web 两个节点");
  }
  if (options.selectedPackages.size !== nodeNames.length) {
    throw new Error("Vue-Hono 组合只接收本次选择的 api 与 web 包实例");
  }
  if (web.packageDefinitionId === api.packageDefinitionId) {
    throw new Error("Vue-Hono 预设的 web 与 API 必须是不同包实例");
  }
  if (
    web.packageDefinitionId === options.rootPackage.packageDefinitionId ||
    api.packageDefinitionId === options.rootPackage.packageDefinitionId
  ) {
    throw new Error("Vue-Hono 的 web 与 API 节点不能复用基础根实例");
  }
  for (const [label, selectedPackage] of [
    ["web", web],
    ["API", api],
  ] as const) {
    if (selectedPackage.definition.role !== "runtime-service") {
      throw new Error(
        `Vue-Hono 预设要求 ${label} 实例 ${selectedPackage.definition.name} (${selectedPackage.definition.path}) 的角色为 runtime-service，实际为 ${selectedPackage.definition.role}`,
      );
    }
  }
  if (
    web.dependencyBindings[honoApiDependencyKey] !== api.packageDefinitionId
  ) {
    throw new Error(
      `Vue-Hono 预设的 web 实例 ${web.definition.name} (${web.definition.path}) 必须绑定到本次选择的 API 实例 ${api.definition.name} (${api.definition.path})`,
    );
  }

  const preparedResources = prepareVueHonoJointE2eResources(
    options.ownerFacts.resources,
  );
  return Object.freeze({
    rootPackageDefinitionId: options.rootPackage.packageDefinitionId,
    rootDeclaration: Object.freeze({
      ...rootDeclaration(api, web),
      files: outputFiles({ api, web, resources: preparedResources }),
    }),
  });
}
