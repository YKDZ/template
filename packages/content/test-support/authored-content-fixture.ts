import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadContentSource,
  type LoadedSourceMember,
} from "@ykdz/template-generator/content-source";

const defineReferencePackageURL = import.meta
  .resolve("@ykdz/template-workspace-authoring/reference-package");
const definePresetURL = import.meta
  .resolve("@ykdz/template-core/preset-definition");

export type AuthoredContentFixtureOptions = {
  readonly namespace: string;
  readonly marker: string;
  readonly featureMarker?: string;
  readonly featureAlias?: string;
  readonly featureResourcePath?: string;
  readonly featurePackageName?: string;
  readonly includeTheme?: boolean;
  readonly includeAddon?: boolean;
};

export type AuthoredContentFixture = {
  readonly root: string;
  readonly members: readonly LoadedSourceMember[];
  readonly resolve: (specifier: string) => string;
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
    `import { defineReferencePackage } from ${JSON.stringify(defineReferencePackageURL)};`,
    "",
    "export const referencePackage = defineReferencePackage({",
    `  packageName: ${JSON.stringify(options.packageName)},`,
    "  resolve: (specifier) => import.meta.resolve(specifier),",
    '  resourceRoot: new URL("../", import.meta.url),',
    `  alias: ${JSON.stringify(options.alias)},`,
    `  instance: ${JSON.stringify(options.instance)},`,
    `  defaultLeafName: ${JSON.stringify(options.defaultLeafName)},`,
    '  role: "shared-library",',
    `  resources: [${JSON.stringify(resourceDirectory)}],`,
    "  template: {",
    '    dependencies: [{ name: "@ykdz/template-workspace-authoring", purpose: "template-execution" }],',
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
  readonly packageName?: string;
  readonly marker: string;
  readonly alias: string;
  readonly defaultLeafName?: string;
  readonly instance: "shared" | "independent";
  readonly resourcePath: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}): Promise<void> {
  const packageRoot = path.join(options.authorsRoot, options.leafName);
  const packageName = options.packageName ?? `@fixture/${options.leafName}`;
  const manifest = packageManifest(packageName, options.dependencies);
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await mkdir(path.dirname(path.join(packageRoot, options.resourcePath)), {
    recursive: true,
  });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.mjs"),
    referenceDefinition({
      packageName,
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
    path.join(
      scopeDirectory,
      packageName.slice(packageName.lastIndexOf("/") + 1),
    ),
    "dir",
  );
}

async function writePresetPackage(options: {
  readonly collectionRoot: string;
  readonly authorsRoot: string;
  readonly featurePackageName: string;
}): Promise<void> {
  const packageRoot = path.join(options.authorsRoot, "preset");
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      packageManifest("@fixture/preset", {
        [options.featurePackageName]: "workspace:*",
        "@ykdz/template-core": "workspace:*",
      }),
      null,
      2,
    ),
  );
  const packageNodeModules = path.join(packageRoot, "node_modules");
  const fixtureScope = path.join(packageNodeModules, "@fixture");
  await mkdir(packageNodeModules, { recursive: true });
  await mkdir(fixtureScope, { recursive: true });
  await symlink(
    path.join(options.authorsRoot, "feature"),
    path.join(
      fixtureScope,
      options.featurePackageName.slice(
        options.featurePackageName.lastIndexOf("/") + 1,
      ),
    ),
    "dir",
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.mjs"),
    [
      `import { referencePackage as feature } from ${JSON.stringify(`${options.featurePackageName}/template`)};`,
      `import { definePreset, presetOwnerFromManifest } from ${JSON.stringify(definePresetURL)};`,
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

  const featurePackageName = options.featurePackageName ?? "@fixture/feature";
  const featureResourcePath = options.featureResourcePath ?? "src/content.ts";
  await writeReferencePackage({
    collectionRoot,
    authorsRoot,
    leafName: "feature",
    packageName: featurePackageName,
    marker: `${options.featureMarker ?? options.marker}:feature`,
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
  await writePresetPackage({
    collectionRoot,
    authorsRoot,
    featurePackageName,
  });
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
    `${featurePackageName}/template`,
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
    resolve,
    load,
    close: async () => await rm(root, { recursive: true, force: true }),
  };
}
