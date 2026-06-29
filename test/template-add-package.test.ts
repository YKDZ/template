import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src/cli.ts");

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

describe("template add package", () => {
  it("adds a TypeScript library package to a generated workspace repository", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-package-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await initGeneratedWorkspace(projectDir);

    await execa(
      "pnpm",
      ["exec", "tsx", cliPath, "add", "package", "--preset", "ts-lib", "--name", "shared"],
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
          { name: "@demo-fullstack/shared", path: "packages/shared", preset: "ts-lib" }
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
      path: "apps/worker",
      preset: "hono-api"
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
      path: "apps/admin",
      preset: "vue-app"
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
});
