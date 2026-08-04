import { fileURLToPath } from "node:url";

import type { DevelopmentContainerToolLayer } from "#template-core/development-container-tool-layer";
import {
  dockerEngineEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "#template-core/module-graph";
import type { PackageContribution } from "#template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "#template-core/preset-definition";
import type { PackageDefinition } from "#template-core/project-blueprint-v2";
import type { RenderOperation } from "#template-core/renderer";

import { browserTestDevelopmentContainerToolLayer } from "../shared/development-container.ts";
import { typescriptConfigSourceOperation } from "../shared/typescript.ts";
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

function shellCheckDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  return {
    identity: "shellcheck",
    dockerfile: {
      source: templateSources.vikeApp,
      from: "devcontainer/shellcheck.Dockerfile",
    },
    requires: ["node-pnpm"],
    probes: [
      { identity: "shellcheck", command: "shellcheck", args: ["--version"] },
    ],
  };
}

function dockerClientDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  return {
    identity: "docker-client",
    dockerfile: {
      source: templateSources.vikeApp,
      from: "devcontainer/docker-client.Dockerfile",
    },
    requires: ["node-pnpm"],
    mounts: [
      {
        identity: "docker-socket",
        type: "bind",
        source: "/var/run/docker.sock",
        target: "/var/run/docker.sock",
      },
    ],
    probes: [
      {
        identity: "docker-cli",
        command: "docker",
        args: ["--version"],
        failureMessage:
          "Docker CLI is unavailable; rebuild the Development Container to install the Docker Client Tool Layer.",
      },
      {
        identity: "docker-daemon",
        command: "docker",
        args: ["version"],
        failureMessage:
          "Docker daemon is inaccessible through /var/run/docker.sock; verify the host daemon is running and the standard socket is accessible.",
      },
    ],
  };
}

function webScripts(): Record<string, string> {
  return {
    build: "vike build",
    deployment:
      "node --conditions=source scripts/check-standalone-deployment.ts",
    dev: "vike dev",
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "shellcheck scripts/container-entrypoint.sh && oxlint --quiet --format=unix --type-aware --config ../../oxlint.config.ts .",
    "lint:fix":
      "oxlint --type-aware --format=unix --config ../../oxlint.config.ts . --fix",
    preview: "vike preview",
    start: "node ./dist/server/index.mjs",
    test: "vitest run --reporter=agent --silent=passed-only --passWithNoTests",
    "test:e2e": "playwright test",
    typecheck:
      "node --conditions=source scripts/run-vue-tsc.ts --build --noEmit --pretty false",
  };
}

function databaseScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json --noEmit",
    "db:seed:example": "node --conditions=source scripts/seed-example.ts",
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    test: "vitest run --reporter=agent --silent=passed-only",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function migrationScripts(databasePackageName: string): Record<string, string> {
  const withDatabasePackage = (command: string): string =>
    `DATABASE_PACKAGE_NAME=${databasePackageName} ${command}`;
  return {
    build: "tsc -p tsconfig.build.json --noEmit",
    "db:generate": withDatabasePackage("drizzle-kit generate"),
    "db:migrate": withDatabasePackage("drizzle-kit migrate"),
    "db:prepare:deploy": "pnpm run db:migrate",
    "db:push": withDatabasePackage("drizzle-kit push"),
    "db:studio": withDatabasePackage("drizzle-kit studio"),
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
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
    "web/server/api.ts",
    "web/test/playwright-teardown.ts",
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
    ...copyOperations(context, web.path, sourceFiles),
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
      version: "0.0.0",
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
      shellCheckEnvironmentNeed(owner),
    ],
    ciDiagnosticArtifacts: [{ kind: "playwright", owner }],
    deploymentEnvironmentNeeds: [dockerEngineEnvironmentNeed()],
    foundation: {
      ...foundation(),
      developmentContainerToolLayers: [
        browserTestDevelopmentContainerToolLayer(),
        shellCheckDevelopmentContainerToolLayer(),
        dockerClientDevelopmentContainerToolLayer(),
      ],
    },
  };
}

function databaseContribution(context: GenerationContext): PackageContribution {
  const { db } = definitions(context);
  const sourceFiles = [
    "db/turbo.json",
    "db/tsconfig.json",
    "db/tsconfig.build.json",
    "db/scripts/seed-example.ts",
    "db/vitest.config.ts",
    "db/test/global-setup.ts",
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
      ...copyOperations(context, db.path, sourceFiles),
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
      ...copyOperations(context, migrations.path, sourceFiles),
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
