import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import { typescriptConfigSourceOperation } from "../shared/typescript.ts";
import {
  sharedVueSourceOperations,
  vueApplicationDevelopmentContainerToolLayers,
  vueApplicationExposure,
  vueApplicationManifest,
  vueApplicationScripts,
} from "../shared/vue.ts";
import { templateSources } from "../template-sources.ts";

function apiScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json",
    dev: "node --conditions=source --watch src/server.ts",
    "format:check": "oxfmt --list-different .",
    "format:write": "oxfmt --write .",
    lint: "oxlint --quiet --format=unix .",
    "lint:fix": "oxlint --format=unix . --fix",
    start: "node dist/server.js",
    test: "vitest run --reporter=agent --silent=passed-only",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function webScripts(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(vueApplicationScripts()).filter(
        ([name]) => name !== "test:e2e",
      ),
    ),
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
        vite: "catalog:",
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
  apiDefinition: PackageDefinition,
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
    "vite.config.ts",
    "vitest.config.ts",
    "turbo.json",
    "src/api.ts",
    "src/App.vue",
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
      includePlaywright: false,
    }),
    operations,
    environmentNeeds: [],
    foundation: {
      ...packageFoundation(definition.path),
      vueHonoJointE2e: {
        kind: "vue-hono-joint-e2e",
        apiPackageName: apiDefinition.name,
      },
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
  replay: ({ context, packageDefinition, initialPackages }) =>
    webContribution(context, initialPackages.require("api"), packageDefinition),
});

export const vueHonoAppDefinition = {
  metadata: {
    name: "vue-hono-app",
    title: "Vue Hono 全栈应用",
    description: "采用独立应用包边界的 Vue 与 Hono 全栈工作区。",
  },
  source: templateSources.vueHonoApp,
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [apiReplayAdapter, webReplayAdapter],
  blueprint(context) {
    const api = apiContribution(context);
    const web = webContribution(context, api.definition);
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
    const api = apiContribution(context);
    return [
      apiReplayAdapter.identify(api),
      webReplayAdapter.identify(webContribution(context, api.definition)),
    ];
  },
} satisfies BuiltInPresetDefinition;
import { fileURLToPath } from "node:url";
