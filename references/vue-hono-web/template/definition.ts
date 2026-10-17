import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-core/module-graph";
import { defineReferencePackage } from "@ykdz/template-core/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vue-hono-web",
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: "vue-hono-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  resources: ["."],
  authoring: {
    dependencies: ["@ykdz/template-core", "typescript-7"],
    scripts: ["build:template"],
    resources: ["template", "template-dist", "tsconfig.template.json"],
  },
  foundation: ({ definition, bindings }) => {
    const api = bindings?.get("@ykdz/reference-hono-api");
    if (api === undefined) throw new Error("缺少已明确关联的 API 包实例");
    return {
      vueHonoJointE2e: {
        kind: "vue-hono-joint-e2e",
        apiPackageName: api.name,
      },
      toolchains: {},
      editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
      dependencyMaintenance: {
        ecosystems: ["npm", "github-actions", "docker"],
        interval: "weekly",
      },
      workspacePackageGlobs: [`${definition.path.split("/")[0]}/*`],
    };
  },
  environmentNeeds: ({ definition }) => [
    playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: { kind: "package-boundary", path: definition.path },
    }),
  ],
  project: (contribution, { definition }) => ({
    ...contribution,
    ciDiagnosticArtifacts: [
      {
        kind: "vitest-browser",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
  }),
});
