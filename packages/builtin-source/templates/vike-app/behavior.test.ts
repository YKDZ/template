import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import { addPackage } from "@ykdz/template-core/package-addition";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "../../src/index.ts";
import { vikeAppPresetProjection } from "./projection.ts";

const playwrightCliPackage = `@playwright/test@${
  loadTemplateDependencyCatalog()["@playwright/test"]
}`;
const execFileAsync = promisify(execFile);
const repositoryDependencies = path.join(
  process.cwd(),
  "packages/builtin-source/node_modules",
);
const repositoryBin = path.join(repositoryDependencies, ".bin");
const packageManagerPinSchema = v.custom<`pnpm@${string}`>(
  (value) => typeof value === "string" && value.startsWith("pnpm@"),
);
const packageJsonSchema = v.looseObject({
  name: v.string(),
  engines: v.object({ node: v.string() }),
  packageManager: v.optional(v.string()),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
  files: v.optional(v.array(v.string())),
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

async function renderVikeProject(
  packageManagerPin: `pnpm@${string}` = "pnpm@11.2.3",
): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "vike-behavior-"));
  const targetDir = path.join(workspace, "demo-vike");
  const blueprint = vikeAppPresetProjection.blueprint({ targetDir });
  const context = assembleGenerationContext({
    blueprint,
    targetDir,
    toolchain: {
      diagnostics: [],
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: {
        kind: "PackageManagerPin",
        value: packageManagerPin,
      },
      source: "online",
    },
  });

  const plan = vikeAppPresetProjection.project(context);
  await vikeAppPresetProjection.render({ plan, targetDir });

  return targetDir;
}

async function linkRepositoryDependencies(targetDir: string): Promise<void> {
  await symlink(
    repositoryDependencies,
    path.join(targetDir, "node_modules"),
    "dir",
  );
}

async function databaseReadiness(databaseFile: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.DATABASE_FILE); const table = db.prepare("select name from sqlite_master where type = \'table\' and name = \'todos\'").get()?.name; const rows = db.prepare("select count(*) as count from todos").get()?.count; console.log(`${table}:${rows}`);',
    ],
    { env: { ...process.env, DATABASE_FILE: databaseFile } },
  );

  return stdout.trim();
}

