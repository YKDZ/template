import {
  playwrightBrowserAssetsEnvironmentNeed,
  type FixComponent,
} from "@ykdz/template-core/module-graph";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type { GenerationContext } from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint-v2";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import { templateSources } from "../template-sources.ts";

/** Vue's tooling peers need these repository policy overrides, never Core defaults. */
export const vuePnpmDependencyOverrides = {
  "pinia>typescript": "-",
  "vue>typescript": "-",
} as const;

export const vueApplicationExposure = {
  exports: { ".": { default: "./src/main.ts", types: "./src/main.ts" } },
  imports: { "#/*": { default: "./src/*.ts", types: "./src/*.ts" } },
} as const;

const sharedVueSourceFiles = [
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.test.json",
  "tsconfig.node.json",
  "typescript/run-vue-tsc.ts",
  "src/main.ts",
  "src/style.css",
  "src/stores/counter.ts",
  "test/app.test.ts",
] as const;

export function vueApplicationScripts(): Record<string, string> {
  return {
    build: "vite build",
    dev: "vite",
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix:run":
      "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    preview: "vite preview",
    test: "vitest run --reporter=agent --silent=passed-only",
    "test:e2e": "node scripts/run-playwright.ts",
  };
}

export function sharedVueSourceOperations(
  packagePath: string,
): readonly RenderOperation[] {
  return sharedVueSourceFiles.map((from) => ({
    kind: "copyFile" as const,
    source: templateSources.vue,
    from,
    to: `${packagePath}/${from.replace("typescript/", "scripts/")}`,
  }));
}

/** Vike shares Vue's compiler runner, but owns its distinct Vike source tree. */
export function vueTypecheckRunnerSourceOperation(
  packagePath: string,
): RenderOperation {
  return {
    kind: "copyFile",
    source: templateSources.vue,
    from: "typescript/run-vue-tsc.ts",
    to: `${packagePath}/scripts/run-vue-tsc.ts`,
  };
}

export function vueApplicationFixes(
  packagePath: string,
): readonly FixComponent[] {
  const owner = { kind: "package-boundary" as const, path: packagePath };
  return [
    { kind: "oxc-format-write", owner },
    { kind: "oxc-lint-fix", owner },
  ];
}

export function vueApplicationEnvironmentNeeds(packagePath: string) {
  return [
    playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: { kind: "package-boundary" as const, path: packagePath },
    }),
  ];
}

export function vueApplicationManifest(options: {
  readonly context: GenerationContext;
  readonly definition: PackageDefinition;
  readonly scripts: Record<string, string>;
}): PackageContribution["manifest"] {
  return {
    name: options.definition.name,
    version: "0.0.0",
    private: true,
    type: "module",
    ...vueApplicationExposure,
    scripts: options.scripts,
    dependencies: { pinia: "catalog:", vue: "catalog:" },
    devDependencies: {
      "@playwright/test": "catalog:",
      "@tailwindcss/vite": "catalog:",
      "@types/node": "catalog:",
      "@types/web-bluetooth": "catalog:",
      "@vitejs/plugin-vue": "catalog:",
      "@vue/tsconfig": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      tailwindcss: "catalog:",
      typescript: "catalog:",
      vite: "catalog:",
      vitest: "catalog:",
      "vue-tsc": "catalog:",
    },
    engines: { node: options.context.toolchain.nodeLtsMajor },
  };
}
