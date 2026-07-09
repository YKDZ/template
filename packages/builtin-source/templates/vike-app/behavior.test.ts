import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { vikeAppPresetProjection } from "./projection.js";

const playwrightCliPackage = `@playwright/test@${
  loadTemplateDependencyCatalog()["@playwright/test"]
}`;
const packageJsonSchema = v.looseObject({
  name: v.string(),
  engines: v.object({ node: v.string() }),
  packageManager: v.optional(v.string()),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
  imports: v.optional(v.record(v.string(), v.record(v.string(), v.string()))),
  scripts: v.record(v.string(), v.string()),
});
const devcontainerSchema = v.looseObject({
  build: v.object({
    dockerfile: v.string(),
    args: v.record(v.string(), v.string()),
  }),
  customizations: v.object({
    vscode: v.object({
      extensions: v.array(v.string()),
      settings: v.record(v.string(), v.unknown()),
    }),
  }),
  features: v.optional(v.unknown()),
});

async function readJsonWithSchema<const Schema extends v.GenericSchema>(
  filePath: string,
  schema: Schema,
): Promise<v.InferOutput<Schema>> {
  return v.parse(
    schema,
    JSON.parse(await readFile(filePath, "utf8")) as unknown,
  );
}

async function generatedFilePaths(
  root: string,
  current = ".",
): Promise<string[]> {
  const entries = await readdir(path.join(root, current), {
    withFileTypes: true,
  });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        return generatedFilePaths(root, relativePath);
      }

      return [relativePath.replaceAll(path.sep, "/")];
    }),
  );

  return paths.flat().toSorted();
}

async function renderVikeProject(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "vike-behavior-"));
  const targetDir = path.join(workspace, "demo-vike");
  const blueprint = vikeAppPresetProjection.blueprint({ targetDir });
  const context = assembleGenerationContext({
    blueprint,
    targetDir,
    toolchain: {
      diagnostics: [],
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
      source: "online",
    },
  });

  const plan = vikeAppPresetProjection.project(context);
  await vikeAppPresetProjection.render({ plan, targetDir });

  return targetDir;
}

