import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-workspace/default-environment";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vike-web",
  // 私有原生清单未声明 npm 版本，给制品显式提供未发布坐标。
  artifactVersion: "0.0.0",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "vike-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  resources: ["."],
  template: {
    resources: ["template", "tsconfig.template.json"],
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace",
        purpose: "template-execution",
      },
      { name: "typescript-7", purpose: "template-execution" },
    ],
    scripts: [
      "build:template",
      "typecheck:template",
      "check:author-planning-roles",
    ],
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
        kind: "playwright",
        owner: { kind: "package-boundary", path: definition.path },
      },
      {
        kind: "vitest-browser",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
  }),
});