async function availablePort(): Promise<number> {
  const server = createServer();

  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForHttpResponse(
  url: string,
  server: ReturnType<typeof spawn>,
): Promise<Response> {
  const timeoutAt = Date.now() + 15_000;

  while (Date.now() < timeoutAt) {
    if (server.exitCode !== null) {
      throw new Error(
        `Server exited before becoming ready (${server.exitCode})`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The port is not accepting requests yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChildProcess(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (child.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function repositoryTscIdentity(): Promise<{
  linkTarget: string | undefined;
  modifiedAt: number;
  version: string;
}> {
  const tscPath = path.join(repositoryBin, "tsc");
  const metadata = await lstat(tscPath);
  const [{ stdout }, linkTarget] = await Promise.all([
    execFileAsync(tscPath, ["--version"]),
    metadata.isSymbolicLink() ? readlink(tscPath) : undefined,
  ]);

  return {
    linkTarget,
    modifiedAt: metadata.mtimeMs,
    version: stdout.trim(),
  };
}

async function fakeContainerCommandEnvironment(targetDir: string): Promise<{
  databaseFile: string;
  env: NodeJS.ProcessEnv;
  observationFile: string;
}> {
  const fakeBinDir = path.join(targetDir, "fake-container-bin");
  const observationFile = path.join(targetDir, "container-observation.txt");
  const databaseFile = path.join(targetDir, "mounted-data", "app.sqlite");
  await mkdir(fakeBinDir);
  await writeFile(
    path.join(fakeBinDir, "drizzle-kit"),
    `#!/bin/sh
echo prepare >> "$CONTAINER_OBSERVATION_FILE"
exit "\${CONTAINER_PREPARE_EXIT_CODE:-0}"
`,
  );
  await writeFile(
    path.join(fakeBinDir, "node"),
    `#!/bin/sh
echo start >> "$CONTAINER_OBSERVATION_FILE"
`,
  );
  await chmod(path.join(fakeBinDir, "drizzle-kit"), 0o755);
  await chmod(path.join(fakeBinDir, "node"), 0o755);

  return {
    databaseFile,
    env: {
      ...process.env,
      CONTAINER_OBSERVATION_FILE: observationFile,
      DATABASE_FILE: databaseFile,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
    },
    observationFile,
  };
}

async function fakeDockerEnvironment(
  targetDir: string,
  port: number,
  playwrightExitCode = 0,
  dockerBuildOutputBytes = 0,
  dockerFailurePattern = "",
  unpreparedPort = 1,
): Promise<{
  dockerObservationFile: string;
  env: NodeJS.ProcessEnv;
  playwrightObservationFile: string;
}> {
  const fakeBinDir = path.join(targetDir, "fake-docker-bin");
  const dockerObservationFile = path.join(targetDir, "docker-commands.txt");
  const playwrightObservationFile = path.join(
    targetDir,
    "deployment-playwright.txt",
  );
  await mkdir(fakeBinDir);
  await writeFile(
    path.join(fakeBinDir, "docker"),
    `#!/bin/sh
echo "$*" >> "$DOCKER_OBSERVATION_FILE"
if [ -n "$FAKE_DOCKER_FAILURE_PATTERN" ] && echo "$*" | grep -F -- "$FAKE_DOCKER_FAILURE_PATTERN" >/dev/null; then
  echo "fake docker stdout failure for $*"
  echo "fake docker stderr failure for $*" >&2
  exit 23
fi
case "$1" in
  build)
    if [ ! -f apps/web/Dockerfile ]; then
      echo "Docker build must run from the repository root" >&2
      exit 24
    fi
    if [ "$FAKE_DOCKER_BUILD_OUTPUT_BYTES" -gt 0 ]; then
      head -c "$FAKE_DOCKER_BUILD_OUTPUT_BYTES" /dev/zero | tr '\\0' x
    fi
    ;;
  port)
    case "$*" in
      *unprepared*) echo "127.0.0.1:$FAKE_UNPREPARED_DOCKER_PORT" ;;
      *) echo "127.0.0.1:$FAKE_DOCKER_PORT" ;;
    esac
    ;;
  inspect)
    case "$*" in
      *State.Status*unprepared*) echo "exited:17" ;;
      *State.Status*) echo "exited:0" ;;
      *) echo true ;;
    esac
    ;;
  logs)
    case "$*" in
      *unprepared*) echo "Database is not ready." ;;
      *) echo "fake container stdout diagnostics" ;;
    esac
    echo "fake container stderr diagnostics" >&2
    ;;
  volume) [ "$2" = create ] && echo fake-volume || true ;;
  run)
    echo fake-container
    ;;
esac
`,
  );
  await writeFile(
    path.join(fakeBinDir, "pnpm"),
    `#!/bin/sh
if [ "$1" = "--dir" ] && [ ! -f "$2/package.json" ]; then
  echo "Playwright must run from the repository root" >&2
  exit 25
fi
echo "$PLAYWRIGHT_EXTERNAL_BASE_URL" >> "$PLAYWRIGHT_OBSERVATION_FILE"
if [ "$PLAYWRIGHT_EXIT_CODE" -ne 0 ]; then
  echo "fake playwright stdout failure"
  echo "fake playwright stderr failure" >&2
fi
exit "$PLAYWRIGHT_EXIT_CODE"
`,
  );
  await chmod(path.join(fakeBinDir, "docker"), 0o755);
  await chmod(path.join(fakeBinDir, "pnpm"), 0o755);

  return {
    dockerObservationFile,
    env: {
      ...process.env,
      DOCKER_OBSERVATION_FILE: dockerObservationFile,
      FAKE_DOCKER_BUILD_OUTPUT_BYTES: String(dockerBuildOutputBytes),
      FAKE_DOCKER_FAILURE_PATTERN: dockerFailurePattern,
      FAKE_DOCKER_PORT: String(port),
      FAKE_UNPREPARED_DOCKER_PORT: String(unpreparedPort),
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      PLAYWRIGHT_EXIT_CODE: String(playwrightExitCode),
      PLAYWRIGHT_OBSERVATION_FILE: playwrightObservationFile,
    },
    playwrightObservationFile,
  };
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
    const migrationsPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/db-migrations/package.json"),
      packageJsonSchema,
    );
    const vueToolingPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/vue-tooling/package.json"),
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
        include: v.array(v.string()),
      }),
    );
    const migrationsTsconfig = await readJsonWithSchema(
      path.join(targetDir, "packages/db-migrations/tsconfig.json"),
      v.object({ include: v.array(v.string()) }),
    );
    const migrationsTurboConfig = await readJsonWithSchema(
      path.join(targetDir, "packages/db-migrations/turbo.json"),
      v.object({
        tasks: v.object({
          "build:run": v.object({ dependsOn: v.array(v.string()) }),
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
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
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
    const containerEntrypointSource = await readFile(
      path.join(targetDir, "apps/web/scripts/container-entrypoint.sh"),
      "utf8",
    );
    const standaloneDeploymentRunnerSource = await readFile(
      path.join(targetDir, "apps/web/scripts/check-standalone-deployment.ts"),
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
    expect(rootPackageJson.scripts["check:deployment"]).toBe(
      "pnpm --filter './apps/web' run check:deployment",
    );
    expect(rootPackageJson.devDependencies).toHaveProperty(
      "typescript-7",
      "catalog:",
    );
    expect(rootPackageJson.devDependencies).not.toHaveProperty("typescript");
    expect(webPackageJson).toMatchObject({
      name: "@demo-vike/web",
      engines: { node: "24" },
    });
    expect(webPackageJson.dependencies).not.toHaveProperty("@demo-vike/db");
    expect(webPackageJson.devDependencies).toHaveProperty(
      "@demo-vike/db",
      "workspace:*",
    );
    expect(webPackageJson.files).toEqual(["dist"]);
    expect(webPackageJson.dependencies).toHaveProperty(
      "drizzle-orm",
      "catalog:",
    );
    expect(webPackageJson.dependencies).toHaveProperty("srvx", "catalog:");
    expect(webPackageJson.scripts["lint:run"]).toBe(
      "shellcheck scripts/container-entrypoint.sh && oxlint --quiet --format=unix --type-aware --config ../../oxlint.config.ts .",
    );
    expect(webPackageJson.scripts["lint:fix:run"]).toBe(
      "oxlint --type-aware --format=unix --config ../../oxlint.config.ts . --fix",
    );
    expect(webPackageJson.scripts["check:deployment"]).toBe(
      "node scripts/check-standalone-deployment.ts",
    );
    expect(webPackageJson.scripts["test:e2e:run"]).toBe(
      "node scripts/run-playwright.ts",
    );
    expect(webPackageJson.scripts["typecheck:run"]).toBe(
      "pnpm --dir ../../packages/vue-tooling run check --build ../../apps/web/tsconfig.json --noEmit --pretty false",
    );
    expect(webPackageJson.devDependencies).not.toHaveProperty("typescript");
    expect(webPackageJson.devDependencies).not.toHaveProperty("vue-tsc");
    expect(webPackageJson.devDependencies).not.toHaveProperty("@vue/tsconfig");
    expect(webPackageJson.devDependencies).toHaveProperty(
      "@demo-vike/vue-tooling",
      "workspace:*",
    );
    expect(webPackageJson.devDependencies).not.toHaveProperty("typescript-7");
    expect(vueToolingPackageJson).toMatchObject({
      name: "@demo-vike/vue-tooling",
      private: true,
      scripts: { check: "node run-vue-tsc.ts" },
      devDependencies: {
        "@vue/tsconfig": "catalog:",
        typescript: "catalog:",
        "typescript-7": "catalog:",
        "vue-tsc": "catalog:",
      },
    });
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
    expect(dbPackageJson.devDependencies).toHaveProperty(
      "typescript-7",
      "catalog:",
    );
    expect(dbPackageJson.devDependencies).not.toHaveProperty("typescript");
    expect(dbPackageJson.scripts).toMatchObject({
      "db:seed:example": "node scripts/seed-example.ts",
      "test:run":
        'DATABASE_FILE="$(pwd)/node_modules/.tmp/test.sqlite" pnpm --dir ../db-migrations run db:prepare:test && DATABASE_FILE="$(pwd)/node_modules/.tmp/test.sqlite" vitest run --reporter=agent --silent=passed-only; status=$?; rm -f ./node_modules/.tmp/test.sqlite; exit $status',
    });
    expect(dbPackageJson.scripts).not.toHaveProperty("db:generate");
    expect(dbPackageJson.scripts).not.toHaveProperty("db:migrate");
    expect(dbPackageJson.scripts).not.toHaveProperty("db:push");
    expect(dbPackageJson.scripts).not.toHaveProperty("db:studio");
    expect(dbPackageJson.devDependencies).not.toHaveProperty("drizzle-kit");
    expect(migrationsPackageJson).toMatchObject({
      name: "@demo-vike/db-migrations",
      private: true,
      engines: { node: "24" },
      dependencies: {
        "drizzle-kit": "catalog:",
        "drizzle-orm": "catalog:",
      },
      devDependencies: {
        "@demo-vike/db": "workspace:*",
      },
    });
    expect(migrationsPackageJson.files).toEqual([
      "drizzle.config.ts",
      "drizzle/migrations",
    ]);
    expect(migrationsPackageJson.scripts).toMatchObject({
      "db:generate": "drizzle-kit generate",
      "db:migrate": "drizzle-kit migrate",
      "db:prepare:deploy": "pnpm run db:migrate",
      "db:prepare:dev": "node scripts/prepare-database.ts dev",
      "db:prepare:test": "node scripts/prepare-database.ts test",
      "db:push": "mkdir -p data node_modules/.tmp && drizzle-kit push",
      "db:studio": "drizzle-kit studio",
    });
    expect(migrationsPackageJson.scripts).not.toHaveProperty("db:seed:example");
    expect(migrationsPackageJson.devDependencies).toHaveProperty(
      "typescript-7",
      "catalog:",
    );
    expect(migrationsPackageJson.devDependencies).not.toHaveProperty(
      "typescript",
    );
    expect(dbTsconfig.compilerOptions.paths).toEqual({
      "#db/*": ["./src/*"],
    });
    expect(dbTsconfig.include).toContain("scripts/**/*.ts");
    expect(dbTsconfig.include).not.toContain("drizzle.config.ts");
    expect(migrationsTsconfig.include).toEqual([
      "drizzle.config.ts",
      "scripts/**/*.ts",
    ]);
    expect(migrationsTurboConfig.tasks["build:run"].dependsOn).toEqual([
      "^build:run",
    ]);
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
    expect(playwrightConfigSource).toContain("PLAYWRIGHT_EXTERNAL_BASE_URL");
    expect(playwrightConfigSource).toContain("...(externalServiceUrl");
    expect(playwrightConfigSource).toContain('trace: "retain-on-failure"');
    expect(playwrightRunnerSource).toContain("DATABASE_FILE");
    expect(playwrightRunnerSource).toContain("awaitExternalService");
    expect(playwrightRunnerSource).toContain("localDatabaseFile");
    expect(playwrightRunnerSource).toContain("PLAYWRIGHT_EXTERNAL_BASE_URL");
    expect(playwrightRunnerSource).toContain("must be a valid HTTP(S) URL");
    expect(appTsconfig.include).toContain("types/**/*.d.ts");
    expect(webTsconfig.references).toEqual(
      expect.arrayContaining([{ path: "../../packages/db" }]),
    );
    expect(files).toContain("apps/web/types/env.d.ts");
    expect(files).toContain("apps/web/types/global.d.ts");
    expect(files).toContain("apps/web/Dockerfile");
    expect(files).toContain("apps/web/Dockerfile.dockerignore");
    expect(files).toContain("apps/web/scripts/container-entrypoint.sh");
    expect(files).not.toContain("apps/web/scripts/prepare-database.sh");
    expect(files).toContain("apps/web/scripts/check-standalone-deployment.ts");
    expect(files).toContain(
      "packages/db-migrations/drizzle/migrations/20260709120325_old_captain_flint/migration.sql",
    );
    expect(files).toContain(
      "packages/db-migrations/drizzle/migrations/20260709120325_old_captain_flint/snapshot.json",
    );
    expect(files).toContain("packages/db-migrations/drizzle.config.ts");
    expect(files).toContain("packages/vue-tooling/run-vue-tsc.ts");
    expect(files).toContain("packages/vue-tooling/tsconfig.dom.json");
    expect(files).not.toContain("apps/web/scripts/run-vue-tsc.ts");
    expect(files).not.toContain("packages/db/drizzle.config.ts");
    expect(files.filter((file) => file.endsWith("drizzle.config.ts"))).toEqual([
      "packages/db-migrations/drizzle.config.ts",
    ]);
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
    expect(dockerfile).toContain(
      "apt-get install -y --no-install-recommends shellcheck",
    );
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );
    expect(checkWorkflow).toContain(
      "- run: sudo apt-get update && sudo apt-get install -y shellcheck\n        if: matrix.check == 'root'",
    );
    expect(checkWorkflow).toContain("docker/setup-buildx-action@v3");
    expect(checkWorkflow).toContain("check: [root, deployment]");
    expect(checkWorkflow).toContain(
      "- run: pnpm run check\n        if: matrix.check == 'root'",
    );
    expect(checkWorkflow).toContain(
      "- run: pnpm run check:deployment\n        if: matrix.check == 'deployment'",
    );
    expect(checkWorkflow).not.toContain("docker-image:");
    expect(checkWorkflow).not.toContain("docker buildx build");
    expect(dependabotConfig).toContain("directory: /apps/web");
    expect(appDockerfile).toContain("FROM node:24-bookworm-slim AS base");
    expect(workspaceYaml).toContain('"pinia>typescript": "-"');
    expect(workspaceYaml).toContain('"valibot>typescript": "-"');
    expect(workspaceYaml).toContain('"vue>typescript": "-"');
    expect(appDockerfile).toContain("FROM application-runtime AS runtime");
    expect(appDockerfile).toContain('ARG PACKAGE_MANAGER_PIN="pnpm@11.2.3"');
    expect(appDockerfile).toContain('ENV COREPACK_HOME="/corepack"');
    expect(appDockerfile).toContain(
      'corepack enable --install-directory "$PNPM_HOME"',
    );
    expect(appDockerfile).toContain(
      'corepack prepare "$PACKAGE_MANAGER_PIN" --activate',
    );
    expect(appDockerfile).toContain(
      "COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cts ./",
    );
    expect(
      appDockerfile.indexOf(
        "COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cts ./",
      ),
    ).toBeLessThan(appDockerfile.indexOf("RUN pnpm fetch"));
    expect(
      appDockerfile.indexOf(
        "COPY --from=pruner /repo/.pnpmfile.cts ./.pnpmfile.cts",
      ),
    ).toBeLessThan(
      appDockerfile.indexOf(
        "RUN pnpm fetch",
        appDockerfile.indexOf("FROM base AS build"),
      ),
    );
    expect(appDockerfile.indexOf("pnpm fetch")).toBeLessThan(
      appDockerfile.indexOf("COPY package.json turbo.json ./"),
    );
    expect(appDockerfile).toContain("pnpm fetch");
    expect(appDockerfile).toContain("pnpm install --offline --frozen-lockfile");
    expect(appDockerfile).toContain(
      "COPY packages/vue-tooling/package.json packages/vue-tooling/package.json",
    );
    expect(appDockerfile).toContain(
      "pnpm exec turbo prune @demo-vike/web @demo-vike/db-migrations --docker",
    );
    expect(
      appDockerfile.indexOf("pnpm --filter ./packages/db run build:run"),
    ).toBeLessThan(
      appDockerfile.indexOf("pnpm --filter ./apps/web run build:run"),
    );
    expect(appDockerfile).toContain("AS standalone");
    expect(appDockerfile).toContain('ENV DATABASE_FILE="/data/app.sqlite"');
    expect(appDockerfile).toContain(
      'ENTRYPOINT ["/usr/local/bin/container-entrypoint"]',
    );
    expect(appDockerfile).toContain('CMD ["prepare-and-start"]');
    expect(appDockerfile).toContain("COPY --from=build --chown=app:nodejs");
    expect(appDockerfile).toContain("USER app");
    expect(appDockerfile).toContain(
      'CMD ["node", "/app/dist/server/index.mjs"]',
    );
    expect(appDockerfile).not.toContain("CONTAINER_CAPABILITY");
    expect(appDockerfile).not.toContain("node:latest");
    expect(appDockerfile).not.toContain("npm install -g");
    expect(appDockerfile).not.toContain("pnpm dlx");
    expect(appDockerignore).toContain("**/node_modules");
    expect(appDockerignore).toContain("*.sqlite");
    expect(containerEntrypointSource).toContain("prepare-and-start");
    expect(containerEntrypointSource).toContain("prepare-only");
    expect(containerEntrypointSource).toContain(
      "drizzle-kit migrate --config /migration/drizzle.config.ts",
    );
    expect(containerEntrypointSource).not.toContain("pnpm");
    expect(containerEntrypointSource).toContain(
      "exec node /app/dist/server/index.mjs",
    );
    expect(standaloneDeploymentRunnerSource).toContain("--target");
    expect(standaloneDeploymentRunnerSource).toContain("standalone");
    expect(standaloneDeploymentRunnerSource).toContain(
      "PLAYWRIGHT_EXTERNAL_BASE_URL",
    );
  });

  it("targets an externally managed Playwright service without a local web server", async () => {
    const targetDir = await renderVikeProject();
    await linkRepositoryDependencies(targetDir);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const { default: config } = await import('./playwright.config.ts'); console.log(JSON.stringify({ baseURL: config.use?.baseURL, webServer: config.webServer }));",
      ],
      {
        cwd: path.join(targetDir, "apps/web"),
        env: {
          ...process.env,
          PLAYWRIGHT_EXTERNAL_BASE_URL: "http://127.0.0.1:4173",
        },
      },
    );

    expect(JSON.parse(stdout) as unknown).toEqual({
      baseURL: "http://127.0.0.1:4173/",
    });
  });

  it("starts the generated local service from a clean checkout and removes its test database", async () => {
    const repositoryPackageJson = await readJsonWithSchema(
      path.join(process.cwd(), "package.json"),
      v.object({ packageManager: packageManagerPinSchema }),
    );
    const targetDir = await renderVikeProject(
      repositoryPackageJson.packageManager,
    );
    const webDir = path.join(targetDir, "apps/web");
    const databaseFile = path.join(webDir, "node_modules/.tmp/e2e.sqlite");
    await linkRepositoryDependencies(targetDir);
    await mkdir(path.join(webDir, "dist/server"), { recursive: true });
    await writeFile(
      path.join(webDir, "dist/server/index.mjs"),
      `import { createServer } from "node:http";

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<h1>Local service ready</h1>");
}).listen(Number(process.env.PORT), "127.0.0.1");
`,
    );
    await writeFile(
      path.join(webDir, "test/e2e/app.spec.ts"),
      `import { expect, test } from "@playwright/test";

test("starts the local service", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Local service ready" })).toBeVisible();
});
`,
    );
    const env = {
      ...process.env,
      CI: "1",
      PATH: `${repositoryBin}${path.delimiter}${process.env.PATH}`,
    };
    await execFileAsync(process.execPath, ["scripts/run-playwright.ts"], {
      cwd: webDir,
      env,
    });

    await expect(access(databaseFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 120_000);

  it("projects source accepted by the generated formatter", async () => {
    const targetDir = await renderVikeProject();
    await linkRepositoryDependencies(targetDir);

    await execFileAsync(
      path.join(repositoryBin, "oxfmt"),
      [
        "--list-different",
        "--config",
        "oxfmt.config.ts",
        "apps/web/pages/index/+Page.telefunc.ts",
        "apps/web/scripts/check-standalone-deployment.ts",
        "apps/web/server/app.ts",
      ],
      { cwd: targetDir, env: process.env },
    );
  });

  it("projects exactly two final deployment images with a slim runtime", async () => {
    const targetDir = await renderVikeProject();
    const dockerfile = await readFile(
      path.join(targetDir, "apps/web/Dockerfile"),
      "utf8",
    );
    const finalTargets = [
      ...dockerfile.matchAll(/^# Final deployment target: (\S+)$/gmu),
    ].map((match) => match[1]);
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM application-runtime AS runtime"),
    );
    const applicationRuntime = dockerfile.slice(
      dockerfile.indexOf("AS application-runtime"),
      dockerfile.indexOf("# Final deployment target: standalone"),
    );

    expect(finalTargets).toEqual(["standalone", "runtime"]);
    expect(dockerfile).toContain(
      "pnpm --filter ./apps/web deploy --prod /runtime-deploy",
    );
    expect(dockerfile).toContain(
      "pnpm --filter ./packages/db-migrations deploy --prod /migration-deploy",
    );
    expect(dockerfile).not.toContain("--legacy");
    expect(dockerfile).not.toContain("file+packages+db");
    expect(dockerfile).not.toMatch(/\b(?:rm|find)\b/u);
    expect(applicationRuntime).toContain("./node_modules");
    expect(applicationRuntime).not.toContain("packages/db");
    expect(applicationRuntime).not.toContain("drizzle-kit");
    expect(dockerfile).toContain("FROM application-runtime AS standalone");
    expect(runtime).toContain("FROM application-runtime AS runtime");
    expect(applicationRuntime).toContain(
      "COPY --from=build --chown=app:nodejs",
    );
    expect(applicationRuntime).toContain("--uid 1001 --gid nodejs");
    expect(applicationRuntime).toContain(
      "install -d -o app -g nodejs /app /data",
    );
    expect(applicationRuntime).toContain(
      'ENV DATABASE_FILE="/data/app.sqlite"',
    );
    expect(runtime).not.toContain("CONTAINER_CAPABILITY");
    expect(runtime).not.toContain("ENTRYPOINT");
    expect(runtime).toContain('CMD ["node", "/app/dist/server/index.mjs"]');
    expect(
      dockerfile.match(/LABEL org\.opencontainers\.image\.version/gu),
    ).toHaveLength(2);
    expect(runtime).not.toContain("--from=pruner");
    expect(runtime).not.toContain("--from=standalone");
    expect(runtime).not.toContain("pnpm");
    expect(runtime).not.toContain("packages/db");
    expect(runtime).not.toContain("pnpm-workspace.yaml");
    expect(runtime).not.toContain("drizzle");
  });

  it("serves the built application after an isolated migration closure prepares its database", async () => {
    const repositoryPackageJson = await readJsonWithSchema(
      path.join(process.cwd(), "package.json"),
      v.object({ packageManager: packageManagerPinSchema }),
    );
    const targetDir = await renderVikeProject(
      repositoryPackageJson.packageManager,
    );
    const rootTscBefore = await repositoryTscIdentity();
    await addPackage({
      cwd: targetDir,
      preset: "ts-lib",
      name: "shared",
      presetSourceManifest: loadBuiltInPresetSourceManifest(),
      projectionSourceRoots: builtInPresetProjectionSourceRoots(),
    });
    await execFileAsync(
      "pnpm",
      ["install", "--ignore-scripts", "--no-frozen-lockfile"],
      {
        cwd: targetDir,
        env: { ...process.env, CI: "1" },
      },
    );
    expect(
      (await lstat(path.join(targetDir, "node_modules"))).isSymbolicLink(),
    ).toBe(false);
    expect(await repositoryTscIdentity()).toEqual(rootTscBefore);
    await execFileAsync(
      "pnpm",
      ["--filter", "./apps/web", "exec", "vike", "build"],
      {
        cwd: targetDir,
        env: process.env,
      },
    );
    const deploymentRoot = await mkdtemp(
      path.join(tmpdir(), "vike-application-closure-"),
    );
    await execFileAsync(
      "pnpm",
      ["--filter", "./apps/web", "deploy", "--prod", deploymentRoot],
      { cwd: targetDir, env: process.env },
    );
    expect(await repositoryTscIdentity()).toEqual(rootTscBefore);
    const deployedNodeModules = path.join(deploymentRoot, "node_modules");
    const virtualStore = path.join(deployedNodeModules, ".pnpm");
    const productionEntries = await readdir(virtualStore);
    expect(await generatedFilePaths(deploymentRoot)).toContain(
      "pnpm-lock.yaml",
    );
    await expect(
      access(path.join(deployedNodeModules, "@demo-vike/db")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      productionEntries.some((entry) => entry.includes("file+packages+db")),
    ).toBe(false);
    expect(
      productionEntries.some((entry) => entry.includes("drizzle-kit")),
    ).toBe(false);

    const migrationRoot = await mkdtemp(
      path.join(tmpdir(), "vike-migration-closure-"),
    );
    await execFileAsync(
      "pnpm",
      [
        "--filter",
        "./packages/db-migrations",
        "deploy",
        "--prod",
        migrationRoot,
      ],
      { cwd: targetDir, env: process.env },
    );
    expect(await generatedFilePaths(migrationRoot)).toContain("pnpm-lock.yaml");

    const databaseFile = path.join(deploymentRoot, "data", "app.sqlite");
    await mkdir(path.dirname(databaseFile), { recursive: true });
    await execFileAsync(
      path.join(migrationRoot, "node_modules/.bin/drizzle-kit"),
      ["migrate"],
      {
        cwd: migrationRoot,
        env: { ...process.env, DATABASE_FILE: databaseFile },
      },
    );
    expect(await databaseReadiness(databaseFile)).toBe("todos:0");

    const port = await availablePort();
    const runtimeEnvironment = {
      ...process.env,
      DATABASE_FILE: databaseFile,
      HOST: "127.0.0.1",
      PORT: String(port),
    };
    const isolatedFiles = await generatedFilePaths(deploymentRoot);
    expect(isolatedFiles).not.toContain("node_modules/@demo-vike/db");
    expect(
      isolatedFiles.some((file) => file.includes("file+packages+db")),
    ).toBe(false);
    expect(isolatedFiles.some((file) => file.includes("drizzle-kit"))).toBe(
      false,
    );
    expect(isolatedFiles).not.toContain("scripts/prepare-database.sh");
    expect(isolatedFiles.some((file) => file.startsWith("packages/db/"))).toBe(
      false,
    );
    const server = spawn(process.execPath, ["dist/server/index.mjs"], {
      cwd: deploymentRoot,
      env: runtimeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const response = await waitForHttpResponse(
        `http://127.0.0.1:${port}/api/health`,
        server,
      );
      expect(await response.json()).toEqual({ ok: true, service: "vike-app" });
    } finally {
      await stopChildProcess(server);
    }
  }, 600_000);

  it("prepares one seeded application database for default and caller-relative development paths", async () => {
    const repositoryPackageJson = await readJsonWithSchema(
      path.join(process.cwd(), "package.json"),
      v.object({ packageManager: packageManagerPinSchema }),
    );
    const targetDir = await renderVikeProject(
      repositoryPackageJson.packageManager,
    );
    await execFileAsync(
      "pnpm",
      ["install", "--ignore-scripts", "--no-frozen-lockfile"],
      { cwd: targetDir, env: { ...process.env, CI: "1" } },
    );

    const preparationEnvironment = { ...process.env };
    delete preparationEnvironment.DATABASE_FILE;
    delete preparationEnvironment.INIT_CWD;
    await execFileAsync(
      "pnpm",
      ["--dir", "packages/db-migrations", "run", "db:prepare:dev"],
      { cwd: targetDir, env: preparationEnvironment },
    );

    const defaultDatabaseFile = path.join(
      targetDir,
      "apps/web/data/app.sqlite",
    );
    expect(await databaseReadiness(defaultDatabaseFile)).toBe("todos:2");

    const relativeDatabaseFile = "caller-data/app.sqlite";
    await execFileAsync(
      "pnpm",
      ["--dir", "packages/db-migrations", "run", "db:prepare:dev"],
      {
        cwd: targetDir,
        env: { ...preparationEnvironment, DATABASE_FILE: relativeDatabaseFile },
      },
    );

    const expectedRelativeDatabaseFile = path.join(
      targetDir,
      relativeDatabaseFile,
    );
    expect(await databaseReadiness(expectedRelativeDatabaseFile)).toBe(
      "todos:2",
    );
    await expect(
      access(
        path.join(targetDir, "packages/db-migrations", relativeDatabaseFile),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(targetDir, "packages/db", relativeDatabaseFile)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("applies SQL from a production migration closure without database schema source", async () => {
    const repositoryPackageJson = await readJsonWithSchema(
      path.join(process.cwd(), "package.json"),
      v.object({ packageManager: packageManagerPinSchema }),
    );
    const targetDir = await renderVikeProject(
      repositoryPackageJson.packageManager,
    );
    await execFileAsync(
      "pnpm",
      ["install", "--ignore-scripts", "--no-frozen-lockfile"],
      { cwd: targetDir, env: { ...process.env, CI: "1" } },
    );

    const deploymentRoot = path.join(targetDir, "migration-deploy");
    await execFileAsync(
      "pnpm",
      [
        "--filter",
        "./packages/db-migrations",
        "deploy",
        "--prod",
        deploymentRoot,
      ],
      { cwd: targetDir, env: process.env },
    );

    const deploymentFiles = await generatedFilePaths(deploymentRoot);
    expect(deploymentFiles).toContain("pnpm-lock.yaml");
    expect(deploymentFiles).toContain("drizzle.config.ts");
    expect(deploymentFiles.some((file) => file.endsWith("migration.sql"))).toBe(
      true,
    );
    expect(deploymentFiles.some((file) => file.includes("src/schema.ts"))).toBe(
      false,
    );
    expect(
      deploymentFiles.some((file) =>
        file.includes("node_modules/@demo-vike/db"),
      ),
    ).toBe(false);
    expect(deploymentFiles.some((file) => file.includes("seed-example"))).toBe(
      false,
    );
    const databaseFile = path.join(deploymentRoot, "prepared.sqlite");
    await execFileAsync(
      path.join(deploymentRoot, "node_modules/.bin/drizzle-kit"),
      ["migrate"],
      {
        cwd: deploymentRoot,
        env: { ...process.env, DATABASE_FILE: databaseFile },
      },
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.DATABASE_FILE); const table = db.prepare("select name from sqlite_master where type = \'table\' and name = \'todos\'").get()?.name; const rows = db.prepare("select count(*) as count from todos").get()?.count; console.log(`${table}:${rows}`);',
      ],
      { env: { ...process.env, DATABASE_FILE: databaseFile } },
    );
    expect(stdout.trim()).toBe("todos:0");
  }, 120_000);

  it.each([
    ["", "must be a non-empty HTTP(S) URL"],
    ["ftp://example.test", "must use HTTP or HTTPS"],
    ["not a URL", "must be a valid HTTP(S) URL"],
  ])(
    "rejects invalid external Playwright service input %#",
    async (externalBaseUrl, diagnostic) => {
      const targetDir = await renderVikeProject();
      await linkRepositoryDependencies(targetDir);

      await expect(
        execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            "await import('./playwright.config.ts')",
          ],
          {
            cwd: path.join(targetDir, "apps/web"),
            env: {
              ...process.env,
              PLAYWRIGHT_EXTERNAL_BASE_URL: externalBaseUrl,
            },
          },
        ),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(diagnostic) });
    },
  );

  it("does not alter an externally managed database", async () => {
    const targetDir = await renderVikeProject();
    const webDir = path.join(targetDir, "apps/web");
    const fakeBinDir = path.join(targetDir, "fake-bin");
    const databaseFile = path.join(targetDir, "external.sqlite");
    const observationFile = path.join(targetDir, "playwright-observation.json");
    await mkdir(fakeBinDir);
    await writeFile(databaseFile, "externally-owned");
    const playwrightPath = path.join(fakeBinDir, "playwright");
    await writeFile(
      playwrightPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PLAYWRIGHT_OBSERVATION_FILE, JSON.stringify({
  args: process.argv.slice(2),
  baseUrl: process.env.PLAYWRIGHT_EXTERNAL_BASE_URL,
}));
`,
    );
    await chmod(playwrightPath, 0o755);

    const server = createServer((_request, response) => {
      response.writeHead(200).end("ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Could not determine test service port");
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      await execFileAsync(
        process.execPath,
        ["scripts/run-playwright.ts", "--project=chromium"],
        {
          cwd: webDir,
          env: {
            ...process.env,
            DATABASE_FILE: databaseFile,
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
            PLAYWRIGHT_EXTERNAL_BASE_URL: baseUrl,
            PLAYWRIGHT_OBSERVATION_FILE: observationFile,
          },
        },
      );

      expect(await readFile(databaseFile, "utf8")).toBe("externally-owned");
      expect(
        JSON.parse(await readFile(observationFile, "utf8")) as unknown,
      ).toEqual({
        args: ["test", "--project=chromium"],
        baseUrl: `${baseUrl}`,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects a relative container database path before preparation", async () => {
    const targetDir = await renderVikeProject();

    await expect(
      execFileAsync("sh", ["scripts/container-entrypoint.sh", "prepare-only"], {
        cwd: path.join(targetDir, "apps/web"),
        env: { ...process.env, DATABASE_FILE: "data/app.sqlite" },
      }),
    ).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining("DATABASE_FILE must be an absolute path"),
    });
  });

  it("prepares an absolute database without starting the application", async () => {
    const targetDir = await renderVikeProject();
    const { databaseFile, env, observationFile } =
      await fakeContainerCommandEnvironment(targetDir);

    await execFileAsync(
      "sh",
      ["scripts/container-entrypoint.sh", "prepare-only"],
      { cwd: path.join(targetDir, "apps/web"), env },
    );

    expect(await readFile(observationFile, "utf8")).toBe("prepare\n");
    await expect(access(path.dirname(databaseFile))).resolves.toBeUndefined();
  });

  it("starts only after successful deployment preparation", async () => {
    const targetDir = await renderVikeProject();
    const { env, observationFile } =
      await fakeContainerCommandEnvironment(targetDir);

    await execFileAsync(
      "sh",
      ["scripts/container-entrypoint.sh", "prepare-and-start"],
      { cwd: path.join(targetDir, "apps/web"), env },
    );

    expect(await readFile(observationFile, "utf8")).toBe("prepare\nstart\n");
  });

  it("does not start when deployment preparation fails", async () => {
    const targetDir = await renderVikeProject();
    const { env, observationFile } =
      await fakeContainerCommandEnvironment(targetDir);

    await expect(
      execFileAsync(
        "sh",
        ["scripts/container-entrypoint.sh", "prepare-and-start"],
        {
          cwd: path.join(targetDir, "apps/web"),
          env: { ...env, CONTAINER_PREPARE_EXIT_CODE: "23" },
        },
      ),
    ).rejects.toMatchObject({ code: 23 });
    expect(await readFile(observationFile, "utf8")).toBe("prepare\n");
  });

  it("replaces the dispatcher so the application receives container signals", async () => {
    const targetDir = await renderVikeProject();
    const { env, observationFile } =
      await fakeContainerCommandEnvironment(targetDir);
    const fakeBinDir = env.PATH!.split(path.delimiter)[0]!;
    await writeFile(
      path.join(fakeBinDir, "node"),
      `#!/bin/sh
trap 'echo signal >> "$CONTAINER_OBSERVATION_FILE"; exit 0' TERM
echo "pid:$$" >> "$CONTAINER_OBSERVATION_FILE"
while :; do sleep 1; done
`,
    );
    await chmod(path.join(fakeBinDir, "node"), 0o755);

    const child = spawn(
      "sh",
      ["scripts/container-entrypoint.sh", "prepare-and-start"],
      { cwd: path.join(targetDir, "apps/web"), env },
    );
    const deadline = Date.now() + 5_000;
    let observation = "";
    while (Date.now() < deadline && !observation.includes("pid:")) {
      try {
        observation = await readFile(observationFile, "utf8");
      } catch {
        // The application has not written its PID yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(observation).toContain(`pid:${child.pid}`);
    child.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    expect(await readFile(observationFile, "utf8")).toContain("signal\n");
  });

  it("checks standalone, prepared runtime, and unprepared runtime lifecycles", async () => {
    const targetDir = await renderVikeProject();
    const server = createServer((_request, response) => {
      response.writeHead(200).end("ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Could not determine fake deployment port");
      }
      const { dockerObservationFile, env, playwrightObservationFile } =
        await fakeDockerEnvironment(targetDir, address.port);

      await execFileAsync(
        process.execPath,
        ["scripts/check-standalone-deployment.ts"],
        { cwd: path.join(targetDir, "apps/web"), env },
      );

      const dockerCommands = await readFile(dockerObservationFile, "utf8");
      expect(dockerCommands).toContain(
        "build --file apps/web/Dockerfile --target standalone --build-arg DEPLOYMENT_BUILD_ID=",
      );
      expect(dockerCommands).toContain(
        "build --file apps/web/Dockerfile --target runtime --build-arg DEPLOYMENT_BUILD_ID=",
      );
      expect(dockerCommands.match(/volume create/gu)).toHaveLength(3);
      expect(dockerCommands.match(/network create/gu)).toHaveLength(1);
      expect(dockerCommands).toContain("run --detach");
      expect(dockerCommands).toContain("standalone:");
      expect(dockerCommands).toContain("prepare-only");
      expect(dockerCommands).toContain(
        "inspect --format={{.State.Status}}:{{.State.ExitCode}}",
      );
      expect(dockerCommands).toContain(
        "port vike-deployment-check-unprepared-",
      );
      expect(dockerCommands).toContain(
        "logs vike-deployment-check-unprepared-",
      );
      expect(dockerCommands).toContain("runtime:");
      expect(dockerCommands).toContain("unprepared");
      expect(dockerCommands).toMatch(
        /unprepared[^\n]*--publish|--publish[^\n]*unprepared/u,
      );
      expect(dockerCommands).toContain("exec");
      expect(dockerCommands).toContain("const expectedIdentity = 1001");
      expect(dockerCommands).toContain("process.getuid() !== expectedIdentity");
      expect(dockerCommands).toContain("process.getgid() !== expectedIdentity");
      expect(dockerCommands).toContain("statSync(process.env.DATABASE_FILE)");
      expect(dockerCommands).toContain("select count(*) as count from todos");
      expect(dockerCommands).toContain("rm --force");
      expect(dockerCommands).toContain("volume rm --force");
      expect(dockerCommands).toContain("image rm --force");
      expect(dockerCommands.match(/^rm --force/gmu)).toHaveLength(4);
      expect(dockerCommands.match(/^volume rm --force/gmu)).toHaveLength(3);
      expect(dockerCommands.match(/^image rm --force/gmu)).toHaveLength(2);
      expect(dockerCommands.match(/^network rm/gmu)).toHaveLength(1);
      expect(await readFile(playwrightObservationFile, "utf8")).toBe(
        `http://127.0.0.1:${address.port}\nhttp://127.0.0.1:${address.port}\n`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects an unprepared runtime that serves any HTTP response before exit", async () => {
    const targetDir = await renderVikeProject();
    const readyServer = createServer((_request, response) => {
      response.writeHead(200).end("ready");
    });
    const leakedServer = createServer((_request, response) => {
      response.writeHead(503).end("not ready");
    });
    await Promise.all(
      [readyServer, leakedServer].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          }),
      ),
    );

    try {
      const readyAddress = readyServer.address();
      const leakedAddress = leakedServer.address();
      if (
        typeof readyAddress !== "object" ||
        readyAddress === null ||
        typeof leakedAddress !== "object" ||
        leakedAddress === null
      ) {
        throw new Error("Could not determine fake deployment ports");
      }
      const { env } = await fakeDockerEnvironment(
        targetDir,
        readyAddress.port,
        0,
        0,
        "",
        leakedAddress.port,
      );

      const result = await execFileAsync(
        process.execPath,
        ["scripts/check-standalone-deployment.ts"],
        { cwd: path.join(targetDir, "apps/web"), env },
      ).catch((error: unknown) => error as { stderr?: string });

      expect(result).toMatchObject({
        stderr: expect.stringMatching(
          /Unprepared runtime served HTTP 503 before exiting/u,
        ),
      });
    } finally {
      await Promise.all(
        [readyServer, leakedServer].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    }
  });

  it("accepts deployment command output larger than execFile's default buffer", async () => {
    const targetDir = await renderVikeProject();
    const server = createServer((_request, response) => {
      response.writeHead(200).end("ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Could not determine fake deployment port");
      }
      const { env } = await fakeDockerEnvironment(
        targetDir,
        address.port,
        0,
        1_200_000,
      );

      await execFileAsync(
        process.execPath,
        ["apps/web/scripts/check-standalone-deployment.ts"],
        { cwd: targetDir, env },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("prints container logs and cleans resources when Playwright fails", async () => {
    const targetDir = await renderVikeProject();
    const server = createServer((_request, response) => {
      response.writeHead(200).end("ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Could not determine fake deployment port");
      }
      const { dockerObservationFile, env } = await fakeDockerEnvironment(
        targetDir,
        address.port,
        19,
      );

      await expect(
        execFileAsync(
          process.execPath,
          ["apps/web/scripts/check-standalone-deployment.ts"],
          { cwd: targetDir, env },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(
          /Deployment mode standalone failed during playwright[\s\S]*"pnpm" "--dir" "apps\/web" "run" "test:e2e:run"[\s\S]*fake playwright stdout failure[\s\S]*fake playwright stderr failure[\s\S]*fake container stdout diagnostics[\s\S]*fake container stderr diagnostics/u,
        ),
      });

      const dockerCommands = await readFile(dockerObservationFile, "utf8");
      expect(dockerCommands).toContain("logs");
      expect(dockerCommands).toContain("rm --force");
      expect(dockerCommands).toContain("volume rm --force");
      expect(dockerCommands).toContain("image rm --force");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reports the real deployment mode, phase, command, and output for Docker failures", async () => {
    const targetDir = await renderVikeProject();
    const { env } = await fakeDockerEnvironment(
      targetDir,
      1,
      0,
      0,
      "--target runtime",
    );

    await expect(
      execFileAsync(
        process.execPath,
        ["apps/web/scripts/check-standalone-deployment.ts"],
        { cwd: targetDir, env },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /Deployment mode runtime failed during build[\s\S]*"docker" "build" "--file" "apps\/web\/Dockerfile" "--target" "runtime"[\s\S]*fake docker stdout failure[\s\S]*fake docker stderr failure/u,
      ),
    });
  });

  it("prints container logs and cleans resources when readiness times out", async () => {
    const targetDir = await renderVikeProject();
    const { dockerObservationFile, env } = await fakeDockerEnvironment(
      targetDir,
      1,
    );

    await expect(
      execFileAsync(
        process.execPath,
        ["apps/web/scripts/check-standalone-deployment.ts"],
        {
          cwd: targetDir,
          env: {
            ...env,
            STANDALONE_DEPLOYMENT_READINESS_TIMEOUT_MS: "50",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /Standalone container was not ready within 50ms[\s\S]*fake container stdout diagnostics[\s\S]*fake container stderr diagnostics/u,
      ),
    });

    const dockerCommands = await readFile(dockerObservationFile, "utf8");
    expect(dockerCommands).toContain("logs");
    expect(dockerCommands).toContain("rm --force");
    expect(dockerCommands).toContain("volume rm --force");
    expect(dockerCommands).toContain("image rm --force");
  });

  it("cleans deployment resources when interrupted", async () => {
    const targetDir = await renderVikeProject();
    const server = createServer((_request, response) => {
      response.writeHead(200).end("ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Could not determine fake deployment port");
      }
      const { dockerObservationFile, env, playwrightObservationFile } =
        await fakeDockerEnvironment(targetDir, address.port);
      const fakeBinDir = env.PATH!.split(path.delimiter)[0]!;
      await writeFile(
        path.join(fakeBinDir, "pnpm"),
        `#!/bin/sh
echo "$PLAYWRIGHT_EXTERNAL_BASE_URL" > "$PLAYWRIGHT_OBSERVATION_FILE"
trap 'exit 143' TERM
while :; do sleep 1; done
`,
      );
      await chmod(path.join(fakeBinDir, "pnpm"), 0o755);

      const child = spawn(
        process.execPath,
        ["apps/web/scripts/check-standalone-deployment.ts"],
        { cwd: targetDir, env },
      );
      let deploymentStderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        deploymentStderr += chunk;
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          await access(playwrightObservationFile);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await expect(access(playwrightObservationFile)).resolves.toBeUndefined();
      child.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });

      const dockerCommands = await readFile(dockerObservationFile, "utf8");
      expect(dockerCommands).toContain("rm --force");
      expect(dockerCommands).toContain("volume rm --force");
      expect(dockerCommands).toContain("image rm --force");
      expect(deploymentStderr).toMatch(
        /fake container stdout diagnostics[\s\S]*fake container stderr diagnostics/u,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
