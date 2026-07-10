import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "packages", "cli", "src", "cli.ts");
const nodeBin = process.execPath;
const workspaceCatalogSchema = v.object({
  catalog: v.optional(v.record(v.string(), v.string())),
});

async function readJson<T>(filePath: string): Promise<T> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Large generated-fixture tests still use typed JSON reads; schema-backed reads are being introduced around high-risk assertions.
  return parsed as T;
}

async function expectCommandFailure(
  command: Promise<unknown>,
  expectedStderr: string | readonly string[],
): Promise<void> {
  try {
    await command;
  } catch (error) {
    const stderr = commandErrorStderr(error);
    const expectedMessages =
      typeof expectedStderr === "string" ? [expectedStderr] : expectedStderr;

    for (const expectedMessage of expectedMessages) {
      expect(stderr).toContain(expectedMessage);
    }

    return;
  }

  throw new Error("Expected command to fail");
}

function commandErrorStderr(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    return error.stderr;
  }

  throw error;
}

async function sourceFileSnapshot(
  sourceDir: string,
  currentDir = sourceDir,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await sourceFileSnapshot(sourceDir, entryPath));
      continue;
    }

    if (entry.isFile()) {
      snapshot[path.relative(sourceDir, entryPath)] = await readFile(
        entryPath,
        "utf8",
      );
    }
  }

  return snapshot;
}

function expectSharedRootOxcScripts(scripts: Record<string, string>): void {
  expect(scripts["format:check:run"]).toBe(
    "oxfmt --list-different --config ../../oxfmt.config.ts .",
  );
  expect(scripts["format:write:run"]).toBe(
    "oxfmt --write --config ../../oxfmt.config.ts .",
  );
  expect(scripts["lint:run"]).toBe(
    "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
  );
  expect(scripts["lint:fix:run"]).toBe(
    "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
  );
}

function catalogFromWorkspaceYaml(
  workspaceYaml: string,
): Record<string, string> {
  const parsed = v.parse(workspaceCatalogSchema, parseYaml(workspaceYaml));

  return parsed.catalog ?? {};
}

