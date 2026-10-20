import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadContentSource,
  type LoadedSourceMember,
} from "@ykdz/template-generator/content-source";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export type AuthoredContentFixtureOptions = {
  readonly namespace: string;
  readonly marker: string;
  readonly featureAlias?: string;
  readonly featureResourcePath?: string;
  readonly includeTheme?: boolean;
  readonly includeAddon?: boolean;
};

export type AuthoredContentFixture = {
  readonly root: string;
  readonly members: readonly LoadedSourceMember[];
  readonly load: (namespace: string) => Promise<readonly LoadedSourceMember[]>;
  readonly close: () => Promise<void>;
};

function packageManifest(
  packageName: string,
  dependencies: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  return {
    name: packageName,
    version: "1.0.0",
    private: true,
    type: "module",
    exports: {
      "./reference": "./package.json",
      "./template": {
        source: "./template/definition.mjs",
        default: "./template/definition.mjs",
      },
      "./assets/*": "./*",
    },
    dependencies,
    devDependencies: {
      "@ykdz/template-workspace-authoring": "workspace:*",
    },
  };
}

function referenceDefinition(options: {
  readonly packageName: string;
  readonly alias: string;
  readonly defaultLeafName: string;
  readonly instance: "shared" | "independent";
  readonly resourcePath: string;
}): string {
  const resourceDirectory = path.posix.dirname(options.resourcePath);
  return [
    'import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";',
    "",
    "export const referencePackage = defineReferencePackage({",
    `  packageName: ${JSON.stringify(options.packageName)},`,
    "  resolve: (specifier) => import.meta.resolve(specifier),",
    `  alias: ${JSON.stringify(options.alias)},`,
    `  instance: ${JSON.stringify(options.instance)},`,
    `  defaultLeafName: ${JSON.stringify(options.defaultLeafName)},`,
    '  role: "shared-library",',
    `  resources: [${JSON.stringify(resourceDirectory)}],`,
    "  authoring: {",
    '    dependencies: ["@ykdz/template-workspace-authoring"],',
    "    scripts: [],",
    "    resources: [],",
    "  },",
    "  foundation: {",
    "    toolchains: {},",
    "    editorCapabilities: [],",
    '    dependencyMaintenance: { ecosystems: ["npm"], interval: "weekly" },',
    "  },",
    "  environmentNeeds: [],",
    "});",
    "",
  ].join("\n");
}

async function writeReferencePackage(options: {
  readonly collectionRoot: string;
  readonly authorsRoot: string;
  readonly leafName: string;
  readonly marker: string;
  readonly alias: string;
  readonly defaultLeafName?: string;
  readonly instance: "shared" | "independent";
  readonly resourcePath: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}): Promise<void> {
  const packageRoot = path.join(options.authorsRoot, options.leafName);
  const manifest = packageManifest(
    `@fixture/${options.leafName}`,
    options.dependencies,
  );
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await mkdir(path.dirname(path.join(packageRoot, options.resourcePath)), {
    recursive: true,
  });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  const packageScopedModules = path.join(packageRoot, "node_modules", "@ykdz");
  await mkdir(path.dirname(packageScopedModules), { recursive: true });
  await symlink(
    path.join(repositoryRoot, "node_modules", "@ykdz"),
    packageScopedModules,
    "dir",
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.mjs"),
    referenceDefinition({
      packageName: `@fixture/${options.leafName}`,
      alias: options.alias,
      defaultLeafName: options.defaultLeafName ?? options.alias,
      instance: options.instance,
      resourcePath: options.resourcePath,
    }),
  );
  await writeFile(
    path.join(packageRoot, options.resourcePath),
    `export const fixtureOrigin = ${JSON.stringify(options.marker)};\n`,
  );
  const scopeDirectory = path.join(
    options.collectionRoot,
    "node_modules",
    "@fixture",
  );
  await mkdir(scopeDirectory, { recursive: true });
  await symlink(
    packageRoot,
    path.join(scopeDirectory, options.leafName),
    "dir",
  );
}

