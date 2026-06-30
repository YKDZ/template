import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const forbiddenWorkspaceLifecycleFeatures = [
  "workspace-audit",
  "workspace-diff",
  "workspace-upgrade"
] as const;

function oxcConfigDirectoriesForPreset(preset: PresetName): string[] {
  if (preset === "vue-hono-app") {
    return ["apps/api", "apps/web"];
  }

  return ["."];
}

function expectNoWorkspaceLifecycleFeatures(features: readonly string[]): void {
  for (const feature of forbiddenWorkspaceLifecycleFeatures) {
    expect(features).not.toContain(feature);
  }
}

describe("template init", () => {
  it.each(forbiddenWorkspaceLifecycleFeatures)(
    "rejects the %s lifecycle feature on its own",
    (feature) => {
      expect(() => {
        expectNoWorkspaceLifecycleFeatures(["root-check", feature]);
      }).toThrow();
    }
  );

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
      expectNoWorkspaceLifecycleFeatures(blueprint.features);

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
        expect(checkWorkflow).toContain("uses: actions/setup-node@v4");
        expect(checkWorkflow).toContain("node-version-file: package.json");
        expect(checkWorkflow).toContain("run: corepack enable");
        expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
        expect(checkWorkflow).not.toContain("node-version: 22");
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
      }
      if (preset.name === "vue-app") {
        expect(checkWorkflow).toContain("pnpm exec playwright install --with-deps chromium");
        expect(devcontainer.postCreateCommand).toContain("pnpm exec playwright install chromium");
      }
      if (preset.name === "vue-hono-app") {
        expect(checkWorkflow).toContain(
          "pnpm --filter ./apps/web exec playwright install --with-deps chromium"
        );
        expect(devcontainer.postCreateCommand).toContain(
          "pnpm --filter @demo-vue-hono-app/web exec playwright install chromium"
        );
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

  it("scopes Playwright install commands to the web package for workspace Vue Hono apps", async () => {
    const projectDir = await generatePresetProject("vue-hono-app");
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    const devcontainer = await readJson<{ postCreateCommand: string }>(
      path.join(projectDir, ".devcontainer/devcontainer.json")
    );

    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium"
    );
    expect(devcontainer.postCreateCommand).toContain(
      "pnpm --filter @demo-vue-hono-app/web exec playwright install chromium"
    );
    expect(checkWorkflow).not.toMatch(/\bpnpm exec playwright install\b/);
    expect(devcontainer.postCreateCommand).not.toMatch(
      /\bpnpm exec playwright install\b/
    );
  }, 120_000);

  it("generates Node presets with Dependabot-compatible pnpm coverage", async () => {
    const nodePresetNames = builtInPresets
      .filter((preset) => preset.generation === "supported")
      .map((preset) => preset.name)
      .filter((preset) => preset !== "rust-bin");

    for (const preset of nodePresetNames) {
      const projectDir = await generatePresetProject(preset);
      const packageJson = await readJson<{
        engines: { node: string };
        packageManager: string;
      }>(
        path.join(projectDir, "package.json")
      );
      const checkWorkflow = await readFile(
        path.join(projectDir, ".github/workflows/check.yml"),
        "utf8"
      );
      const dependabot = await readFile(
        path.join(projectDir, ".github/dependabot.yml"),
        "utf8"
      );

      expect(packageJson.engines.node).toBe("22");
      expect(packageJson.packageManager).toBe("pnpm@10.0.0");
      expect(checkWorkflow).toContain("node-version-file: package.json");
      expect(checkWorkflow).toContain("run: corepack enable");
      expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
      expect(checkWorkflow).not.toContain("          version: 10.0.0");
      expect(dependabot).toContain("package-ecosystem: npm");
      expect(dependabot).toContain("package-ecosystem: github-actions");
    }
  }, 240_000);

  it("generates single-package Node metadata as the Node and pnpm version authority", async () => {
    const projectDir = await generatePresetProject("ts-lib");
    const packageJson = await readJson<{
      engines: { node: string };
      packageManager: string;
    }>(path.join(projectDir, "package.json"));
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    const devcontainer = await readJson<{ postCreateCommand: string }>(
      path.join(projectDir, ".devcontainer/devcontainer.json")
    );

    expect(packageJson.engines.node).toBe("22");
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(checkWorkflow).toContain("node-version-file: package.json");
    expect(checkWorkflow).toContain("run: corepack enable");
    expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
    expect(checkWorkflow).not.toContain("version: 10.0.0");
    expect(checkWorkflow).not.toContain("node-version: 22");
    expect(devcontainer.postCreateCommand).toBe("corepack enable && pnpm install");
  }, 120_000);

  it("generates workspace Node metadata as the Node and pnpm version authority", async () => {
    const projectDir = await generatePresetProject("vue-hono-app");
    const rootPackageJson = await readJson<{
      engines: { node: string };
      packageManager: string;
    }>(path.join(projectDir, "package.json"));
    const apiPackageJson = await readJson<{
      engines: { node: string };
      packageManager?: string;
    }>(path.join(projectDir, "apps/api/package.json"));
    const webPackageJson = await readJson<{
      engines: { node: string };
      packageManager?: string;
    }>(path.join(projectDir, "apps/web/package.json"));
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    const devcontainer = await readJson<{ postCreateCommand: string }>(
      path.join(projectDir, ".devcontainer/devcontainer.json")
    );

    expect(rootPackageJson.engines.node).toBe("22");
    expect(rootPackageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(apiPackageJson.engines.node).toBe("22");
    expect(apiPackageJson).not.toHaveProperty("packageManager");
    expect(webPackageJson.engines.node).toBe("22");
    expect(webPackageJson).not.toHaveProperty("packageManager");
    expect(checkWorkflow).toContain("node-version-file: package.json");
    expect(checkWorkflow).toContain("run: corepack enable");
    expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
    expect(checkWorkflow).not.toContain("version: 10.0.0");
    expect(checkWorkflow).not.toContain("node-version: 22");
    expect(devcontainer.postCreateCommand).toContain("corepack enable && pnpm install");
    expect(devcontainer.postCreateCommand).not.toContain("corepack prepare");
    expect(devcontainer.postCreateCommand).not.toContain("pnpm@10.0.0");
  }, 120_000);

  it("generates Node presets with checked OXC config source", async () => {
    const nodePresetNames = builtInPresets
      .filter((preset) => preset.generation === "supported")
      .map((preset) => preset.name)
      .filter((preset) => preset !== "rust-bin");

    for (const preset of nodePresetNames) {
      const projectDir = await generatePresetProject(preset);
      const files = await generatedFilePaths(projectDir);

      for (const configDir of oxcConfigDirectoriesForPreset(preset)) {
        const prefix = configDir === "." ? "" : `${configDir}/`;
        expect(files).toContain(`${prefix}oxlint.config.ts`);
        expect(files).toContain(`${prefix}oxfmt.config.ts`);

        const packageJson = await readJson<{ scripts: Record<string, string> }>(
          path.join(projectDir, configDir, "package.json")
        );
        expect(packageJson.scripts["format:check"]).toBe("oxfmt --check .");
        expect(packageJson.scripts["format:write"]).toBe("oxfmt --write .");
        expect(packageJson.scripts.lint).toBe("oxlint . --deny-warnings");
        expect(packageJson.scripts["lint:fix"]).toBe("oxlint . --fix --deny-warnings");
      }

      expect(files.some((file) => file.endsWith(".oxlintrc.json"))).toBe(false);
      expect(files.some((file) => file.endsWith(".oxfmtrc.json"))).toBe(false);
    }
  }, 240_000);

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

  it("prints the planned Project Blueprint during dry-run without writing files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-dry-run-"));
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--dry-run"
      ],
      { cwd: repoRoot }
    );

    expect(result.stdout).toContain("Project Blueprint");
    expect(result.stdout).toContain("Preset: ts-lib");
    expect(result.stdout).toContain("Target:");
    expect(result.stdout).toContain(projectDir);
    expect(result.stdout).toContain("Post Commands:");
    expect(result.stdout).toContain("Enable Corepack");
    expect(result.stdout).toContain("corepack enable");
    expect(result.stdout).toContain("Refresh Package Manager Pin and Install Dependencies");
    expect(result.stdout).toContain("corepack use pnpm@10.0.0");
    expect(result.stdout).not.toContain("Install dependencies: pnpm install");
    expect(result.stdout).toContain("pnpm run fix");

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints machine-readable init output with --json", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    const result = await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "vue-hono-app",
        "--scope",
        "custom-scope",
        "--dry-run",
        "--json"
      ],
      { cwd: repoRoot }
    );

    const output = JSON.parse(result.stdout) as {
      command: string;
      dryRun: boolean;
      ready: boolean;
      targetDir: string;
      blueprint: {
        preset: string;
        packageManager: string;
        packages: Array<{ name: string; path: string }>;
      };
      postCommands: {
        planned: Array<{ id: string }>;
        run: Array<{ id: string }>;
        failed: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
      };
    };

    expect(output).toEqual(
      expect.objectContaining({
        command: "init",
        dryRun: true,
        ready: false,
        targetDir: projectDir
      })
    );
    expect(output.blueprint).toEqual(
      expect.objectContaining({
        preset: "vue-hono-app",
        packageManager: "pnpm",
        packages: [
          { name: "@custom-scope/web", path: "apps/web" },
          { name: "@custom-scope/api", path: "apps/api" }
        ]
      })
    );
    expect(output.postCommands.planned.map((command) => command.id)).toEqual([
      "node-enable-corepack",
      "node-refresh-package-manager-pin",
      "node-run-fix",
      "vue-hono-install-playwright-browsers"
    ]);
    expect(output.postCommands.run).toEqual([]);
    expect(output.postCommands.failed).toEqual([]);
    expect(output.postCommands.skipped).toEqual([
      { id: "node-enable-corepack", reason: "dry-run" },
      { id: "node-refresh-package-manager-pin", reason: "dry-run" },
      { id: "node-run-fix", reason: "dry-run" },
      { id: "vue-hono-install-playwright-browsers", reason: "dry-run" }
    ]);
    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints machine-readable init output after non-dry-run generation with --json --yes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-"));
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--json",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const output = JSON.parse(result.stdout) as {
      command: string;
      dryRun: boolean;
      ready: boolean;
      targetDir: string;
      blueprint: { preset: string; packageManager: string };
      postCommands: {
        planned: Array<{ id: string }>;
        run: Array<{ id: string }>;
        failed: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
      };
      nextSteps: string[];
    };

    expect(output).toEqual(
      expect.objectContaining({
        command: "init",
        dryRun: false,
        ready: false,
        targetDir: projectDir,
        blueprint: expect.objectContaining({
          preset: "ts-lib",
          packageManager: "pnpm"
        }),
        nextSteps: [`cd ${projectDir}`, "pnpm install", "pnpm run check"]
      })
    );
    expect(output.postCommands.planned.map((command) => command.id)).toEqual([
      "node-enable-corepack",
      "node-refresh-package-manager-pin",
      "node-run-fix"
    ]);
    expect(output.postCommands.run).toEqual([]);
    expect(output.postCommands.failed).toEqual([]);
    expect(output.postCommands.skipped).toEqual([
      { id: "node-enable-corepack", reason: "ready-mode-not-requested" },
      { id: "node-refresh-package-manager-pin", reason: "ready-mode-not-requested" },
      { id: "node-run-fix", reason: "ready-mode-not-requested" }
    ]);
    await stat(path.join(projectDir, "package.json"));
    await expect(stat(path.join(projectDir, "pnpm-lock.yaml"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("runs planned Post Commands only when ready mode is requested", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-ready-"));
    const projectDir = path.join(workspace, "demo-lib");
    const fakeBin = path.join(workspace, "bin");
    await mkdir(fakeBin);
    await writeExecutable(
      path.join(fakeBin, "corepack"),
      [
        "#!/usr/bin/env node",
        'import { readFileSync, writeFileSync } from "node:fs";',
        "",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'use') {",
        "  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));",
        "  packageJson.packageManager = `${args[1]}+sha224.fake-corepack-hash`;",
        "  writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\\n`);",
        "  writeFileSync('pnpm-lock.yaml', 'lockfileVersion: 9.0\\n');",
        "}",
        ""
      ].join("\n")
    );
    await writeExecutable(
      path.join(fakeBin, "pnpm"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync, writeFileSync } from "node:fs";',
        "",
        "const args = process.argv.slice(2);",
        "appendFileSync('ready-command-log.jsonl', `${JSON.stringify(args)}\\n`);",
        "if (args[0] === 'install') {",
        "  writeFileSync('pnpm-lock.yaml', 'lockfileVersion: 9.0\\n');",
        "}",
        "if (args[0] === 'run' && args[1] === 'fix') {",
        "  writeFileSync('READY_FIX_RAN', 'yes\\n');",
        "}",
        ""
      ].join("\n")
    );

    const result = await execa(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--ready",
        "--json",
        "--yes"
      ],
      {
        cwd: repoRoot,
        env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` }
      }
    );

    const output = JSON.parse(result.stdout) as {
      postCommands: {
        planned: Array<{
          id: string;
          label: string;
          command: string;
          args: string[];
          cwd: string;
        }>;
        run: Array<{ id: string; exitCode: number }>;
        failed: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
      };
    };

    expect(output.postCommands.planned).toEqual([
      {
        id: "node-enable-corepack",
        label: "Enable Corepack",
        command: "corepack",
        args: ["enable"],
        cwd: projectDir
      },
      {
        id: "node-refresh-package-manager-pin",
        label: "Refresh Package Manager Pin and Install Dependencies",
        command: "corepack",
        args: ["use", "pnpm@10.0.0"],
        cwd: projectDir
      },
      {
        id: "node-run-fix",
        label: "Run Fix Command",
        command: "pnpm",
        args: ["run", "fix"],
        cwd: projectDir
      }
    ]);
    expect(output.postCommands.run).toEqual([
      { id: "node-enable-corepack", exitCode: 0 },
      { id: "node-refresh-package-manager-pin", exitCode: 0 },
      { id: "node-run-fix", exitCode: 0 }
    ]);
    expect(output.postCommands.failed).toEqual([]);
    expect(output.postCommands.skipped).toEqual([]);
    await stat(path.join(projectDir, "pnpm-lock.yaml"));
    await stat(path.join(projectDir, "READY_FIX_RAN"));
    expect(
      (await readFile(path.join(projectDir, "ready-command-log.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    ).toEqual([["run", "fix"]]);
    expect(
      (
        await readJson<{ packageManager: string }>(path.join(projectDir, "package.json"))
      ).packageManager
    ).toBe("pnpm@10.0.0+sha224.fake-corepack-hash");
    expect(
      await readJson<{ packageManager: string }>(
        path.join(projectDir, ".project-kit", "blueprint.json")
      )
    ).toEqual(expect.objectContaining({ packageManager: "pnpm" }));
    expect(
      await readJson<Record<string, unknown>>(
        path.join(projectDir, ".project-kit", "generated-by.json")
      )
    ).not.toHaveProperty("packageManager");
  });

  it("fails ready mode clearly when a planned Post Command fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-ready-failure-"));
    const projectDir = path.join(workspace, "demo-lib");
    const fakeBin = path.join(workspace, "bin");
    const fakeCorepack = path.join(fakeBin, "corepack");
    await mkdir(fakeBin);
    await writeExecutable(fakeCorepack, "#!/bin/sh\necho planned corepack failed >&2\nexit 7\n");

    const result = await execa(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--ready",
        "--json",
        "--yes"
      ],
      {
        cwd: repoRoot,
        env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
        reject: false
      }
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout) as {
      postCommands: {
        run: Array<{ id: string }>;
        failed: Array<{ id: string; exitCode: number | null; error: string }>;
        skipped: Array<{ id: string; reason: string }>;
      };
    };
    expect(output.postCommands.run).toEqual([]);
    expect(output.postCommands.failed).toEqual([
      {
        id: "node-enable-corepack",
        exitCode: 7,
        error: expect.stringContaining("node-enable-corepack")
      }
    ]);
    expect(output.postCommands.skipped).toEqual([]);
    expect(result.stderr).toContain("Post Command failed");
  });

  it("fails clearly in non-interactive init without --yes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-noninteractive-"));
    const projectDir = path.join(workspace, "demo-lib");

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
          path.join(repoRoot, "src/cli.ts"),
          "init",
          projectDir,
          "--preset",
          "ts-lib"
        ],
        { cwd: repoRoot, timeout: 5_000 }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Non-interactive init requires --yes")
    });

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows empty target directories and rejects non-empty target directories", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-dir-safety-"));
    const emptyDir = path.join(workspace, "empty");
    const nonEmptyDir = path.join(workspace, "non-empty");
    await mkdir(emptyDir);
    await mkdir(nonEmptyDir);
    await writeFile(path.join(nonEmptyDir, "README.md"), "# existing\n", "utf8");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        emptyDir,
        "--preset",
        "ts-lib",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    await stat(path.join(emptyDir, "package.json"));

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
          path.join(repoRoot, "src/cli.ts"),
          "init",
          nonEmptyDir,
          "--preset",
          "ts-lib",
          "--yes"
        ],
        { cwd: repoRoot }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Target directory is not empty")
    });
    expect(await readFile(path.join(nonEmptyDir, "README.md"), "utf8")).toBe(
      "# existing\n"
    );
  });

  it("reviews the Project Blueprint and asks for confirmation in interactive terminals", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-interactive-"));
    const projectDir = path.join(workspace, "demo-lib");
    const cliPath = path.join(repoRoot, "src/cli.ts");

    const result = await execa(
      "bash",
      [
        "-lc",
        [
          "printf 'y\\n' |",
          "script -qfec",
          shellQuote(
            `pnpm exec tsx ${shellQuote(cliPath)} init ${shellQuote(projectDir)} --preset ts-lib`
          ),
          "/dev/null"
        ].join(" ")
      ],
      { cwd: repoRoot }
    );

    expect(result.stdout).toContain("Project Blueprint");
    expect(result.stdout).toContain("Preset: ts-lib");
    expect(result.stdout).toContain("Generate this project? [y/N]");
    expect(result.stdout).toContain(`Initialized ts-lib project in ${projectDir}`);
    await stat(path.join(projectDir, "package.json"));
  });

  it("cancels interactive init without writing files when confirmation is declined", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-interactive-"));
    const projectDir = path.join(workspace, "demo-lib");
    const cliPath = path.join(repoRoot, "src/cli.ts");

    await expect(
      execa(
        "bash",
        [
          "-lc",
          [
            "printf 'n\\n' |",
            "script -qfec",
            shellQuote(
              `pnpm exec tsx ${shellQuote(cliPath)} init ${shellQuote(projectDir)} --preset ts-lib`
            ),
            "/dev/null"
          ].join(" ")
        ],
        { cwd: repoRoot }
      )
    ).rejects.toMatchObject({
      stdout: expect.stringMatching(/Generate this project\? \[y\/N\][\s\S]*Init cancelled/)
    });

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints next steps after generation without installing dependencies", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-next-steps-"));
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
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

    expect(result.stdout).toContain(`Initialized ts-lib project in ${projectDir}`);
    expect(result.stdout).toContain("Next steps:");
    expect(result.stdout).toContain(`cd ${projectDir}`);
    expect(result.stdout).toContain("pnpm install");
    expect(result.stdout).toContain("pnpm run check");
    await expect(stat(path.join(projectDir, "pnpm-lock.yaml"))).rejects.toMatchObject({
      code: "ENOENT"
    });
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
    const files = await generatedFilePaths(projectDir);

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
    expect(checkWorkflow).not.toContain("node-version-file: package.json");
    expect(checkWorkflow).not.toContain("corepack enable");
    expect(dependabot).toContain("package-ecosystem: cargo");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(files.some((file) => file.endsWith("oxlint.config.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("oxfmt.config.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith(".oxlintrc.json"))).toBe(false);
    expect(files.some((file) => file.endsWith(".oxfmtrc.json"))).toBe(false);

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
    expect(webApiClient).toMatch(/^import type \{ AppType \} from "@demo-fullstack\/api";$/m);
    expect(webApiClient).toMatch(/^import \{ hc \} from "hono\/client";$/m);
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
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium"
    );

    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m
    )?.[1];
    expect(installCommand).toBeDefined();

    expect(installCommand).toBe("pnpm install");
  }, 240_000);

  it("uses --scope for generated workspace package names", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-scope-"));
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
        "--scope",
        "custom-scope",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const blueprint = await readJson<{
      packages: Array<{ name: string; path: string }>;
    }>(path.join(projectDir, ".project-kit/blueprint.json"));
    const apiPackageJson = await readJson<{ name: string }>(
      path.join(projectDir, "apps/api/package.json")
    );
    const webPackageJson = await readJson<{
      name: string;
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));
    const webApiClient = await readFile(
      path.join(projectDir, "apps/web/src/api.ts"),
      "utf8"
    );
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );

    expect(apiPackageJson.name).toBe("@custom-scope/api");
    expect(webPackageJson.name).toBe("@custom-scope/web");
    expect(webPackageJson.dependencies["@custom-scope/api"]).toBe("workspace:*");
    expect(webApiClient).toMatch(/^import type \{ AppType \} from "@custom-scope\/api";$/m);
    expect(webApiClient).toMatch(/^import \{ hc \} from "hono\/client";$/m);
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium"
    );
    expect(blueprint.packages).toEqual([
      { name: "@custom-scope/web", path: "apps/web" },
      { name: "@custom-scope/api", path: "apps/api" }
    ]);
  }, 120_000);

  it("normalizes npm scopes that include a leading at sign", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-scope-"));
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
        "--scope",
        "@custom-scope",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const apiPackageJson = await readJson<{ name: string }>(
      path.join(projectDir, "apps/api/package.json")
    );
    const webPackageJson = await readJson<{
      name: string;
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));
    const blueprint = await readJson<{
      packages: Array<{ name: string; path: string }>;
    }>(path.join(projectDir, ".project-kit/blueprint.json"));

    expect(apiPackageJson.name).toBe("@custom-scope/api");
    expect(webPackageJson.name).toBe("@custom-scope/web");
    expect(webPackageJson.dependencies["@custom-scope/api"]).toBe("workspace:*");
    expect(blueprint.packages).toEqual([
      { name: "@custom-scope/web", path: "apps/web" },
      { name: "@custom-scope/api", path: "apps/api" }
    ]);
  }, 120_000);

  it("rejects npm scopes with whitespace before writing files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-scope-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await expect(
      execa(
        "pnpm",
        [
          "exec",
          "tsx",
          path.join(repoRoot, "src/cli.ts"),
          "init",
          projectDir,
          "--preset",
          "vue-hono-app",
          "--scope",
          "custom\nscope",
          "--yes"
        ],
        { cwd: repoRoot }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--scope must be a valid npm scope without whitespace")
    });

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
