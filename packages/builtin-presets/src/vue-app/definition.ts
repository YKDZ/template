import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint-v2";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import {
  sharedVueSourceOperations,
  vueApplicationChecks,
  vueApplicationEnvironmentNeeds,
  vueApplicationExposure,
  vueApplicationFixes,
  vueApplicationManifest,
  vueApplicationScripts,
} from "../shared/vue.ts";
import { templateSources } from "../template-sources.ts";

function packageScripts(): Record<string, string> {
  return {
    ...vueApplicationScripts(),
    "typecheck:run":
      "node scripts/run-vue-tsc.ts --build --noEmit --pretty false",
  };
}

function appContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
}): PackageContribution {
  const definition: PackageDefinition = {
    name: `@${options.context.scope}/${options.packageLeafName}`,
    path: options.packagePath,
    role: "runtime-service",
  };
  const exposure = vueApplicationExposure;
  const sourceFiles = [
    "env.d.ts",
    "index.html",
    "playwright.config.ts",
    "vite.config.ts",
    "vitest.config.ts",
    "turbo.json",
    "scripts/run-playwright.ts",
    "src/App.vue",
    "test/e2e/app.spec.ts",
  ] as const;
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
    ...sourceFiles.map((from) => ({
      kind: "copyFile" as const,
      source: templateSources.vueApp,
      from,
      to: `${definition.path}/${from.replace("typescript/", "scripts/")}`,
    })),
    ...sharedVueSourceOperations(definition.path),
  ];
  return {
    definition,
    exposure,
    manifest: vueApplicationManifest({
      context: options.context,
      definition,
      scripts: packageScripts(),
    }),
    operations,
    checks: vueApplicationChecks(definition.path),
    fixes: vueApplicationFixes(definition.path),
    environmentNeeds: vueApplicationEnvironmentNeeds(definition.path),
    foundation: {
      toolchains: {},
      editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
      dependencyMaintenance: {
        ecosystems: ["npm", "github-actions", "docker"],
        interval: "weekly",
      },
      workspacePackageGlobs: [`${options.packagePath.split("/")[0]}/*`],
    },
  };
}

export const vueAppDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "vue-app",
    title: "Vue app",
    description:
      "Vue app workspace with Vite, Tailwind, Pinia, and test tooling.",
  },
  source: templateSources.vueApp,
  plannerSourceFile: fileURLToPath(import.meta.url),
  blueprint(context) {
    return {
      schemaVersion: 2,
      packages: [
        appContribution({
          context,
          packageLeafName: "web",
          packagePath: "apps/web",
        }).definition,
      ],
    };
  },
  planInitialization(context) {
    return appContribution({
      context,
      packageLeafName: "web",
      packagePath: "apps/web",
    });
  },
  defaultPackagePath({ packageLeafName }) {
    return `apps/${packageLeafName}`;
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return appContribution({ context, packageLeafName, packagePath });
  },
};
import { fileURLToPath } from "node:url";
