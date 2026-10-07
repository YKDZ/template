import { fileURLToPath } from "node:url";

import {
  dockerEngineEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
} from "@ykdz/template-core/module-graph";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
  type InitialPackageDefinitionLookup,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import { browserTestDevelopmentContainerToolLayer } from "../shared/development-container.ts";
import { typescriptConfigSourceOperation } from "../shared/typescript.ts";
import { vueTypecheckRunnerSourceOperation } from "../shared/vue.ts";
import { templateSources } from "../template-sources.ts";

type VikePackageDefinitions = {
  readonly web: PackageDefinition;
  readonly db: PackageDefinition;
  readonly migrations: PackageDefinition;
};

function definitions(context: GenerationContext): VikePackageDefinitions {
  return {
    web: {
      name: `@${context.defaultPackageScope}/web`,
      path: "apps/web",
      role: "runtime-service",
    },
    db: {
      name: `@${context.defaultPackageScope}/db`,
      path: "packages/db",
      role: "shared-library",
    },
    migrations: {
      name: `@${context.defaultPackageScope}/db-migrations`,
      path: "packages/db-migrations",
      role: "shared-library",
    },
  };
}

function replayDefinitions(
  initialPackages: InitialPackageDefinitionLookup,
): VikePackageDefinitions {
  return {
    web: initialPackages.require("web"),
    db: initialPackages.require("database"),
    migrations: initialPackages.require("migrations"),
  };
}

function foundation(
  packageDefinitions: VikePackageDefinitions,
): PackageContribution["foundation"] {
  const workspacePackageGlobs = [
    ...new Set(
      Object.values(packageDefinitions).map(
        (definition) => `${definition.path.split("/")[0]}/*`,
      ),
    ),
  ];
  return {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    typescriptConfigurationPackage: { dependency: "required" },
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      directories: { npm: "/", docker: "/.devcontainer" },
      interval: "weekly",
    },
    workspacePackageGlobs,
  };
}

function webScripts(): Record<string, string> {
  return {
    build: "vike build",
    dev: "DATABASE_PROFILE=dev NODE_OPTIONS=--conditions=source vike dev",
    "format:check": "oxfmt --list-different .",
    "format:write": "oxfmt --write .",
    lint: "oxlint --quiet --format=unix --type-aware .",
    "lint:fix": "oxlint --type-aware --format=unix . --fix",
    preview: "DATABASE_PROFILE=dev vike preview",
    start: "node ./dist/server/index.mjs",
    test: "vitest run --reporter=agent --silent=passed-only --passWithNoTests",
    "test:e2e": "DATABASE_PROFILE=e2e playwright test",
    typecheck:
      "node --conditions=source scripts/run-vue-tsc.ts --build --noEmit --pretty false",
  };
}

function databaseScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json --pretty false",
    "db:seed:example": "node --conditions=source scripts/seed-example.ts",
    "db:reset": "node --conditions=source scripts/reset.ts",
    "format:check": "oxfmt --list-different .",
    "format:write": "oxfmt --write .",
    lint: "oxlint --quiet --format=unix .",
    "lint:fix": "oxlint --format=unix . --fix",
    test: "DATABASE_PROFILE=test NODE_OPTIONS=--conditions=source vitest run --reporter=agent --silent=passed-only",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function migrationScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json --noEmit",
    "db:generate":
      "DATABASE_PROFILE=dev NODE_OPTIONS=--conditions=source drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:prepare:deploy": "pnpm run db:migrate",
    "db:push": "NODE_OPTIONS=--conditions=source drizzle-kit push",
    "db:studio":
      "DATABASE_PROFILE=dev NODE_OPTIONS=--conditions=source drizzle-kit studio",
    "format:check": "oxfmt --list-different .",
    "format:write": "oxfmt --write .",
    lint: "oxlint --quiet --format=unix .",
    "lint:fix": "oxlint --format=unix . --fix",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function copyOperations(
  context: GenerationContext,
  packagePath: string,
  sourceFiles: readonly string[],
): RenderOperation[] {
  const policyConfigs = new Set([
    "web/tsconfig.app.json",
    "web/tsconfig.node.json",
    "db/tsconfig.json",
    "db-migrations/tsconfig.json",
  ]);
  return sourceFiles.map((from) => {
    const to = `${packagePath}/${from.replace(/^(?:web|db|db-migrations)\//, "")}`;
    return policyConfigs.has(from)
      ? typescriptConfigSourceOperation({
          context,
          source: templateSources.vikeApp,
          from,
          to,
        })
      : {
          kind: "copyFile" as const,
          source: templateSources.vikeApp,
          from,
          to,
        };
  });
}

