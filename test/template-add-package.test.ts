import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src/cli.ts");
const tsxBin = path.join(repoRoot, "node_modules/.bin/tsx");

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function initGeneratedWorkspace(projectDir: string): Promise<void> {
  await execa(
    "pnpm",
    ["exec", "tsx", cliPath, "init", projectDir, "--preset", "vue-hono-app", "--yes"],
    { cwd: repoRoot }
  );
}

function playwrightWebServerPorts(configText: string): number[] {
  const matches = [
    ...configText.matchAll(/port:\s*(\d+)/g),
    ...configText.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)
  ];

  if (matches.length === 0) {
    throw new Error("Playwright config does not declare a web server port");
  }

  return matches.map((match) => Number(match[1]));
}

describe("template add package", () => {
  it("adds packages while keeping the stored blueprint valid for later additions", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "add", "package", "--preset", "ts-lib", "--name", "shared"],
      { cwd: projectDir }
    );
    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "blueprint", "validate", ".project-kit/blueprint.json"],
      { cwd: projectDir }
    );
    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "add", "package", "--preset", "hono-api", "--name", "worker"],
      { cwd: projectDir }
    );

    const blueprint = await readJson<{
      preset: string;
      projectKind: string;
      packages: Array<{ name: string; path: string; preset?: string }>;
    }>(path.join(projectDir, ".project-kit/blueprint.json"));
    const workspaceYaml = await readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8");
    const rootPackageJson = await readJson<{ scripts: Record<string, string> }>(
      path.join(projectDir, "package.json")
    );
    const rootTsconfig = await readJson<{ references: Array<{ path: string }> }>(
      path.join(projectDir, "tsconfig.json")
    );
    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "packages/shared/package.json"));
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
      include: string[];
    }>(path.join(projectDir, "packages/shared/tsconfig.json"));

    expect(blueprint).toEqual(
      expect.objectContaining({
        preset: "vue-hono-app",
        projectKind: "multi-package",
        packages: [
          { name: "@demo-fullstack/web", path: "apps/web" },
          { name: "@demo-fullstack/api", path: "apps/api" },
          { name: "@demo-fullstack/shared", path: "packages/shared" },
          { name: "@demo-fullstack/worker", path: "apps/worker" }
        ]
      })
    );
    expect(workspaceYaml).toContain("  - apps/*");
    expect(workspaceYaml).toContain("  - packages/*");
    expect(rootPackageJson.scripts.check).toBe("turbo run check");
    expect(rootTsconfig.references).toContainEqual({
      path: "./packages/shared/tsconfig.json"
    });
    expect(packageJson.name).toBe("@demo-fullstack/shared");
    expect(packageJson.scripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check"
    );
    expect(packageJson.devDependencies.typescript).toBe("catalog:");
    expect(tsconfig.compilerOptions.composite).toBe(true);
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });
    expect(tsconfig.include).toEqual(["src/**/*.ts"]);

    await stat(path.join(projectDir, "packages/shared/src/index.ts"));
    await stat(path.join(projectDir, "apps/worker/src/app.ts"));
  });

  it("fails clearly in a generated Single-Package Project", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-lib");

    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "init", projectDir, "--preset", "ts-lib", "--yes"],
      { cwd: repoRoot }
    );

    await expect(
      execa(
        "pnpm",
        ["exec", "tsx", cliPath, "add", "package", "--preset", "ts-lib", "--name", "shared"],
        { cwd: projectDir }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Package Addition only supports existing workspace Generated Repositories"
      )
    });

    await expect(stat(path.join(projectDir, "packages/shared"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("adds a Hono API package to a generated workspace repository", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "add", "package", "--preset", "hono-api", "--name", "worker"],
      { cwd: projectDir }
    );

    const blueprint = await readJson<{
      packages: Array<{ name: string; path: string; preset?: string }>;
    }>(path.join(projectDir, ".project-kit/blueprint.json"));
    const rootTsconfig = await readJson<{ references: Array<{ path: string }> }>(
      path.join(projectDir, "tsconfig.json")
    );
    const packageJson = await readJson<{
      name: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    }>(path.join(projectDir, "apps/worker/package.json"));

    expect(blueprint.packages).toContainEqual({
      name: "@demo-fullstack/worker",
      path: "apps/worker"
    });
    expect(rootTsconfig.references).toContainEqual({
      path: "./apps/worker/tsconfig.json"
    });
    expect(packageJson.name).toBe("@demo-fullstack/worker");
    expect(packageJson.dependencies.hono).toBe("catalog:");
    expect(packageJson.scripts.check).toContain("pnpm run test");

    await stat(path.join(projectDir, "apps/worker/src/app.ts"));
    await stat(path.join(projectDir, "apps/worker/test/app.test.ts"));
  });

  it("adds a Vue app package with root TypeScript project references", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "add", "package", "--preset", "vue-app", "--name", "admin"],
      { cwd: projectDir }
    );

    const blueprint = await readJson<{
      packages: Array<{ name: string; path: string; preset?: string }>;
    }>(path.join(projectDir, ".project-kit/blueprint.json"));
    const rootTsconfig = await readJson<{ references: Array<{ path: string }> }>(
      path.join(projectDir, "tsconfig.json")
    );
    const packageJson = await readJson<{
      name: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    }>(path.join(projectDir, "apps/admin/package.json"));

    expect(blueprint.packages).toContainEqual({
      name: "@demo-fullstack/admin",
      path: "apps/admin"
    });
    expect(rootTsconfig.references).toEqual(
      expect.arrayContaining([
        { path: "./apps/admin/tsconfig.app.json" },
        { path: "./apps/admin/tsconfig.test.json" },
        { path: "./apps/admin/tsconfig.node.json" }
      ])
    );
    expect(packageJson.name).toBe("@demo-fullstack/admin");
    expect(packageJson.dependencies.vue).toBe("catalog:");
    expect(packageJson.scripts.typecheck).toBe("vue-tsc --build --noEmit");

    await stat(path.join(projectDir, "apps/admin/src/App.vue"));
    await stat(path.join(projectDir, "apps/admin/test/e2e/app.spec.ts"));
  });

  it("adds a Vue app package with a distinct e2e preview port from the existing web app", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "add", "package", "--preset", "vue-app", "--name", "admin"],
      { cwd: projectDir }
    );

    const webPlaywright = await readFile(
      path.join(projectDir, "apps/web/playwright.config.ts"),
      "utf8"
    );
    const adminPlaywright = await readFile(
      path.join(projectDir, "apps/admin/playwright.config.ts"),
      "utf8"
    );
    const adminPackageJson = await readJson<{ scripts: Record<string, string> }>(
      path.join(projectDir, "apps/admin/package.json")
    );

    expect(playwrightWebServerPorts(webPlaywright)).toContain(4173);
    const [adminPort] = playwrightWebServerPorts(adminPlaywright);
    expect(playwrightWebServerPorts(webPlaywright)).not.toContain(adminPort);
    expect(adminPackageJson.scripts.check).toContain("pnpm run test:e2e");
    expect(adminPackageJson.scripts["test:e2e"]).toBe("pnpm run build && playwright test");
  });

  it("fails clearly when the target package path already exists", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");
    const userFile = path.join(projectDir, "packages/shared/README.md");

    await initGeneratedWorkspace(projectDir);
    await mkdir(path.dirname(userFile), { recursive: true });
    await writeFile(userFile, "user-owned content\n", "utf8");

    await expect(
      execa(
        "pnpm",
        ["exec", "tsx", cliPath, "add", "package", "--preset", "ts-lib", "--name", "shared"],
        { cwd: projectDir }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Package Addition would overwrite an existing path")
    });

    expect(await readFile(userFile, "utf8")).toBe("user-owned content\n");
  });

  it("fails before writing package files when the workspace manifest cannot be updated", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await writeFile(path.join(projectDir, "pnpm-workspace.yaml"), "catalog:\n  vite: ^7.0.0\n", "utf8");

    await expect(
      execa(
        tsxBin,
        [cliPath, "add", "package", "--preset", "ts-lib", "--name", "shared"],
        { cwd: projectDir }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Cannot update pnpm workspace membership")
    });

    await expect(stat(path.join(projectDir, "packages/shared"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("fails before writing package files when root TypeScript references cannot be updated", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);
    await writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({ files: [], references: "./apps/web" }, null, 2),
      "utf8"
    );

    await expect(
      execa(
        "pnpm",
        ["exec", "tsx", cliPath, "add", "package", "--preset", "ts-lib", "--name", "shared"],
        { cwd: projectDir }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Cannot update root TypeScript project references: references must be an array"
      )
    });

    await expect(stat(path.join(projectDir, "packages/shared"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
