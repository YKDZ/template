import {
  cp,
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

import {
  loadBuiltInPresetSourceManifest,
  projectBuiltInPresetSourcePreset,
  type PresetSourceManifestPreset,
} from "@ykdz/template-builtin-source";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import type { PresetProjectionPlan } from "@ykdz/template-core/preset-projection";
import { blueprintForPresetSourcePreset } from "@ykdz/template-core/projection-capabilities";
import type { CopyFileOperation } from "@ykdz/template-core/renderer";
import { execa } from "execa";
import * as v from "valibot";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const templatesRoot = path.join(
  repoRoot,
  "packages",
  "builtin-source",
  "templates",
);
const packageJsonBinSchema = v.object({
  bin: v.record(v.string(), v.string()),
});
const cliPackageJsonSchema = v.object({
  bin: v.record(v.string(), v.string()),
  bundleDependencies: v.optional(v.array(v.string())),
  dependencies: v.optional(v.record(v.string(), v.string())),
  files: v.array(v.string()),
  license: v.optional(v.string()),
  name: v.string(),
  private: v.boolean(),
  publishConfig: v.optional(v.object({ access: v.optional(v.string()) })),
  repository: v.optional(
    v.object({ type: v.optional(v.string()), url: v.optional(v.string()) }),
  ),
});
const builtinSourcePackageJsonSchema = v.object({
  files: v.array(v.string()),
  name: v.string(),
  private: v.boolean(),
});
const runtimePackageJsonSchema = v.object({
  files: v.array(v.string()),
  name: v.string(),
  private: v.boolean(),
});
const packDryRunFileSchema = v.object({ path: v.string() });
const packDryRunSchema = v.object({
  files: v.array(packDryRunFileSchema),
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

process.env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL ??= jsonDataUrl([
  { version: "v24.11.0", lts: "Krypton" },
  { version: "v26.1.0", lts: false },
]);
process.env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL ??= jsonDataUrl({
  versions: {
    "10.34.4": { engines: { node: ">=18.12" } },
  },
});

function jsonDataUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

const packageRootFiles = [
  "Cargo.lock",
  "Cargo.toml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "packages/cli/package.json",
  "packages/cli/tsconfig.build.json",
  "packages/cli/tsconfig.json",
  "packages/core/package.json",
  "packages/core/tsconfig.build.json",
  "packages/core/tsconfig.json",
  "packages/shared/package.json",
  "packages/shared/tsconfig.build.json",
  "packages/shared/tsconfig.json",
  "packages/builtin-source/package.json",
  "packages/builtin-source/tsconfig.build.json",
  "packages/builtin-source/tsconfig.json",
];

const supportedPresetSourcePresets =
  loadBuiltInPresetSourceManifest().presets.filter(
    (preset) =>
      preset.generation === "supported" && preset.projection !== undefined,
  );
const packagePublishIntegrationTimeoutMs = 180_000;
const presetSourceTestPattern =
  /^packages\/builtin-source\/templates\/[^/]+\/behavior\.test\.ts$/;
const packedPresetSourceTestPattern =
  /^package\/node_modules\/@ykdz\/template-builtin-source\/templates\/[^/]+\/behavior\.test\.ts$/;
const publishedPackageRuntimeEnv = {
  NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "")
    .replaceAll(/(?:^|\s)--conditions=source(?=\s|$)/g, " ")
    .trim(),
};

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function runtimeSourceFiles(): Promise<string[]> {
  const packageSourceFiles = (
    await Promise.all([
      listFiles(path.join(repoRoot, "packages/cli/src")),
      listFiles(path.join(repoRoot, "packages/core/src")),
      listFiles(path.join(repoRoot, "packages/shared/src")),
      listFiles(path.join(repoRoot, "packages/builtin-source/src")),
      listFiles(path.join(repoRoot, "packages/builtin-source/templates")),
    ])
  )
    .flat()
    .filter((file) => file.endsWith(".ts"))
    .map((file) => relativeRepoPath(file));

  return [
    ...packageSourceFiles.filter((file) => !presetSourceTestPattern.test(file)),
    "packages/builtin-source/templates/preset-source.json",
  ];
}

function projectionPlanFor(
  preset: PresetSourceManifestPreset,
): PresetProjectionPlan {
  const targetDir = path.join("/tmp", `generated-${preset.name}`);
  const blueprint = blueprintForPresetSourcePreset(preset, {
    targetDir,
    scope: "acme",
  });

  return projectBuiltInPresetSourcePreset({
    preset,
    context: assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.34.4" },
        source: "bundled-fallback",
        diagnostics: [],
      },
    }),
  });
}

