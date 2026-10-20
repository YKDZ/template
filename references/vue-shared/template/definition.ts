import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-core/module-graph";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vue-shared",
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: "vue-shared",
  instance: "shared",
  defaultLeafName: "vue-shared",
  role: "shared-library",
  resources: ["."],
  authoring: {
    dependencies: [
      "@ykdz/template-core",
      "@ykdz/template-workspace-authoring",
      "typescript-7",
    ],
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
