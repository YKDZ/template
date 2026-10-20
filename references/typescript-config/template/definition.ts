export const referenceDefinition = {
  packageName: "@ykdz/reference-typescript-config",
  resolve: (specifier: string) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "typescript-config",
  instance: "shared",
  defaultLeafName: "typescript-config",
  role: "shared-library",
  resources: ["."],
  template: {
    dependencies: [],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
  },
  environmentNeeds: [],
  foundation: {
    workspaceConfiguration: { kind: "typescript-workspace-configuration" },
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
} as const;