function projectionTemplateSourceFiles(): string[] {
  const files = new Set<string>();

  for (const preset of supportedPresetSourcePresets) {
    const plan = projectionPlanFor(preset);
    const sourceRoots: Record<string, string> = {
      ...plan.sourceRoots,
      default: plan.sourceRoot,
    };

    for (const operation of plan.operations) {
      if (operation.kind === "writeTextFromFragments") {
        for (const fragment of operation.fragments) {
          const root = fragment.sourceRoot
            ? sourceRoots[fragment.sourceRoot]
            : sourceRoots.default;

          if (!root) {
            throw new Error(
              `Missing sourceRoot ${fragment.sourceRoot} for ${preset.name}`,
            );
          }

          files.add(relativeRepoPath(path.join(root, fragment.from)));
        }

        continue;
      }

      if (operation.kind === "writeTextTemplate") {
        const root = operation.sourceRoot
          ? sourceRoots[operation.sourceRoot]
          : sourceRoots.default;

        if (!root) {
          throw new Error(
            `Missing sourceRoot ${operation.sourceRoot} for ${preset.name}`,
          );
        }

        files.add(relativeRepoPath(path.join(root, operation.from)));
        continue;
      }

      if (operation.kind === "copyFile") {
        const root = operation.sourceRoot
          ? sourceRoots[operation.sourceRoot]
          : sourceRoots.default;

        if (!root) {
          throw new Error(
            `Missing sourceRoot ${operation.sourceRoot} for ${preset.name}`,
          );
        }

        files.add(relativeRepoPath(path.join(root, operation.from)));
      }
    }
  }

  return [...files];
}

function projectionOperationSourceFiles(
  preset: PresetSourceManifestPreset,
): string[] {
  const files = new Set<string>();
  const plan = projectionPlanFor(preset);
  const sourceRoots: Record<string, string> = {
    ...plan.sourceRoots,
    default: plan.sourceRoot,
  };

  function sourceFileFor(from: string, sourceRootName: string | undefined) {
    const root =
      sourceRootName === undefined
        ? sourceRoots.default
        : sourceRoots[sourceRootName];

    if (!root) {
      throw new Error(
        `Missing sourceRoot ${sourceRootName} for ${preset.name}`,
      );
    }

    files.add(relativeRepoPath(path.join(root, from)));
  }

  for (const operation of plan.operations) {
    if (operation.kind === "writeTextFromFragments") {
      for (const fragment of operation.fragments) {
        sourceFileFor(fragment.from, fragment.sourceRoot);
      }
      continue;
    }

    if (operation.kind === "writeTextTemplate") {
      sourceFileFor(operation.from, operation.sourceRoot);
      continue;
    }

    if (operation.kind === "copyFile") {
      sourceFileFor(operation.from, operation.sourceRoot);
    }
  }

  return [...files].toSorted();
}

function checkedGithubTemplateFiles(): string[] {
  return supportedPresetSourcePresets.flatMap((preset) => [
    `packages/builtin-source/templates/${preset.name}/.github/dependabot.yml`,
    `packages/builtin-source/templates/${preset.name}/.github/workflows/check.yml`,
  ]);
}

async function manifestReferencedTemplateFiles(): Promise<string[]> {
  const manifest = loadBuiltInPresetSourceManifest();
  const files = new Set<string>();

  async function addReference(referencePath: string): Promise<void> {
    const absolutePath = path.join(templatesRoot, referencePath);
    const stats = await stat(absolutePath);

    if (stats.isDirectory()) {
      for (const file of await listFiles(absolutePath)) {
        files.add(relativeRepoPath(file));
      }
      return;
    }

    if (stats.isFile()) {
      files.add(relativeRepoPath(absolutePath));
    }
  }

  for (const resource of manifest.sharedResources) {
    await addReference(resource.path);
  }

  for (const preset of manifest.presets) {
    for (const root of preset.source?.roots ?? []) {
      await addReference(root);
    }

    for (const file of preset.source?.files ?? []) {
      await addReference(file);
    }
  }

  return [...files];
}