describe("vike-app Preset Source behavior", () => {
  it("projects a Vike web app with a linked database workspace package", async () => {
    const targetDir = await renderVikeProject();
    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const webPackageJson = await readJsonWithSchema(
      path.join(targetDir, "apps/web/package.json"),
      packageJsonSchema,
    );
    const dbPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/db/package.json"),
      packageJsonSchema,
    );
    const appTsconfig = await readJsonWithSchema(
      path.join(targetDir, "apps/web/tsconfig.app.json"),
      v.object({ include: v.array(v.string()) }),
    );
    const webTsconfig = await readJsonWithSchema(
      path.join(targetDir, "apps/web/tsconfig.json"),
      v.object({ references: v.array(v.object({ path: v.string() })) }),
    );
    const dbTsconfig = await readJsonWithSchema(
      path.join(targetDir, "packages/db/tsconfig.json"),
      v.object({
        compilerOptions: v.object({
          paths: v.record(v.string(), v.array(v.string())),
        }),
      }),
    );
    const dbSource = await readFile(
      path.join(targetDir, "packages/db/src/db.ts"),
      "utf8",
    );
    const todoQueriesSource = await readFile(
      path.join(targetDir, "packages/db/src/queries/todos.ts"),
      "utf8",
    );
    const readinessSource = await readFile(
      path.join(targetDir, "packages/db/src/readiness.ts"),
      "utf8",
    );
    const seedSource = await readFile(
      path.join(targetDir, "packages/db/src/seed/example.ts"),
      "utf8",
    );
    const schemaSource = await readFile(
      path.join(targetDir, "packages/db/src/schema.ts"),
      "utf8",
    );
    const serverSource = await readFile(
      path.join(targetDir, "apps/web/server/app.ts"),
      "utf8",
    );
    const pageSource = await readFile(
      path.join(targetDir, "apps/web/pages/index/+Page.vue"),
      "utf8",
    );
    const playwrightConfigSource = await readFile(
      path.join(targetDir, "apps/web/playwright.config.ts"),
      "utf8",
    );
    const appDockerfile = await readFile(
      path.join(targetDir, "apps/web/Dockerfile"),
      "utf8",
    );
    const appDockerignore = await readFile(
      path.join(targetDir, "apps/web/Dockerfile.dockerignore"),
      "utf8",
    );
    const playwrightRunnerSource = await readFile(
      path.join(targetDir, "apps/web/scripts/run-playwright.ts"),
      "utf8",
    );
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const checkWorkflow = await readFile(
      path.join(targetDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const dependabotConfig = await readFile(
      path.join(targetDir, ".github/dependabot.yml"),
      "utf8",
    );
    const files = await generatedFilePaths(targetDir);

    expect(rootPackageJson).toMatchObject({
      name: "demo-vike",
      engines: { node: "24" },
      packageManager: "pnpm@11.2.3",
    });
    expect(webPackageJson).toMatchObject({
      name: "@demo-vike/web",
      engines: { node: "24" },
    });
    expect(webPackageJson.dependencies).toHaveProperty(
      "@demo-vike/db",
      "workspace:*",
    );
    expect(webPackageJson.scripts["lint:run"]).toBe(
      "oxlint --quiet --format=unix --type-aware --config ../../oxlint.config.ts .",
    );
    expect(webPackageJson.scripts["lint:fix:run"]).toBe(
      "oxlint --type-aware --format=unix --config ../../oxlint.config.ts . --fix",
    );
    expect(dbPackageJson).toMatchObject({
      name: "@demo-vike/db",
      imports: { "#db/*": { default: "./src/*.ts", types: "./src/*.ts" } },
      engines: { node: "24" },
      dependencies: { "drizzle-orm": "catalog:" },
    });
    expect(dbPackageJson.imports).not.toHaveProperty("#/*");
    expect(dbPackageJson.scripts["typecheck:run"]).toBe(
      "tsc -p tsconfig.json --noEmit --pretty false",
    );
    expect(dbPackageJson.scripts).toMatchObject({
      "db:generate": "drizzle-kit generate",
      "db:migrate": "drizzle-kit migrate",
      "db:prepare:deploy": "pnpm run db:migrate",
      "db:prepare:dev": "pnpm run db:push && pnpm run db:seed:example",
      "db:prepare:test":
        'rm -f "${DATABASE_FILE:-./node_modules/.tmp/test.sqlite}" && pnpm run db:push && pnpm run db:seed:example',
      "db:push": "mkdir -p data node_modules/.tmp && drizzle-kit push",
      "db:seed:example":
        "node --experimental-strip-types scripts/seed-example.ts",
      "db:studio": "drizzle-kit studio",
    });
    expect(dbPackageJson.scripts).not.toHaveProperty("db:seed");
    expect(dbPackageJson.scripts).not.toHaveProperty("drizzle:generate");
    expect(dbPackageJson.scripts).not.toHaveProperty("drizzle:migrate");
    expect(dbPackageJson.scripts).not.toHaveProperty("drizzle:studio");
    expect(dbTsconfig.compilerOptions.paths).toEqual({
      "#db/*": ["./src/*"],
    });
    expect(dbSource).toContain('from "#db/schema"');
    expect(dbSource).not.toContain('from "drizzle-orm/node-sqlite/migrator"');
    expect(dbSource).not.toContain("migrate(db");
    expect(dbSource).not.toContain('from "#/');
    expect(readinessSource).toContain("assertDatabaseReady");
    expect(readinessSource).toContain("Database is not ready.");
    expect(seedSource).toContain("seedExampleData");
    expect(seedSource).toContain("Read the generated TODO.md");
    expect(schemaSource).toContain("title: text().notNull().unique()");
    expect(todoQueriesSource).toContain(".prepare()");
    expect(serverSource).toContain("export function createApp()");
    expect(serverSource).toContain("assertDatabaseReady(createDatabase())");
    expect(serverSource).toContain("process.exit(1)");
    expect(pageSource).toContain("onMounted(() =>");
    expect(pageSource).toContain("void refreshTodos();");
    expect(playwrightConfigSource).toContain("db:prepare:test");
    expect(playwrightRunnerSource).toContain("DATABASE_FILE");
    expect(playwrightRunnerSource).toContain("rm(env.DATABASE_FILE!");
    expect(appTsconfig.include).toContain("types/**/*.d.ts");
    expect(webTsconfig.references).toEqual(
      expect.arrayContaining([{ path: "../../packages/db" }]),
    );
    expect(files).toContain("apps/web/types/env.d.ts");
    expect(files).toContain("apps/web/types/global.d.ts");
    expect(files).toContain("apps/web/Dockerfile");
    expect(files).toContain("apps/web/Dockerfile.dockerignore");
    expect(files).toContain(
      "packages/db/drizzle/migrations/20260709120325_old_captain_flint/migration.sql",
    );
    expect(files).toContain(
      "packages/db/drizzle/migrations/20260709120325_old_captain_flint/snapshot.json",
    );
    expect(files).toContain("packages/db/scripts/seed-example.ts");
    expect(files).toContain("packages/db/src/readiness.ts");
    expect(files).toContain("packages/db/src/seed/example.ts");
    expect(files).not.toContain("env.d.ts");
    expect(files).not.toContain("global.d.ts");
    expect(files).not.toContain("behavior.test.ts");
    expect(files).not.toContain("apps/web/behavior.test.ts");
    expect(files).not.toContain("packages/db/behavior.test.ts");

    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
        PLAYWRIGHT_CLI_PACKAGE: playwrightCliPackage,
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );
    expect(checkWorkflow).toContain("docker-image:");
    expect(checkWorkflow).toContain("docker/setup-buildx-action@v3");
    expect(checkWorkflow).toContain(
      "docker buildx build --load --file apps/web/Dockerfile --target runtime",
    );
    expect(checkWorkflow).toContain(
      "docker buildx build --load --file apps/web/Dockerfile --target database-preparation",
    );
    expect(dependabotConfig).toContain("directory: /apps/web");
    expect(appDockerfile).toContain("FROM node:24-bookworm-slim AS base");
    expect(appDockerfile).toContain("FROM node:24-bookworm-slim AS runtime");
    expect(appDockerfile).toContain('ARG PACKAGE_MANAGER_PIN="pnpm@11.2.3"');
    expect(appDockerfile).toContain(
      'corepack enable && corepack prepare "$PACKAGE_MANAGER_PIN" --activate',
    );
    expect(appDockerfile).toContain(
      "COPY pnpm-lock.yaml pnpm-workspace.yaml ./",
    );
    expect(appDockerfile.indexOf("pnpm fetch")).toBeLessThan(
      appDockerfile.indexOf("COPY package.json turbo.json ./"),
    );
    expect(appDockerfile).toContain("pnpm fetch");
    expect(appDockerfile).toContain("pnpm install --offline --frozen-lockfile");
    expect(appDockerfile).toContain(
      "pnpm exec turbo prune @demo-vike/web --docker",
    );
    expect(appDockerfile).toContain("AS database-preparation");
    expect(appDockerfile).toContain(
      'CMD ["pnpm", "--dir", "packages/db", "run", "db:prepare:deploy"]',
    );
    expect(appDockerfile).toContain("COPY --from=build --chown=app:nodejs");
    expect(appDockerfile).toContain("USER app");
    expect(appDockerfile).toContain('CMD ["node", "dist/server/index.mjs"]');
    expect(appDockerfile).not.toContain("node:latest");
    expect(appDockerfile).not.toContain("npm install -g");
    expect(appDockerfile).not.toContain("pnpm dlx");
    expect(appDockerignore).toContain("**/node_modules");
    expect(appDockerignore).toContain("*.sqlite");
  });
});
