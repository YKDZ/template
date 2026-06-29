import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { builtInPresets, type PresetName } from "../src/declarations.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function generatedFilePaths(root: string, current = "."): Promise<string[]> {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await generatedFilePaths(root, relativePath)));
      continue;
    }

    files.push(relativePath);
  }

  return files.sort();
}

async function generatePresetProject(preset: PresetName): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
  const projectDir = path.join(workspace, `demo-${preset}`);

  await execa(
    "pnpm",
    [
      "exec",
      "tsx",
      path.join(repoRoot, "src/cli.ts"),
      "init",
      projectDir,
      "--preset",
      preset,
      "--yes"
    ],
    { cwd: repoRoot }
  );

  return projectDir;
}

describe("template init", () => {
  it("generates capability-aware infrastructure for every supported built-in preset", async () => {
    const supportedPresets = builtInPresets.filter(
      (preset) => preset.generation === "supported"
    );
    const outOfScopePathPatterns = [
      /(^|\/)Dockerfile$/,
      /(^|\/)\.dockerignore$/,
      /(^|\/)docker-compose\.ya?ml$/,
      /(^|\/)compose\.ya?ml$/,
      /(^|\/)k8s\//,
      /(^|\/)deploy\//,
      /(^|\/)\.github\/workflows\/.*(audit|diff|upgrade|ownership|manifest|release|deploy|image|docker).*\.ya?ml$/
    ];

    for (const preset of supportedPresets) {
      const projectDir = await generatePresetProject(preset.name);
      const blueprint = await readJson<{
        features: string[];
        packageManager?: string;
      }>(path.join(projectDir, ".project-kit/blueprint.json"));
      const devcontainer = await readJson<{
        image: string;
        postCreateCommand?: string;
        mounts?: string[];
        customizations: { vscode: { extensions: string[] } };
      }>(path.join(projectDir, ".devcontainer/devcontainer.json"));
      const checkWorkflow = await readFile(
        path.join(projectDir, ".github/workflows/check.yml"),
        "utf8"
      );
      const dependabot = await readFile(
        path.join(projectDir, ".github/dependabot.yml"),
        "utf8"
      );
      const files = await generatedFilePaths(projectDir);

      expect(files.filter((file) => file.startsWith(".github/workflows/"))).toEqual([
        ".github/workflows/check.yml"
      ]);
      expect(files.some((file) => outOfScopePathPatterns.some((pattern) => pattern.test(file)))).toBe(
        false
      );
      expect(blueprint.features).not.toContain("native-binary-release");
      expect(blueprint.features).not.toEqual(
        expect.arrayContaining(["workspace-audit", "workspace-diff", "workspace-upgrade"])
      );

      expect(checkWorkflow).toContain("pull_request:");
      expect(checkWorkflow).toContain("push:");
      expect(checkWorkflow).not.toMatch(/\b(gh|hub)\s+(repo|api|auth|pr|release)\b/);
      expect(checkWorkflow).not.toMatch(/\bdocker\s+(build|push|login)\b/);
      expect(checkWorkflow).not.toContain("docker/build-push-action");
      expect(checkWorkflow).not.toContain("docker/login-action");

      expect(dependabot).toContain("package-ecosystem: github-actions");
      if (blueprint.packageManager === "pnpm") {
        expect(dependabot).toContain("package-ecosystem: npm");
        expect(dependabot).not.toContain("package-ecosystem: cargo");
        expect(devcontainer.image).toContain("typescript-node:22");
        expect(devcontainer.postCreateCommand).toContain("corepack enable && pnpm install");
        expect(checkWorkflow).toContain("uses: pnpm/action-setup@v4");
        expect(checkWorkflow).toContain("uses: actions/setup-node@v4");
        expect(checkWorkflow).toContain("run: pnpm install");
        expect(checkWorkflow).toContain("run: pnpm run check");
      } else {
        expect(dependabot).toContain("package-ecosystem: cargo");
        expect(dependabot).not.toContain("package-ecosystem: npm");
        expect(devcontainer.image).toContain("devcontainers/rust");
        expect(devcontainer.postCreateCommand).toContain("rustup component add rustfmt clippy");
        expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
        expect(checkWorkflow).toContain("run: ./scripts/check");
        expect(checkWorkflow).not.toContain("pnpm");
      }

      const extensions = devcontainer.customizations.vscode.extensions;
      if (preset.name === "ts-lib" || preset.name === "hono-api") {
        expect(extensions).toEqual(["oxc.oxc-vscode"]);
      }
      if (preset.name === "vue-app" || preset.name === "vue-hono-app") {
        expect(extensions).toEqual(["Vue.volar", "oxc.oxc-vscode"]);
        expect(checkWorkflow).toContain("pnpm exec playwright install --with-deps chromium");
        expect(devcontainer.postCreateCommand).toContain("pnpm exec playwright install chromium");
      }
      if (preset.name === "rust-bin") {
        expect(extensions).toEqual(["rust-lang.rust-analyzer", "tamasfe.even-better-toml"]);
        expect(devcontainer.mounts).toEqual(
          expect.arrayContaining([
            expect.stringContaining("target=/usr/local/cargo/registry"),
            expect.stringContaining("target=${containerWorkspaceFolder}/target")
          ])
        );
      }
    }
  }, 300_000);

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

    expect(installCommand).toBe("pnpm install");
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

    expect(installCommand).toBe("pnpm install");
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
    const blueprintPath = path.join(projectDir, ".project-kit/blueprint.json");
    const blueprint = await readJson<{ preset: string; packageManager?: string }>(
      blueprintPath
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
    expect(blueprint).not.toHaveProperty("packageManager");
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

    await execa(
      "pnpm",
      ["exec", "tsx", path.join(repoRoot, "src/cli.ts"), "blueprint", "validate", blueprintPath],
      { cwd: repoRoot }
    );
  }, 120_000);

  it("normalizes rust-bin directory names into Cargo-safe package names", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-rust-name-"));
    const projectDir = path.join(workspace, 'My demo.app "quoted"');

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
    const cargoLock = await readFile(path.join(projectDir, "Cargo.lock"), "utf8");

    expect(cargoToml).toContain('name = "my-demo-app-quoted"');
    expect(cargoLock).toContain('name = "my-demo-app-quoted"');
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

    expect(installCommand).toBe("pnpm install");
  }, 180_000);

  it("generates a full-stack vue-hono-app project through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "vue-hono-app",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const rootPackageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const apiPackageJson = await readJson<{
      name: string;
      types: string;
      exports: Record<string, string>;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/api/package.json"));
    const webPackageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));
    const rootTsconfig = await readJson<{
      files: string[];
      references: Array<{ path: string }>;
    }>(path.join(projectDir, "tsconfig.json"));
    const webTsconfig = await readJson<{
      references: Array<{ path: string }>;
    }>(path.join(projectDir, "apps/web/tsconfig.json"));
    const webAppTsconfig = await readJson<{
      compilerOptions: { paths: Record<string, string[]> };
      references: Array<{ path: string }>;
    }>(path.join(projectDir, "apps/web/tsconfig.app.json"));
    const webTestTsconfig = await readJson<{
      references: Array<{ path: string }>;
    }>(path.join(projectDir, "apps/web/tsconfig.test.json"));
    const turboConfig = await readJson<{
      tasks: { check: { dependsOn: string[] } };
    }>(path.join(projectDir, "turbo.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8"
    );
    const blueprint = await readJson<{
      preset: string;
      projectKind: string;
      packages: Array<{ name: string; path: string }>;
    }>(path.join(projectDir, ".project-kit/blueprint.json"));
    const apiIndex = await readFile(
      path.join(projectDir, "apps/api/src/index.ts"),
      "utf8"
    );
    const webApiClient = await readFile(
      path.join(projectDir, "apps/web/src/api.ts"),
      "utf8"
    );
    const viteConfig = await readFile(
      path.join(projectDir, "apps/web/vite.config.ts"),
      "utf8"
    );
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );

    expect(rootPackageJson.name).toBe("demo-fullstack");
    expect(rootPackageJson.scripts.check).toBe("turbo run check");
    expect(rootPackageJson.devDependencies.turbo).toBe("catalog:");
    expect(workspaceYaml).toContain("  - apps/*");
    expect(workspaceYaml).toContain("turbo:");

    expect(apiPackageJson.name).toBe("@demo-fullstack/api");
    expect(apiPackageJson.types).toBe("./dist/index.d.ts");
    expect(apiPackageJson.exports).toEqual({ ".": "./dist/index.js" });
    expect(apiPackageJson.dependencies.hono).toBe("catalog:");
    expect(apiPackageJson.dependencies).not.toHaveProperty("vue");
    expect(apiIndex).toContain('import type { app } from "./runtime.js"');
    expect(apiIndex).toContain("export type AppType = typeof app");
    expect(apiIndex).not.toContain("new Hono");
    expect(apiIndex).not.toContain("@hono/node-server");

    expect(webPackageJson.name).toBe("@demo-fullstack/web");
    expect(webPackageJson.scripts.typecheck).toBe("vue-tsc --build");
    expect(webPackageJson.dependencies["@demo-fullstack/api"]).toBe("workspace:*");
    expect(webPackageJson.dependencies.hono).toBe("catalog:");
    expect(webApiClient).toContain('import { hc } from "hono/client"');
    expect(webApiClient).toContain('import type { AppType } from "@demo-fullstack/api"');
    expect(viteConfig).toContain('"/api"');
    expect(viteConfig).toContain("VITE_API_BASE_URL");

    expect(rootTsconfig.files).toEqual([]);
    expect(rootTsconfig.references).toEqual([
      { path: "./apps/api/tsconfig.json" },
      { path: "./apps/web/tsconfig.app.json" },
      { path: "./apps/web/tsconfig.test.json" },
      { path: "./apps/web/tsconfig.node.json" }
    ]);
    expect(webTsconfig.references).toEqual([
      { path: "./tsconfig.app.json" },
      { path: "./tsconfig.test.json" },
      { path: "./tsconfig.node.json" }
    ]);
    expect(webAppTsconfig.compilerOptions.paths["@demo-fullstack/api"]).toEqual([
      "../api/src/index.ts"
    ]);
    expect(webAppTsconfig.references).toEqual([{ path: "../api/tsconfig.build.json" }]);
    expect(webTestTsconfig.references).toEqual([{ path: "../api/tsconfig.build.json" }]);
    expect(turboConfig.tasks.check.dependsOn).toEqual(["^build"]);

    expect(blueprint).toEqual(
      expect.objectContaining({
        preset: "vue-hono-app",
        projectKind: "multi-package",
        packages: [
          { name: "@demo-fullstack/web", path: "apps/web" },
          { name: "@demo-fullstack/api", path: "apps/api" }
        ]
      })
    );

    await stat(path.join(projectDir, "apps/api/src/server.ts"));
    await stat(path.join(projectDir, "apps/web/test/e2e/app.spec.ts"));
    await expect(
      stat(path.join(projectDir, "packages/api-client"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(checkWorkflow).not.toContain("cache: pnpm");
    expect(checkWorkflow).toContain("pnpm exec playwright install --with-deps chromium");

    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m
    )?.[1];
    expect(installCommand).toBeDefined();

    expect(installCommand).toBe("pnpm install");
  }, 240_000);
});
