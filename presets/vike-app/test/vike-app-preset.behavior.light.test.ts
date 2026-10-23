import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { databaseDependencyKey as migrationsDatabaseDependencyKey } from "@ykdz/reference-vike-migrations/template";
import { databaseDependencyKey as webDatabaseDependencyKey } from "@ykdz/reference-vike-web/template";
import {
  contentIdentityKey,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";
import { parse as parseYaml } from "yaml";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@ykdz/reference-workspace-root/template",
      load: () => import("@ykdz/reference-workspace-root/template"),
    },
    {
      specifier: "@ykdz/reference-vike-web/template",
      load: () => import("@ykdz/reference-vike-web/template"),
    },
    {
      specifier: "@ykdz/reference-vike-db/template",
      load: () => import("@ykdz/reference-vike-db/template"),
    },
    {
      specifier: "@ykdz/reference-vike-migrations/template",
      load: () => import("@ykdz/reference-vike-migrations/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/preset-vike-app/template",
      load: () => import("@ykdz/preset-vike-app/template"),
    },
  ],
});

type LoadedPresetMember = LoadedContentMember<unknown, "preset">;
type LoadedReferenceMember = LoadedContentMember<unknown, "reference">;

function member(kind: "preset", packageName: string): LoadedPresetMember;
function member(kind: "reference", packageName: string): LoadedReferenceMember;
function member(
  kind: "preset" | "reference",
  packageName: string,
): LoadedContentMember {
  const found = content.find(
    (candidate) =>
      candidate.kind === kind && candidate.identity.packageName === packageName,
  );
  assert.ok(found, `内容集合缺少 ${kind} ${packageName}`);
  return found;
}

function withVikeWebRole(role: string): readonly LoadedContentMember[] {
  const webMember = member("reference", "@ykdz/reference-vike-web");
  const definition = webMember.definition as Record<string, unknown>;
  const createWebDefinition = definition.createDefinition as (
    input: unknown,
  ) => unknown;
  const invalidWeb: LoadedReferenceMember = Object.freeze({
    ...webMember,
    definition: Object.freeze({
      ...definition,
      role,
      createDefinition: (input: unknown) => ({
        ...(createWebDefinition(input) as Record<string, unknown>),
        role,
      }),
    }),
  });
  return content.map((candidate) =>
    candidate === webMember ? invalidWeb : candidate,
  );
}

const preset = member("preset", "@ykdz/preset-vike-app");
const library = member("reference", "@ykdz/reference-ts-lib");
const conventions = {
  repositoryName: "demo",
  defaultPackageScope: "demo",
};
const temporaryRoots = new Set<string>();

async function createTargetRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "template-vike-preset-"));
  temporaryRoots.add(parent);
  return path.join(parent, "demo");
}

async function readJson<T extends Record<string, unknown>>(
  filePath: string,
): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function snapshotTree(targetRoot: string): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }[]
> {
  const files: { path: string; mode: number; content: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        files.push({
          path: relativePath,
          mode: (await stat(absolutePath)).mode & 0o777,
          content: (await readFile(absolutePath)).toString("base64"),
        });
      }
    }
  }
  await visit(targetRoot);
  return files;
}

