import { fileURLToPath } from "node:url";

import { databasePreparation } from "@ykdz/reference-vike-db/template";
import { deploymentCheck } from "@ykdz/reference-vike-web/template";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
  type InitialPackageDefinitionLookup,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";

import { requireReferencePackage } from "../reference-composition.ts";
const web = requireReferencePackage("@ykdz/reference-vike-web");
const database = requireReferencePackage("@ykdz/reference-vike-db");
const migration = requireReferencePackage("@ykdz/reference-vike-migrations");
const deploymentSource = (file: string) => ({
  source: createTemplateSourceHandle(
    fileURLToPath(
      import.meta.resolve("@ykdz/template-workspace/assets/deployment/" + file),
    ),
  ),
  from: ".",
});
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

function webContribution(
  context: GenerationContext,
  topology: VikePackageDefinitions,
): PackageContribution {
  const contribution = web.contribute({
    context,
    definition: topology.web,
    bindings: new Map([[database.manifest.name, topology.db]]),
  });
  return {
    ...contribution,
    foundation: {
      ...contribution.foundation,
      deploymentCheck: deploymentCheck({
        web: topology.web,
        database: topology.db,
        migrations: topology.migrations,
        sources: {
          checker: deploymentSource("scripts/check-standalone-deployment.ts"),
          controlScript: deploymentSource("scripts/container-entrypoint.sh"),
          dockerfile: deploymentSource("Dockerfile"),
          dockerIgnore: deploymentSource(".dockerignore"),
        },
      }),
    },
  };
}
function databaseContribution(
  context: GenerationContext,
  topology: VikePackageDefinitions,
): PackageContribution {
  const contribution = database.contribute({
    context,
    definition: topology.db,
  });
  return {
    ...contribution,
    foundation: {
      ...contribution.foundation,
      databasePreparation: databasePreparation({
        web: topology.web,
        database: topology.db,
        migrations: topology.migrations,
      }),
    },
  };
}
function migrationsContribution(
  context: GenerationContext,
  topology: VikePackageDefinitions,
): PackageContribution {
  return migration.contribute({
    context,
    definition: topology.migrations,
    bindings: new Map([[database.manifest.name, topology.db]]),
  });
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
    source: web.source("src"),
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