function catalogDependencyNames(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}): string[] {
  const dependencies = new Set<string>();

  for (const dependencyMap of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const [dependency, specifier] of Object.entries(dependencyMap ?? {})) {
      if (specifier.startsWith("catalog:")) {
        dependencies.add(dependency);
      }
    }
  }

  return [...dependencies].toSorted();
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(stat(filePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
}

async function initGeneratedWorkspace(
  projectDir: string,
  preset = "vue-hono-app",
): Promise<void> {
  await execa(
    "node",
    [
      "--conditions=source",
      cliPath,
      "init",
      projectDir,
      "--preset",
      preset,
      "--yes",
    ],
    { cwd: repoRoot },
  );
}

describe("template add package", () => {
  it("keeps the generated Dependency Catalog complete when an added package introduces catalog dependencies", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    const initialWorkspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    expect(catalogFromWorkspaceYaml(initialWorkspaceYaml)).not.toHaveProperty(
      "valibot",
    );

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
      ],
      { cwd: projectDir },
    );

    const workspaceCatalog = catalogFromWorkspaceYaml(
      await readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8"),
    );
    const templateCatalog = catalogFromWorkspaceYaml(
      await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
    );
    const packageJson = await readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(path.join(projectDir, "packages/shared/package.json"));
    const addedPackageCatalogDependencies = catalogDependencyNames(packageJson);

    expect(workspaceCatalog).toHaveProperty("valibot");
    expect(workspaceCatalog.valibot).toBe(templateCatalog.valibot);
    expect(
      addedPackageCatalogDependencies.filter(
        (dependency) => workspaceCatalog[dependency] === undefined,
      ),
    ).toEqual([]);
  }, 120_000);

  it("adds packages while keeping the stored blueprint valid for later additions", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
      ],
      { cwd: projectDir },
    );
    await execa(
      nodeBin,
      [
        "--conditions=source",
        cliPath,
        "blueprint",
        "validate",
        ".template/blueprint.json",
      ],
      {
        cwd: projectDir,
      },
    );
    const blueprint = await readJson<{
      preset: string;
      projectKind: string;
      packages: Array<{
        name: string;
        path: string;
        role?: string;
        sourcePreset?: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const rootPackageJson = await readJson<{
      scripts: Record<string, string>;
      engines: { node: string };
    }>(path.join(projectDir, "package.json"));
    const turboConfig = await readJson<{
      tasks: Record<
        string,
        { cache?: boolean; dependsOn?: string[]; outputs?: string[] }
      >;
    }>(path.join(projectDir, "turbo.json"));
    const rootTsconfig = await readJson<{
      references?: Array<{ path: string }>;
    }>(path.join(projectDir, "tsconfig.json"));
    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      engines: { node: string };
      packageManager?: string;
    }>(path.join(projectDir, "packages/shared/package.json"));
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
      include: string[];
    }>(path.join(projectDir, "packages/shared/tsconfig.json"));

    expect(blueprint).toEqual(
      expect.objectContaining({
        preset: "vue-hono-app",
        projectKind: "multi-package",
      }),
    );
    expect(blueprint.packages).toEqual([
      { name: "@demo-fullstack/web", path: "apps/web" },
      { name: "@demo-fullstack/api", path: "apps/api" },
      {
        name: "@demo-fullstack/shared",
        path: "packages/shared",
        role: "shared-library",
        sourcePreset: "ts-lib",
      },
    ]);
    expect(workspaceYaml).toContain("  - apps/*");
    expect(workspaceYaml).toContain("  - packages/*");
    expect(rootPackageJson.scripts.check).toBe(
      "pnpm run check:boundaries && turbo run format:check:run lint:run typecheck:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
    );
    expect(rootPackageJson.scripts.check).not.toBe(
      "turbo run typecheck:run format:check:run lint:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
    );
    expect(turboConfig.tasks["typecheck:run"]!.dependsOn).toEqual([
      "^typecheck:run",
    ]);
    expect(turboConfig.tasks["build:run"]).toEqual({
      outputs: ["dist/**"],
    });
    expect(turboConfig.tasks["test:run"]!.dependsOn).toEqual([
      "^typecheck:run",
    ]);
    expect(turboConfig.tasks["test:e2e:run"]!.dependsOn).toEqual(["build:run"]);
    expect(turboConfig.tasks["check:run"]!.cache).toBe(false);
    expect(rootPackageJson.scripts.fix).toBe(
      "turbo run format:write:run lint:fix:run fix:run --output-logs=errors-only --log-order=grouped",
    );
    expect(rootPackageJson.scripts.fix).not.toBe(
      "pnpm run format:write && pnpm run lint:fix && turbo run fix --filter './apps/*'",
    );
    expect(rootTsconfig.references).not.toContainEqual({
      path: "./packages/shared/tsconfig.json",
    });
    expect(packageJson.name).toBe("@demo-fullstack/shared");
    expect(rootPackageJson.engines.node).toBe("24");
    expect(packageJson.engines.node).toBe(rootPackageJson.engines.node);
    expect(packageJson).not.toHaveProperty("packageManager");
    expect(packageJson.scripts).not.toHaveProperty("check");
    expect(packageJson.scripts).not.toHaveProperty("build:run");
    expectSharedRootOxcScripts(packageJson.scripts);
    expect(packageJson.devDependencies.typescript).toBe("catalog:");
    const addedPackageDependencySpecifiers = Object.values(
      packageJson.devDependencies,
    );
    expect(
      addedPackageDependencySpecifiers.every((value) => value === "catalog:"),
    ).toBe(true);
    expect(tsconfig.compilerOptions.composite).toBe(true);
    expect(tsconfig.compilerOptions).not.toHaveProperty("paths");
    expect(tsconfig.include).toEqual(["src/**/*.ts"]);

    await stat(path.join(projectDir, "packages/shared/src/index.ts"));
    await expectPathMissing(
      path.join(projectDir, "packages/shared/oxlint.config.ts"),
    );
    await expectPathMissing(
      path.join(projectDir, "packages/shared/oxfmt.config.ts"),
    );
    await expectPathMissing(
      path.join(projectDir, "apps/worker/oxlint.config.ts"),
    );
    await expectPathMissing(
      path.join(projectDir, "apps/worker/oxfmt.config.ts"),
    );
    await expectPathMissing(
      path.join(projectDir, "packages/shared/.oxlintrc.json"),
    );
    await expectPathMissing(
      path.join(projectDir, "packages/shared/.oxfmtrc.json"),
    );
    await expectPathMissing(
      path.join(projectDir, "apps/worker/.oxlintrc.json"),
    );
    await expectPathMissing(path.join(projectDir, "apps/worker/.oxfmtrc.json"));
  }, 120_000);

  it("adds a package at an explicit two-segment Package Path", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "vue-app",
        "--name",
        "worker",
        "--path",
        "services/worker",
      ],
      { cwd: projectDir },
    );

    const blueprint = await readJson<{
      packages: Array<{
        name: string;
        path: string;
        role?: string;
        sourcePreset?: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const rootPackageJson = await readJson<{
      scripts: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const rootTsconfig = await readJson<{
      references: Array<{ path: string }>;
    }>(path.join(projectDir, "tsconfig.json"));
    const packageJson = await readJson<{ name: string }>(
      path.join(projectDir, "services/worker/package.json"),
    );

    expect(blueprint.packages).toContainEqual(
      expect.objectContaining({
        name: "@demo-fullstack/worker",
        path: "services/worker",
        role: "runtime-service",
        sourcePreset: "vue-app",
      }),
    );
    expect(workspaceYaml).toContain("  - services/*");
    expect(rootPackageJson.scripts.check).not.toContain(
      "turbo run typecheck:run --filter './apps/*' --filter './services/*'",
    );
    expect(rootPackageJson.scripts.check).toContain(
      "pnpm run check:boundaries && turbo run format:check:run lint:run typecheck:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
    );
    expect(rootTsconfig.references).not.toContainEqual({
      path: "./services/worker/tsconfig.json",
    });
    expect(packageJson.name).toBe("@demo-fullstack/worker");
    await stat(path.join(projectDir, "services/worker/src/App.vue"));
    await expectPathMissing(path.join(projectDir, "apps/worker/package.json"));
  }, 120_000);

  it("links an added TypeScript library from one existing consumer without editing consumer source", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    const webSourceDir = path.join(projectDir, "apps/web/src");
    const beforeWebSource = await sourceFileSnapshot(webSourceDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
        "--link-from",
        "apps/web",
      ],
      { cwd: projectDir },
    );

    await execa(
      nodeBin,
      [
        "--conditions=source",
        cliPath,
        "blueprint",
        "validate",
        ".template/blueprint.json",
      ],
      {
        cwd: projectDir,
      },
    );

    const blueprint = await readJson<{
      packageLinkIntents?: Array<{
        consumerPackagePath: string;
        providerPackagePath: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const webPackageJson = await readJson<{
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));
    const sharedPackageJson = await readJson<{
      exports: unknown;
      imports: unknown;
    }>(path.join(projectDir, "packages/shared/package.json"));

    expect(webPackageJson.dependencies["@demo-fullstack/shared"]).toBe(
      "workspace:*",
    );
    expect(sharedPackageJson.exports).toEqual({
      ".": {
        default: "./src/index.ts",
        types: "./src/index.ts",
      },
    });
    expect(sharedPackageJson.imports).toEqual({
      "#/*": {
        default: "./src/*.ts",
        types: "./src/*.ts",
      },
    });
    expect(blueprint.packageLinkIntents).toEqual([
      {
        consumerPackagePath: "apps/web",
        providerPackagePath: "packages/shared",
      },
    ]);
    expect(await sourceFileSnapshot(webSourceDir)).toEqual(beforeWebSource);
  }, 120_000);

  it("links an added TypeScript library from multiple existing consumers", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
        "--link-from",
        "apps/web",
        "--link-from",
        "apps/api",
      ],
      { cwd: projectDir },
    );

    const blueprint = await readJson<{
      packageLinkIntents?: Array<{
        consumerPackagePath: string;
        providerPackagePath: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const webPackageJson = await readJson<{
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));
    const apiPackageJson = await readJson<{
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/api/package.json"));
    const sharedPackageJson = await readJson<{
      exports: unknown;
      imports: unknown;
    }>(path.join(projectDir, "packages/shared/package.json"));

    expect(webPackageJson.dependencies["@demo-fullstack/shared"]).toBe(
      "workspace:*",
    );
    expect(apiPackageJson.dependencies["@demo-fullstack/shared"]).toBe(
      "workspace:*",
    );
    expect(sharedPackageJson.exports).toEqual({
      ".": {
        default: "./src/index.ts",
        types: "./src/index.ts",
      },
    });
    expect(sharedPackageJson.imports).toEqual({
      "#/*": {
        default: "./src/*.ts",
        types: "./src/*.ts",
      },
    });
    expect(blueprint.packageLinkIntents).toEqual([
      {
        consumerPackagePath: "apps/web",
        providerPackagePath: "packages/shared",
      },
      {
        consumerPackagePath: "apps/api",
        providerPackagePath: "packages/shared",
      },
    ]);
  }, 120_000);

  it("deduplicates repeated Package Link Intent consumers", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
        "--link-from",
        "apps/web",
        "--link-from",
        "apps/web",
      ],
      { cwd: projectDir },
    );

    const blueprint = await readJson<{
      packageLinkIntents?: Array<{
        consumerPackagePath: string;
        providerPackagePath: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const webPackageJson = await readJson<{
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));

    expect(blueprint.packageLinkIntents).toEqual([
      {
        consumerPackagePath: "apps/web",
        providerPackagePath: "packages/shared",
      },
    ]);
    expect(
      Object.entries(webPackageJson.dependencies).filter(
        ([dependencyName, specifier]) =>
          dependencyName === "@demo-fullstack/shared" &&
          specifier === "workspace:*",
      ),
    ).toHaveLength(1);
  }, 120_000);

  it("normalizes an existing provider dependency when linking an added provider", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    const webPackageJsonPath = path.join(projectDir, "apps/web/package.json");
    const webPackageJson = await readJson<{
      dependencies?: Record<string, string>;
    }>(webPackageJsonPath);
    await writeFile(
      webPackageJsonPath,
      `${JSON.stringify(
        {
          ...webPackageJson,
          dependencies: {
            ...webPackageJson.dependencies,
            "@demo-fullstack/shared": "^1.0.0",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await execa(
      nodeBin,
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
        "--link-from",
        "apps/web",
      ],
      { cwd: projectDir },
    );

    const updatedWebPackageJson = await readJson<{
      dependencies: Record<string, string>;
    }>(webPackageJsonPath);

    expect(updatedWebPackageJson.dependencies["@demo-fullstack/shared"]).toBe(
      "workspace:*",
    );
    expect(
      Object.keys(updatedWebPackageJson.dependencies).filter(
        (dependencyName) => dependencyName === "@demo-fullstack/shared",
      ),
    ).toHaveLength(1);
  }, 120_000);

  it("rejects unknown --link-from Package Paths with available Package Paths", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    const unknownConsumerPackagePath = execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
        "--link-from",
        "apps/admin",
      ],
      { cwd: projectDir },
    );

    await expectCommandFailure(unknownConsumerPackagePath, [
      "Unknown Package Path for --link-from: apps/admin",
      "Available Package Paths: apps/web, apps/api",
    ]);
    await expectPathMissing(path.join(projectDir, "packages/shared"));
  }, 120_000);

  it("rejects self-linking the added package from itself", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "shared",
          "--link-from",
          "packages/shared",
        ],
        { cwd: projectDir },
      ),
      "Package Link Intent cannot link packages/shared from itself",
    );
    await expectPathMissing(path.join(projectDir, "packages/shared"));
  }, 120_000);

  it.each([
    {
      preset: "vue-app",
      name: "admin",
      packagePath: "apps/admin",
      referencePath: "./apps/admin/tsconfig.app.json",
      generatedFile: "src/App.vue",
    },
    {
      preset: "ts-lib",
      name: "ui",
      packagePath: "packages/ui",
      referencePath: "./packages/ui/tsconfig.json",
      generatedFile: "src/index.ts",
    },
    {
      preset: "ts-lib",
      name: "cli",
      packagePath: "tools/cli",
      referencePath: "./tools/cli/tsconfig.json",
      generatedFile: "src/index.ts",
    },
  ])(
    "adds an explicit Package Path in $packagePath",
    async ({ preset, name, packagePath, referencePath, generatedFile }) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-package-"),
      );
      const projectDir = path.join(workspace, "demo-fullstack");

      await initGeneratedWorkspace(projectDir);

      await execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          preset,
          "--name",
          name,
          "--path",
          packagePath,
        ],
        { cwd: projectDir },
      );

      const blueprint = await readJson<{
        packages: Array<{
          name: string;
          path: string;
          role?: string;
          sourcePreset?: string;
        }>;
      }>(path.join(projectDir, ".template/blueprint.json"));
      const workspaceYaml = await readFile(
        path.join(projectDir, "pnpm-workspace.yaml"),
        "utf8",
      );
      const rootTsconfig = await readJson<{
        references?: Array<{ path: string }>;
      }>(path.join(projectDir, "tsconfig.json"));

      expect(blueprint.packages).toContainEqual(
        expect.objectContaining({
          name: `@demo-fullstack/${name}`,
          path: packagePath,
          role: preset === "ts-lib" ? "shared-library" : "runtime-service",
          sourcePreset: preset,
        }),
      );
      expect(workspaceYaml).toContain(`  - ${packagePath.split("/")[0]}/*`);
      expect(rootTsconfig.references).not.toContainEqual({
        path: referencePath,
      });
      await stat(path.join(projectDir, packagePath, generatedFile));
    },
  );

  it("keeps generated Root Check passing after an explicit Package Path addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-lib");

    await initGeneratedWorkspace(projectDir, "ts-lib");

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "cli",
        "--path",
        "tools/cli",
      ],
      { cwd: projectDir },
    );

    await execa("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd: projectDir,
    });
    await execa(
      "pnpm",
      ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
      { cwd: projectDir },
    );
    await execa("pnpm", ["run", "check"], { cwd: projectDir });
  }, 180_000);

  it("keeps generated Root Check passing after a multi-consumer Package Link Intent", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
        "--link-from",
        "apps/web",
        "--link-from",
        "apps/api",
      ],
      { cwd: projectDir },
    );

    await execa("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd: projectDir,
    });
    await execa(
      "pnpm",
      ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
      { cwd: projectDir },
    );
    await execa("pnpm", ["run", "check"], { cwd: projectDir });
  }, 180_000);

  it("rejects nested explicit Package Paths", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "vue-app",
          "--name",
          "admin",
          "--path",
          "apps/api/admin",
        ],
        { cwd: projectDir },
      ),
      "Package Path apps/api/admin must be exactly two safe path segments",
    );

    await expectPathMissing(path.join(projectDir, "apps/api/admin"));
  }, 120_000);

  it.each([
    {
      packagePath: "admin",
      diagnostic: "Package Path admin must be exactly two safe path segments",
    },
    {
      packagePath: "/apps/admin",
      diagnostic: "Package Path /apps/admin must be relative",
    },
    {
      packagePath: "../admin",
      diagnostic: "Package Path ../admin must not escape the workspace",
    },
    {
      packagePath: ".github/admin",
      diagnostic: "Package Path .github/admin uses reserved collection .github",
    },
    {
      packagePath: "node_modules/admin",
      diagnostic:
        "Package Path node_modules/admin uses reserved collection node_modules",
    },
    {
      packagePath: "dist/admin",
      diagnostic: "Package Path dist/admin uses reserved collection dist",
    },
    {
      packagePath: "target/admin",
      diagnostic: "Package Path target/admin uses reserved collection target",
    },
  ])(
    "rejects invalid explicit Package Path $packagePath",
    async ({ packagePath, diagnostic }) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-package-"),
      );
      const projectDir = path.join(workspace, "demo-fullstack");

      await initGeneratedWorkspace(projectDir);

      await expectCommandFailure(
        execa(
          "node",
          [
            "--conditions=source",
            cliPath,
            "add",
            "package",
            "--preset",
            "vue-app",
            "--name",
            "admin",
            "--path",
            packagePath,
          ],
          { cwd: projectDir },
        ),
        diagnostic,
      );
    },
    120_000,
  );

  it("rejects duplicate package names with a semantic Package Path diagnostic", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "web",
          "--path",
          "packages/web",
        ],
        { cwd: projectDir },
      ),
      "Package Path packages/web conflicts with existing package @demo-fullstack/web",
    );

    await expectPathMissing(path.join(projectDir, "packages/web"));
  }, 120_000);

  it("rejects duplicate Package Paths with a semantic Package Path diagnostic", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "admin",
          "--path",
          "apps/api",
        ],
        { cwd: projectDir },
      ),
      "Package Path apps/api conflicts with existing package @demo-fullstack/api",
    );
  }, 120_000);

  it("rejects existing filesystem target paths with a semantic Package Path diagnostic", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await mkdir(path.join(projectDir, "services/cache"), { recursive: true });

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "vue-app",
          "--name",
          "cache",
          "--path",
          "services/cache",
        ],
        { cwd: projectDir },
      ),
      "Package Path services/cache conflicts with existing filesystem path",
    );
  }, 120_000);

  it("adds a package to the generated TypeScript library workspace tracer", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-lib");

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--yes",
      ],
      { cwd: repoRoot },
    );

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
      ],
      { cwd: projectDir },
    );

    const blueprint = await readJson<{
      projectKind: string;
      packages: Array<{
        name: string;
        path: string;
        role?: string;
        sourcePreset?: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const rootTsconfig = await readJson<{
      references?: Array<{ path: string }>;
    }>(path.join(projectDir, "tsconfig.json"));
    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      packageManager?: string;
    }>(path.join(projectDir, "packages/shared/package.json"));

    expect(blueprint.projectKind).toBe("multi-package");
    expect(blueprint.packages).toEqual([
      { name: "@demo-lib/demo-lib", path: "packages/demo-lib" },
      {
        name: "@demo-lib/shared",
        path: "packages/shared",
        role: "shared-library",
        sourcePreset: "ts-lib",
      },
    ]);
    expect(workspaceYaml).toContain("  - packages/*");
    expect(rootTsconfig).toEqual({ files: [] });
    expect(packageJson.name).toBe("@demo-lib/shared");
    expect(packageJson).not.toHaveProperty("packageManager");
    expect(packageJson.scripts).not.toHaveProperty("check");
    expect(packageJson.scripts).not.toHaveProperty("build:run");
    expectSharedRootOxcScripts(packageJson.scripts);
    expect(packageJson.devDependencies.typescript).toBe("catalog:");

    await stat(path.join(projectDir, "packages/shared/src/index.ts"));
    await expectPathMissing(
      path.join(projectDir, "packages/shared/oxlint.config.ts"),
    );
    await expectPathMissing(
      path.join(projectDir, "packages/shared/oxfmt.config.ts"),
    );
  });

  it.each([{ projectName: "demo-vue", preset: "vue-app" }])(
    "adds a TypeScript library package to the generated $preset workspace",
    async ({ projectName, preset }) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-package-"),
      );
      const projectDir = path.join(workspace, projectName);

      await initGeneratedWorkspace(projectDir, preset);

      await execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "shared",
        ],
        { cwd: projectDir },
      );
      await execa(
        nodeBin,
        [
          "--conditions=source",
          cliPath,
          "blueprint",
          "validate",
          ".template/blueprint.json",
        ],
        {
          cwd: projectDir,
        },
      );

      const blueprint = await readJson<{
        projectKind: string;
        packages: Array<{
          name: string;
          path: string;
          role?: string;
          sourcePreset?: string;
        }>;
      }>(path.join(projectDir, ".template/blueprint.json"));
      const workspaceYaml = await readFile(
        path.join(projectDir, "pnpm-workspace.yaml"),
        "utf8",
      );
      const rootTsconfig = await readJson<{
        references: Array<{ path: string }>;
      }>(path.join(projectDir, "tsconfig.json"));
      const packageJson = await readJson<{
        name: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
        engines: { node: string };
      }>(path.join(projectDir, "packages/shared/package.json"));

      expect(blueprint.projectKind).toBe("multi-package");
      expect(blueprint.packages).toContainEqual(
        expect.objectContaining({
          name: `@${projectName}/shared`,
          path: "packages/shared",
          role: "shared-library",
          sourcePreset: "ts-lib",
        }),
      );
      expect(workspaceYaml).toContain("  - packages/*");
      expect(rootTsconfig.references ?? []).not.toContainEqual({
        path: "./packages/shared/tsconfig.json",
      });
      expect(packageJson.name).toBe(`@${projectName}/shared`);
      expect(packageJson.engines.node).toBe("24");
      expect(packageJson.dependencies.valibot).toBe("catalog:");
      expect(packageJson.devDependencies.typescript).toBe("catalog:");
      expectSharedRootOxcScripts(packageJson.scripts);

      await stat(path.join(projectDir, "packages/shared/src/index.ts"));
      await expectPathMissing(
        path.join(projectDir, "packages/shared/oxlint.config.ts"),
      );
      await expectPathMissing(
        path.join(projectDir, "packages/shared/oxfmt.config.ts"),
      );
    },
  );

  it("fails clearly when the requested preset does not support Package Addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    const unsupportedPackageAddition = execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "rust-bin",
        "--name",
        "native",
      ],
      { cwd: projectDir },
    );

    await expectCommandFailure(unsupportedPackageAddition, [
      "Preset rust-bin cannot be used for Package Addition.",
      "Supported Package Addition presets: ts-lib, vue-app",
    ]);

    await expect(
      stat(path.join(projectDir, "packages/native")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(projectDir, "apps/native")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails clearly when vue-hono-app is requested for Package Addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    const unsupportedPackageAddition = execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "vue-hono-app",
        "--name",
        "fullstack",
      ],
      { cwd: projectDir },
    );

    await expectCommandFailure(unsupportedPackageAddition, [
      "Preset vue-hono-app cannot be used for Package Addition.",
      "Supported Package Addition presets: ts-lib, vue-app",
    ]);

    await expect(
      stat(path.join(projectDir, "apps/fullstack")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails clearly when Local Template Metadata is missing", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await rm(path.join(projectDir, ".template"), { recursive: true });

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "worker",
        ],
        { cwd: projectDir },
      ),
      "Package Addition requires a valid .template/blueprint.json",
    );

    await expect(
      stat(path.join(projectDir, "apps/worker")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails clearly when Local Template Metadata is invalid", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await writeFile(
      path.join(projectDir, ".template/blueprint.json"),
      "null\n",
      "utf8",
    );

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "shared",
        ],
        { cwd: projectDir },
      ),
      "Package Addition requires a valid .template/blueprint.json",
    );

    await expect(
      stat(path.join(projectDir, "packages/shared")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails clearly when Local Template Metadata declares a single-package Project Shape", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await writeFile(
      path.join(projectDir, ".template/blueprint.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "single-package",
          features: ["strict-typescript", "root-check"],
          packages: [
            { name: "@demo-fullstack/shared", path: "packages/shared" },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "extra",
        ],
        { cwd: projectDir },
      ),
      "Package Addition only supports existing workspace Generated Repositories",
    );

    await expect(
      stat(path.join(projectDir, "packages/extra")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adds packages with the existing generated repository Node engine", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    const rootPackageJsonPath = path.join(projectDir, "package.json");
    const rootPackageJson = await readJson<{
      engines: { node: string };
      [key: string]: unknown;
    }>(rootPackageJsonPath);
    const inheritedNodeVersion = "25";
    await writeFile(
      rootPackageJsonPath,
      `${JSON.stringify(
        {
          ...rootPackageJson,
          engines: { ...rootPackageJson.engines, node: inheritedNodeVersion },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
      ],
      { cwd: projectDir },
    );

    const packageJson = await readJson<{
      engines: { node: string };
    }>(path.join(projectDir, "packages/shared/package.json"));

    expect(packageJson.engines.node).toBe(inheritedNodeVersion);
  });

  it("adds a Vue app package without root TypeScript project references", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "vue-app",
        "--name",
        "admin",
      ],
      { cwd: projectDir },
    );

    const blueprint = await readJson<{
      packages: Array<{
        name: string;
        path: string;
        role?: string;
        sourcePreset?: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const rootTsconfig = await readJson<{
      references: Array<{ path: string }>;
    }>(path.join(projectDir, "tsconfig.json"));
    const packageJson = await readJson<{
      name: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
      engines: { node: string };
      imports: unknown;
      packageManager?: string;
    }>(path.join(projectDir, "apps/admin/package.json"));
    const appTsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
    }>(path.join(projectDir, "apps/admin/tsconfig.app.json"));
    const appSource = await readFile(
      path.join(projectDir, "apps/admin/src/App.vue"),
      "utf8",
    );

    expect(blueprint.packages).toContainEqual(
      expect.objectContaining({
        name: "@demo-fullstack/admin",
        path: "apps/admin",
        role: "runtime-service",
        sourcePreset: "vue-app",
      }),
    );
    expect(rootTsconfig.references).not.toEqual(
      expect.arrayContaining([
        { path: "./apps/admin/tsconfig.app.json" },
        { path: "./apps/admin/tsconfig.test.json" },
        { path: "./apps/admin/tsconfig.node.json" },
      ]),
    );
    expect(packageJson.name).toBe("@demo-fullstack/admin");
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson).not.toHaveProperty("packageManager");
    expect(packageJson.dependencies.vue).toBe("catalog:");
    expect(packageJson.imports).toEqual({
      "#/*": {
        default: "./src/*.ts",
        types: "./src/*.ts",
      },
    });
    expect(packageJson.scripts["typecheck:run"]).toBe(
      "vue-tsc --build --noEmit --pretty false",
    );
    expectSharedRootOxcScripts(packageJson.scripts);
    expect(appTsconfig.compilerOptions).not.toHaveProperty("paths");
    expect(appSource).toContain('from "#/stores/counter"');

    await stat(path.join(projectDir, "apps/admin/src/App.vue"));
    await stat(path.join(projectDir, "apps/admin/scripts/run-playwright.ts"));
    await stat(path.join(projectDir, "apps/admin/test/e2e/app.spec.ts"));
    await expectPathMissing(
      path.join(projectDir, "apps/admin/oxlint.config.ts"),
    );
    await expectPathMissing(
      path.join(projectDir, "apps/admin/oxfmt.config.ts"),
    );
  });

  it("updates root OXC lint configuration when adding a Vue app to a Node-only base", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-api");

    await initGeneratedWorkspace(projectDir, "ts-lib");

    const beforeOxlintConfig = await readFile(
      path.join(projectDir, "oxlint.config.ts"),
      "utf8",
    );
    expect(beforeOxlintConfig).toContain('"typescript"');
    expect(beforeOxlintConfig).toContain('"oxc"');
    expect(beforeOxlintConfig).not.toContain('"vue"');

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "vue-app",
        "--name",
        "admin",
      ],
      { cwd: projectDir },
    );

    const afterOxlintConfig = await readFile(
      path.join(projectDir, "oxlint.config.ts"),
      "utf8",
    );
    expect(afterOxlintConfig).toContain('"vue"');
  });

  it("adds a TypeScript package to a Rust base repository", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-native");

    await initGeneratedWorkspace(projectDir, "rust-bin");

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
      ],
      { cwd: projectDir },
    );

    const blueprint = await readJson<{
      packages: Array<{
        name: string;
        path: string;
        role?: string;
        sourcePreset?: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const gitignore = await readFile(
      path.join(projectDir, ".gitignore"),
      "utf8",
    );
    const rootPackageJson = await readJson<{
      type: string;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
    }>(path.join(projectDir, "packages/shared/package.json"));

    expect(blueprint.packages).toContainEqual(
      expect.objectContaining({
        name: "@demo-native/shared",
        path: "packages/shared",
        role: "shared-library",
        sourcePreset: "ts-lib",
      }),
    );
    expect(workspaceYaml).toContain("  - packages/*");
    await expectPathMissing(path.join(projectDir, "tsconfig.json"));
    expect(rootPackageJson.type).toBe("module");
    expect(rootPackageJson.devDependencies.oxfmt).toBe("catalog:");
    expect(rootPackageJson.devDependencies.oxlint).toBe("catalog:");
    expect(gitignore).toContain("node_modules\n");
    expect(gitignore).toContain("dist\n");
    expect(packageJson.name).toBe("@demo-native/shared");
    expect(packageJson.scripts["typecheck:run"]).toBe(
      "tsc -p tsconfig.json --noEmit --pretty false",
    );
    await stat(path.join(projectDir, "oxlint.config.ts"));
    await stat(path.join(projectDir, "oxfmt.config.ts"));
  });

  it("rejects linking a TypeScript package from a native package without partial writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-native");

    await initGeneratedWorkspace(projectDir, "rust-bin");

    const blueprintPath = path.join(projectDir, ".template/blueprint.json");
    const workspaceYamlPath = path.join(projectDir, "pnpm-workspace.yaml");
    const rootPackageJsonPath = path.join(projectDir, "package.json");
    const beforeBlueprint = await readFile(blueprintPath, "utf8");
    const blueprint = await readJson<{
      packages: Array<{ path: string }>;
    }>(blueprintPath);
    const nativePackagePath = blueprint.packages[0]?.path;

    if (!nativePackagePath) {
      throw new Error("Expected rust-bin fixture to include a native package");
    }

    const beforeWorkspaceYaml = await readFile(workspaceYamlPath, "utf8");
    const beforeRootPackageJson = await readFile(rootPackageJsonPath, "utf8");
    const nativeCargoTomlPath = path.join(
      projectDir,
      nativePackagePath,
      "Cargo.toml",
    );
    const beforeNativeCargoToml = await readFile(nativeCargoTomlPath, "utf8");

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "shared",
          "--link-from",
          nativePackagePath,
        ],
        { cwd: projectDir },
      ),
      `Package Link Intent from native package ${nativePackagePath} is unsupported in V1 TypeScript-only Project Linking`,
    );

    await expectPathMissing(path.join(projectDir, "packages/shared"));
    expect(await readFile(blueprintPath, "utf8")).toBe(beforeBlueprint);
    expect(await readFile(workspaceYamlPath, "utf8")).toBe(beforeWorkspaceYaml);
    expect(await readFile(rootPackageJsonPath, "utf8")).toBe(
      beforeRootPackageJson,
    );
    expect(await readFile(nativeCargoTomlPath, "utf8")).toBe(
      beforeNativeCargoToml,
    );
  }, 120_000);

  it("adds a Vue app package with runtime-allocated e2e preview ports", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "vue-app",
        "--name",
        "admin",
      ],
      { cwd: projectDir },
    );

    const webPlaywright = await readFile(
      path.join(projectDir, "apps/web/playwright.config.ts"),
      "utf8",
    );
    const adminPlaywright = await readFile(
      path.join(projectDir, "apps/admin/playwright.config.ts"),
      "utf8",
    );
    const adminPackageJson = await readJson<{
      scripts: Record<string, string>;
    }>(path.join(projectDir, "apps/admin/package.json"));

    expect(webPlaywright).toContain('requiredPort("PLAYWRIGHT_WEB_PORT")');
    expect(adminPlaywright).toContain('requiredPort("PLAYWRIGHT_WEB_PORT")');
    expect(webPlaywright).not.toMatch(/\b(?:--port\s+|:)(?:\d[\d_]*)/);
    expect(adminPlaywright).not.toMatch(/\b(?:--port\s+|:)(?:\d[\d_]*)/);
    expect(adminPackageJson.scripts).not.toHaveProperty("check");
    expect(adminPackageJson.scripts["test:e2e:run"]).toBe(
      "node --experimental-strip-types scripts/run-playwright.ts",
    );
  });

  it("fails clearly when the target package path already exists", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");
    const userFile = path.join(projectDir, "packages/shared/README.md");

    await initGeneratedWorkspace(projectDir);
    await mkdir(path.dirname(userFile), { recursive: true });
    await writeFile(userFile, "user-owned content\n", "utf8");

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "shared",
        ],
        { cwd: projectDir },
      ),
      "Package Path packages/shared conflicts with existing filesystem path",
    );

    expect(await readFile(userFile, "utf8")).toBe("user-owned content\n");
  });

  it("fails before writing package files when the workspace manifest cannot be updated", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await writeFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "catalog:\n  vite: ^7.0.0\n",
      "utf8",
    );

    await expectCommandFailure(
      execa(
        nodeBin,
        [
          "--conditions=source",
          cliPath,
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "shared",
        ],
        {
          cwd: projectDir,
        },
      ),
      "Cannot update pnpm workspace membership",
    );

    await expect(
      stat(path.join(projectDir, "packages/shared")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adds a package without reading root TypeScript project references", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    const invalidRootTsconfig = '{ "files": [], "references": ';
    await writeFile(
      path.join(projectDir, "tsconfig.json"),
      invalidRootTsconfig,
      "utf8",
    );

    await execa(
      "node",
      [
        "--conditions=source",
        cliPath,
        "add",
        "package",
        "--preset",
        "ts-lib",
        "--name",
        "shared",
      ],
      { cwd: projectDir },
    );

    const rootTsconfig = await readFile(
      path.join(projectDir, "tsconfig.json"),
      "utf8",
    );
    const blueprint = await readJson<{
      packages: Array<{
        name: string;
        path: string;
        role?: string;
        sourcePreset?: string;
      }>;
    }>(path.join(projectDir, ".template/blueprint.json"));

    expect(rootTsconfig).toBe(invalidRootTsconfig);
    expect(blueprint.packages).toContainEqual(
      expect.objectContaining({
        name: "@demo-fullstack/shared",
        path: "packages/shared",
        role: "shared-library",
        sourcePreset: "ts-lib",
      }),
    );
    await stat(path.join(projectDir, "packages/shared/src/index.ts"));
  });
});