async function packageFiles(): Promise<string[]> {
  return [
    ...new Set([
      ...packageRootFiles,
      ...(await runtimeSourceFiles()),
      ...projectionTemplateSourceFiles(),
      ...checkedGithubTemplateFiles(),
      ...(await manifestReferencedTemplateFiles()),
      "packages/builtin-source/templates/shared/editor-customization/capabilities.json",
      "packages/builtin-source/templates/shared/oxc/tsconfig.json",
    ]),
  ].toSorted();
}

function relativeRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function copyCleanPackage(targetDir: string): Promise<void> {
  for (const file of await packageFiles()) {
    const from = path.join(repoRoot, file);
    const to = path.join(targetDir, file);

    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
}

async function checkedTemplatePackagePaths(): Promise<string[]> {
  return [
    ...new Set([
      ...projectionTemplateSourceFiles(),
      ...checkedGithubTemplateFiles(),
      ...(await manifestReferencedTemplateFiles()),
    ]),
  ]
    .map((file) =>
      file.replace(
        "packages/builtin-source/",
        "package/node_modules/@ykdz/template-builtin-source/",
      ),
    )
    .toSorted();
}

function firstCopyOperation(
  preset: PresetSourceManifestPreset,
): CopyFileOperation {
  const operation = projectionPlanFor(preset).operations.find(
    (candidate) => candidate.kind === "copyFile",
  );

  if (!operation) {
    throw new Error(
      `Preset Projection ${preset.name} does not copy template source`,
    );
  }

  return operation;
}

describe("package publishing", () => {
  it("declares public npm metadata for the template CLI", async () => {
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "packages/cli/package.json"),
      cliPackageJsonSchema,
    );

    expect(packageJson.name).toBe("@ykdz/template");
    expect(packageJson.private).toBe(false);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/YKDZ/template.git",
    });
    expect(packageJson.bin.template).toBe("dist/cli.js");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("execa");
    expect(packageJson.publishConfig?.access).toBe("public");
  });

  it("bundles private runtime workspaces required by generation", async () => {
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "packages/cli/package.json"),
      cliPackageJsonSchema,
    );
    const privateRuntimeWorkspaces = [
      "@ykdz/template-shared",
      "@ykdz/template-core",
      "@ykdz/template-builtin-source",
    ];

    expect(packageJson.dependencies).toMatchObject(
      Object.fromEntries(
        privateRuntimeWorkspaces.map((workspace) => [workspace, "workspace:*"]),
      ),
    );
    expect(packageJson.bundleDependencies).toEqual(
      expect.arrayContaining(privateRuntimeWorkspaces),
    );
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "node_modules/@ykdz/template-shared",
        "node_modules/@ykdz/template-core",
        "node_modules/@ykdz/template-builtin-source",
      ]),
    );
  });

  it("declares a narrow package surface for bundled runtime packages", async () => {
    const builtinSourcePackageJson = await readJsonWithSchema(
      path.join(repoRoot, "packages/builtin-source/package.json"),
      builtinSourcePackageJsonSchema,
    );
    const sharedPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "packages/shared/package.json"),
      runtimePackageJsonSchema,
    );

    expect(builtinSourcePackageJson.name).toBe("@ykdz/template-builtin-source");
    expect(builtinSourcePackageJson.private).toBe(true);
    expect(builtinSourcePackageJson.files).toEqual(
      expect.arrayContaining(["templates", "!templates/*/behavior.test.ts"]),
    );
    expect(sharedPackageJson.name).toBe("@ykdz/template-shared");
    expect(sharedPackageJson.private).toBe(true);
    expect(sharedPackageJson.files).toEqual(["dist"]);
  });

  it("does not treat Preset Source behavior tests as packable template source", async () => {
    expect(await packageFiles()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(presetSourceTestPattern)]),
    );
    expect(await checkedTemplatePackagePaths()).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(packedPresetSourceTestPattern),
      ]),
    );

    const result = await execa(
      "pnpm",
      [
        "--filter",
        "@ykdz/template-builtin-source",
        "pack",
        "--dry-run",
        "--json",
      ],
      { cwd: repoRoot },
    );
    const dryRun = v.parse(
      packDryRunSchema,
      JSON.parse(result.stdout) as unknown,
    );
    expect(dryRun.files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^templates\/[^/]+\/behavior\.test\.ts$/),
      ]),
    );
  });

  it("does not copy Preset Source behavior tests into generated repositories", () => {
    for (const preset of supportedPresetSourcePresets) {
      expect(projectionOperationSourceFiles(preset)).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(presetSourceTestPattern),
        ]),
      );
    }
  });

  it(
    "packs a tarball with the advertised CLI from a clean unbuilt checkout",
    async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "template-pack-"));
      const packageDir = path.join(workspace, "package");
      const packDir = path.join(workspace, "pack");
      const consumerDir = path.join(workspace, "consumer");

      await copyCleanPackage(packageDir);
      await mkdir(packDir);
      await mkdir(consumerDir);
      await mkdir(path.join(packageDir, "packages/shared/.turbo/logs"), {
        recursive: true,
      });
      await writeFile(
        path.join(packageDir, "packages/shared/.turbo/logs/build.log"),
        "local turbo log\n",
      );

      await execa("pnpm", ["install", "--frozen-lockfile"], {
        cwd: packageDir,
      });
      await execa("pnpm", ["pack", "--pack-destination", packDir], {
        cwd: path.join(packageDir, "packages/cli"),
      });

      const packedFiles = await readdir(packDir);
      const tarball = packedFiles.find((file) => file.endsWith(".tgz"));
      expect(tarball).toBeDefined();

      const tarballPath = path.join(packDir, tarball!);
      const tarballContents = await execa("tar", ["-tf", tarballPath]);
      const packedPaths = tarballContents.stdout.split("\n");
      expect(packedPaths).toContain("package/dist/cli.js");
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-core/dist/devcontainer.js",
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-shared/dist/index.js",
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-shared/dist/index.d.ts",
      );
      expect(packedPaths).not.toEqual(
        expect.arrayContaining([
          "package/node_modules/@ykdz/template-shared/src/index.ts",
          "package/node_modules/@ykdz/template-shared/tsconfig.build.json",
          "package/node_modules/@ykdz/template-shared/tsconfig.json",
          "package/node_modules/@ykdz/template-shared/.turbo/logs/build.log",
        ]),
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-core/dist/generation-context.js",
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-core/dist/module-graph.js",
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-core/dist/next-step-instructions.js",
      );
      expect(packedPaths).not.toContain("package/dist/post-commands.js");
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-builtin-source/templates/preset-source.json",
      );
      expect(packedPaths).not.toContain("package/templates/preset-source.json");
      expect(packedPaths).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^package\/templates\/.+/),
        ]),
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-core/dist/toolchain-resolution.js",
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-core/dist/Cargo.toml",
      );
      expect(packedPaths).toContain(
        "package/node_modules/@ykdz/template-core/dist/Cargo.lock",
      );
      expect(
        packedPaths.filter((packedPath) => packedPath.endsWith(".map")),
      ).toEqual([]);
      expect(packedPaths).not.toContain(
        "package/node_modules/@ykdz/template-builtin-source/templates/registry.ts",
      );
      expect(packedPaths).not.toContain(
        "package/node_modules/@ykdz/template-builtin-source/templates/projection-plans.ts",
      );
      expect(packedPaths).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^package\/node_modules\/@ykdz\/template-builtin-source\/templates\/[^/]+\/projection\.ts$/,
          ),
        ]),
      );
      expect(packedPaths).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(packedPresetSourceTestPattern),
        ]),
      );
      const localTemplateArtifact = path.join(
        templatesRoot,
        `.package-publish-artifact-${process.pid}.tmp`,
      );
      await writeFile(localTemplateArtifact, "not checked template source\n");
      try {
        expect(packedPaths).toEqual(
          expect.arrayContaining(await checkedTemplatePackagePaths()),
        );
        expect(packedPaths).toEqual(
          expect.arrayContaining([
            "package/node_modules/@ykdz/template-builtin-source/templates/shared/devcontainer/browser-test.Dockerfile",
            "package/node_modules/@ykdz/template-builtin-source/templates/shared/devcontainer/node-pnpm.Dockerfile",
            "package/node_modules/@ykdz/template-builtin-source/templates/shared/devcontainer/rust.Dockerfile",
            "package/node_modules/@ykdz/template-builtin-source/templates/rust-bin/src/main.rs",
            "package/node_modules/@ykdz/template-builtin-source/templates/shared/oxc/node/oxlint.config.ts",
            "package/node_modules/@ykdz/template-builtin-source/templates/shared/oxc/vue/oxlint.config.ts",
            "package/node_modules/@ykdz/template-builtin-source/templates/shared/oxc/oxfmt.config.ts",
          ]),
        );
        expect(packedPaths).not.toContain(
          `package/node_modules/@ykdz/template-builtin-source/templates/${path.basename(
            localTemplateArtifact,
          )}`,
        );
      } finally {
        await rm(localTemplateArtifact, { force: true });
      }
      expect(packedPaths).not.toContain(
        "package/node_modules/@ykdz/template-builtin-source/templates/shared/oxc/oxc-config-modules.d.ts",
      );
      expect(packedPaths).not.toContain(
        "package/node_modules/@ykdz/template-builtin-source/templates/shared/oxc/package.json",
      );
      expect(packedPaths).not.toContain(
        "package/node_modules/@ykdz/template-builtin-source/templates/shared/oxc/tsconfig.json",
      );

      await writeFile(
        path.join(consumerDir, "package.json"),
        `${JSON.stringify({ type: "module" }, null, 2)}\n`,
      );
      await execa("pnpm", ["add", tarballPath], { cwd: consumerDir });

      const result = await execa("pnpm", ["exec", "template", "--help"], {
        cwd: consumerDir,
        env: publishedPackageRuntimeEnv,
      });
      expect(result.stdout).toContain("Usage:");

      for (const preset of supportedPresetSourcePresets) {
        const presetName = preset.name;
        const generatedDir = path.join(consumerDir, `generated-${presetName}`);
        const copyOperation = firstCopyOperation(preset);

        await execa(
          "pnpm",
          [
            "exec",
            "template",
            "init",
            generatedDir,
            "--preset",
            presetName,
            "--yes",
          ],
          { cwd: consumerDir, env: publishedPackageRuntimeEnv },
        );
        const copiedTemplateSource = await readFile(
          path.join(generatedDir, copyOperation.to),
          "utf8",
        );
        expect(copiedTemplateSource.length).toBeGreaterThan(0);
      }

      const templateBin = path.join(consumerDir, "node_modules/.bin/template");
      const generatedWorkspaceDir = path.join(
        consumerDir,
        "generated-workspace",
      );
      await execa(
        "pnpm",
        [
          "exec",
          "template",
          "init",
          generatedWorkspaceDir,
          "--preset",
          "vue-hono-app",
          "--yes",
        ],
        { cwd: consumerDir, env: publishedPackageRuntimeEnv },
      );
      await execa(
        templateBin,
        ["add", "package", "--preset", "ts-lib", "--name", "shared"],
        {
          cwd: generatedWorkspaceDir,
          env: publishedPackageRuntimeEnv,
        },
      );
      await expect(
        readFile(
          path.join(generatedWorkspaceDir, "packages/shared/src/index.ts"),
          "utf8",
        ),
      ).resolves.toContain("export function greet");

      const packageJsonPath = path.join(
        consumerDir,
        "node_modules/@ykdz/template/package.json",
      );
      const packageJson = await readJsonWithSchema(
        packageJsonPath,
        packageJsonBinSchema,
      );
      expect(packageJson.bin.template).toBe("dist/cli.js");
    },
    packagePublishIntegrationTimeoutMs,
  );
});