function webContribution(
  context: GenerationContext,
  packageDefinitions = definitions(context),
): PackageContribution {
  const { web, db, migrations } = packageDefinitions;
  const sourceFiles = [
    "web/+server.ts",
    "web/.env.example",
    "web/assets/logo.svg",
    "web/components/CounterButton.vue",
    "web/components/PageShell.vue",
    "web/pages/+Head.vue",
    "web/pages/+Layout.vue",
    "web/pages/+config.ts",
    "web/pages/index/+Page.vue",
    "web/pages/tailwind.css",
    "web/playwright.config.ts",
    "web/server/api.ts",
    "web/test/playwright-teardown.ts",
    "web/test/e2e/app.spec.ts",
    "web/turbo.json",
    "web/types/env.d.ts",
    "web/vitest.config.ts",
    "web/tsconfig.json",
    "web/tsconfig.app.json",
    "web/tsconfig.test.json",
    "web/tsconfig.node.json",
  ] as const;
  const operations: RenderOperation[] = [
    {
      kind: "writeJson",
      to: `${web.path}/package.json`,
      value: {},
      multilineArrays: ["files"],
    },
    ...copyOperations(context, web.path, sourceFiles),
    {
      kind: "writeTextTemplate",
      source: templateSources.vikeApp,
      from: "web/vite.config.ts",
      to: `${web.path}/vite.config.ts`,
      replacements: { DB_PACKAGE_NAME: db.name },
    },
    {
      kind: "copyFile",
      source: templateSources.vikeApp,
      from: "web/pages/index/+Page.telefunc.ts",
      to: `${web.path}/pages/index/+Page.telefunc.ts`,
    },
    {
      kind: "replaceAnchors",
      path: `${web.path}/pages/index/+Page.telefunc.ts`,
      language: "typescript",
      replacements: {
        "db-package-import": `import { createTodo, listTodos } from "${db.name}/queries/todos";`,
      },
    },
    {
      kind: "copyFile",
      source: templateSources.vikeApp,
      from: "web/server/app.ts",
      to: `${web.path}/server/app.ts`,
    },
    {
      kind: "replaceAnchors",
      path: `${web.path}/server/app.ts`,
      language: "typescript",
      replacements: {
        "db-package-import": `import { createDatabase } from "${db.name}";\nimport { assertDatabaseReady } from "${db.name}/readiness";`,
      },
    },
    {
      kind: "copyFile",
      source: templateSources.vikeApp,
      from: "web/types/global.d.ts",
      to: `${web.path}/types/global.d.ts`,
    },
    {
      kind: "replaceAnchors",
      path: `${web.path}/types/global.d.ts`,
      language: "typescript",
      replacements: {
        "db-package-import": `import type { Database } from "${db.name}";`,
      },
    },
    vueTypecheckRunnerSourceOperation(web.path),
  ];
  const owner = { kind: "package-boundary" as const, path: web.path };
  return {
    definition: web,
    exposure: {
      exports: {},
      imports: {
        "#/assets/*": { default: "./assets/*", types: "./assets/*" },
        "#/components/*": {
          default: "./components/*",
          types: "./components/*",
        },
        "#/server/*": { default: "./server/*.ts", types: "./server/*.ts" },
        "#db/*": { default: `${db.name}/*`, types: `${db.name}/*` },
      },
    },
    manifest: {
      name: web.name,
      private: true,
      type: "module",
      files: ["dist"],
      imports: {
        "#/assets/*": { default: "./assets/*", types: "./assets/*" },
        "#/components/*": {
          default: "./components/*",
          types: "./components/*",
        },
        "#/server/*": { default: "./server/*.ts", types: "./server/*.ts" },
        "#db/*": { default: `${db.name}/*`, types: `${db.name}/*` },
      },
      scripts: webScripts(),
      dependencies: {
        "@vikejs/hono": "catalog:",
        hono: "catalog:",
        srvx: "catalog:",
        telefunc: "catalog:",
        vike: "catalog:",
        "vike-vue": "catalog:",
        vue: "catalog:",
      },
      devDependencies: {
        "@playwright/test": "catalog:",
        "@tailwindcss/vite": "catalog:",
        "@types/node": "catalog:",
        "@vitejs/plugin-vue": "catalog:",
        "@vue/tsconfig": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        tailwindcss: "catalog:",
        turbo: "catalog:",
        typescript: "catalog:",
        vite: "catalog:",
        vitest: "catalog:",
        "vue-tsc": "catalog:",
      },
      engines: { node: context.toolchain.nodeLtsMajor },
      packageManager: context.toolchain.packageManagerPin,
    },
    operations,
    environmentNeeds: [
      playwrightBrowserAssetsEnvironmentNeed({ browser: "chromium", owner }),
    ],
    ciDiagnosticArtifacts: [{ kind: "playwright", owner }],
    foundation: {
      ...foundation(packageDefinitions),
      deploymentCheck: {
        kind: "application-container-with-database-migrations",
        applicationPackageName: web.name,
        databasePackageName: db.name,
        migrationPackageName: migrations.name,
        environmentNeeds: [dockerEngineEnvironmentNeed()],
        sources: {
          checker: {
            source: templateSources.vikeApp,
            from: "web/scripts/check-standalone-deployment.ts",
          },
          controlScript: {
            source: templateSources.vikeApp,
            from: "web/scripts/container-entrypoint.sh",
          },
          dockerfile: {
            source: templateSources.vikeApp,
            from: "web/Dockerfile",
          },
          dockerIgnore: {
            source: templateSources.vikeApp,
            from: "web/Dockerfile.dockerignore",
          },
          shellCheckDockerfile: {
            source: templateSources.vikeApp,
            from: "devcontainer/shellcheck.Dockerfile",
          },
        },
      },
      developmentContainerToolLayers: [
        browserTestDevelopmentContainerToolLayer(),
      ],
    },
  };
}

