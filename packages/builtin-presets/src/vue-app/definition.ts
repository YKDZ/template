import { fileURLToPath } from "node:url";

import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-workspace-authoring/preset-definition";

import { requireReferencePackage } from "../reference-composition.ts";

const referencePackage = requireReferencePackage("@ykdz/reference-vue-app");

function appContribution(
  context: GenerationContext,
  definition: PackageDefinition = {
    name: `@${context.defaultPackageScope}/web`,
    path: "apps/web",
    role: referencePackage.role,
  },
): PackageContribution {
  referencePackage.prepare();
  return referencePackage.contribute({ context, definition });
}

const appReplayAdapter = definePackageContributionReplayAdapter({
  identity: "app",
  replay: ({ context, packageDefinition }) =>
    appContribution(context, packageDefinition),
});

export const vueAppDefinition = {
  metadata: {
    name: "vue-app",
    title: "Vue 应用",
    description: "使用 Vite、Tailwind、Pinia 和测试工具的 Vue 应用工作区。",
  },
  source: referencePackage.source("src"),
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [appReplayAdapter],
  blueprint(context) {
    return {
      schemaVersion: 3,
      packages: [appContribution(context).definition],
    };
  },
  planInitialization(context) {
    return appReplayAdapter.identify(appContribution(context));
  },
  defaultPackagePath({ packageLeafName }) {
    return `apps/${packageLeafName}`;
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return appReplayAdapter.identify(
      appContribution(context, {
        name: `@${context.defaultPackageScope}/${packageLeafName}`,
        path: packagePath,
        role: referencePackage.role,
      }),
    );
  },
} satisfies BuiltInPresetDefinition;
