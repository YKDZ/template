import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-environment/module-graph";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vue-shared",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "vue-shared",
  instance: "shared",
  defaultLeafName: "vue-shared",
  role: "shared-library",
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
    operations: contribution.operations.map((operation) =>
      operation.kind === "writeJson" &&
      operation.to === `${definition.path}/tsconfig.app.base.json`
        ? { ...operation, multilineArrays: ["extends"] }
        : operation,
    ),
    ciDiagnosticArtifacts: [
      {
        kind: "vitest-browser",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
  }),
});
