import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "src/cli.ts");
const tsxBin = path.join(repoRoot, "node_modules/.bin/tsx");

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function expectSharedRootOxcScripts(scripts: Record<string, string>): void {
  expect(scripts["format:check"]).toBe(
    "oxfmt --check --config ../../oxfmt.config.ts .",
  );
  expect(scripts["format:write"]).toBe(
    "oxfmt --write --config ../../oxfmt.config.ts .",
  );
  expect(scripts.lint).toBe(
    "oxlint --config ../../oxlint.config.ts . --deny-warnings",
  );
  expect(scripts["lint:fix"]).toBe(
    "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings",
  );
}

function catalogFromWorkspaceYaml(
  workspaceYaml: string,
): Record<string, string> {
  const parsed = parseYaml(workspaceYaml) as {
    catalog?: Record<string, string>;
  };

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

  return [...dependencies].sort();
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
    "pnpm",
    ["exec", "tsx", cliPath, "init", projectDir, "--preset", preset, "--yes"],
    { cwd: repoRoot },
  );
}

function playwrightWebServerPorts(configText: string): number[] {
  const matches = [
    ...configText.matchAll(/port:\s*(\d+)/g),
    ...configText.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g),
  ];

  if (matches.length === 0) {
    throw new Error("Playwright config does not declare a web server port");
  }

  return matches.map((match) => Number(match[1]));
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
      "pnpm",
      [
        "exec",
        "tsx",
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
      "pnpm",
      [
        "exec",
        "tsx",
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
      tsxBin,
      [cliPath, "blueprint", "validate", ".template/blueprint.json"],
      {
        cwd: projectDir,
      },
    );
    await execa(
      tsxBin,
      [cliPath, "add", "package", "--preset", "hono-api", "--name", "worker"],
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
      tasks: {
        build: { dependsOn?: string[]; outputs: string[] };
        check: { dependsOn: string[] };
        typecheck: { dependsOn: string[] };
        test: { dependsOn: string[] };
        "test:e2e": { dependsOn: string[] };
      };
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
    const workerPackageJson = await readJson<{
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/worker/package.json"));
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
      {
        name: "@demo-fullstack/worker",
        path: "apps/worker",
        role: "runtime-service",
        sourcePreset: "hono-api",
      },
    ]);
    expect(workspaceYaml).toContain("  - apps/*");
    expect(workspaceYaml).toContain("  - packages/*");
    expect(rootPackageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './apps/*' --filter './packages/*' && turbo run build --filter './apps/*' --filter './packages/*' && turbo run test --filter './apps/*' --filter './packages/*' && turbo run test:e2e --filter './apps/*' --filter './packages/*' && turbo run check --filter './apps/*' --filter './packages/*'",
    );
    expect(rootPackageJson.scripts.check).not.toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './apps/*' && turbo run check --filter './apps/*'",
    );
    expect(turboConfig.tasks.typecheck.dependsOn).toEqual(["^typecheck"]);
    expect(turboConfig.tasks.build).toEqual({
      dependsOn: ["^build"],
      outputs: ["dist/**"],
    });
    expect(turboConfig.tasks.test.dependsOn).toEqual(["^typecheck"]);
    expect(turboConfig.tasks["test:e2e"].dependsOn).toEqual([
      "build",
      "^build",
    ]);
    expect(turboConfig.tasks.check.dependsOn).toEqual([
      "typecheck",
      "build",
      "test",
      "test:e2e",
    ]);
    expect(rootPackageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix && turbo run fix --filter './apps/*' --filter './packages/*'",
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
    expect(packageJson.scripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );
    expect(packageJson.scripts).not.toHaveProperty("build");
    expectSharedRootOxcScripts(packageJson.scripts);
    expect(packageJson.devDependencies.typescript).toBe("catalog:");
    const addedPackageDependencySpecifiers = [
      ...Object.values(packageJson.devDependencies),
      ...Object.values(workerPackageJson.dependencies),
      ...Object.values(workerPackageJson.devDependencies),
    ];
    expect(
      addedPackageDependencySpecifiers.every((value) => value === "catalog:"),
    ).toBe(true);
    expect(tsconfig.compilerOptions.composite).toBe(true);
    expect(tsconfig.compilerOptions).not.toHaveProperty("paths");
    expect(tsconfig.include).toEqual(["src/**/*.ts"]);

    await stat(path.join(projectDir, "packages/shared/src/index.ts"));
    await stat(path.join(projectDir, "apps/worker/src/app.ts"));
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
      "pnpm",
      [
        "exec",
        "tsx",
        cliPath,
        "add",
        "package",
        "--preset",
        "hono-api",
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
        sourcePreset: "hono-api",
      }),
    );
    expect(workspaceYaml).toContain("  - services/*");
    expect(rootPackageJson.scripts.check).toContain(
      "turbo run typecheck --filter './apps/*' --filter './services/*'",
    );
    expect(rootPackageJson.scripts.check).toContain(
      "turbo run check --filter './apps/*' --filter './services/*'",
    );
    expect(rootTsconfig.references).not.toContainEqual({
      path: "./services/worker/tsconfig.json",
    });
    expect(packageJson.name).toBe("@demo-fullstack/worker");
    await stat(path.join(projectDir, "services/worker/src/app.ts"));
    await expectPathMissing(path.join(projectDir, "apps/worker/package.json"));
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
        "pnpm",
        [
          "exec",
          "tsx",
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
      "pnpm",
      [
        "exec",
        "tsx",
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
    await execa("pnpm", ["run", "check"], { cwd: projectDir });
  }, 180_000);

  it("rejects nested explicit Package Paths", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
          cliPath,
          "add",
          "package",
          "--preset",
          "hono-api",
          "--name",
          "admin",
          "--path",
          "apps/api/admin",
        ],
        { cwd: projectDir },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Path apps/api/admin must be exactly two safe path segments",
      ),
    });

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

      await expect(
        execa(
          "pnpm",
          [
            "exec",
            "tsx",
            cliPath,
            "add",
            "package",
            "--preset",
            "hono-api",
            "--name",
            "admin",
            "--path",
            packagePath,
          ],
          { cwd: projectDir },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(diagnostic),
      });
    },
    120_000,
  );

  it("rejects duplicate package names with a semantic Package Path diagnostic", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
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
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Path packages/web conflicts with existing package @demo-fullstack/web",
      ),
    });

    await expectPathMissing(path.join(projectDir, "packages/web"));
  }, 120_000);

  it("rejects duplicate Package Paths with a semantic Package Path diagnostic", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
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
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Path apps/api conflicts with existing package @demo-fullstack/api",
      ),
    });
  }, 120_000);

  it("rejects existing filesystem target paths with a semantic Package Path diagnostic", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await mkdir(path.join(projectDir, "services/cache"), { recursive: true });

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
          cliPath,
          "add",
          "package",
          "--preset",
          "hono-api",
          "--name",
          "cache",
          "--path",
          "services/cache",
        ],
        { cwd: projectDir },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Path services/cache conflicts with existing filesystem path",
      ),
    });
  }, 120_000);

  it("adds a package to the generated TypeScript library workspace tracer", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-lib");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
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
      "pnpm",
      [
        "exec",
        "tsx",
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
    expect(packageJson.scripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );
    expect(packageJson.scripts).not.toHaveProperty("build");
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

  it.each([
    { projectName: "demo-api", preset: "hono-api" },
    { projectName: "demo-vue", preset: "vue-app" },
  ])(
    "adds a TypeScript library package to the generated $preset workspace",
    async ({ projectName, preset }) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-package-"),
      );
      const projectDir = path.join(workspace, projectName);

      await initGeneratedWorkspace(projectDir, preset);

      await execa(
        "pnpm",
        [
          "exec",
          "tsx",
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
        tsxBin,
        [cliPath, "blueprint", "validate", ".template/blueprint.json"],
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
      "pnpm",
      [
        "exec",
        "tsx",
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

    await expect(unsupportedPackageAddition).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Preset rust-bin cannot be used for Package Addition.",
      ),
    });
    await expect(unsupportedPackageAddition).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Supported Package Addition presets: ts-lib, hono-api, vue-app",
      ),
    });

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

  it("fails clearly when Local Template Metadata is missing", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await rm(path.join(projectDir, ".template"), { recursive: true });

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
          cliPath,
          "add",
          "package",
          "--preset",
          "hono-api",
          "--name",
          "worker",
        ],
        { cwd: projectDir },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Addition requires a valid .template/blueprint.json",
      ),
    });

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

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
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
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Addition requires a valid .template/blueprint.json",
      ),
    });

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

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
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
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Addition only supports existing workspace Generated Repositories",
      ),
    });

    await expect(
      stat(path.join(projectDir, "packages/extra")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adds a Hono API package to a generated workspace repository", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        cliPath,
        "add",
        "package",
        "--preset",
        "hono-api",
        "--name",
        "worker",
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
      types: string;
      exports: unknown;
      imports: unknown;
      packageManager?: string;
    }>(path.join(projectDir, "apps/worker/package.json"));
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
    }>(path.join(projectDir, "apps/worker/tsconfig.json"));
    const serverSource = await readFile(
      path.join(projectDir, "apps/worker/src/server.ts"),
      "utf8",
    );
    const testSource = await readFile(
      path.join(projectDir, "apps/worker/test/app.test.ts"),
      "utf8",
    );

    expect(blueprint.packages).toContainEqual(
      expect.objectContaining({
        name: "@demo-fullstack/worker",
        path: "apps/worker",
        role: "runtime-service",
        sourcePreset: "hono-api",
      }),
    );
    expect(rootTsconfig.references).not.toContainEqual({
      path: "./apps/worker/tsconfig.json",
    });
    expect(packageJson.name).toBe("@demo-fullstack/worker");
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson).not.toHaveProperty("packageManager");
    expect(packageJson.dependencies.hono).toBe("catalog:");
    expect(packageJson.types).toBe("./src/index.ts");
    expect(packageJson.exports).toEqual({
      ".": {
        default: "./dist/index.js",
        types: "./src/index.ts",
      },
    });
    expect(packageJson.imports).toEqual({
      "#/*": {
        default: "./dist/*.js",
        types: "./src/*.ts",
      },
    });
    expect(packageJson.scripts.check).toContain("pnpm run test");
    expectSharedRootOxcScripts(packageJson.scripts);
    expect(tsconfig.compilerOptions).not.toHaveProperty("paths");
    expect(serverSource).toContain('from "#/app"');
    expect(serverSource).not.toContain('from "#/app.js"');
    expect(testSource).toContain('from "#/app"');
    expect(testSource).not.toContain('from "#/app.js"');

    await stat(path.join(projectDir, "apps/worker/src/app.ts"));
    await stat(path.join(projectDir, "apps/worker/test/app.test.ts"));
    await expectPathMissing(
      path.join(projectDir, "apps/worker/oxlint.config.ts"),
    );
    await expectPathMissing(
      path.join(projectDir, "apps/worker/oxfmt.config.ts"),
    );
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
      "pnpm",
      [
        "exec",
        "tsx",
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
      "pnpm",
      [
        "exec",
        "tsx",
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
    expect(packageJson.scripts.typecheck).toBe("vue-tsc --build --noEmit");
    expectSharedRootOxcScripts(packageJson.scripts);
    expect(appTsconfig.compilerOptions).not.toHaveProperty("paths");
    expect(appSource).toContain('from "#/stores/counter"');

    await stat(path.join(projectDir, "apps/admin/src/App.vue"));
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

    await initGeneratedWorkspace(projectDir, "hono-api");

    const beforeOxlintConfig = await readFile(
      path.join(projectDir, "oxlint.config.ts"),
      "utf8",
    );
    expect(beforeOxlintConfig).toContain('plugins: ["typescript", "oxc"]');

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
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
    expect(afterOxlintConfig).toContain(
      'plugins: ["typescript", "oxc", "vue"]',
    );
  });

  it("adds a TypeScript package to a Rust base repository", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-native");

    await initGeneratedWorkspace(projectDir, "rust-bin");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
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
    expect(packageJson.scripts.check).toContain("pnpm run typecheck");
    await stat(path.join(projectDir, "oxlint.config.ts"));
    await stat(path.join(projectDir, "oxfmt.config.ts"));
  });

  it("adds a Vue app package with a distinct e2e preview port from the existing web app", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-package-"),
    );
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
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

    expect(playwrightWebServerPorts(webPlaywright)).toContain(4173);
    const [adminPort] = playwrightWebServerPorts(adminPlaywright);
    expect(playwrightWebServerPorts(webPlaywright)).not.toContain(adminPort);
    expect(adminPackageJson.scripts.check).toContain("pnpm run test:e2e");
    expect(adminPackageJson.scripts["test:e2e"]).toBe(
      "pnpm run build && playwright test",
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

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
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
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Path packages/shared conflicts with existing filesystem path",
      ),
    });

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

    await expect(
      execa(
        tsxBin,
        [cliPath, "add", "package", "--preset", "ts-lib", "--name", "shared"],
        {
          cwd: projectDir,
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Cannot update pnpm workspace membership",
      ),
    });

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
      "pnpm",
      [
        "exec",
        "tsx",
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
