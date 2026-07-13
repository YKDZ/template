import { fileURLToPath } from "node:url";

import {
  dockerEngineEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@ykdz/template-core/module-graph";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint-v2";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import { vueTypecheckRunnerSourceOperation } from "../shared/vue.ts";
import { templateSources } from "../template-sources.ts";

function definitions(context: GenerationContext): {
  readonly web: PackageDefinition;
  readonly db: PackageDefinition;
  readonly migrations: PackageDefinition;
} {
  return {
    web: {
      name: `@${context.scope}/web`,
      path: "apps/web",
      role: "runtime-service",
    },
    db: {
      name: `@${context.scope}/db`,
      path: "packages/db",
      role: "shared-library",
    },
    migrations: {
      name: `@${context.scope}/db-migrations`,
      path: "packages/db-migrations",
      role: "shared-library",
    },
  };
}

function foundation(): PackageContribution["foundation"] {
  return {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      directories: { npm: "/", docker: "/.devcontainer" },
      extraDirectories: { docker: ["/apps/web"] },
      interval: "weekly",
    },
    workspacePackageGlobs: ["apps/*", "packages/*"],
  };
}

function webScripts(): Record<string, string> {
  const prepareDatabase =
    "DATABASE_FILE=../../apps/web/data/app.sqlite pnpm --dir ../../packages/db-migrations run db:prepare:dev";
  return {
    build: "vike build",
    deployment: "node scripts/check-standalone-deployment.ts",
    dev: `${prepareDatabase} && vike dev`,
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "shellcheck scripts/container-entrypoint.sh && oxlint --quiet --format=unix --type-aware --config ../../oxlint.config.ts .",
    "lint:fix":
      "oxlint --type-aware --format=unix --config ../../oxlint.config.ts . --fix",
    preview: `${prepareDatabase} && vike preview`,
    start: "node ./dist/server/index.mjs",
    test: "vitest run --reporter=agent --silent=passed-only --passWithNoTests",
    "test:e2e": "node scripts/run-playwright.ts",
    typecheck: "node scripts/run-vue-tsc.ts --build --noEmit --pretty false",
  };
}

function databaseScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.json --noEmit",
    "db:seed:example": "node scripts/seed-example.ts",
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    test: 'DATABASE_FILE="$(pwd)/node_modules/.tmp/test.sqlite" pnpm --dir ../db-migrations run db:prepare:test && DATABASE_FILE="$(pwd)/node_modules/.tmp/test.sqlite" vitest run --reporter=agent --silent=passed-only; status=$?; rm -f ./node_modules/.tmp/test.sqlite; exit $status',
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function migrationScripts(databasePackageName: string): Record<string, string> {
  const withDatabasePackage = (command: string): string =>
    `DATABASE_PACKAGE_NAME=${databasePackageName} ${command}`;
  return {
    build: "tsc -p tsconfig.json --noEmit",
    "db:generate": withDatabasePackage("drizzle-kit generate"),
    "db:migrate": withDatabasePackage("drizzle-kit migrate"),
    "db:prepare:deploy": "pnpm run db:migrate",
    "db:prepare:dev": `DATABASE_PACKAGE_NAME=${databasePackageName} node scripts/prepare-database.ts dev`,
    "db:prepare:test": `DATABASE_PACKAGE_NAME=${databasePackageName} node scripts/prepare-database.ts test`,
    "db:push": withDatabasePackage(
      "mkdir -p data node_modules/.tmp && drizzle-kit push",
    ),
    "db:studio": withDatabasePackage("drizzle-kit studio"),
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function copyOperations(
  packagePath: string,
  sourceFiles: readonly string[],
): RenderOperation[] {
  return sourceFiles.map((from) => ({
    kind: "copyFile" as const,
    source: templateSources.vikeApp,
    from,
    to: `${packagePath}/${from.replace(/^(?:web|db|db-migrations)\//, "")}`,
  }));
}

function webContribution(context: GenerationContext): PackageContribution {
  const { web, db } = definitions(context);
  const sourceFiles = [
    "web/+server.ts",
    "web/.env.example",
    "web/Dockerfile.dockerignore",
    "web/assets/logo.svg",
    "web/components/CounterButton.vue",
    "web/components/PageShell.vue",
    "web/pages/+Head.vue",
    "web/pages/+Layout.vue",
    "web/pages/+config.ts",
    "web/pages/index/+Page.vue",
    "web/pages/tailwind.css",
    "web/playwright.config.ts",
    "web/scripts/check-standalone-deployment.ts",
    "web/scripts/container-entrypoint.sh",
    "web/scripts/run-playwright.ts",
    "web/server/api.ts",
    "web/test/e2e/app.spec.ts",
    "web/turbo.json",
    "web/types/env.d.ts",
    "web/vite.config.ts",
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
    ...copyOperations(web.path, sourceFiles),
    {
      kind: "writeTextTemplate",
      source: templateSources.vikeApp,
      from: "web/Dockerfile",
      to: `${web.path}/Dockerfile`,
      replacements: {
        NODE_VERSION: context.toolchain.nodeLtsMajor,
        PACKAGE_MANAGER_PIN: context.toolchain.packageManagerPin,
        DB_PACKAGE_NAME: definitions(context).db.name,
        DB_MIGRATIONS_PACKAGE_NAME: definitions(context).migrations.name,
        WEB_PACKAGE_NAME: web.name,
      },
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
    {
      kind: "setExecutable",
      path: `${web.path}/scripts/container-entrypoint.sh`,
      executable: true,
    },
  ];
  const owner = { kind: "package-boundary" as const, path: web.path };
  return {
    definition: web,
    exposure: {
      exports: {},
      imports: {
        "#/*": { default: "./*.ts", types: "./*.ts" },
        "#db/*": { default: `${db.name}/*`, types: `${db.name}/*` },
      },
    },
    manifest: {
      name: web.name,
      version: "0.0.0",
      private: true,
      type: "module",
      files: ["dist"],
      imports: {
        "#/*": { default: "./*.ts", types: "./*.ts" },
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
      shellCheckEnvironmentNeed(owner),
    ],
    deploymentEnvironmentNeeds: [dockerEngineEnvironmentNeed()],
    foundation: foundation(),
  };
}

function databaseContribution(context: GenerationContext): PackageContribution {
  const { db } = definitions(context);
  const sourceFiles = [
    "db/turbo.json",
    "db/tsconfig.json",
    "db/scripts/seed-example.ts",
    "db/src/db.ts",
    "db/src/index.ts",
    "db/src/queries/todos.ts",
    "db/src/readiness.ts",
    "db/src/seed/example.ts",
    "db/src/schema.ts",
    "db/src/types.d.ts",
    "db/test/todos.test.ts",
  ] as const;
  const exposure = {
    exports: {
      ".": { default: "./src/index.ts", types: "./src/index.ts" },
      "./schema": { default: "./src/schema.ts", types: "./src/schema.ts" },
      "./types": { default: "./src/types.d.ts", types: "./src/types.d.ts" },
      "./queries/todos": {
        default: "./src/queries/todos.ts",
        types: "./src/queries/todos.ts",
      },
      "./readiness": {
        default: "./src/readiness.ts",
        types: "./src/readiness.ts",
      },
    },
    imports: { "#db/*": { default: "./src/*.ts", types: "./src/*.ts" } },
  };
  return {
    definition: db,
    exposure,
    manifest: {
      name: db.name,
      version: "0.0.0",
      private: true,
      type: "module",
      ...exposure,
      scripts: databaseScripts(),
      dependencies: { "drizzle-orm": "catalog:" },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        "typescript-7": "catalog:",
        vitest: "catalog:",
      },
      engines: { node: context.toolchain.nodeLtsMajor },
    },
    operations: [
      { kind: "writeJson", to: `${db.path}/package.json`, value: {} },
      ...copyOperations(db.path, sourceFiles),
    ],
    environmentNeeds: [],
    foundation: foundation(),
  };
}

function migrationsContribution(
  context: GenerationContext,
): PackageContribution {
  const { db, migrations } = definitions(context);
  const sourceFiles = [
    "db-migrations/drizzle.config.ts",
    "db-migrations/tsconfig.json",
    "db-migrations/drizzle/migrations/20260709120325_old_captain_flint/migration.sql",
    "db-migrations/drizzle/migrations/20260709120325_old_captain_flint/snapshot.json",
    "db-migrations/scripts/prepare-database.ts",
    "db-migrations/turbo.json",
  ] as const;
  return {
    definition: migrations,
    exposure: { exports: {}, imports: {} },
    manifest: {
      name: migrations.name,
      version: "0.0.0",
      private: true,
      type: "module",
      files: ["drizzle.config.ts", "drizzle/migrations"],
      scripts: migrationScripts(db.name),
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
      ...copyOperations(migrations.path, sourceFiles),
    ],
    environmentNeeds: [],
    foundation: foundation(),
  };
}

export const vikeAppDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "vike-app",
    title: "Vike app",
    description:
      "Vike, Hono, Telefunc, Drizzle, and Vue workspace with separate database and migration packages.",
  },
  source: templateSources.vikeApp,
  plannerSourceFile: fileURLToPath(import.meta.url),
  blueprint(context) {
    const { web, db, migrations } = definitions(context);
    return {
      schemaVersion: 2,
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
  planInitialization: webContribution,
  planInitializationContributions(context) {
    return [
      webContribution(context),
      databaseContribution(context),
      migrationsContribution(context),
    ];
  },
};
