import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-npm-publication",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "npm-publication",
  instance: "shared",
  defaultLeafName: "npm-publication",
  defaultPath: "tools/npm-publication",
  role: "shared-library",
  resources: [
    "README.md",
    "resources/release.yml",
    "resources/setup",
    "scripts",
    "tsconfig.json",
    "tsconfig.scripts.json",
    "turbo.json",
  ],
  template: {
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace",
        purpose: "template-execution",
      },
      { name: "@types/semver", purpose: "target" },
      { name: "@types/semver", purpose: "template-execution" },
      { name: "semver", purpose: "target" },
      { name: "semver", purpose: "template-execution" },
      { name: "tar", purpose: "target" },
      { name: "tar", purpose: "template-execution" },
      {
        name: "validate-npm-package-name",
        purpose: "target",
      },
      {
        name: "validate-npm-package-name",
        purpose: "template-execution",
      },
    ],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
  },
  environmentNeeds: [],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions"],
      interval: "weekly",
    },
  },
});

export { projectPublicationWorkspace } from "./workspace.ts";
export { projectPublicationSetup } from "./setup-workspace.ts";

export {
  normalizePublicationConfiguration,
  publicationTargetDependencies,
  projectPublicationTarget,
  isPublicationEnabled,
} from "./target.ts";
