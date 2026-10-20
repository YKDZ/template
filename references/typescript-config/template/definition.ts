export const referenceDefinition = {
  packageName: "@ykdz/reference-typescript-config",
  resolve: (specifier: string) => import.meta.resolve(specifier),
  alias: "typescript-config",
  instance: "shared",
  defaultLeafName: "typescript-config",
  role: "shared-library",
  resources: ["."],
  authoring: {
    dependencies: [],
    scripts: ["build:template"],
    resources: ["template", "template-dist", "tsconfig.template.json"],
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
