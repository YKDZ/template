import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
import { parse } from "yaml";

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

async function repositorySnapshot(
  repositoryRoot: string,
): Promise<
  Record<string, { readonly content: string; readonly mode: number }>
> {
  const files: Record<string, { content: string; mode: number }> = {};
  for (const entry of await readdir(repositoryRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    files[path.relative(repositoryRoot, filePath)] = {
      content: await readFile(filePath, "utf8"),
      mode: (await stat(filePath)).mode & 0o777,
    };
  }
  return Object.fromEntries(
    Object.entries(files).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

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

    assert.match(
      await readFile(path.join(targetRoot, "pnpm-workspace.yaml"), "utf8"),
      /overrides:\n  pinia>typescript: "-"\n  vue>typescript: "-"/u,
    );
    const dependabot = parse(
      await readFile(path.join(targetRoot, ".github/dependabot.yml"), "utf8"),
    ) as {
      updates: { "package-ecosystem": string; directory: string }[];
    };
    assert.deepStrictEqual(
      dependabot.updates.map(
        ({ "package-ecosystem": ecosystem, directory }) => [
          ecosystem,
          directory,
        ],
      ),
      [
        ["devcontainers", "/"],
        ["npm", "/"],
        ["github-actions", "/"],
        ["docker", "/.devcontainer"],
        ["docker", "/"],
      ],
    );

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

    const databaseManifestPath = path.join(
      targetRoot,
      "packages/db/package.json",
    );
    const databaseManifest = JSON.parse(
      await readFile(databaseManifestPath, "utf8"),
    ) as { scripts: Record<string, string> };
    delete databaseManifest.scripts["db:reset"];
    await writeFile(
      databaseManifestPath,
      JSON.stringify(databaseManifest) + "\n",
    );
    const beforeInvalidAddition = await repositorySnapshot(targetRoot);
    const invalidAddition = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "next" },
    });
    assert.strictEqual(invalidAddition.status, "operation-failure");
    if (invalidAddition.status === "operation-failure") {
      assert.match(
        invalidAddition.error.message,
        /Database Preparation requires exact @demo\/db script db:reset/u,
      );
    }
    assert.deepStrictEqual(
      await repositorySnapshot(targetRoot),
      beforeInvalidAddition,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
