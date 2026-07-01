import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { parse as parseYaml } from "yaml";

import { builtInPresets } from "../src/declarations.js";
import {
  editorCustomizationForCapabilities,
  type EditorCustomizationCapability,
  type EditorCustomizationOptions,
} from "../src/editor-customization.js";
import { assembleGenerationContext } from "../src/generation-context.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const optionalGitDisplays = [
  "git init",
  "git add .",
  'git commit -m "Initial commit"',
];

const defaultToolchainEnv = {
  TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL: jsonDataUrl([
    { version: "v24.11.0", lts: "Krypton" },
    { version: "v26.1.0", lts: false },
  ]),
  TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL: jsonDataUrl({
    versions: {
      "10.0.0": { engines: { node: ">=18.12" } },
    },
  }),
};

process.env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL ??=
  defaultToolchainEnv.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL;
process.env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL ??=
  defaultToolchainEnv.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL;

function jsonDataUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

function toolchainEnvWithPnpm(version: string): Record<string, string> {
  return {
    TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL: jsonDataUrl([
      { version: "v24.11.0", lts: "Krypton" },
      { version: "v26.1.0", lts: false },
    ]),
    TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL: jsonDataUrl({
      versions: {
        [version]: { engines: { node: ">=24.0.0" } },
        "12.0.0": { engines: { node: ">=26.0.0" } },
      },
    }),
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeExecutable(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

async function generatedFilePaths(
  root: string,
  current = ".",
): Promise<string[]> {
  const entries = await readdir(path.join(root, current), {
    withFileTypes: true,
  });
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

async function generatePresetProject(preset: string): Promise<string> {
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
      "--yes",
    ],
    { cwd: repoRoot },
  );

  return projectDir;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const forbiddenWorkspaceLifecycleFeatures = [
  "workspace-audit",
  "workspace-diff",
  "workspace-upgrade",
] as const;

function oxcConfigDirectoriesForPreset(preset: string): string[] {
  if (preset === "vue-hono-app") {
    return ["apps/api", "apps/web"];
  }

  return ["."];
}

function editorCustomizationOptionsForPreset(
  preset: string,
): EditorCustomizationOptions | undefined {
  return preset === "vue-hono-app" ? { oxcConfigPaths: "nested" } : undefined;
}

function editorCustomizationCapabilitiesForPreset(
  preset: string,
): EditorCustomizationCapability[] {
  if (preset === "ts-lib") {
    return ["oxc-format-lint"];
  }

  if (preset === "rust-bin") {
    return ["rust-tooling"];
  }

  if (preset === "vue-app" || preset === "vue-hono-app") {
    return ["oxc-format-lint", "vue", "tailwind", "vitest"];
  }

  return ["oxc-format-lint", "vitest"];
}

function catalogFromWorkspaceYaml(
  workspaceYaml: string,
): Record<string, string> {
  const parsed = parseYaml(workspaceYaml) as {
    catalog?: Record<string, string>;
  };

  return parsed.catalog ?? {};
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
    },
  );

  it("generates a minimal Template Dependency Catalog projection for the Hono API preset", async () => {
    const projectDir = await generatePresetProject("hono-api");
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );

    expect(catalogFromWorkspaceYaml(workspaceYaml)).toEqual({
      "@hono/node-server": "^2.0.6",
      "@types/node": "^24.0.0",
      hono: "^4.12.27",
      oxfmt: "^0.57.0",
      oxlint: "^1.72.0",
      "tsc-alias": "^1.8.17",
      typescript: "^6.0.3",
      vitest: "^4.1.9",
    });
  });

  it("generates a minimal Template Dependency Catalog projection for the TypeScript library preset", async () => {
    const projectDir = await generatePresetProject("ts-lib");
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );

    expect(catalogFromWorkspaceYaml(workspaceYaml)).toEqual({
      "@types/node": "^24.0.0",
      oxfmt: "^0.57.0",
      oxlint: "^1.72.0",
      "tsc-alias": "^1.8.17",
      typescript: "^6.0.3",
    });
  });

  it("generates a minimal Template Dependency Catalog projection for the Vue app preset", async () => {
    const projectDir = await generatePresetProject("vue-app");
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );

    expect(catalogFromWorkspaceYaml(workspaceYaml)).toEqual({
      "@playwright/test": "^1.61.1",
      "@tailwindcss/vite": "^4.3.2",
      "@types/node": "^24.0.0",
      "@types/web-bluetooth": "^0.0.21",
      "@vitejs/plugin-vue": "^6.0.7",
      "@vue/tsconfig": "^0.9.1",
      "@vueuse/core": "^14.3.0",
      oxfmt: "^0.57.0",
      oxlint: "^1.72.0",
      pinia: "^3.0.4",
      tailwindcss: "^4.3.2",
      typescript: "^6.0.3",
      vite: "^8.1.2",
      vitest: "^4.1.9",
      vue: "^3.5.39",
      "vue-tsc": "^3.3.6",
    });
    expect(workspaceYaml).toContain("allowBuilds:\n  esbuild: true\n");
  });

  it("generates a minimal Template Dependency Catalog projection for the Vue Hono app preset", async () => {
    const projectDir = await generatePresetProject("vue-hono-app");
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );

    expect(catalogFromWorkspaceYaml(workspaceYaml)).toEqual({
      "@hono/node-server": "^2.0.6",
      "@playwright/test": "^1.61.1",
      "@tailwindcss/vite": "^4.3.2",
      "@types/node": "^24.0.0",
      "@types/web-bluetooth": "^0.0.21",
      "@vitejs/plugin-vue": "^6.0.7",
      "@vue/tsconfig": "^0.9.1",
      "@vueuse/core": "^14.3.0",
      hono: "^4.12.27",
      oxfmt: "^0.57.0",
      oxlint: "^1.72.0",
      pinia: "^3.0.4",
      tailwindcss: "^4.3.2",
      "tsc-alias": "^1.8.17",
      tsx: "^4.22.4",
      turbo: "^2.10.2",
      typescript: "^6.0.3",
      vite: "^8.1.2",
      vitest: "^4.1.9",
      vue: "^3.5.39",
      "vue-tsc": "^3.3.6",
    });
    expect(workspaceYaml).toContain("packages:\n  - apps/*\n");
    expect(workspaceYaml).toContain("allowBuilds:\n  esbuild: true\n");
  });

  it("generates capability-aware infrastructure for every supported built-in preset", async () => {
    const supportedPresets = builtInPresets.filter(
      (preset) => preset.generation === "supported",
    );
    const outOfScopePathPatterns = [
      /^(?!\.devcontainer\/Dockerfile$)(?:.*\/)?Dockerfile$/,
      /(^|\/)\.dockerignore$/,
      /(^|\/)docker-compose\.ya?ml$/,
      /(^|\/)compose\.ya?ml$/,
      /(^|\/)k8s\//,
      /(^|\/)deploy\//,
      /(^|\/)\.github\/workflows\/.*(audit|diff|upgrade|ownership|manifest|release|deploy|image|docker).*\.ya?ml$/,
    ];

    for (const preset of supportedPresets) {
      const projectDir = await generatePresetProject(preset.name);
      const blueprint = await readJson<{
        features: string[];
        packageManager?: string;
      }>(path.join(projectDir, ".template/blueprint.json"));
      const devcontainer = await readJson<{
        image?: string;
        build?: {
          dockerfile: string;
          args?: Record<string, string>;
        };
        features?: Record<string, { version?: string; pnpmVersion?: string }>;
        postCreateCommand?: string;
        mounts?: string[];
        customizations: {
          vscode: {
            extensions: string[];
            settings?: Record<string, unknown>;
          };
        };
      }>(path.join(projectDir, ".devcontainer/devcontainer.json"));
      const packageJson = await readJson<{
        engines: { node: string };
        packageManager: string;
      }>(path.join(projectDir, "package.json"));
      const checkWorkflow = await readFile(
        path.join(projectDir, ".github/workflows/check.yml"),
        "utf8",
      );
      const gitignore = await readFile(
        path.join(projectDir, ".gitignore"),
        "utf8",
      );
      const dependabot = await readFile(
        path.join(projectDir, ".github/dependabot.yml"),
        "utf8",
      );
      const files = await generatedFilePaths(projectDir);
      const dockerfile = files.includes(".devcontainer/Dockerfile")
        ? await readFile(
            path.join(projectDir, ".devcontainer/Dockerfile"),
            "utf8",
          )
        : undefined;

      expect(
        files.filter((file) => file.startsWith(".github/workflows/")),
      ).toEqual([".github/workflows/check.yml"]);
      expect(
        files.some((file) =>
          outOfScopePathPatterns.some((pattern) => pattern.test(file)),
        ),
      ).toBe(false);
      expect(files).toContain(".template/blueprint.json");
      expect(files).toContain(".template/generated-by.json");
      expect(files.some((file) => file.startsWith(".project-kit/"))).toBe(
        false,
      );
      expect(gitignore).toContain(".template/\n");
      expect(gitignore).toContain(".pnpm-store/\n");
      await expect(
        stat(path.join(projectDir, ".project-kit")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(path.join(projectDir, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(blueprint.features).not.toContain("native-binary-release");
      expectNoWorkspaceLifecycleFeatures(blueprint.features);

      expect(checkWorkflow).toContain("pull_request:");
      expect(checkWorkflow).toContain("push:");
      expect(checkWorkflow).not.toMatch(
        /\b(gh|hub)\s+(repo|api|auth|pr|release)\b/,
      );
      expect(checkWorkflow).not.toMatch(/\bdocker\s+(build|push|login)\b/);
      expect(checkWorkflow).not.toContain("docker/build-push-action");
      expect(checkWorkflow).not.toContain("docker/login-action");

      expect(dependabot).toContain("package-ecosystem: github-actions");
      if (blueprint.packageManager === "pnpm") {
        expect(dependabot).toContain("package-ecosystem: npm");
        expect(checkWorkflow).toContain("uses: actions/setup-node@v6");
        expect(checkWorkflow).toContain("node-version-file: package.json");
        expect(checkWorkflow).toContain("run: corepack enable");
        expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
        expect(checkWorkflow).not.toContain("node-version:");
        expect(checkWorkflow).toContain("run: pnpm install");
        expect(checkWorkflow).toContain("run: pnpm run check");
        expect(checkWorkflow).not.toContain("run: ./scripts/check");
      }

      if (
        preset.name === "ts-lib" ||
        preset.name === "vue-app" ||
        preset.name === "vue-hono-app"
      ) {
        expect(files).toContain(".devcontainer/Dockerfile");
        expect(devcontainer.build).toEqual({
          dockerfile: "Dockerfile",
          args: {
            NODE_VERSION: packageJson.engines.node,
            PACKAGE_MANAGER_PIN: packageJson.packageManager,
          },
        });
        expect(devcontainer).not.toHaveProperty("features");
        expect(dockerfile).toContain(
          `FROM mcr.microsoft.com/devcontainers/typescript-node:${packageJson.engines.node}`,
        );
        if (preset.name === "ts-lib") {
          expect(dockerfile).not.toContain("libnss3");
          expect(dockerfile).not.toContain("xvfb");
        } else {
          expect(dockerfile).toContain("libnss3");
          expect(dockerfile).toContain("libgbm1");
          expect(dockerfile).toContain("xvfb");
          expect(dockerfile).not.toMatch(
            /\b(?:npm|pnpm|corepack)\s+.*-g\s+turbo\b/,
          );
        }
      } else if (preset.name === "rust-bin") {
        expect(dependabot).toContain("package-ecosystem: cargo");
        expect(files).toContain(".devcontainer/Dockerfile");
        expect(files).toContain("rust-toolchain.toml");
        expect(devcontainer.build).toEqual({
          dockerfile: "Dockerfile",
          args: {
            NODE_VERSION: packageJson.engines.node,
            PACKAGE_MANAGER_PIN: packageJson.packageManager,
            RUST_TOOLCHAIN: "stable",
          },
        });
        expect(devcontainer).not.toHaveProperty("features");
        expect(devcontainer.mounts).toEqual(
          expect.arrayContaining([
            expect.stringContaining("target=/usr/local/cargo/registry"),
            expect.stringContaining("target=/usr/local/cargo/git"),
            expect.stringContaining("target=${containerWorkspaceFolder}/target"),
          ]),
        );
        expect(dockerfile).toContain(
          `FROM mcr.microsoft.com/devcontainers/typescript-node:${packageJson.engines.node}`,
        );
        expect(dockerfile).toContain("ARG RUST_TOOLCHAIN=stable");
        expect(dockerfile).toContain(
          "rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy",
        );
        expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
      } else {
        expect(dependabot).not.toContain("package-ecosystem: cargo");
        expect(devcontainer.image).toContain("typescript-node:24");
        const nodeFeature = Object.entries(devcontainer.features ?? {}).find(
          ([id]) => id.includes("features/node"),
        )?.[1];
        expect(nodeFeature).toEqual({
          version: packageJson.engines.node,
          pnpmVersion: packageJson.packageManager.replace(/^pnpm@/, ""),
        });
      }
      expect(devcontainer).not.toHaveProperty("postCreateCommand");

      const extensions = devcontainer.customizations.vscode.extensions;
      const expectedEditorCustomization = editorCustomizationForCapabilities(
        editorCustomizationCapabilitiesForPreset(preset.name),
        editorCustomizationOptionsForPreset(preset.name),
      );
      const workspaceExtensions = await readJson<{
        recommendations: string[];
      }>(path.join(projectDir, ".vscode/extensions.json"));
      const workspaceSettings = await readJson<Record<string, unknown>>(
        path.join(projectDir, ".vscode/settings.json"),
      );

      expect(extensions).toEqual(expectedEditorCustomization.extensions);
      expect(devcontainer.customizations.vscode.settings).toEqual(
        expectedEditorCustomization.settings,
      );
      expect(workspaceExtensions.recommendations).toEqual(
        expectedEditorCustomization.extensions,
      );
      expect(workspaceSettings).toEqual(expectedEditorCustomization.settings);
      if (preset.name === "vue-app") {
        expect(checkWorkflow).toContain(
          "pnpm exec playwright install --with-deps chromium",
        );
      }
      if (preset.name === "vue-hono-app") {
        expect(checkWorkflow).toContain(
          "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
        );
      }
      if (preset.name === "rust-bin") {
        expect(devcontainer.mounts).toEqual(
          expect.arrayContaining([
            expect.stringContaining("target=/usr/local/cargo/registry"),
            expect.stringContaining(
              "target=${containerWorkspaceFolder}/target",
            ),
          ]),
        );
      }
    }
  }, 300_000);

  it("scopes Playwright install commands to the web package for workspace Vue Hono apps", async () => {
    const projectDir = await generatePresetProject("vue-hono-app");
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const devcontainer = await readJson<{ postCreateCommand?: string }>(
      path.join(projectDir, ".devcontainer/devcontainer.json"),
    );

    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );
    expect(devcontainer).not.toHaveProperty("postCreateCommand");
    expect(checkWorkflow).not.toMatch(/\bpnpm exec playwright install\b/);
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
      }>(path.join(projectDir, "package.json"));
      const checkWorkflow = await readFile(
        path.join(projectDir, ".github/workflows/check.yml"),
        "utf8",
      );
      const dependabot = await readFile(
        path.join(projectDir, ".github/dependabot.yml"),
        "utf8",
      );

      expect(packageJson.engines.node).toBe("24");
      expect(packageJson.packageManager).toBe("pnpm@10.0.0");
      expect(checkWorkflow).toContain("node-version-file: package.json");
      expect(checkWorkflow).toContain("run: corepack enable");
      expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
      expect(checkWorkflow).not.toContain("          version: 10.0.0");
      expect(dependabot).toContain("package-ecosystem: npm");
      expect(dependabot).toContain("package-ecosystem: github-actions");
    }
  }, 240_000);

  it("generates the TypeScript library Development Container from the Node pnpm toolchain baseline", async () => {
    const projectDir = await generatePresetProject("ts-lib");
    const packageJson = await readJson<{
      engines: { node: string };
      packageManager: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const tsconfig = await readJson<{
      compilerOptions: { paths?: Record<string, string[]> };
    }>(path.join(projectDir, "tsconfig.json"));
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const devcontainerText = await readFile(
      path.join(projectDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainer = JSON.parse(devcontainerText) as {
      name: string;
      build: {
        dockerfile: string;
        args: {
          NODE_VERSION: string;
          PACKAGE_MANAGER_PIN: string;
        };
      };
      features?: Record<string, unknown>;
      customizations: {
        vscode: {
          extensions: string[];
          settings: Record<string, unknown>;
        };
      };
      postCreateCommand?: string;
    };
    const dockerfile = await readFile(
      path.join(projectDir, ".devcontainer/Dockerfile"),
      "utf8",
    );

    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(checkWorkflow).toContain("node-version-file: package.json");
    expect(checkWorkflow).toContain("run: corepack enable");
    expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
    expect(checkWorkflow).not.toContain("version: 10.0.0");
    expect(checkWorkflow).not.toContain("node-version:");
    expect(Object.keys(devcontainer)).toEqual([
      "name",
      "build",
      "customizations",
    ]);
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: packageJson.engines.node,
        PACKAGE_MANAGER_PIN: packageJson.packageManager,
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer).not.toHaveProperty("postCreateCommand");
    expect(devcontainer.customizations.vscode.extensions).toContain(
      "oxc.oxc-vscode",
    );
    expect(devcontainer.customizations.vscode.extensions).not.toContain(
      "dbaeumer.vscode-eslint",
    );
    expect(devcontainer.customizations.vscode.settings).toHaveProperty(
      "oxc.enable",
      true,
    );
    expect(devcontainerText).toMatch(
      /^\{\n  "name": "demo-ts-lib development",\n  "build": \{/,
    );
    expect(dockerfile).toContain(
      `FROM mcr.microsoft.com/devcontainers/typescript-node:${packageJson.engines.node}`,
    );
    expect(dockerfile).toContain(
      `RUN corepack enable && corepack prepare ${packageJson.packageManager} --activate`,
    );
    expect(packageJson.scripts.build).toBe(
      "tsc -p tsconfig.json && tsc-alias -p tsconfig.json",
    );
    expect(packageJson.devDependencies["tsc-alias"]).toBe("catalog:");
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });
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
      "utf8",
    );
    const devcontainer = await readJson<{
      build?: {
        dockerfile: string;
        args?: Record<string, string>;
      };
      features?: Record<string, { version?: string; pnpmVersion?: string }>;
      postCreateCommand?: string;
    }>(path.join(projectDir, ".devcontainer/devcontainer.json"));
    const dockerfile = await readFile(
      path.join(projectDir, ".devcontainer/Dockerfile"),
      "utf8",
    );

    expect(rootPackageJson.engines.node).toBe("24");
    expect(rootPackageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(apiPackageJson.engines.node).toBe("24");
    expect(apiPackageJson).not.toHaveProperty("packageManager");
    expect(webPackageJson.engines.node).toBe("24");
    expect(webPackageJson).not.toHaveProperty("packageManager");
    expect(checkWorkflow).toContain("node-version-file: package.json");
    expect(checkWorkflow).toContain("run: corepack enable");
    expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
    expect(checkWorkflow).not.toContain("version: 10.0.0");
    expect(checkWorkflow).not.toContain("node-version:");
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: rootPackageJson.engines.node,
        PACKAGE_MANAGER_PIN: rootPackageJson.packageManager,
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(dockerfile).toContain(
      `FROM mcr.microsoft.com/devcontainers/typescript-node:${rootPackageJson.engines.node}`,
    );
    expect(dockerfile).toContain(
      `RUN corepack enable && corepack prepare ${rootPackageJson.packageManager} --activate`,
    );
    expect(devcontainer).not.toHaveProperty("postCreateCommand");
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
          path.join(projectDir, configDir, "package.json"),
        );
        expect(packageJson.scripts["format:check"]).toBe("oxfmt --check .");
        expect(packageJson.scripts["format:write"]).toBe("oxfmt --write .");
        expect(packageJson.scripts.lint).toBe("oxlint . --deny-warnings");
        expect(packageJson.scripts["lint:fix"]).toBe(
          "oxlint . --fix --deny-warnings",
        );
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const rootWorkspaceYaml = await readFile(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
    }>(path.join(projectDir, "tsconfig.json"));
    const gitignore = await readFile(
      path.join(projectDir, ".gitignore"),
      "utf8",
    );
    const blueprint = await readJson<{ preset: string }>(
      path.join(projectDir, ".template/blueprint.json"),
    );
    const generatedBy = await readJson<{ packageName: string }>(
      path.join(projectDir, ".template/generated-by.json"),
    );
    const templateFiles = await readdir(path.join(projectDir, ".template"));
    const generatedWorkspace = parseYaml(workspaceYaml) as {
      catalog: Record<string, string>;
    };
    const templateWorkspace = parseYaml(rootWorkspaceYaml) as {
      catalog: Record<string, string>;
    };

    const projection = findBuiltInPresetProjection("ts-lib");
    const expectedPlan = projection!.project(
      assembleGenerationContext({
        targetDir: projectDir,
        blueprint: projection!.blueprint({ targetDir: projectDir }),
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@10.0.0",
          },
          source: "online",
          diagnostics: [],
        },
      }),
    );

    expect(packageJson.name).toBe("demo-lib");
    expect(packageJson.scripts).toEqual(expectedPlan.packageScripts);
    expect(packageJson.scripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );
    expect(packageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix",
    );
    expect(packageJson.devDependencies.typescript).toBe("catalog:");
    expect(packageJson.devDependencies.oxlint).toBe("catalog:");
    expect(packageJson.devDependencies.oxfmt).toBe("catalog:");

    expect(workspaceYaml).toContain("catalog:");
    expect(workspaceYaml).toContain("typescript:");
    expect(workspaceYaml).toContain("oxlint:");
    expect(workspaceYaml).toContain("oxfmt:");
    expect(generatedWorkspace.catalog).toEqual({
      "@types/node": templateWorkspace.catalog["@types/node"],
      oxfmt: templateWorkspace.catalog.oxfmt,
      oxlint: templateWorkspace.catalog.oxlint,
      "tsc-alias": templateWorkspace.catalog["tsc-alias"],
      typescript: templateWorkspace.catalog.typescript,
    });
    expect(generatedWorkspace.catalog).not.toHaveProperty("hono");

    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });

    expect(blueprint.preset).toBe("ts-lib");
    expect(generatedBy.packageName).toBe("@ykdz/template");
    expect(templateFiles).toEqual(["blueprint.json", "generated-by.json"]);
    expect(gitignore).toContain(".template/\n");
    expect(gitignore).toContain(".pnpm-store/\n");

    await stat(path.join(projectDir, ".devcontainer/devcontainer.json"));
    await stat(path.join(projectDir, ".devcontainer/Dockerfile"));
    await stat(path.join(projectDir, ".github/workflows/check.yml"));
    await stat(path.join(projectDir, ".github/dependabot.yml"));
    await stat(path.join(projectDir, "src/index.ts"));
    await expect(
      stat(path.join(projectDir, ".project-kit")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(projectDir, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
    );
    expect(checkWorkflow).not.toContain("cache: pnpm");
    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m,
    )?.[1];
    expect(installCommand).toBeDefined();

    expect(installCommand).toBe("pnpm install");
  });

  it("prints the planned Project Blueprint during dry-run without writing files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-dry-run-"));
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      [
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--dry-run",
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain("Project Blueprint");
    expect(result.stdout).toContain("Preset: ts-lib");
    expect(result.stdout).toContain("Target:");
    expect(result.stdout).toContain(projectDir);
    expect(result.stdout).toContain("Toolchain Resolution:");
    expect(result.stdout).toContain("Node LTS major:");
    expect(result.stdout).toContain("Package Manager Pin:");
    expect(result.stdout).toContain("Next Step Instructions:");
    expect(result.stdout).toContain("Install dependencies: pnpm install");
    expect(result.stdout).toContain("Run Fix Command: pnpm run fix");
    expect(result.stdout).toContain("Run Root Check: pnpm run check");
    expect(result.stdout).not.toContain("Post Commands:");
    expect(result.stdout).not.toContain("corepack");

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints machine-readable init output with --json", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    const result = await execa(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      [
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "vue-hono-app",
        "--scope",
        "custom-scope",
        "--dry-run",
        "--json",
      ],
      { cwd: repoRoot },
    );

    const output = JSON.parse(result.stdout) as {
      command: string;
      dryRun: boolean;
      targetDir: string;
      blueprint: {
        preset: string;
        packageManager: string;
        packages: Array<{ name: string; path: string }>;
      };
      toolchain: {
        nodeLtsMajor: string;
        packageManagerPin: string;
        source: string;
      };
      nextSteps: Array<{
        id: string;
        display: string;
        command: string;
        args: string[];
        cwd: string;
      }>;
    };

    expect(output).toEqual(
      expect.objectContaining({
        command: "init",
        dryRun: true,
        targetDir: projectDir,
      }),
    );
    expect(output.blueprint).toEqual(
      expect.objectContaining({
        preset: "vue-hono-app",
        packageManager: "pnpm",
        packages: [
          { name: "@custom-scope/web", path: "apps/web" },
          { name: "@custom-scope/api", path: "apps/api" },
        ],
      }),
    );
    expect(output.toolchain).toEqual(
      expect.objectContaining({
        nodeLtsMajor: expect.any(String),
        packageManagerPin: expect.stringMatching(/^pnpm@/),
      }),
    );
    expect(output.nextSteps.map((step) => step.display)).toEqual([
      `cd ${projectDir}`,
      "pnpm install",
      "pnpm run fix",
      "pnpm --filter ./apps/web exec playwright install chromium",
      "pnpm run check",
      ...optionalGitDisplays,
    ]);
    expect(output.nextSteps[2]).toEqual(
      expect.objectContaining({
        id: "run-fix",
        command: "pnpm",
        args: ["run", "fix"],
        cwd: projectDir,
      }),
    );
    expect(output.nextSteps[3]).toEqual(
      expect.objectContaining({
        id: "install-web-playwright-browsers",
        command: "pnpm",
        args: [
          "--filter",
          "./apps/web",
          "exec",
          "playwright",
          "install",
          "chromium",
        ],
        cwd: projectDir,
      }),
    );
    expect(output).not.toHaveProperty("postCommands");
    expect(output).not.toHaveProperty("ready");
    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints rust-bin dry-run JSON from the Preset Projection plan", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-"));
    const projectDir = path.join(workspace, "demo-rust");

    const result = await execa(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      [
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "rust-bin",
        "--dry-run",
        "--json",
      ],
      { cwd: repoRoot },
    );

    const output = JSON.parse(result.stdout) as {
      command: string;
      dryRun: boolean;
      targetDir: string;
      blueprint: { preset: string; packageManager: string };
      toolchain: {
        nodeLtsMajor: string;
        packageManagerPin: string;
      };
      nextSteps: Array<{ id: string; display: string }>;
    };

    expect(output).toEqual(
      expect.objectContaining({
        command: "init",
        dryRun: true,
        targetDir: projectDir,
        blueprint: expect.objectContaining({
          preset: "rust-bin",
          packageManager: "pnpm",
        }),
        toolchain: expect.objectContaining({
          nodeLtsMajor: expect.any(String),
          packageManagerPin: expect.stringMatching(/^pnpm@/),
        }),
      }),
    );
    expect(output.nextSteps.map((step) => step.display)).toEqual([
      `cd ${projectDir}`,
      "pnpm install",
      "pnpm run fix",
      "pnpm run check",
      ...optionalGitDisplays,
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const output = JSON.parse(result.stdout) as {
      command: string;
      dryRun: boolean;
      targetDir: string;
      blueprint: { preset: string; packageManager: string };
      toolchain: {
        nodeLtsMajor: string;
        packageManagerPin: string;
        source: string;
        diagnostics: string[];
      };
      nextSteps: Array<{
        id: string;
        display: string;
        command: string;
        args: string[];
        cwd: string;
      }>;
    };

    expect(output).toEqual(
      expect.objectContaining({
        command: "init",
        dryRun: false,
        targetDir: projectDir,
        blueprint: expect.objectContaining({
          preset: "ts-lib",
          packageManager: "pnpm",
        }),
      }),
    );
    expect(output.nextSteps).toEqual([
      expect.objectContaining({
        id: "enter-project",
        display: `cd ${projectDir}`,
        command: "cd",
        args: [projectDir],
        cwd: ".",
      }),
      expect.objectContaining({
        id: "install-dependencies",
        display: "pnpm install",
        command: "pnpm",
        args: ["install"],
        cwd: projectDir,
      }),
      expect.objectContaining({
        id: "run-fix",
        display: "pnpm run fix",
        command: "pnpm",
        args: ["run", "fix"],
        cwd: projectDir,
      }),
      expect.objectContaining({
        id: "run-root-check",
        display: "pnpm run check",
        command: "pnpm",
        args: ["run", "check"],
        cwd: projectDir,
      }),
      expect.objectContaining({
        id: "optional-git-init",
        display: "git init",
        command: "git",
        args: ["init"],
        cwd: projectDir,
        machineVerifiable: false,
      }),
      expect.objectContaining({
        id: "optional-git-add",
        display: "git add .",
        command: "git",
        args: ["add", "."],
        cwd: projectDir,
        machineVerifiable: false,
      }),
      expect.objectContaining({
        id: "optional-git-commit",
        display: 'git commit -m "Initial commit"',
        command: "git",
        args: ["commit", "-m", "Initial commit"],
        cwd: projectDir,
        machineVerifiable: false,
      }),
    ]);
    expect(output.toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@10.0.0",
      source: "online",
      diagnostics: [],
    });
    expect(output).not.toHaveProperty("postCommands");
    expect(output).not.toHaveProperty("ready");
    await stat(path.join(projectDir, "package.json"));
    expect(
      await readJson<Record<string, unknown>>(
        path.join(projectDir, ".template", "generated-by.json"),
      ),
    ).not.toHaveProperty("nextSteps");
    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps projection next step paths consistent with a relative target dir", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-"));

    const result = await execa(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      [
        path.join(repoRoot, "src/cli.ts"),
        "init",
        "demo-lib",
        "--preset",
        "ts-lib",
        "--dry-run",
        "--json",
      ],
      { cwd: workspace },
    );

    const output = JSON.parse(result.stdout) as {
      targetDir: string;
      nextSteps: Array<{
        id: string;
        display: string;
        args: string[];
        cwd: string;
      }>;
    };

    expect(output.targetDir).toBe("demo-lib");
    expect(output.nextSteps[0]).toEqual(
      expect.objectContaining({
        id: "enter-project",
        display: "cd demo-lib",
        args: ["demo-lib"],
        cwd: ".",
      }),
    );
    expect(output.nextSteps.slice(1).map((step) => step.cwd)).toEqual([
      "demo-lib",
      "demo-lib",
      "demo-lib",
      "demo-lib",
      "demo-lib",
      "demo-lib",
    ]);
  });

  it("reports bundled toolchain fallback in JSON output and the generation record", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-toolchain-fallback-"),
    );
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
        "--yes",
      ],
      {
        cwd: repoRoot,
        env: {
          TEMPLATE_TOOLCHAIN_RESOLUTION: "online",
          TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL:
            "http://127.0.0.1:9/index.json",
        },
      },
    );

    const output = JSON.parse(result.stdout) as {
      toolchain: {
        nodeLtsMajor: string;
        packageManagerPin: string;
        source: string;
        diagnostics: string[];
      };
    };
    const generationRecord = await readJson<{
      toolchain: {
        nodeLtsMajor: string;
        packageManagerPin: string;
        source: string;
      };
    }>(path.join(projectDir, ".template/generated-by.json"));

    expect(output.toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@10.0.0",
      source: "bundled-fallback",
      diagnostics: [
        expect.stringContaining("Using bundled fallback toolchain metadata"),
      ],
    });
    expect(generationRecord.toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@10.0.0",
      source: "bundled-fallback",
    });
  });

  it("reports bundled toolchain fallback visibly in human init output", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-toolchain-fallback-"),
    );
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
        "--yes",
      ],
      {
        cwd: repoRoot,
        env: {
          TEMPLATE_TOOLCHAIN_RESOLUTION: "online",
          TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL:
            "http://127.0.0.1:9/index.json",
        },
      },
    );

    expect(result.stdout).toContain("Toolchain Resolution:");
    expect(result.stdout).toContain("Source: bundled-fallback");
    expect(result.stdout).toContain("Node LTS major: 24");
    expect(result.stdout).toContain("Package Manager Pin: pnpm@10.0.0");
    expect(result.stdout).toContain(
      "Using bundled fallback toolchain metadata",
    );
  });

  it("rejects ready mode without executing generated project commands", async () => {
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
        "",
      ].join("\n"),
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
        "",
      ].join("\n"),
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
        "--yes",
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          ...toolchainEnvWithPnpm("10.2.0"),
        },
        reject: false,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown option: --ready");
    expect(result.stderr).not.toContain(
      "Run template-maintained Post Commands",
    );
    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not advertise ready mode in help", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ready-failure-"),
    );

    const result = await execa(
      "pnpm",
      ["exec", "tsx", path.join(repoRoot, "src/cli.ts"), "--help"],
      {
        cwd: repoRoot,
      },
    );

    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).not.toContain("--ready");
    expect(result.stdout).not.toContain("Post Commands");
    await expect(stat(workspace)).resolves.toBeDefined();
  });

  it("fails clearly in non-interactive init without --yes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-noninteractive-"),
    );
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
          "ts-lib",
        ],
        { cwd: repoRoot, timeout: 5_000 },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Non-interactive init requires --yes"),
    });

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows empty target directories and rejects non-empty target directories", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-dir-safety-"),
    );
    const emptyDir = path.join(workspace, "empty");
    const nonEmptyDir = path.join(workspace, "non-empty");
    await mkdir(emptyDir);
    await mkdir(nonEmptyDir);
    await writeFile(
      path.join(nonEmptyDir, "README.md"),
      "# existing\n",
      "utf8",
    );

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
        "--yes",
      ],
      { cwd: repoRoot },
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
          "--yes",
        ],
        { cwd: repoRoot },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Target directory is not empty"),
    });
    expect(await readFile(path.join(nonEmptyDir, "README.md"), "utf8")).toBe(
      "# existing\n",
    );
  });

  it("reviews the Project Blueprint and asks for confirmation in interactive terminals", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-interactive-"),
    );
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
            `pnpm exec tsx ${shellQuote(cliPath)} init ${shellQuote(projectDir)} --preset ts-lib`,
          ),
          "/dev/null",
        ].join(" "),
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain("Project Blueprint");
    expect(result.stdout).toContain("Preset: ts-lib");
    expect(result.stdout).toContain("Generate this project? [y/N]");
    expect(result.stdout).toContain(
      `Initialized ts-lib project in ${projectDir}`,
    );
    await stat(path.join(projectDir, "package.json"));
  });

  it("cancels interactive init without writing files when confirmation is declined", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-interactive-"),
    );
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
              `pnpm exec tsx ${shellQuote(cliPath)} init ${shellQuote(projectDir)} --preset ts-lib`,
            ),
            "/dev/null",
          ].join(" "),
        ],
        { cwd: repoRoot },
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringMatching(
        /Generate this project\? \[y\/N\][\s\S]*Init cancelled/,
      ),
    });

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints next steps after generation without installing dependencies", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-next-steps-"),
    );
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain(
      `Initialized ts-lib project in ${projectDir}`,
    );
    expect(result.stdout).toContain("Next Step Instructions:");
    expect(result.stdout).toContain(`cd ${projectDir}`);
    expect(result.stdout).toContain("pnpm install");
    expect(result.stdout).toContain("pnpm run fix");
    expect(result.stdout).toContain("pnpm run check");
    expect(result.stdout).toContain("git init");
    expect(result.stdout).toContain("git add .");
    expect(result.stdout).toContain('git commit -m "Initial commit"');
    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prints fix next steps after generation without executing the fix command", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-next-step-fix-"),
    );
    const projectDir = path.join(workspace, "demo-lib");
    const fakeBin = path.join(workspace, "bin");
    const commandLog = path.join(workspace, "commands.jsonl");

    await mkdir(fakeBin);
    await writeExecutable(
      path.join(fakeBin, "pnpm"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        "",
        "appendFileSync(",
        `  ${JSON.stringify(commandLog)},`,
        "  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n'",
        ");",
        "",
      ].join("\n"),
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
        "--yes",
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          ...toolchainEnvWithPnpm("10.2.0"),
        },
      },
    );

    expect(result.stdout).toContain("Run Fix Command: pnpm run fix");
    await expect(readFile(commandLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
    }>(path.join(projectDir, "tsconfig.json"));
    const blueprint = await readJson<{ preset: string }>(
      path.join(projectDir, ".template/blueprint.json"),
    );
    const appSource = await readFile(
      path.join(projectDir, "src/app.ts"),
      "utf8",
    );
    const serverSource = await readFile(
      path.join(projectDir, "src/server.ts"),
      "utf8",
    );

    expect(packageJson.name).toBe("demo-api");
    expect(packageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test",
    );
    expect(packageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix",
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
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
    );
    expect(checkWorkflow).not.toContain("cache: pnpm");
    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m,
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const cargoToml = await readFile(
      path.join(projectDir, "Cargo.toml"),
      "utf8",
    );
    const rustfmtToml = await readFile(
      path.join(projectDir, "rustfmt.toml"),
      "utf8",
    );
    const rustToolchainToml = await readFile(
      path.join(projectDir, "rust-toolchain.toml"),
      "utf8",
    );
    const packageJson = await readJson<{
      name: string;
      private: boolean;
      engines: { node: string };
      scripts: Record<string, string>;
      packageManager: string;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const devcontainer = await readJson<{
      build: {
        dockerfile: string;
        args: Record<string, string>;
      };
      features?: unknown;
      mounts: string[];
      postCreateCommand?: string;
      customizations: {
        vscode: {
          extensions: string[];
          settings: Record<string, unknown>;
        };
      };
    }>(path.join(projectDir, ".devcontainer/devcontainer.json"));
    const workspaceExtensions = await readJson<{
      recommendations: string[];
    }>(path.join(projectDir, ".vscode/extensions.json"));
    const workspaceSettings = await readJson<Record<string, unknown>>(
      path.join(projectDir, ".vscode/settings.json"),
    );
    const blueprintPath = path.join(projectDir, ".template/blueprint.json");
    const blueprint = await readJson<{
      preset: string;
      packageManager?: string;
    }>(blueprintPath);
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const dockerfile = await readFile(
      path.join(projectDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const dependabot = await readFile(
      path.join(projectDir, ".github/dependabot.yml"),
      "utf8",
    );
    const files = await generatedFilePaths(projectDir);

    expect(packageJson.name).toBe("demo-rust");
    expect(packageJson.private).toBe(true);
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(packageJson.scripts).toEqual({
      check:
        "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace",
      fix: "cargo fmt --all",
    });
    expect(packageJson.scripts.fix).not.toContain("clippy");
    expect(workspaceYaml).toBe(["packages:", "  - .", ""].join("\n"));

    expect(cargoToml).toContain('name = "demo-rust"');
    expect(cargoToml).toContain('edition = "2024"');
    expect(cargoToml).toContain("[workspace.lints.clippy]");
    expect(cargoToml).toContain('all = "deny"');
    expect(cargoToml).toContain("[profile.release]");
    expect(cargoToml).toContain('strip = "symbols"');
    expect(rustfmtToml).toContain('edition = "2024"');
    expect(rustToolchainToml).toContain('[toolchain]\nchannel = "stable"\n');
    expect(rustToolchainToml).toContain(
      'components = ["rustfmt", "clippy"]',
    );

    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: packageJson.engines.node,
        PACKAGE_MANAGER_PIN: packageJson.packageManager,
        RUST_TOOLCHAIN: "stable",
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(dockerfile).toContain(
      `FROM mcr.microsoft.com/devcontainers/typescript-node:${packageJson.engines.node}`,
    );
    expect(dockerfile).toContain(
      `RUN corepack enable && corepack prepare ${packageJson.packageManager} --activate`,
    );
    expect(dockerfile).toContain("ARG RUST_TOOLCHAIN=stable");
    expect(dockerfile).toContain(
      "rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy",
    );
    expect(devcontainer).not.toHaveProperty("postCreateCommand");
    expect(devcontainer.mounts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("target=/usr/local/cargo/registry"),
        expect.stringContaining("target=${containerWorkspaceFolder}/target"),
      ]),
    );
    const expectedEditorCustomization = editorCustomizationForCapabilities([
      "rust-tooling",
    ]);
    expect(devcontainer.customizations.vscode.extensions).toEqual(
      expectedEditorCustomization.extensions,
    );
    expect(devcontainer.customizations.vscode.settings).toEqual(
      expectedEditorCustomization.settings,
    );
    expect(workspaceExtensions.recommendations).toEqual(
      expectedEditorCustomization.extensions,
    );
    expect(workspaceSettings).toEqual(expectedEditorCustomization.settings);

    expect(blueprint.preset).toBe("rust-bin");
    expect(blueprint.packageManager).toBe("pnpm");
    expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(checkWorkflow).toContain("components: rustfmt, clippy");
    expect(checkWorkflow).toContain("node-version-file: package.json");
    expect(checkWorkflow).toContain("run: corepack enable");
    expect(checkWorkflow).toContain("run: pnpm install");
    expect(checkWorkflow).toContain("run: pnpm run check");
    expect(checkWorkflow).toContain("uses: Swatinem/rust-cache@v2");
    expect(checkWorkflow).not.toContain("./scripts/check");
    expect(dependabot).toContain("package-ecosystem: cargo");
    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(files.some((file) => file.endsWith("oxlint.config.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("oxfmt.config.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith(".oxlintrc.json"))).toBe(false);
    expect(files.some((file) => file.endsWith(".oxfmtrc.json"))).toBe(false);

    await stat(path.join(projectDir, "src/main.rs"));
    await stat(path.join(projectDir, "Cargo.lock"));
    await expect(
      stat(path.join(projectDir, "scripts/check")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "blueprint",
        "validate",
        blueprintPath,
      ],
      { cwd: repoRoot },
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const cargoToml = await readFile(
      path.join(projectDir, "Cargo.toml"),
      "utf8",
    );
    const cargoLock = await readFile(
      path.join(projectDir, "Cargo.lock"),
      "utf8",
    );

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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
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
      path.join(projectDir, ".template/blueprint.json"),
    );

    expect(packageJson.name).toBe("demo-vue");
    expect(packageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test && pnpm run test:e2e",
    );
    expect(packageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix",
    );
    expect(packageJson.scripts["test:e2e"]).toBe(
      "pnpm run build && playwright test",
    );
    expect(packageJson.scripts.typecheck).toBe("vue-tsc --build --noEmit");
    expect(packageJson.dependencies.vue).toBe("catalog:");
    expect(packageJson.dependencies.pinia).toBe("catalog:");
    expect(packageJson.dependencies["@vueuse/core"]).toBe("catalog:");
    expect(packageJson.devDependencies.vite).toBe("catalog:");
    expect(packageJson.devDependencies["@vitejs/plugin-vue"]).toBe("catalog:");
    expect(packageJson.devDependencies["@vue/tsconfig"]).toBe("catalog:");
    expect(packageJson.devDependencies["@types/web-bluetooth"]).toBe(
      "catalog:",
    );
    expect(packageJson.devDependencies.vitest).toBe("catalog:");
    expect(packageJson.devDependencies["@playwright/test"]).toBe("catalog:");
    for (const excludedPackage of [
      "vue-router",
      "echarts",
      "shadcn-vue",
      "vee-validate",
      "@tanstack/vue-form",
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
      { path: "./tsconfig.node.json" },
    ]);
    expect(appTsconfig.compilerOptions).not.toHaveProperty("baseUrl");
    expect(appTsconfig.compilerOptions.strict).toBe(true);
    expect(appTsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(appTsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });
    expect(appTsconfig.compilerOptions.types).toEqual(["web-bluetooth"]);
    expect(appTsconfig.include).toEqual([
      "env.d.ts",
      "src/**/*.ts",
      "src/**/*.vue",
    ]);
    expect(testTsconfig.compilerOptions.types).toEqual([
      "node",
      "vitest/globals",
      "web-bluetooth",
    ]);
    expect(testTsconfig.include).toEqual([
      "env.d.ts",
      "src/**/*.ts",
      "src/**/*.vue",
      "test/**/*.ts",
    ]);
    expect(nodeTsconfig.compilerOptions.types).toEqual(["node"]);
    expect(nodeTsconfig.include).toEqual([
      "playwright.config.ts",
      "vite.config.ts",
      "vitest.config.ts",
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
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
    );
    expect(checkWorkflow).not.toContain("cache: pnpm");
    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m,
    )?.[1];
    expect(installCommand).toBeDefined();
    expect(checkWorkflow).toContain(
      "pnpm exec playwright install --with-deps chromium",
    );

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
        "--yes",
      ],
      { cwd: repoRoot },
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
      "utf8",
    );
    const blueprint = await readJson<{
      preset: string;
      projectKind: string;
      packages: Array<{ name: string; path: string }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const apiIndex = await readFile(
      path.join(projectDir, "apps/api/src/index.ts"),
      "utf8",
    );
    const webApiClient = await readFile(
      path.join(projectDir, "apps/web/src/api.ts"),
      "utf8",
    );
    const viteConfig = await readFile(
      path.join(projectDir, "apps/web/vite.config.ts"),
      "utf8",
    );
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
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
    expect(webPackageJson.dependencies["@demo-fullstack/api"]).toBe(
      "workspace:*",
    );
    expect(webPackageJson.dependencies.hono).toBe("catalog:");
    expect(webApiClient).toMatch(
      /^import type \{ AppType \} from "@demo-fullstack\/api";$/m,
    );
    expect(webApiClient).toMatch(/^import \{ hc \} from "hono\/client";$/m);
    expect(viteConfig).toContain('"/api"');
    expect(viteConfig).toContain("VITE_API_BASE_URL");

    expect(rootTsconfig.files).toEqual([]);
    expect(rootTsconfig.references).toEqual([
      { path: "./apps/api/tsconfig.json" },
      { path: "./apps/web/tsconfig.app.json" },
      { path: "./apps/web/tsconfig.test.json" },
      { path: "./apps/web/tsconfig.node.json" },
    ]);
    expect(webTsconfig.references).toEqual([
      { path: "./tsconfig.app.json" },
      { path: "./tsconfig.test.json" },
      { path: "./tsconfig.node.json" },
    ]);
    expect(webAppTsconfig.compilerOptions).not.toHaveProperty("baseUrl");
    expect(webAppTsconfig.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
    expect(webAppTsconfig.compilerOptions.paths["@demo-fullstack/api"]).toEqual(
      ["../api/src/index.ts"],
    );
    expect(webAppTsconfig.references).toEqual([
      { path: "../api/tsconfig.build.json" },
    ]);
    expect(webTestTsconfig.references).toEqual([
      { path: "../api/tsconfig.build.json" },
    ]);
    expect(turboConfig.tasks.check.dependsOn).toEqual(["^build"]);

    expect(blueprint).toEqual(
      expect.objectContaining({
        preset: "vue-hono-app",
        projectKind: "multi-package",
        packages: [
          { name: "@demo-fullstack/web", path: "apps/web" },
          { name: "@demo-fullstack/api", path: "apps/api" },
        ],
      }),
    );

    await stat(path.join(projectDir, "apps/api/src/server.ts"));
    await stat(path.join(projectDir, "apps/web/test/e2e/app.spec.ts"));
    await expect(
      stat(path.join(projectDir, "packages/api-client")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(checkWorkflow).not.toContain("cache: pnpm");
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );

    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m,
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const blueprint = await readJson<{
      packages: Array<{ name: string; path: string }>;
    }>(path.join(projectDir, ".template/blueprint.json"));
    const apiPackageJson = await readJson<{ name: string }>(
      path.join(projectDir, "apps/api/package.json"),
    );
    const webPackageJson = await readJson<{
      name: string;
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));
    const webApiClient = await readFile(
      path.join(projectDir, "apps/web/src/api.ts"),
      "utf8",
    );
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8",
    );

    expect(apiPackageJson.name).toBe("@custom-scope/api");
    expect(webPackageJson.name).toBe("@custom-scope/web");
    expect(webPackageJson.dependencies["@custom-scope/api"]).toBe(
      "workspace:*",
    );
    expect(webApiClient).toMatch(
      /^import type \{ AppType \} from "@custom-scope\/api";$/m,
    );
    expect(webApiClient).toMatch(/^import \{ hc \} from "hono\/client";$/m);
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );
    expect(blueprint.packages).toEqual([
      { name: "@custom-scope/web", path: "apps/web" },
      { name: "@custom-scope/api", path: "apps/api" },
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
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const apiPackageJson = await readJson<{ name: string }>(
      path.join(projectDir, "apps/api/package.json"),
    );
    const webPackageJson = await readJson<{
      name: string;
      dependencies: Record<string, string>;
    }>(path.join(projectDir, "apps/web/package.json"));
    const blueprint = await readJson<{
      packages: Array<{ name: string; path: string }>;
    }>(path.join(projectDir, ".template/blueprint.json"));

    expect(apiPackageJson.name).toBe("@custom-scope/api");
    expect(webPackageJson.name).toBe("@custom-scope/web");
    expect(webPackageJson.dependencies["@custom-scope/api"]).toBe(
      "workspace:*",
    );
    expect(blueprint.packages).toEqual([
      { name: "@custom-scope/web", path: "apps/web" },
      { name: "@custom-scope/api", path: "apps/api" },
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
          "--yes",
        ],
        { cwd: repoRoot },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--scope must be a valid npm scope without whitespace",
      ),
    });

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
