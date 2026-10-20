import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-environment/module-graph";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vue-hono-web",
  resolve: (specifier) => import.meta.resolve(specifier),
  alias: "vue-hono-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  resources: ["."],
  template: {
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      { name: "@ykdz/template-environment", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace-authoring",
        purpose: "template-execution",
      },
      { name: "typescript-7", purpose: "template-execution" },
    ],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
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
