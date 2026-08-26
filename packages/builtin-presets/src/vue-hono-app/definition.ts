import type { PackageContribution } from "#template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "#template-core/preset-definition";
import type { PackageDefinition } from "#template-core/project-blueprint";
import type { RenderOperation } from "#template-core/renderer";

import { typescriptConfigSourceOperation } from "../shared/typescript.ts";
import {
  sharedVueSourceOperations,
  vueApplicationDevelopmentContainerToolLayers,
  vueApplicationEnvironmentNeeds,
  vueApplicationExposure,
  vueApplicationManifest,
  vueApplicationScripts,
} from "../shared/vue.ts";
import { templateSources } from "../template-sources.ts";

function apiScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json",
    dev: "node --conditions=source --watch src/server.ts",
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    start: "node dist/server.js",
    test: "vitest run --reporter=agent --silent=passed-only",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function webScripts(): Record<string, string> {
  return {
    ...vueApplicationScripts(),
    typecheck:
      "node --conditions=source scripts/run-vue-tsc.ts --build --noEmit --pretty false",
  };
}

function packageFoundation(
  packagePath: string,
): PackageContribution["foundation"] {
  return {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    typescriptConfigurationPackage: { dependency: "required" },
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: [`${packagePath.split("/")[0]}/*`],
  };
}

function apiContribution(
  context: GenerationContext,
  definition: PackageDefinition = {
    name: `@${context.defaultPackageScope}/api`,
    path: "apps/api",
    role: "runtime-service",
  },
): PackageContribution {
  const exposure = {
    exports: {
      ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
    },
    imports: {
      "#/*": {
        source: "./src/*.ts",
        types: "./src/*.ts",
        default: "./dist/*.js",
      },
    },
  };
  const sourceFiles = [
    "turbo.json",
    "vitest.config.ts",
    "tsconfig.json",
    "tsconfig.build.json",
    "src/index.ts",
    "src/runtime.ts",
    "src/server.ts",
    "test/app.test.ts",
  ] as const;
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
    ...sourceFiles.map((from) =>
      from === "tsconfig.json"
        ? typescriptConfigSourceOperation({
            context,
            source: templateSources.vueHonoApp,
            from: `api/${from}`,
            to: `${definition.path}/${from}`,
          })
        : {
            kind: "copyFile" as const,
            source: templateSources.vueHonoApp,
            from: `api/${from}`,
            to: `${definition.path}/${from}`,
          },
    ),
  ];
  return {
    definition,
    exposure,
    manifest: {
      name: definition.name,
      private: true,
      type: "module",
      ...exposure,
      scripts: apiScripts(),
      dependencies: { "@hono/node-server": "catalog:", hono: "catalog:" },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        "typescript-7": "catalog:",
        vitest: "catalog:",
      },
      engines: { node: context.toolchain.nodeLtsMajor },
    },
    operations,
    environmentNeeds: [],
    foundation: packageFoundation(definition.path),
  };
}

function webContribution(
  context: GenerationContext,
  definition: PackageDefinition = {
    name: `@${context.defaultPackageScope}/web`,
    path: "apps/web",
    role: "runtime-service",
  },
): PackageContribution {
  const exposure = vueApplicationExposure;
  const localSourceFiles = [
    "env.d.ts",
    "index.html",
    "playwright.config.ts",
    "vite.config.ts",
    "vitest.config.ts",
    "turbo.json",
    "src/api.ts",
    "src/App.vue",
    "test/e2e/app.spec.ts",
  ] as const;
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
    ...localSourceFiles.map((from) => ({
      kind: "copyFile" as const,
      source: templateSources.vueHonoApp,
      from: `web/${from}`,
      to: `${definition.path}/${from}`,
    })),
    ...sharedVueSourceOperations(context, definition.path),
  ];
  return {
    definition,
    exposure,
    manifest: vueApplicationManifest({
      context,
      definition,
      scripts: webScripts(),
    }),
    operations,
    environmentNeeds: vueApplicationEnvironmentNeeds(definition.path),
    ciDiagnosticArtifacts: [
      {
        kind: "playwright",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
    foundation: {
      ...packageFoundation(definition.path),
      developmentContainerToolLayers:
        vueApplicationDevelopmentContainerToolLayers(),
    },
  };
}

const apiReplayAdapter = definePackageContributionReplayAdapter({
  identity: "api",
  replay: ({ context, packageDefinition }) =>
    apiContribution(context, packageDefinition),
});

const webReplayAdapter = definePackageContributionReplayAdapter({
  identity: "web",
  replay: ({ context, packageDefinition }) =>
    webContribution(context, packageDefinition),
});

export const vueHonoAppDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "vue-hono-app",
    title: "Vue Hono app",
    description:
      "Full-stack Vue and Hono workspace with separated app package boundaries.",
  },
  source: templateSources.vueHonoApp,
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [apiReplayAdapter, webReplayAdapter],
  blueprint(context) {
    const api = apiContribution(context);
    const web = webContribution(context);
    return {
      schemaVersion: 3,
      packages: [api.definition, web.definition],
      packageLinkIntents: [
        {
          consumerPackagePath: web.definition.path,
          providerPackagePath: api.definition.path,
        },
      ],
    };
  },
  planInitialization(context) {
    return apiReplayAdapter.identify(apiContribution(context));
  },
  planInitializationContributions(context) {
    return [
      apiReplayAdapter.identify(apiContribution(context)),
      webReplayAdapter.identify(webContribution(context)),
    ];
  },
};
import { fileURLToPath } from "node:url";