async function writePresetPackage(options: {
  readonly collectionRoot: string;
  readonly authorsRoot: string;
}): Promise<void> {
  const packageRoot = path.join(options.authorsRoot, "preset");
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      packageManifest("@fixture/preset", {
        "@fixture/feature": "workspace:*",
      }),
      null,
      2,
    ),
  );
  const packageNodeModules = path.join(packageRoot, "node_modules");
  const packageYkdzModules = path.join(packageNodeModules, "@ykdz");
  const fixtureScope = path.join(packageNodeModules, "@fixture");
  await mkdir(packageNodeModules, { recursive: true });
  await mkdir(fixtureScope, { recursive: true });
  await symlink(
    path.join(repositoryRoot, "node_modules", "@ykdz"),
    packageYkdzModules,
    "dir",
  );
  await symlink(
    path.join(options.authorsRoot, "feature"),
    path.join(fixtureScope, "feature"),
    "dir",
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.mjs"),
    [
      'import { referencePackage as feature } from "@fixture/feature/template";',
      'import { definePreset, presetOwnerFromManifest } from "@ykdz/template-core/preset-definition";',
      'import presetManifest from "../package.json" with { type: "json" };',
      "",
      "export const preset = definePreset({",
      '  metadata: { alias: "authored", title: "Authored fixture", description: "An external package fixture." },',
      '  operations: ["init"],',
      '  owner: presetOwnerFromManifest(presetManifest, "./template"),',
      "  nodes: { feature: { reference: feature } },",
      "});",
      "",
    ].join("\n"),
  );
  const scopeDirectory = path.join(
    options.collectionRoot,
    "node_modules",
    "@fixture",
  );
  await mkdir(scopeDirectory, { recursive: true });
  await symlink(packageRoot, path.join(scopeDirectory, "preset"), "dir");
}

/** 创建独立于仓库定义的reference、shared、preset和specifier集合。 */
export async function createAuthoredContentFixture(
  options: AuthoredContentFixtureOptions,
): Promise<AuthoredContentFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "template-authored-content-"));
  const collectionRoot = path.join(root, options.namespace, "collection");
  const authorsRoot = path.join(root, options.namespace, "authors");
  const nodeModulesRoot = path.join(collectionRoot, "node_modules");
  await mkdir(nodeModulesRoot, { recursive: true });
  await symlink(
    path.join(repositoryRoot, "node_modules", "@ykdz"),
    path.join(nodeModulesRoot, "@ykdz"),
    "dir",
  );

  const featureResourcePath = options.featureResourcePath ?? "src/content.ts";
  await writeReferencePackage({
    collectionRoot,
    authorsRoot,
    leafName: "feature",
    marker: `${options.marker}:feature`,
    alias: options.featureAlias ?? "feature",
    instance: "independent",
    resourcePath: featureResourcePath,
    dependencies: { "@fixture/typescript-config": "workspace:*" },
  });
  await writeReferencePackage({
    collectionRoot,
    authorsRoot,
    leafName: "typescript-config",
    marker: `${options.marker}:theme`,
    alias: "theme",
    defaultLeafName: "typescript-config",
    instance: "shared",
    resourcePath: "src/theme.ts",
  });
  await writeReferencePackage({
    collectionRoot,
    authorsRoot,
    leafName: "addon",
    marker: `${options.marker}:addon`,
    alias: "addon",
    instance: "independent",
    resourcePath: "src/addon.ts",
  });
  await writePresetPackage({ collectionRoot, authorsRoot });
  const featureScope = path.join(
    authorsRoot,
    "feature",
    "node_modules",
    "@fixture",
  );
  await mkdir(featureScope, { recursive: true });
  await symlink(
    path.join(authorsRoot, "typescript-config"),
    path.join(featureScope, "typescript-config"),
    "dir",
  );

  const collectionModulePath = path.join(collectionRoot, "collection.mjs");
  await writeFile(
    collectionModulePath,
    "export const resolve = (specifier) => import.meta.resolve(specifier);\n",
  );
  const collectionModule = await import(
    pathToFileURL(collectionModulePath).href
  );
  const resolve = collectionModule.resolve as (specifier: string) => string;
  const memberSpecifiers = [
    "@fixture/feature/template",
    ...(options.includeTheme === false
      ? []
      : ["@fixture/typescript-config/template"]),
    ...(options.includeAddon === false ? [] : ["@fixture/addon/template"]),
    "@fixture/preset/template",
  ];
  const load = async (namespace: string) =>
    await loadContentSource({
      namespace,
      resolve,
      members: memberSpecifiers,
    });
  const members = await load(options.namespace);

  return {
    root,
    members,
    load,
    close: async () => await rm(root, { recursive: true, force: true }),
  };
}
