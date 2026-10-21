import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadContentSource,
  type LoadedSourceMember,
} from "@ykdz/template-generator/content-source";
import type { ReferenceTemplateDependency } from "@ykdz/template-workspace/reference-package";

const sdkPackageEntries = {
  "@ykdz/template-core": "@ykdz/template-core/content-identity",
  "@ykdz/template-generator": "@ykdz/template-generator/content-source",
  "@ykdz/template-workspace": "@ykdz/template-workspace/reference-package",
  "@ykdz/template-workspace-authoring":
    "@ykdz/template-workspace-authoring/content-artifact",
} as const;

function localSdkPackageRoots(): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(sdkPackageEntries).map(([name, specifier]) => {
      const entry = new URL(import.meta.resolve(specifier));
      return [name, fileURLToPath(new URL("../", entry))];
    }),
  );
}

export type AuthoredContentFixtureOptions = {
  readonly namespace: string;
  readonly marker: string;
  /** 为并存的原生同名来源提供可区分的精确坐标。 */
  readonly contentVersion?: string;
  readonly featureMarker?: string;
  readonly featureAlias?: string;
  readonly featureResourcePath?: string;
  readonly featurePackageName?: string;
  readonly featureDependsOnTheme?: boolean;
  readonly featureNativeDevDependencies?: Readonly<Record<string, string>>;
  /** 在原创 reference 入口中写入额外的运行时代码。 */
  readonly featureTemplatePrelude?: readonly string[];
  readonly featureTemplateDependencies?: readonly ReferenceTemplateDependency[];
  readonly addonDependsOnTheme?: boolean;
  readonly addonTemplateDependencies?: readonly ReferenceTemplateDependency[];
  readonly includeTheme?: boolean;
  readonly includeAddon?: boolean;
  readonly sdkVersions?: ReadonlyMap<string, string>;
  readonly toolVersions?: {
    readonly typescript: string;
    readonly nodeTypes: string;
  };
  readonly nativeWorkspace?: boolean;
  readonly deferLoad?: boolean;
  readonly collectionPackageName?: string;
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
  devDependencies: Readonly<Record<string, string>> = {},
  sdkVersions: ReadonlyMap<string, string> = new Map(),
  version = "1.0.0",
): Record<string, unknown> {
  const authoringVersion =
    sdkVersions.get("@ykdz/template-workspace") ?? "workspace:*";
  return {
    name: packageName,
    version,
    private: true,
    type: "module",
    files: ["template-dist"],
    exports: {
      "./reference": "./package.json",
      "./template": {
        source: "./template/definition.ts",
        types: "./template-dist/definition.d.ts",
        default: "./template-dist/definition.js",
      },
    },
    scripts: {
      "build:template":
        "rm -rf template-dist && tsc -p tsconfig.template.json --pretty false",
    },
    dependencies,
    devDependencies: {
      ...devDependencies,
      "@ykdz/template-workspace": authoringVersion,
    },
  };
}

