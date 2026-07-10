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

import {
  builtInPresets,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import { execa } from "execa";
import * as v from "valibot";

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
      "11.11.0": { engines: { node: ">=24.0.0" } },
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

const initJsonOutputSchema = v.looseObject({
  command: v.optional(v.string()),
  dryRun: v.optional(v.boolean()),
  targetDir: v.string(),
  blueprint: v.looseObject({
    preset: v.string(),
    packageManager: v.optional(v.string()),
    packages: v.optional(
      v.array(v.object({ name: v.string(), path: v.string() })),
    ),
  }),
  toolchain: v.looseObject({
    nodeLtsMajor: v.string(),
    packageManagerPin: v.string(),
    source: v.optional(v.string()),
    diagnostics: v.optional(v.array(v.string())),
  }),
  nextSteps: v.array(
    v.looseObject({
      id: v.string(),
      display: v.string(),
      command: v.optional(v.string()),
      args: v.optional(v.array(v.string())),
      cwd: v.optional(v.string()),
      machineVerifiable: v.optional(v.boolean()),
    }),
  ),
  followUpDocument: v.looseObject({
    enabled: v.boolean(),
    path: v.optional(v.string()),
  }),
});
function parseJsonWithSchema<const Schema extends v.GenericSchema>(
  text: string,
  schema: Schema,
): v.InferOutput<Schema> {
  return v.parse(schema, JSON.parse(text) as unknown);
}

async function expectCommandFailure(
  command: Promise<unknown>,
  expected: { readonly stderr?: string; readonly stdout?: string | RegExp },
): Promise<void> {
  try {
    await command;
  } catch (error) {
    if (expected.stderr !== undefined) {
      expect(commandErrorOutput(error, "stderr")).toContain(expected.stderr);
    }

    if (typeof expected.stdout === "string") {
      expect(commandErrorOutput(error, "stdout")).toContain(expected.stdout);
    } else if (expected.stdout !== undefined) {
      expect(commandErrorOutput(error, "stdout")).toMatch(expected.stdout);
    }

    return;
  }

  throw new Error("Expected command to fail");
}

function commandErrorOutput(
  error: unknown,
  stream: "stderr" | "stdout",
): string {
  if (typeof error !== "object" || error === null) {
    throw error;
  }

  if (
    stream === "stderr" &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    return error.stderr;
  }

  if (
    stream === "stdout" &&
    "stdout" in error &&
    typeof error.stdout === "string"
  ) {
    return error.stdout;
  }

  throw error;
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
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Large generated-fixture tests still use typed JSON reads; schema-backed reads are being introduced around high-risk assertions.
  return parsed as T;
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

  return files.toSorted();
}

async function generatePresetProject(preset: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
  const projectDir = path.join(workspace, `demo-${preset}`);

  await execa(
    "node",
    [
      "--conditions=source",
      path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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

function expectNoWorkspaceLifecycleFeatures(features: readonly string[]): void {
  for (const feature of forbiddenWorkspaceLifecycleFeatures) {
    expect(features).not.toContain(feature);
  }
}

function supportedPresetNamesWithCapability(kind: string): string[] {
  return loadBuiltInPresetSourceManifest()
    .presets.filter(
      (preset) =>
        preset.generation === "supported" &&
        (preset.projection?.capabilities ?? []).some(
          (capability) => capability.kind === kind,
        ),
    )
    .map((preset) => preset.name);
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

  it("generates capability-aware infrastructure for every supported built-in preset", async () => {
    const supportedPresets = builtInPresets.filter(
      (preset) => preset.generation === "supported",
    );
    const outOfScopePathPatterns = [
      /^(?!\.devcontainer\/Dockerfile$)(?!apps\/web\/Dockerfile$)(?:.*\/)?Dockerfile$/,
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

      expect(files).toContain(".devcontainer/Dockerfile");
      expect(devcontainer.build?.dockerfile).toBe("Dockerfile");
      expect(devcontainer.build?.args).toMatchObject({
        NODE_VERSION: packageJson.engines.node,
        PACKAGE_MANAGER_PIN: packageJson.packageManager,
      });
      expect(devcontainer).not.toHaveProperty("features");
      expect(devcontainer).not.toHaveProperty("postCreateCommand");
      if (dockerfile !== undefined) {
        expect(dockerfile).toContain("ARG NODE_VERSION");
        expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
        expect(dockerfile).toContain(
          'corepack enable --install-directory "$PNPM_HOME"',
        );
        expect(dockerfile).not.toContain("typescript-node");
        expect(dockerfile).not.toMatch(
          /\b(?:npm|pnpm|corepack)\s+.*-g\s+turbo\b/,
        );
      }

      const workspaceExtensions = await readJson<{
        recommendations: string[];
      }>(path.join(projectDir, ".vscode/extensions.json"));
      const workspaceSettings = await readJson<Record<string, unknown>>(
        path.join(projectDir, ".vscode/settings.json"),
      );

      expect(devcontainer.customizations.vscode.extensions).toEqual(
        workspaceExtensions.recommendations,
      );
      expect(devcontainer.customizations.vscode.settings).toEqual(
        workspaceSettings,
      );
    }
  }, 300_000);

  it("generates Node presets with the explicit pnpm 11 workspace contract", async () => {
    const nodePresetNames = supportedPresetNamesWithCapability(
      "node-pnpm-devcontainer",
    );

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
      const workspaceYaml = await readFile(
        path.join(projectDir, "pnpm-workspace.yaml"),
        "utf8",
      );
      const dependabot = await readFile(
        path.join(projectDir, ".github/dependabot.yml"),
        "utf8",
      );

      expect(packageJson.engines.node).toBe("24");
      expect(packageJson.packageManager).toBe("pnpm@11.11.0");
      expect(workspaceYaml).toContain("nodeLinker: isolated");
      expect(workspaceYaml).toContain("injectWorkspacePackages: true");
      expect(workspaceYaml).toContain("dedupeInjectedDeps: false");
      expect(workspaceYaml).toContain(
        "syncInjectedDepsAfterScripts:\n  - build:run",
      );
      expect(workspaceYaml).toContain("minimumReleaseAge: 1440");
      expect(workspaceYaml).toContain("minimumReleaseAgeStrict: true");
      expect(checkWorkflow).toContain("node-version-file: package.json");
      expect(checkWorkflow).toContain("run: corepack enable");
      expect(checkWorkflow).not.toContain("uses: pnpm/action-setup");
      expect(checkWorkflow).not.toContain("          version: 10.0.0");
      expect(dependabot).toContain("package-ecosystem: npm");
      expect(dependabot).toContain("package-ecosystem: github-actions");
    }
  }, 240_000);

  it("generates Node presets with checked OXC config source", async () => {
    const nodePresetNames =
      supportedPresetNamesWithCapability("oxc-format-lint");

    for (const preset of nodePresetNames) {
      const projectDir = await generatePresetProject(preset);
      const files = await generatedFilePaths(projectDir);
      const blueprint = await readJson<{
        packages?: Array<{ path: string }>;
      }>(path.join(projectDir, ".template/blueprint.json"));
      const packageDirs = blueprint.packages?.map((pkg) => pkg.path) ?? ["."];

      expect(files).toContain("oxlint.config.ts");
      expect(files).toContain("oxfmt.config.ts");

      const rootPackageJson = await readJson<{
        scripts: Record<string, string>;
      }>(path.join(projectDir, "package.json"));
      const rootConfigTsconfig = await readJson<{ include: string[] }>(
        path.join(projectDir, "tsconfig.config.json"),
      );
      expect(rootPackageJson.scripts.typecheck).toBe(
        "turbo run typecheck:run --output-logs=errors-only --log-order=grouped",
      );
      expect(rootPackageJson.scripts["typecheck:run"]).toBe(
        "tsc -p tsconfig.config.json --noEmit --pretty false",
      );
      expect(rootConfigTsconfig.include).toEqual([
        "oxlint.config.ts",
        "oxfmt.config.ts",
      ]);
      expect(rootPackageJson.scripts["format:check"]).toBe(
        "turbo run format:check:run --output-logs=errors-only --log-order=grouped",
      );
      expect(rootPackageJson.scripts["format:check:run"]).toBe(
        "oxfmt --list-different oxlint.config.ts oxfmt.config.ts",
      );
      expect(rootPackageJson.scripts.lint).toBe(
        "turbo run lint:run --output-logs=errors-only --log-order=grouped",
      );
      expect(rootPackageJson.scripts["lint:run"]).toBe(
        "oxlint --quiet --format=unix oxlint.config.ts oxfmt.config.ts",
      );

      for (const packageDir of packageDirs) {
        const packageJson = await readJson<{
          scripts: Record<string, string>;
        }>(path.join(projectDir, packageDir, "package.json"));
        expect(packageJson.scripts["format:check:run"]).toContain(
          "--config ../../oxfmt.config.ts",
        );
        expect(packageJson.scripts["format:write:run"]).toContain(
          "--config ../../oxfmt.config.ts",
        );
        expect(packageJson.scripts["lint:run"]).toContain(
          "--config ../../oxlint.config.ts",
        );
        expect(packageJson.scripts["lint:fix:run"]).toContain(
          "--config ../../oxlint.config.ts",
        );
        expect(files).not.toContain(`${packageDir}/oxlint.config.ts`);
        expect(files).not.toContain(`${packageDir}/oxfmt.config.ts`);
      }

      expect(files.some((file) => file.endsWith(".oxlintrc.json"))).toBe(false);
      expect(files.some((file) => file.endsWith(".oxfmtrc.json"))).toBe(false);
    }
  }, 240_000);

  it("generates a usable ts-lib project through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--yes",
      ],
      { cwd: repoRoot },
    );

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

    expect(result.stdout).toContain("Initialized project");
    expect(result.stdout).toContain(projectDir);
    expect(blueprint.preset).toBe("ts-lib");
    expect(generatedBy.packageName).toBe("@ykdz/template");
    expect(templateFiles).toEqual(["blueprint.json", "generated-by.json"]);
    expect(gitignore).toContain(".template/\n");
    expect(gitignore).toContain(".pnpm-store/\n");

    await stat(path.join(projectDir, "package.json"));
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
  });

  it("prints the planned Project Blueprint during dry-run without writing files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-dry-run-"));
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      process.execPath,
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--dry-run",
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain("Project Blueprint");
    expect(result.stdout).toMatch(/Preset:\s+ts-lib/);
    expect(result.stdout).toContain("Target:");
    expect(result.stdout).toContain(projectDir);
    expect(result.stdout).toContain("Toolchain Resolution:");
    expect(result.stdout).toContain("Node LTS major:");
    expect(result.stdout).toContain("Package Manager Pin:");
    expect(result.stdout).toContain("Generated Follow-Up Document:");
    expect(result.stdout).toMatch(/Enabled:\s+yes/);
    expect(result.stdout).toContain(path.join(projectDir, "TODO.md"));
    expect(result.stdout).not.toContain("Next Step Instructions:");
    expect(result.stdout).not.toContain("pnpm install");
    expect(result.stdout).not.toContain("Post Commands:");
    expect(result.stdout).not.toContain("corepack");

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints machine-readable init output with --json", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    const result = await execa(
      process.execPath,
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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

    const output = parseJsonWithSchema(result.stdout, initJsonOutputSchema);

    expect(output.command).toBe("init");
    expect(output.dryRun).toBe(true);
    expect(output.targetDir).toBe(projectDir);
    expect(output.blueprint.preset).toBe("vue-hono-app");
    expect(output.blueprint.packageManager).toBe("pnpm");
    expect(output.blueprint.packages).toEqual([
      { name: "@custom-scope/web", path: "apps/web" },
      { name: "@custom-scope/api", path: "apps/api" },
    ]);
    expect(output.toolchain.nodeLtsMajor.length).toBeGreaterThan(0);
    expect(output.toolchain.packageManagerPin).toMatch(/^pnpm@/);
    expect(output.nextSteps.map((step) => step.display)).toEqual([
      `cd ${projectDir}`,
      "pnpm install",
      "pnpm run fix",
      "pnpm --filter ./apps/web exec playwright install chromium",
      "pnpm run check",
      ...optionalGitDisplays,
    ]);
    expect(output.followUpDocument).toEqual({
      enabled: true,
      path: "TODO.md",
    });
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
        id: "install-apps-web-playwright-browsers",
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
      process.execPath,
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        projectDir,
        "--preset",
        "rust-bin",
        "--dry-run",
        "--json",
      ],
      { cwd: repoRoot },
    );

    const output = parseJsonWithSchema(result.stdout, initJsonOutputSchema);

    expect(output.command).toBe("init");
    expect(output.dryRun).toBe(true);
    expect(output.targetDir).toBe(projectDir);
    expect(output.blueprint.preset).toBe("rust-bin");
    expect(output.blueprint.packageManager).toBe("pnpm");
    expect(output.toolchain.nodeLtsMajor.length).toBeGreaterThan(0);
    expect(output.toolchain.packageManagerPin).toMatch(/^pnpm@/);
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
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--json",
        "--yes",
      ],
      { cwd: repoRoot },
    );

    const output = parseJsonWithSchema(result.stdout, initJsonOutputSchema);

    expect(output.command).toBe("init");
    expect(output.dryRun).toBe(false);
    expect(output.targetDir).toBe(projectDir);
    expect(output.blueprint.preset).toBe("ts-lib");
    expect(output.blueprint.packageManager).toBe("pnpm");
    expect(
      output.nextSteps.map((step) => ({
        id: step.id,
        display: step.display,
        command: step.command,
        args: step.args,
        cwd: step.cwd,
        machineVerifiable: step.machineVerifiable,
      })),
    ).toEqual([
      {
        id: "enter-project",
        display: `cd ${projectDir}`,
        command: "cd",
        args: [projectDir],
        cwd: ".",
        machineVerifiable: false,
      },
      {
        id: "install-dependencies",
        display: "pnpm install",
        command: "pnpm",
        args: ["install"],
        cwd: projectDir,
        machineVerifiable: true,
      },
      {
        id: "run-fix",
        display: "pnpm run fix",
        command: "pnpm",
        args: ["run", "fix"],
        cwd: projectDir,
        machineVerifiable: true,
      },
      {
        id: "run-root-check",
        display: "pnpm run check",
        command: "pnpm",
        args: ["run", "check"],
        cwd: projectDir,
        machineVerifiable: true,
      },
      {
        id: "optional-git-init",
        display: "git init",
        command: "git",
        args: ["init"],
        cwd: projectDir,
        machineVerifiable: false,
      },
      {
        id: "optional-git-add",
        display: "git add .",
        command: "git",
        args: ["add", "."],
        cwd: projectDir,
        machineVerifiable: false,
      },
      {
        id: "optional-git-commit",
        display: 'git commit -m "Initial commit"',
        command: "git",
        args: ["commit", "-m", "Initial commit"],
        cwd: projectDir,
        machineVerifiable: false,
      },
    ]);
    expect(output.toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.11.0",
      source: "online",
      diagnostics: [],
    });
    expect(output.followUpDocument).toEqual({
      enabled: true,
      path: "TODO.md",
    });
    expect(output).not.toHaveProperty("postCommands");
    expect(output).not.toHaveProperty("ready");
    await stat(path.join(projectDir, "package.json"));
    await expect(
      readFile(path.join(projectDir, "TODO.md"), "utf8"),
    ).resolves.toContain("### Next Steps");
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
      process.execPath,
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        "demo-lib",
        "--preset",
        "ts-lib",
        "--dry-run",
        "--json",
      ],
      { cwd: workspace },
    );

    const output = parseJsonWithSchema(result.stdout, initJsonOutputSchema);

    expect(output.targetDir).toBe("demo-lib");
    const firstNextStep = output.nextSteps[0];
    expect(firstNextStep).toBeDefined();
    expect(
      firstNextStep && {
        id: firstNextStep.id,
        display: firstNextStep.display,
        args: firstNextStep.args,
        cwd: firstNextStep.cwd,
      },
    ).toEqual({
      id: "enter-project",
      display: "cd demo-lib",
      args: ["demo-lib"],
      cwd: ".",
    });
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
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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

    const output = parseJsonWithSchema(result.stdout, initJsonOutputSchema);
    const generationRecord = await readJson<{
      toolchain: {
        nodeLtsMajor: string;
        packageManagerPin: string;
        source: string;
      };
    }>(path.join(projectDir, ".template/generated-by.json"));

    expect(output.toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.11.0",
      source: "bundled-fallback",
      diagnostics: [
        expect.stringContaining("Using bundled fallback toolchain metadata"),
      ],
    });
    expect(generationRecord.toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.11.0",
      source: "bundled-fallback",
    });
  });

  it("reports bundled toolchain fallback visibly in human init output", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-toolchain-fallback-"),
    );
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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
    expect(result.stdout).toMatch(/Source:\s+bundled-fallback/);
    expect(result.stdout).toMatch(/Node LTS major:\s+24/);
    expect(result.stdout).toMatch(/Package Manager Pin:\s+pnpm@11\.11\.0/);
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
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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
    expect(result.stderr).toContain("Error: Unknown option: --ready");
    expect(result.stderr).toContain("Run `template --help` for usage.");
    expect(result.stderr).not.toContain("Usage:");
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
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "--help",
      ],
      {
        cwd: repoRoot,
      },
    );

    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).not.toContain("--ready");
    expect(result.stdout).not.toContain("Post Commands");
    expect(result.stdout).toContain("Init options:");
    expect(result.stdout).toContain("  --yes");
    expect(result.stdout).toContain("Add package options:");
    expect(result.stdout).not.toMatch(/Add package options:[\s\S]*--yes/);
    await expect(stat(workspace)).resolves.toBeDefined();
  });

  it("fails clearly in non-interactive init without --yes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-noninteractive-"),
    );
    const projectDir = path.join(workspace, "demo-lib");

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
          "init",
          projectDir,
          "--preset",
          "ts-lib",
        ],
        { cwd: repoRoot, timeout: 5_000 },
      ),
      { stderr: "Non-interactive init requires --yes" },
    );

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
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        emptyDir,
        "--preset",
        "ts-lib",
        "--yes",
      ],
      { cwd: repoRoot },
    );

    await stat(path.join(emptyDir, "package.json"));

    const nonEmptyResult = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        nonEmptyDir,
        "--preset",
        "ts-lib",
        "--yes",
      ],
      { cwd: repoRoot, reject: false },
    );

    expect(nonEmptyResult.exitCode).toBe(1);
    expect(nonEmptyResult.stderr).toContain("Target directory is not empty");
    expect(nonEmptyResult.stderr).toContain("Run `template --help` for usage.");
    expect(nonEmptyResult.stderr).not.toContain("Usage:");
    expect(await readFile(path.join(nonEmptyDir, "README.md"), "utf8")).toBe(
      "# existing\n",
    );
  });

  it("reviews the Project Blueprint and asks for confirmation in interactive terminals", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-interactive-"),
    );
    const projectDir = path.join(workspace, "demo-lib");
    const cliPath = path.join(repoRoot, "packages", "cli", "src", "cli.ts");

    const result = await execa(
      "bash",
      [
        "-lc",
        [
          "printf 'y\\n' |",
          "script -qfec",
          shellQuote(
            `node --conditions=source ${shellQuote(cliPath)} init ${shellQuote(projectDir)} --preset ts-lib`,
          ),
          "/dev/null",
        ].join(" "),
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain("Project Blueprint");
    expect(result.stdout).toMatch(/Preset:\s+ts-lib/);
    expect(result.stdout).toContain("Generate this project? [y/N]");
    expect(result.stdout).toContain("Initialized project");
    expect(result.stdout).toMatch(/Preset:\s+ts-lib/);
    expect(result.stdout).toContain(projectDir);
    await stat(path.join(projectDir, "package.json"));
  });

  it("cancels interactive init without writing files when confirmation is declined", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-interactive-"),
    );
    const projectDir = path.join(workspace, "demo-lib");
    const cliPath = path.join(repoRoot, "packages", "cli", "src", "cli.ts");

    await expectCommandFailure(
      execa(
        "bash",
        [
          "-lc",
          [
            "printf 'n\\n' |",
            "script -qfec",
            shellQuote(
              `node --conditions=source ${shellQuote(cliPath)} init ${shellQuote(projectDir)} --preset ts-lib`,
            ),
            "/dev/null",
          ].join(" "),
        ],
        { cwd: repoRoot },
      ),
      { stdout: /Generate this project\? \[y\/N\][\s\S]*Init cancelled/ },
    );

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a follow-up TODO.md after generation without installing dependencies", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-next-steps-"),
    );
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--yes",
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain("Initialized project");
    expect(result.stdout).toMatch(/Preset:\s+ts-lib/);
    expect(result.stdout).toContain(projectDir);
    expect(result.stdout).toContain(
      `Follow-up checklist written to ${path.join(projectDir, "TODO.md")}`,
    );
    expect(result.stdout).not.toContain("Next Step Instructions:");
    expect(result.stdout).not.toContain("pnpm install");
    await expect(
      readFile(path.join(projectDir, "TODO.md"), "utf8"),
    ).resolves.toBe(
      [
        "# TODO",
        "",
        "Generated follow-up tasks for this repository.",
        "",
        "### Next Steps",
        "- [ ] Install dependencies",
        "  `pnpm install`",
        "- [ ] Run Fix Command",
        "  `pnpm run fix`",
        "- [ ] Run Root Check",
        "  `pnpm run check`",
        "",
        "### Optional Git Setup",
        "- [ ] Initialize git",
        "  `git init`",
        "- [ ] Stage files",
        "  `git add .`",
        "- [ ] Create your first commit",
        '  `git commit -m "Initial commit"`',
        "",
        "### Done ✓",
        "",
      ].join("\n"),
    );
    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prints next steps instead of writing TODO.md when disabled", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-next-steps-"),
    );
    const projectDir = path.join(workspace, "demo-lib");

    const result = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--yes",
        "--no-todo",
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain("Initialized project");
    expect(result.stdout).toContain("Next Step Instructions:");
    expect(result.stdout).toContain(`cd ${projectDir}`);
    expect(result.stdout).toContain("pnpm install");
    expect(result.stdout).toContain("pnpm run fix");
    expect(result.stdout).toContain("pnpm run check");
    expect(result.stdout).toContain("git init");
    expect(result.stdout).not.toContain("Follow-up checklist written to");
    await expect(stat(path.join(projectDir, "TODO.md"))).rejects.toMatchObject({
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
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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

    expect(result.stdout).toContain(
      `Follow-up checklist written to ${path.join(projectDir, "TODO.md")}`,
    );
    await expect(
      readFile(path.join(projectDir, "TODO.md"), "utf8"),
    ).resolves.toMatch(/Run Fix Command\s+`pnpm run fix`/);
    await expect(readFile(commandLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses --scope for generated workspace package names", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-scope-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await execa(
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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
    expect(webPackageJson.dependencies).not.toHaveProperty("@custom-scope/api");
    expect(webApiClient).toContain("export async function getHealth");
    expect(webApiClient).not.toContain("@custom-scope/api");
    expect(webApiClient).not.toContain("hono/client");
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
      "node",
      [
        "--conditions=source",
        path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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
    expect(webPackageJson.dependencies).not.toHaveProperty("@custom-scope/api");
    expect(blueprint.packages).toEqual([
      { name: "@custom-scope/web", path: "apps/web" },
      { name: "@custom-scope/api", path: "apps/api" },
    ]);
  }, 120_000);

  it("rejects npm scopes with whitespace before writing files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-scope-"));
    const projectDir = path.join(workspace, "demo-fullstack");

    await expectCommandFailure(
      execa(
        "node",
        [
          "--conditions=source",
          path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
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
      { stderr: "--scope must be a valid npm scope without whitespace" },
    );

    await expect(stat(projectDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