function generator() {
  return createDefaultGenerator({ content });
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("Vike 应用组合预设公开行为", () => {
  void it("拒绝应用角色不符的预设选择且不写入目标", async () => {
    const targetRoot = await createTargetRoot();
    const invalid = await createDefaultGenerator({
      content: withVikeWebRole("shared-library"),
    }).init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.equal(invalid.status, "operation-failure", JSON.stringify(invalid));
    if (invalid.status === "operation-failure") {
      assert.match(
        invalid.error.message,
        /Vike 应用部署要求应用包具有 runtime-service 角色/u,
      );
    }
    await assert.rejects(access(targetRoot), { code: "ENOENT" });
  });

  void it("绑定独立数据库并合成数据库任务、部署资源与 CI 声明", async () => {
    const targetRoot = await createTargetRoot();
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    if (initialized.status !== "success") return;

    const selection = initialized.generationRecord.selections.find(
      ({ presetIdentity }) =>
        presetIdentity !== null &&
        contentIdentityKey(presetIdentity) ===
          contentIdentityKey(preset.identity),
    );
    assert.ok(selection);
    const packagesById = new Map(
      initialized.generationRecord.packages.map((item) => [
        item.packageDefinitionId,
        item,
      ]),
    );
    const webId = selection.nodes.web;
    const databaseId = selection.nodes.database;
    const migrationsId = selection.nodes.migrations;
    assert.ok(webId && databaseId && migrationsId);
    const web = packagesById.get(webId);
    const database = packagesById.get(databaseId);
    const migrations = packagesById.get(migrationsId);
    assert.ok(web && database && migrations);
    assert.equal(
      web.dependencyBindings[webDatabaseDependencyKey],
      database.packageDefinitionId,
    );
    assert.equal(
      migrations.dependencyBindings[migrationsDatabaseDependencyKey],
      database.packageDefinitionId,
    );
    assert.equal(database.createdBy, "initialization");

    const rootManifest = await readJson<{
      scripts: Record<string, string>;
    }>(path.join(targetRoot, "package.json"));
    assert.equal(
      rootManifest.scripts["database:prepare:dev"],
      "DATABASE_PROFILE=dev pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/db run db:seed:example",
    );
    assert.equal(
      rootManifest.scripts["database:prepare:test"],
      "DATABASE_PROFILE=test pnpm --filter @demo/db run db:reset && DATABASE_PROFILE=test pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=test pnpm --filter @demo/db run db:seed:example",
    );
    assert.equal(
      rootManifest.scripts["database:prepare:e2e"],
      "DATABASE_PROFILE=e2e pnpm --filter @demo/db run db:reset && DATABASE_PROFILE=e2e pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=e2e pnpm --filter @demo/db run db:seed:example",
    );
    assert.equal(
      rootManifest.scripts.dev,
      "pnpm run database:prepare:dev && turbo watch dev --filter=@demo/web",
    );

    const turbo = await readJson<{
      tasks: Record<string, { readonly dependsOn: readonly string[] }>;
    }>(path.join(targetRoot, "turbo.json"));
    assert.deepEqual(turbo.tasks["//#deployment"]?.dependsOn, [
      "@demo/web#build",
      "@demo/web#browser:prepare",
      "@demo/db#build",
      "@demo/db-migrations#build",
    ]);

    const checker = await readFile(
      path.join(targetRoot, "scripts/check-standalone-deployment.ts"),
      "utf8",
    );
    assert.match(checker, /const applicationPackageName = "@demo\/web";/u);
    assert.match(checker, /APPLICATION_PACKAGE_PATH: "apps\/web"/u);
    assert.match(checker, /DATABASE_PACKAGE_NAME: "@demo\/db"/u);
    assert.match(checker, /MIGRATION_PACKAGE_NAME: "@demo\/db-migrations"/u);
    assert.equal(
      (await stat(path.join(targetRoot, "scripts/container-entrypoint.sh")))
        .mode & 0o111,
      0o111,
    );

    const workflow = await readFile(
      path.join(targetRoot, ".github/workflows/check.yml"),
      "utf8",
    );
    assert.match(workflow, /name: Full Check/u);
    assert.match(workflow, /timeout-minutes: 45/u);
    assert.ok(
      workflow.indexOf("id: prepare-deployment") <
        workflow.indexOf("id: run-heavy-check"),
    );
    assert.match(workflow, /uses: docker\/setup-buildx-action@/u);
    assert.match(
      workflow,
      /uses: docker\/setup-buildx-action@[^\s]+ # v4\.4\.1/u,
    );
    const dependabot = parseYaml(
      await readFile(path.join(targetRoot, ".github/dependabot.yml"), "utf8"),
    ) as {
      updates: readonly {
        readonly [key: string]: unknown;
        readonly "package-ecosystem": string;
        readonly directory: string;
      }[];
    };
    assert.ok(
      dependabot.updates.some(
        (update) =>
          update["package-ecosystem"] === "docker" && update.directory === "/",
      ),
    );
    assert.ok(
      initialized.ownerFacts.environmentNeeds.check.some(
        (need) =>
          need.kind === "shellcheck-command" &&
          need.owner.kind === "workspace-orchestration" &&
          need.owner.path === ".",
      ),
    );
    assert.ok(
      initialized.ownerFacts.environmentNeeds.deployment.some(
        (need) => need.kind === "docker-engine",
      ),
    );
  });

  void it("加包校验当前清单、保护读取事实并保留部署组合", async () => {
    const targetRoot = await createTargetRoot();
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    if (initialized.status !== "success") return;

    const databaseManifestPath = path.join(
      targetRoot,
      "packages/db/package.json",
    );
    const originalDatabaseManifest = await readFile(databaseManifestPath);
    const databaseManifest = JSON.parse(
      originalDatabaseManifest.toString("utf8"),
    ) as { scripts: Record<string, unknown> };
    delete databaseManifest.scripts["db:reset"];
    await writeFile(
      databaseManifestPath,
      `${JSON.stringify(databaseManifest, null, 2)}\n`,
    );
    const beforeInvalidAdd = await snapshotTree(targetRoot);
    const invalidAdd = await generator().add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "guide" },
    });
    assert.equal(
      invalidAdd.status,
      "operation-failure",
      JSON.stringify(invalidAdd),
    );
    if (invalidAdd.status === "operation-failure") {
      assert.match(
        invalidAdd.error.message,
        /Vike 数据准备要求 @demo\/db 的 scripts\.db:reset 与来源包保持一致/u,
      );
    }
    assert.deepEqual(await snapshotTree(targetRoot), beforeInvalidAdd);
    await writeFile(databaseManifestPath, originalDatabaseManifest);

    const stagedGenerator = generator();
    const planning = await stagedGenerator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "guide" },
    });
    assert.equal(planning.status, "planned", JSON.stringify(planning));
    if (planning.status !== "planned") return;

    const changedManifest = JSON.parse(
      originalDatabaseManifest.toString("utf8"),
    ) as { scripts: Record<string, unknown> };
    changedManifest.scripts["db:reset"] = "node scripts/reset.mjs --changed";
    await writeFile(
      databaseManifestPath,
      `${JSON.stringify(changedManifest, null, 2)}\n`,
    );
    const beforeStaleCommit = await snapshotTree(targetRoot);
    const staleCommit = await stagedGenerator.commitPlan(planning.plan);
    assert.equal(staleCommit.status, "conflict", JSON.stringify(staleCommit));
    if (staleCommit.status === "conflict") {
      assert.ok(
        staleCommit.conflicts.some(
          ({ path: conflictPath }) =>
            conflictPath === "packages/db/package.json",
        ),
      );
    }
    assert.deepEqual(await snapshotTree(targetRoot), beforeStaleCommit);
    await writeFile(databaseManifestPath, originalDatabaseManifest);

    const recordIds = initialized.generationRecord.packages.map(
      ({ packageDefinitionId }) => packageDefinitionId,
    );
    const added = await generator().add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "guide" },
    });
    assert.equal(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") return;
    assert.ok(
      recordIds.every((packageDefinitionId) =>
        added.generationRecord.packages.some(
          (item) => item.packageDefinitionId === packageDefinitionId,
        ),
      ),
    );
    assert.equal(
      (
        await readJson<{ scripts: Record<string, string> }>(
          path.join(targetRoot, "package.json"),
        )
      ).scripts["database:prepare:dev"],
      "DATABASE_PROFILE=dev pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/db run db:seed:example",
    );

    const beforeRepeatedPresetAdd = await snapshotTree(targetRoot);
    const repeatedPresetAdd = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
    });
    assert.equal(repeatedPresetAdd.status, "operation-failure");
    assert.deepEqual(await snapshotTree(targetRoot), beforeRepeatedPresetAdd);
  });
});
