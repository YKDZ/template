import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-workspace/default-environment";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

/** Hono API 与 web 之间保持稳定的原生依赖绑定键。 */
export const honoApiDependencyKey = "hono-api";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vue-hono-web",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "vue-hono-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  resources: ["."],
  template: {
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace",
        purpose: "template-execution",
      },
      { name: "typescript-7", purpose: "template-execution" },
    ],
    scripts: ["build:template", "check:author-planning-roles"],
    resources: ["template", "tsconfig.template.json", ".npmignore"],
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
    ],
  }),
});