function databaseContribution(
  context: GenerationContext,
  packageDefinitions = definitions(context),
): PackageContribution {
  const { db, migrations, web } = packageDefinitions;
  const sourceFiles = [
    "db/turbo.json",
    "db/tsconfig.json",
    "db/tsconfig.build.json",
    "db/scripts/seed-example.ts",
    "db/scripts/reset.ts",
    "db/src/db.ts",
    "db/src/index.ts",
    "db/src/queries/todos.ts",
    "db/src/readiness.ts",
    "db/src/storage.ts",
    "db/src/seed/example.ts",
    "db/src/schema.ts",
    "db/src/types.ts",
    "db/test/todos.test.ts",
  ] as const;
  const exposure = {
    exports: {
      ".": {
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./queries/todos": {
        source: "./src/queries/todos.ts",
        types: "./dist/queries/todos.d.ts",
        default: "./dist/queries/todos.js",
      },
      "./readiness": {
        source: "./src/readiness.ts",
        types: "./dist/readiness.d.ts",
        default: "./dist/readiness.js",
      },
      "./schema": {
        source: "./src/schema.ts",
        types: "./dist/schema.d.ts",
        default: "./dist/schema.js",
      },
      "./storage": {
        source: "./src/storage.ts",
        types: "./dist/storage.d.ts",
        default: "./dist/storage.js",
      },
      "./types": {
        source: "./src/types.ts",
        types: "./dist/types.d.ts",
      },
    },
    imports: {
      "#db/*": {
        source: "./src/*.ts",
        types: "./dist/*.d.ts",
        default: "./dist/*.js",
      },
    },
  };
  return {
    definition: db,
    exposure,
    manifest: {
      name: db.name,
      private: true,
      type: "module",
      files: ["dist"],
      ...exposure,
      scripts: databaseScripts(),
      dependencies: { "drizzle-orm": "catalog:" },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        "typescript-7": "catalog:",
        vite: "catalog:",
        vitest: "catalog:",
      },
      engines: { node: context.toolchain.nodeLtsMajor },
    },
    operations: [
      {
        kind: "writeJson",
        to: `${db.path}/package.json`,
        value: {},
        multilineArrays: ["files"],
      },
      ...copyOperations(context, db.path, sourceFiles),
    ],
    environmentNeeds: [],
    foundation: {
      ...foundation(packageDefinitions),
      databasePreparation: {
        kind: "sqlite-database-preparation",
        migrationPackageName: migrations.name,
        consumers: [
          { kind: "application-dev", packageName: web.name },
          { kind: "database-test", packageName: db.name },
          { kind: "application-e2e", packageName: web.name },
        ],
      },
    },
  };
}

