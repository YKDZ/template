import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("template init", () => {
  it("generates a usable ts-lib project through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
    const projectDir = path.join(workspace, "demo-lib");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8"
    );
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
    }>(path.join(projectDir, "tsconfig.json"));
    const blueprint = await readJson<{ preset: string }>(
      path.join(projectDir, ".project-kit/blueprint.json")
    );
    const generatedBy = await readJson<{ packageName: string }>(
      path.join(projectDir, ".project-kit/generated-by.json")
    );
    const projectKitFiles = await readdir(path.join(projectDir, ".project-kit"));

    expect(packageJson.name).toBe("demo-lib");
    expect(packageJson.scripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check"
    );
    expect(packageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix"
    );
    expect(packageJson.devDependencies.typescript).toBe("catalog:");
    expect(packageJson.devDependencies.oxlint).toBe("catalog:");
    expect(packageJson.devDependencies.oxfmt).toBe("catalog:");

    expect(workspaceYaml).toContain("catalog:");
    expect(workspaceYaml).toContain("typescript:");
    expect(workspaceYaml).toContain("oxlint:");
    expect(workspaceYaml).toContain("oxfmt:");

    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });

    expect(blueprint.preset).toBe("ts-lib");
    expect(generatedBy.packageName).toBe("@ykdz/template");
    expect(projectKitFiles).toEqual(["blueprint.json", "generated-by.json"]);

    await stat(path.join(projectDir, ".devcontainer/devcontainer.json"));
    await stat(path.join(projectDir, ".github/workflows/check.yml"));
    await stat(path.join(projectDir, ".github/dependabot.yml"));
    await stat(path.join(projectDir, "src/index.ts"));

    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    expect(checkWorkflow).not.toContain("cache: pnpm");
    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m
    )?.[1];
    expect(installCommand).toBeDefined();

    await execa("pnpm", installCommand!.split(" ").slice(1), {
      cwd: projectDir
    });

    await writeFile(
      path.join(projectDir, "src/internal.ts"),
      [
        "export function greetingMessage(name: string): string {",
        "  return `Hello, ${name}`;",
        "}",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(projectDir, "src/index.ts"),
      [
        'import { greetingMessage } from "@/internal.js";',
        "",
        "export type Greeting = {",
        "  message: string;",
        "};",
        "",
        "export function greet(name: string): Greeting {",
        "  return { message: greetingMessage(name) };",
        "}",
        ""
      ].join("\n")
    );

    await execa("pnpm", ["run", "check"], { cwd: projectDir });
    await execa("pnpm", ["run", "build"], { cwd: projectDir });

    const emittedIndex = await readFile(
      path.join(projectDir, "dist/index.js"),
      "utf8"
    );
    expect(emittedIndex).not.toContain("@/");

    const importResult = await execa(
      "node",
      [
        "--input-type=module",
        "--eval",
        [
          `import { greet } from ${JSON.stringify(
            pathToFileURL(path.join(projectDir, "dist/index.js")).href
          )};`,
          'console.log(greet("Ada").message);'
        ].join("\n")
      ],
      { cwd: projectDir }
    );
    expect(importResult.stdout).toBe("Hello, Ada");
  });

  it("generates a usable hono-api project through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
    const projectDir = path.join(workspace, "demo-api");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "hono-api",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8"
    );
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
    }>(path.join(projectDir, "tsconfig.json"));
    const blueprint = await readJson<{ preset: string }>(
      path.join(projectDir, ".project-kit/blueprint.json")
    );
    const appSource = await readFile(path.join(projectDir, "src/app.ts"), "utf8");
    const serverSource = await readFile(
      path.join(projectDir, "src/server.ts"),
      "utf8"
    );

    expect(packageJson.name).toBe("demo-api");
    expect(packageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test"
    );
    expect(packageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix"
    );
    expect(packageJson.scripts.start).toBe("node dist/server.js");
    expect(packageJson.dependencies.hono).toBe("catalog:");
    expect(packageJson.dependencies["@hono/node-server"]).toBe("catalog:");
    expect(packageJson.devDependencies.vitest).toBe("catalog:");
    expect(packageJson.devDependencies.typescript).toBe("catalog:");
    expect(packageJson.devDependencies.oxlint).toBe("catalog:");
    expect(packageJson.devDependencies.oxfmt).toBe("catalog:");

    expect(workspaceYaml).toContain("catalog:");
    expect(workspaceYaml).toContain("hono:");
    expect(workspaceYaml).toContain('"@hono/node-server":');
    expect(workspaceYaml).toContain("vitest:");

    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });

    expect(blueprint.preset).toBe("hono-api");
    expect(appSource).toContain('"/health"');
    expect(serverSource).toContain('from "@/app.js"');

    await stat(path.join(projectDir, ".devcontainer/devcontainer.json"));
    await stat(path.join(projectDir, ".github/workflows/check.yml"));
    await stat(path.join(projectDir, ".github/dependabot.yml"));
    await stat(path.join(projectDir, "test/app.test.ts"));

    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    expect(checkWorkflow).not.toContain("cache: pnpm");
    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m
    )?.[1];
    expect(installCommand).toBeDefined();

    await execa("pnpm", installCommand!.split(" ").slice(1), {
      cwd: projectDir
    });
    await execa("pnpm", ["run", "check"], { cwd: projectDir });
    await execa("pnpm", ["run", "build"], { cwd: projectDir });

    const server = execa("pnpm", ["run", "start"], { cwd: projectDir });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for Hono API to start"));
        }, 10_000);

        server.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("http://localhost:3000")) {
            clearTimeout(timeout);
            resolve();
          }
        });

        server.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const response = await fetch("http://localhost:3000/health");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    } finally {
      server.kill("SIGTERM");
    }
  });

  it("generates a usable rust-bin project through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
    const projectDir = path.join(workspace, "demo-rust");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "rust-bin",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const cargoToml = await readFile(path.join(projectDir, "Cargo.toml"), "utf8");
    const rustfmtToml = await readFile(path.join(projectDir, "rustfmt.toml"), "utf8");
    const checkScript = await readFile(path.join(projectDir, "scripts/check"), "utf8");
    const devcontainer = await readJson<{
      image: string;
      mounts: string[];
      customizations: { vscode: { extensions: string[] } };
    }>(path.join(projectDir, ".devcontainer/devcontainer.json"));
    const blueprint = await readJson<{ preset: string }>(
      path.join(projectDir, ".project-kit/blueprint.json")
    );
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    const dependabot = await readFile(
      path.join(projectDir, ".github/dependabot.yml"),
      "utf8"
    );

    expect(cargoToml).toContain('name = "demo-rust"');
    expect(cargoToml).toContain('edition = "2024"');
    expect(cargoToml).toContain("[workspace.lints.clippy]");
    expect(cargoToml).toContain('all = "deny"');
    expect(cargoToml).toContain("[profile.release]");
    expect(cargoToml).toContain('strip = "symbols"');
    expect(rustfmtToml).toContain("edition = \"2024\"");

    expect(checkScript).toContain("cargo fmt --all -- --check");
    expect(checkScript).toContain(
      "cargo clippy --workspace --all-targets -- -D warnings"
    );
    expect(checkScript).toContain("cargo test --workspace");

    expect(devcontainer.image).toContain("rust");
    expect(devcontainer.mounts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("target=/usr/local/cargo/registry"),
        expect.stringContaining("target=${containerWorkspaceFolder}/target")
      ])
    );
    expect(devcontainer.customizations.vscode.extensions).toEqual(
      expect.arrayContaining(["rust-lang.rust-analyzer", "tamasfe.even-better-toml"])
    );

    expect(blueprint.preset).toBe("rust-bin");
    expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(checkWorkflow).toContain("components: rustfmt, clippy");
    expect(checkWorkflow).toContain("uses: Swatinem/rust-cache@v2");
    expect(checkWorkflow).toContain("run: ./scripts/check");
    expect(dependabot).toContain("package-ecosystem: cargo");
    expect(dependabot).toContain("package-ecosystem: github-actions");

    await stat(path.join(projectDir, "src/main.rs"));
    await stat(path.join(projectDir, "Cargo.lock"));
    await expect(
      stat(path.join(projectDir, "package.json"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });

    const checkResult = await execa("./scripts/check", [], { cwd: projectDir });
    expect(checkResult.stdout).toContain("cargo fmt");
    expect(checkResult.stdout).toContain("cargo clippy");
    expect(checkResult.stdout).toContain("cargo test");

    const runResult = await execa("cargo", ["run", "--quiet"], { cwd: projectDir });
    expect(runResult.stdout).toBe("Hello from demo-rust");
  }, 120_000);

  it("generates a Vue app project through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
    const projectDir = path.join(workspace, "demo-vue");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "vue-app",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8"
    );
    const tsconfig = await readJson<{
      files: string[];
      references: Array<{ path: string }>;
    }>(path.join(projectDir, "tsconfig.json"));
    const appTsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
      include: string[];
    }>(path.join(projectDir, "tsconfig.app.json"));
    const testTsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
      include: string[];
    }>(path.join(projectDir, "tsconfig.test.json"));
    const nodeTsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
      include: string[];
    }>(path.join(projectDir, "tsconfig.node.json"));
    const blueprint = await readJson<{ preset: string }>(
      path.join(projectDir, ".project-kit/blueprint.json")
    );

    expect(packageJson.name).toBe("demo-vue");
    expect(packageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test && pnpm run test:e2e"
    );
    expect(packageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix"
    );
    expect(packageJson.scripts["test:e2e"]).toBe(
      "pnpm run build && playwright test"
    );
    expect(packageJson.scripts.typecheck).toBe("vue-tsc --build --noEmit");
    expect(packageJson.dependencies.vue).toBe("catalog:");
    expect(packageJson.dependencies.pinia).toBe("catalog:");
    expect(packageJson.dependencies["@vueuse/core"]).toBe("catalog:");
    expect(packageJson.devDependencies.vite).toBe("catalog:");
    expect(packageJson.devDependencies["@vitejs/plugin-vue"]).toBe("catalog:");
    expect(packageJson.devDependencies["@vue/tsconfig"]).toBe("catalog:");
    expect(packageJson.devDependencies["@types/web-bluetooth"]).toBe("catalog:");
    expect(packageJson.devDependencies.vitest).toBe("catalog:");
    expect(packageJson.devDependencies["@playwright/test"]).toBe("catalog:");
    for (const excludedPackage of [
      "vue-router",
      "echarts",
      "shadcn-vue",
      "vee-validate",
      "@tanstack/vue-form"
    ]) {
      expect(packageJson.dependencies).not.toHaveProperty(excludedPackage);
      expect(packageJson.devDependencies).not.toHaveProperty(excludedPackage);
    }

    expect(workspaceYaml).toContain("catalog:");
    expect(workspaceYaml).toContain("vue:");
    expect(workspaceYaml).toContain("pinia:");
    expect(workspaceYaml).toContain('"@vueuse/core":');
    expect(workspaceYaml).toContain("vite:");
    expect(workspaceYaml).toContain('"@playwright/test":');
    expect(workspaceYaml).toContain('"@types/web-bluetooth":');

    expect(tsconfig.files).toEqual([]);
    expect(tsconfig.references).toEqual([
      { path: "./tsconfig.app.json" },
      { path: "./tsconfig.test.json" },
      { path: "./tsconfig.node.json" }
    ]);
    expect(appTsconfig.compilerOptions.strict).toBe(true);
    expect(appTsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(appTsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });
    expect(appTsconfig.compilerOptions.types).toEqual(["web-bluetooth"]);
    expect(appTsconfig.include).toEqual([
      "env.d.ts",
      "src/**/*.ts",
      "src/**/*.vue"
    ]);
    expect(testTsconfig.compilerOptions.types).toEqual([
      "node",
      "vitest/globals",
      "web-bluetooth"
    ]);
    expect(testTsconfig.include).toEqual([
      "env.d.ts",
      "src/**/*.ts",
      "src/**/*.vue",
      "test/**/*.ts"
    ]);
    expect(nodeTsconfig.compilerOptions.types).toEqual(["node"]);
    expect(nodeTsconfig.include).toEqual([
      "playwright.config.ts",
      "vite.config.ts",
      "vitest.config.ts"
    ]);

    expect(blueprint.preset).toBe("vue-app");

    await stat(path.join(projectDir, ".devcontainer/devcontainer.json"));
    await stat(path.join(projectDir, ".github/workflows/check.yml"));
    await stat(path.join(projectDir, ".github/dependabot.yml"));
    await stat(path.join(projectDir, "src/App.vue"));
    await stat(path.join(projectDir, "src/main.ts"));
    await stat(path.join(projectDir, "test/app.test.ts"));
    await stat(path.join(projectDir, "test/e2e/app.spec.ts"));

    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    expect(checkWorkflow).not.toContain("cache: pnpm");
    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m
    )?.[1];
    expect(installCommand).toBeDefined();
    expect(checkWorkflow).toContain("pnpm exec playwright install --with-deps chromium");

    await execa("pnpm", installCommand!.split(" ").slice(1), {
      cwd: projectDir
    });
    await writeFile(
      path.join(projectDir, "src/type-boundary.ts"),
      [
        "export const nodeEnv = process.env.NODE_ENV;",
        "",
        'describe("browser app source", () => {',
        '  it("does not see test globals", () => {',
        "    expect(nodeEnv).toBeDefined();",
        "  });",
        "});",
        ""
      ].join("\n")
    );
    await expect(
      execa("pnpm", ["run", "typecheck"], { cwd: projectDir })
    ).rejects.toMatchObject({
      failed: true
    });
    await writeFile(
      path.join(projectDir, "src/type-boundary.ts"),
      [
        "export function currentBrowserLocation(): string {",
        "  return window.location.href;",
        "}",
        ""
      ].join("\n")
    );
    await execa("pnpm", ["run", "typecheck"], { cwd: projectDir });
    await execa("pnpm", ["exec", "playwright", "install", "chromium"], {
      cwd: projectDir
    });
    await execa("pnpm", ["run", "test:e2e"], { cwd: projectDir });
    await execa("pnpm", ["run", "check"], { cwd: projectDir });
  }, 180_000);
});
