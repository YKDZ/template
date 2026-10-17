import { fileURLToPath } from "node:url";

import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";

import { requireReferencePackage } from "../reference-composition.ts";

const api = requireReferencePackage("@ykdz/reference-hono-api");
const web = requireReferencePackage("@ykdz/reference-vue-hono-web");

function apiDefinition(context: GenerationContext): PackageDefinition {
  return {
    name: `@${context.defaultPackageScope}/api`,
    path: "apps/api",
    role: api.role,
  };
}
function webDefinition(context: GenerationContext): PackageDefinition {
  return {
    name: `@${context.defaultPackageScope}/web`,
    path: "apps/web",
    role: web.role,
  };
}
const apiReplayAdapter = definePackageContributionReplayAdapter({
  identity: "api",
  replay: ({ context, packageDefinition }) =>
    api.contribute({ context, definition: packageDefinition }),
});
const webReplayAdapter = definePackageContributionReplayAdapter({
  identity: "web",
  replay: ({ context, packageDefinition, initialPackages }) =>
    web.contribute({
      context,
      definition: packageDefinition,
      bindings: new Map([[api.manifest.name, initialPackages.require("api")]]),
    }),
});

export const vueHonoAppDefinition = {
  metadata: {
    name: "vue-hono-app",
    title: "Vue Hono 全栈应用",
    description: "采用独立应用包边界的 Vue 与 Hono 全栈工作区。",
  },
  source: web.source("src"),
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [apiReplayAdapter, webReplayAdapter],
  blueprint(context) {
    const apiPackage = apiDefinition(context);
    const webPackage = webDefinition(context);
    return {
      schemaVersion: 3,
      packages: [apiPackage, webPackage],
      packageLinkIntents: [
        {
          consumerPackagePath: webPackage.path,
          providerPackagePath: apiPackage.path,
        },
      ],
    };
  },
  planInitialization(context) {
    return apiReplayAdapter.identify(
      api.contribute({ context, definition: apiDefinition(context) }),
    );
  },
  planInitializationContributions(context) {
    const apiPackage = apiDefinition(context);
    return [
      apiReplayAdapter.identify(
        api.contribute({ context, definition: apiPackage }),
      ),
      webReplayAdapter.identify(
        web.contribute({
          context,
          definition: webDefinition(context),
          bindings: new Map([[api.manifest.name, apiPackage]]),
        }),
      ),
    ];
  },
} satisfies BuiltInPresetDefinition;