function migrationsContribution(
  context: GenerationContext,
  packageDefinitions = definitions(context),
): PackageContribution {
  const { db, migrations } = packageDefinitions;
  const sourceFiles = [
    "db-migrations/tsconfig.json",
    "db-migrations/tsconfig.build.json",
    "db-migrations/drizzle/migrations/20260709120325_old_captain_flint/migration.sql",
    "db-migrations/drizzle/migrations/20260709120325_old_captain_flint/snapshot.json",
    "db-migrations/turbo.json",
  ] as const;
  return {
    definition: migrations,
    exposure: { exports: {}, imports: {} },
    manifest: {
      name: migrations.name,
      private: true,
      type: "module",
      files: ["drizzle.config.ts", "drizzle/migrations"],
      scripts: migrationScripts(),
      dependencies: { "drizzle-kit": "catalog:", "drizzle-orm": "catalog:" },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        "typescript-7": "catalog:",
      },
      engines: { node: context.toolchain.nodeLtsMajor },
    },
    operations: [
      {
        kind: "writeJson",
        to: `${migrations.path}/package.json`,
        value: {},
        multilineArrays: ["files"],
      },
      ...copyOperations(context, migrations.path, sourceFiles),
      {
        kind: "writeTextTemplate",
        source: templateSources.vikeApp,
        from: "db-migrations/drizzle.config.ts",
        to: `${migrations.path}/drizzle.config.ts`,
        replacements: { DB_PACKAGE_NAME: db.name },
      },
    ],
    environmentNeeds: [],
    foundation: foundation(packageDefinitions),
  };
}

const webReplayAdapter = definePackageContributionReplayAdapter({
  identity: "web",
  replay: ({ context, initialPackages }) =>
    webContribution(context, replayDefinitions(initialPackages)),
});

const databaseReplayAdapter = definePackageContributionReplayAdapter({
  identity: "database",
  replay: ({ context, initialPackages }) =>
    databaseContribution(context, replayDefinitions(initialPackages)),
});

const migrationsReplayAdapter = definePackageContributionReplayAdapter({
  identity: "migrations",
  replay: ({ context, initialPackages }) =>
    migrationsContribution(context, replayDefinitions(initialPackages)),
});

export function createVikeAppDefinition(
  resolvePackageDefinitions: (
    context: GenerationContext,
  ) => VikePackageDefinitions = definitions,
) {
  return {
    metadata: {
      name: "vike-app",
      title: "Vike 应用",
      description:
        "包含独立数据库和迁移包的 Vike、Hono、Telefunc、Drizzle 与 Vue 工作区。",
    },
    source: templateSources.vikeApp,
    plannerSourceFile: fileURLToPath(import.meta.url),
    packageContributionReplayAdapters: [
      webReplayAdapter,
      databaseReplayAdapter,
      migrationsReplayAdapter,
    ],
    blueprint(context) {
      const { web, db, migrations } = resolvePackageDefinitions(context);
      return {
        schemaVersion: 3,
        packages: [web, db, migrations],
        packageLinkIntents: [
          { consumerPackagePath: web.path, providerPackagePath: db.path },
          {
            consumerPackagePath: migrations.path,
            providerPackagePath: db.path,
          },
        ],
      };
    },
    planInitialization(context) {
      const packageDefinitions = resolvePackageDefinitions(context);
      return webReplayAdapter.identify(
        webContribution(context, packageDefinitions),
      );
    },
    planInitializationContributions(context) {
      const packageDefinitions = resolvePackageDefinitions(context);
      return [
        webReplayAdapter.identify(webContribution(context, packageDefinitions)),
        databaseReplayAdapter.identify(
          databaseContribution(context, packageDefinitions),
        ),
        migrationsReplayAdapter.identify(
          migrationsContribution(context, packageDefinitions),
        ),
      ];
    },
  } satisfies BuiltInPresetDefinition;
}

export const vikeAppDefinition = createVikeAppDefinition();
