import type { PackageContribution } from "#template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "#template-core/preset-definition";
import type { PackageDefinition } from "#template-core/project-blueprint";
import type { RenderOperation } from "#template-core/renderer";

import {
  sharedVueSourceOperations,
  vueApplicationDevelopmentContainerToolLayers,
  vueApplicationEnvironmentNeeds,
  vueApplicationExposure,
  vueApplicationManifest,
  vueApplicationScripts,
} from "../shared/vue.ts";
import { templateSources } from "../template-sources.ts";

function packageScripts(): Record<string, string> {
  return {
    ...vueApplicationScripts(),
    typecheck:
      "node --conditions=source scripts/run-vue-tsc.ts --build --noEmit --pretty false",
  };
}

function appContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
  readonly packageDefinition?: PackageDefinition;
}): PackageContribution {
  const definition: PackageDefinition = options.packageDefinition ?? {
    name: `@${options.context.defaultPackageScope}/${options.packageLeafName}`,
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
    ...sharedVueSourceOperations(options.context, definition.path),
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
    environmentNeeds: vueApplicationEnvironmentNeeds(definition.path),
    ciDiagnosticArtifacts: [
      {
        kind: "playwright",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
    foundation: {
      toolchains: {},
      editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
      typescriptConfigurationPackage: { dependency: "required" },
      dependencyMaintenance: {
        ecosystems: ["npm", "github-actions", "docker"],
        interval: "weekly",
      },
      workspacePackageGlobs: [`${definition.path.split("/")[0]}/*`],
      developmentContainerToolLayers:
        vueApplicationDevelopmentContainerToolLayers(),
    },
  };
}

const appReplayAdapter = definePackageContributionReplayAdapter({
  identity: "app",
  replay: ({ context, packageDefinition, packageLeafName }) =>
    appContribution({
      context,
      packageLeafName,
      packagePath: packageDefinition.path,
      packageDefinition,
    }),
});

export const vueAppDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "vue-app",
    title: "Vue app",
    description:
      "Vue app workspace with Vite, Tailwind, Pinia, and test tooling.",
  },
  source: templateSources.vueApp,
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [appReplayAdapter],
  blueprint(context) {
    return {
      schemaVersion: 3,
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
    return appReplayAdapter.identify(
      appContribution({
        context,
        packageLeafName: "web",
        packagePath: "apps/web",
      }),
    );
  },
  defaultPackagePath({ packageLeafName }) {
    return `apps/${packageLeafName}`;
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return appReplayAdapter.identify(
      appContribution({ context, packageLeafName, packagePath }),
    );
  },
};
import { fileURLToPath } from "node:url";