async function writeTemplateBuildFiles(packageRoot: string): Promise<void> {
  await writeFile(
    path.join(packageRoot, "tsconfig.template.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: "template",
          outDir: "template-dist",
          declaration: true,
          resolveJsonModule: true,
          strict: true,
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["template/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

function referenceDefinition(options: {
  readonly packageName: string;
  readonly alias: string;
  readonly defaultLeafName: string;
  readonly instance: "shared" | "independent";
  readonly resourcePath: string;
  readonly templateDependencies?: readonly ReferenceTemplateDependency[];
  readonly templatePrelude?: readonly string[];
}): string {
  const resourceDirectory = path.posix.dirname(options.resourcePath);
  return [
    ...(options.templatePrelude ?? []),
    "",
    'import { defineReferencePackage, type ReferencePackage } from "@ykdz/template-workspace/reference-package";',
    "",
    "export const referencePackage: ReferencePackage = defineReferencePackage({",
    `  packageName: ${JSON.stringify(options.packageName)},`,
    "  resolve: (specifier) => import.meta.resolve(specifier),",
    '  resourceRoot: new URL("../", import.meta.url),',
    `  alias: ${JSON.stringify(options.alias)},`,
    `  instance: ${JSON.stringify(options.instance)},`,
    `  defaultLeafName: ${JSON.stringify(options.defaultLeafName)},`,
    '  role: "shared-library",',
    `  resources: [${JSON.stringify(resourceDirectory)}],`,
    "  template: {",
    `    dependencies: ${JSON.stringify(
      options.templateDependencies ?? [
        {
          name: "@ykdz/template-workspace",
          purpose: "template-execution",
        },
      ],
    )},`,
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
  readonly version: string;
  readonly alias: string;
  readonly defaultLeafName?: string;
  readonly instance: "shared" | "independent";
  readonly resourcePath: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly templateDependencies?: readonly ReferenceTemplateDependency[];
  readonly templatePrelude?: readonly string[];
  readonly sdkVersions: ReadonlyMap<string, string>;
  readonly nativeWorkspace: boolean;
}): Promise<void> {
  const packageRoot = path.join(options.authorsRoot, options.leafName);
  const packageName = options.packageName ?? `@fixture/${options.leafName}`;
  const manifest = packageManifest(
    packageName,
    options.dependencies,
    options.devDependencies,
    options.sdkVersions,
    options.version,
  );
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await mkdir(path.dirname(path.join(packageRoot, options.resourcePath)), {
    recursive: true,
  });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.ts"),
    referenceDefinition({
      packageName,
      alias: options.alias,
      defaultLeafName: options.defaultLeafName ?? options.alias,
      instance: options.instance,
      resourcePath: options.resourcePath,
      ...(options.templatePrelude === undefined
        ? {}
        : { templatePrelude: options.templatePrelude }),
      ...(options.templateDependencies === undefined
        ? {}
        : { templateDependencies: options.templateDependencies }),
    }),
  );
  await writeTemplateBuildFiles(packageRoot);
  await writeFile(
    path.join(packageRoot, options.resourcePath),
    `export const fixtureOrigin = ${JSON.stringify(options.marker)};\n`,
  );
  if (!options.nativeWorkspace) {
    await linkPackage(
      path.join(options.collectionRoot, "node_modules"),
      packageName,
      packageRoot,
    );
  }
}

async function linkPackage(
  nodeModulesRoot: string,
  packageName: string,
  packageRoot: string,
): Promise<void> {
  const parts = packageName.startsWith("@")
    ? packageName.split("/")
    : [packageName];
  const linkPath = path.join(nodeModulesRoot, ...parts);
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(packageRoot, linkPath, "dir");
}

async function writePresetPackage(options: {
  readonly collectionRoot: string;
  readonly authorsRoot: string;
  readonly featurePackageName: string;
  readonly version: string;
  readonly sdkVersions: ReadonlyMap<string, string>;
  readonly nativeWorkspace: boolean;
}): Promise<void> {
  const packageRoot = path.join(options.authorsRoot, "preset");
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      packageManifest(
        "@fixture/preset",
        {
          [options.featurePackageName]: "workspace:*",
          "@ykdz/template-core":
            options.sdkVersions.get("@ykdz/template-core") ?? "workspace:*",
        },
        {
          "@ykdz/template-workspace-authoring":
            options.sdkVersions.get("@ykdz/template-workspace-authoring") ??
            "workspace:*",
        },
        options.sdkVersions,
        options.version,
      ),
      null,
      2,
    ),
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.ts"),
    [
      `import { referencePackage as feature } from ${JSON.stringify(`${options.featurePackageName}/template`)};`,
      'import { definePreset, presetOwnerFromManifest } from "@ykdz/template-core/preset-definition";',
      'import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";',
      'import presetManifest from "../package.json" with { type: "json" };',
      "",
      "export const preset = defineNativeContentArtifact(",
      "  definePreset({",
      '  metadata: { alias: "authored", title: "Authored fixture", description: "An external package fixture." },',
      '  operations: ["init"],',
      '  owner: presetOwnerFromManifest(presetManifest, "./template"),',
      "  nodes: { feature: { reference: feature } },",
      "  }),",
      "  {",
      "    manifest: presetManifest,",
      '    resourceRoot: new URL("../", import.meta.url),',
      '    exportPath: "./template",',
      '    executionDependencies: ["@ykdz/template-workspace-authoring"],',
      "  },",
      ");",
      "",
    ].join("\n"),
  );
  await writeTemplateBuildFiles(packageRoot);
  if (!options.nativeWorkspace) {
    await linkPackage(
      path.join(packageRoot, "node_modules"),
      options.featurePackageName,
      path.join(options.authorsRoot, "feature"),
    );
    await linkPackage(
      path.join(options.collectionRoot, "node_modules"),
      "@fixture/preset",
      packageRoot,
    );
  }
}

/** 创建独立于仓库定义的reference、shared、preset和specifier集合。 */
export async function createAuthoredContentFixture(
  options: AuthoredContentFixtureOptions,
): Promise<AuthoredContentFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "template-authored-content-"));
  const collectionRoot = path.join(root, options.namespace, "collection");
  const authorsRoot = path.join(root, options.namespace, "authors");
  const nodeModulesRoot = path.join(collectionRoot, "node_modules");
  const nativeWorkspace = options.nativeWorkspace ?? false;
  const sdkVersions = options.sdkVersions ?? new Map<string, string>();
  const collectionPackageName =
    options.collectionPackageName ?? "@fixture/authored-content";
  await mkdir(nodeModulesRoot, { recursive: true });

  const featurePackageName = options.featurePackageName ?? "@fixture/feature";
  const featureResourcePath = options.featureResourcePath ?? "src/content.ts";
  await writeReferencePackage({
    collectionRoot,
    authorsRoot,
    leafName: "feature",
    nativeWorkspace,
    sdkVersions,
    packageName: featurePackageName,
    version: options.contentVersion ?? "1.0.0",
    marker: `${options.featureMarker ?? options.marker}:feature`,
    alias: options.featureAlias ?? "feature",
    instance: "independent",
    resourcePath: featureResourcePath,
    dependencies:
      options.featureDependsOnTheme === false
        ? {}
        : { "@fixture/tooling-config": "workspace:*" },
    ...(options.featureNativeDevDependencies === undefined
      ? {}
      : { devDependencies: options.featureNativeDevDependencies }),
    ...(options.featureTemplatePrelude === undefined
      ? {}
      : { templatePrelude: options.featureTemplatePrelude }),
    ...(options.featureTemplateDependencies === undefined
      ? {}
      : { templateDependencies: options.featureTemplateDependencies }),
  });
  await writeReferencePackage({
    collectionRoot,
    authorsRoot,
    leafName: "tooling-config",
    version: options.contentVersion ?? "1.0.0",
    nativeWorkspace,
    sdkVersions,
    marker: `${options.marker}:theme`,
    alias: "theme",
    defaultLeafName: "tooling-config",
    instance: "shared",
    resourcePath: "src/theme.ts",
  });
  await writeReferencePackage({
    collectionRoot,
    authorsRoot,
    leafName: "addon",
    version: options.contentVersion ?? "1.0.0",
    nativeWorkspace,
    sdkVersions,
    marker: `${options.marker}:addon`,
    alias: "addon",
    instance: "independent",
    resourcePath: "src/addon.ts",
    dependencies:
      options.addonDependsOnTheme === true
        ? { "@fixture/tooling-config": "workspace:*" }
        : {},
    ...(options.addonTemplateDependencies === undefined
      ? options.addonDependsOnTheme === true
        ? {
            templateDependencies: [
              { name: "@fixture/tooling-config", purpose: "target" },
            ],
          }
        : {}
      : { templateDependencies: options.addonTemplateDependencies }),
  });
  await writePresetPackage({
    collectionRoot,
    authorsRoot,
    featurePackageName,
    version: options.contentVersion ?? "1.0.0",
    sdkVersions,
    nativeWorkspace,
  });

  const collectionDependencies: Record<string, string> = {
    [featurePackageName]: "workspace:*",
    "@fixture/preset": "workspace:*",
    "@ykdz/template-generator":
      sdkVersions.get("@ykdz/template-generator") ?? "workspace:*",
    "@ykdz/template-workspace":
      sdkVersions.get("@ykdz/template-workspace") ?? "workspace:*",
  };
  if (options.includeTheme !== false) {
    collectionDependencies["@fixture/tooling-config"] = "workspace:*";
  }
  if (options.includeAddon !== false) {
    collectionDependencies["@fixture/addon"] = "workspace:*";
  }
  await writeFile(
    path.join(collectionRoot, "package.json"),
    `${JSON.stringify(
      packageManifest(
        collectionPackageName,
        collectionDependencies,
        {},
        sdkVersions,
        options.contentVersion ?? "1.0.0",
      ),
      null,
      2,
    )}\n`,
  );
  const rootManifest = {
    name: `authored-content-${options.namespace}`,
    private: true,
    type: "module",
    ...(options.toolVersions === undefined
      ? {}
      : {
          devDependencies: {
            typescript: options.toolVersions.typescript,
            "@types/node": options.toolVersions.nodeTypes,
          },
        }),
  };
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(rootManifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    [
      "packages:",
      `  - ${JSON.stringify(`${options.namespace}/authors/*`)}`,
      `  - ${JSON.stringify(`${options.namespace}/collection`)}`,
      "",
    ].join("\n"),
  );
  if (!nativeWorkspace) {
    for (const [name, packageRoot] of localSdkPackageRoots()) {
      await linkPackage(path.join(root, "node_modules"), name, packageRoot);
      await linkPackage(nodeModulesRoot, name, packageRoot);
    }
    if (options.featureDependsOnTheme !== false) {
      await linkPackage(
        path.join(authorsRoot, "feature", "node_modules"),
        "@fixture/tooling-config",
        path.join(authorsRoot, "tooling-config"),
      );
    }
  }

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
      : ["@fixture/tooling-config/template"]),
    ...(options.includeAddon === false ? [] : ["@fixture/addon/template"]),
    "@fixture/preset/template",
  ];
  const load = async (namespace: string) =>
    await loadContentSource({
      namespace,
      resolve,
      members: memberSpecifiers,
    });
  const members = options.deferLoad ? [] : await load(options.namespace);

  return {
    root,
    members,
    resolve,
    load,
    close: async () => await rm(root, { recursive: true, force: true }),
  };
}
