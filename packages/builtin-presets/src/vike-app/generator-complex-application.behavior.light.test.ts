import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as database } from "@ykdz/reference-vike-db/template";
import { referencePackage as migrations } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as web } from "@ykdz/reference-vike-web/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { createVikeProjectContents } from "@ykdz/template-builtin-presets";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const configuration = defineReferencePackage(configurationDefinition);
const projectContent = createVikeProjectContents({
  web,
  database,
  nodeIdentities: {
    web: "web",
    database: "database",
    migrations: "migrations",
  },
});

void it("Vike 项目要求用真实 web、数据库和迁移实例生成拓扑并在加包回放", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-generator-vike-project-"),
  );
  const targetRoot = path.join(temporaryRoot, "demo");
  try {
    const generator = createGenerator({
      content: [
        projectContent.web,
        projectContent.database,
        migrations,
        vueShared,
        configuration,
        library,
      ],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "web", contentIdentity: web.identity },
          { nodeIdentity: "database", contentIdentity: database.identity },
          { nodeIdentity: "migrations", contentIdentity: migrations.identity },
        ],
      },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      { consumerPackagePath: "apps/web", providerPackagePath: "packages/db" },
      {
        consumerPackagePath: "packages/db-migrations",
        providerPackagePath: "packages/db",
      },
    ]);
    const rootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(
      rootManifest.scripts["database:prepare:dev"],
      "DATABASE_PROFILE=dev pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/db run db:seed:example",
    );
    assert.strictEqual(
      rootManifest.scripts["deployment"],
      "node --conditions=source scripts/check-standalone-deployment.ts",
    );
    const deployment = JSON.parse(
      await readFile(path.join(targetRoot, "deployment.json"), "utf8"),
    ) as { application: { name: string }; database: { name: string } };
    assert.deepStrictEqual(deployment, {
      application: { name: "@demo/web", path: "apps/web" },
      database: { name: "@demo/db", path: "packages/db" },
      migrations: {
        name: "@demo/db-migrations",
        path: "packages/db-migrations",
      },
    });
    const deploymentScript = path.join(
      targetRoot,
      "scripts/container-entrypoint.sh",
    );
    assert.strictEqual((await stat(deploymentScript)).mode & 0o111, 0o111);
    assert.ok(
      (
        JSON.parse(
          await readFile(
            path.join(targetRoot, ".template/environment-needs.json"),
            "utf8",
          ),
        ) as { deployment: { kind: string }[] }
      ).deployment.some((need) => need.kind === "docker-engine"),
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "domain" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.deepStrictEqual(
      added.status === "success" ? added.blueprint.packageLinkIntents : [],
      [
        { consumerPackagePath: "apps/web", providerPackagePath: "packages/db" },
        {
          consumerPackagePath: "packages/db-migrations",
          providerPackagePath: "packages/db",
        },
      ],
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "deployment.json"), "utf8"),
      ).application.name,
      "@demo/web",
    );
    await readFile(
      path.join(targetRoot, "packages/domain/package.json"),
      "utf8",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
