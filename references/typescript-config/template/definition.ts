export const referenceDefinition = {
  packageName: "@ykdz/reference-typescript-config",
  resolve: (specifier: string) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "typescript-config",
  instance: "shared",
  defaultLeafName: "typescript-config",
  workspaceConfiguration: {
    kind: "typescript-workspace-configuration",
  },
  role: "shared-library",
  resources: ["."],
  template: {
    dependencies: [],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
  },
  environmentNeeds: [],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
} as const;
