import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-core/module-graph";
import { defineReferencePackage } from "@ykdz/template-core/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vue-app",
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: "vue-app",
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
  foundation: ({ definition }) => ({
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: [`${definition.path.split("/")[0]}/*`],
  }),
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
      {
        kind: "playwright",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
  }),
});
