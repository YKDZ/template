import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint-v2";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import {
  sharedVueSourceOperations,
  vueApplicationEnvironmentNeeds,
  vueApplicationExposure,
  vueApplicationManifest,
  vueApplicationScripts,
} from "../shared/vue.ts";
import { templateSources } from "../template-sources.ts";

function apiScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    dev: "node --watch src/server.ts",
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
    typecheck: "node scripts/run-vue-tsc.ts --build --pretty false",
  };
}

function packageFoundation(): PackageContribution["foundation"] {
  return {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: ["apps/*"],
  };
}

function apiContribution(context: GenerationContext): PackageContribution {
  const definition: PackageDefinition = {
    name: `@${context.scope}/api`,
    path: "apps/api",
    role: "runtime-service",
  };
  const exposure = {
    exports: {
      ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
    },
    imports: { "#/*": { default: "./dist/*.js", types: "./src/*.ts" } },
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
    ...sourceFiles.map((from) => ({
      kind: "copyFile" as const,
      source: templateSources.vueHonoApp,
      from: `api/${from}`,
      to: `${definition.path}/${from}`,
    })),
  ];
  return {
    definition,
    exposure,
    manifest: {
      name: definition.name,
      version: "0.0.0",
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
        "tsc-alias": "catalog:",
        "typescript-7": "catalog:",
        vitest: "catalog:",
      },
      engines: { node: context.toolchain.nodeLtsMajor },
    },
    operations,
    environmentNeeds: [],
    foundation: packageFoundation(),
  };
}

function webContribution(context: GenerationContext): PackageContribution {
  const definition: PackageDefinition = {
    name: `@${context.scope}/web`,
    path: "apps/web",
    role: "runtime-service",
  };
  const exposure = vueApplicationExposure;
  const localSourceFiles = [
    "env.d.ts",
    "index.html",
    "playwright.config.ts",
    "vite.config.ts",
    "vitest.config.ts",
    "turbo.json",
    "scripts/run-playwright.ts",
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
    ...sharedVueSourceOperations(definition.path),
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
    foundation: packageFoundation(),
  };
}

export const vueHonoAppDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "vue-hono-app",
    title: "Vue Hono app",
    description:
      "Full-stack Vue and Hono workspace with separated app package boundaries.",
  },
  source: templateSources.vueHonoApp,
  plannerSourceFile: fileURLToPath(import.meta.url),
  blueprint(context) {
    const api = apiContribution(context);
    const web = webContribution(context);
    return {
      schemaVersion: 2,
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
    return apiContribution(context);
  },
  planInitializationContributions(context) {
    return [apiContribution(context), webContribution(context)];
  },
};
import { fileURLToPath } from "node:url";
