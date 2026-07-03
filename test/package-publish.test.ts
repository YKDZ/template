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

import { execa } from "execa";

import { assembleGenerationContext } from "../src/generation-context.js";
import type { PresetProjectionPlan } from "../src/preset-projection.js";
import {
  loadBuiltInPresetSourceManifest,
  type PresetSourceManifestPreset,
} from "../src/preset-source.js";
import {
  blueprintForPresetSourcePreset,
  projectPresetSourcePreset,
} from "../src/projection-capabilities.js";
import type { CopyFileOperation } from "../src/renderer.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const templatesRoot = path.join(repoRoot, "templates");

process.env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL ??= jsonDataUrl([
  { version: "v24.11.0", lts: "Krypton" },
  { version: "v26.1.0", lts: false },
]);
process.env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL ??= jsonDataUrl({
  versions: {
    "10.0.0": { engines: { node: ">=18.12" } },
  },
});

function jsonDataUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

const packageRootFiles = [
  ".npmignore",
  "LICENSE",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.build.json",
  "tsconfig.json",
];

const supportedPresetSourcePresets =
  loadBuiltInPresetSourceManifest().presets.filter(
    (preset) =>
      preset.generation === "supported" && preset.projection !== undefined,
  );

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
  const srcFiles = (await listFiles(path.join(repoRoot, "src")))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => relativeRepoPath(file));

  return [...srcFiles, "templates/preset-source.json"];
}

function projectionPlanFor(
  preset: PresetSourceManifestPreset,
): PresetProjectionPlan {
  const targetDir = path.join("/tmp", `generated-${preset.name}`);
  const blueprint = blueprintForPresetSourcePreset(preset, {
    targetDir,
    scope: "acme",
  });

  return projectPresetSourcePreset({
    preset,
    context: assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.0.0" },
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
      ...(plan.sourceRoots ?? {}),
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

function checkedGithubTemplateFiles(): string[] {
  return supportedPresetSourcePresets.flatMap((preset) => [
    `templates/${preset.name}/.github/dependabot.yml`,
    `templates/${preset.name}/.github/workflows/check.yml`,
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
      "templates/shared/editor-customization/capabilities.json",
      "templates/shared/oxc/tsconfig.json",
    ]),
  ].sort();
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
    .map((file) => `package/${file}`)
    .sort();
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
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      bin: Record<string, string>;
      dependencies?: Record<string, string>;
      license?: string;
      name: string;
      private: boolean;
      publishConfig?: { access?: string };
      repository?: { type?: string; url?: string };
    };

    expect(packageJson.name).toBe("@ykdz/template");
    expect(packageJson.private).toBe(false);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/YKDZ/template.git",
    });
    expect(packageJson.bin.template).toBe("dist/src/cli.js");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("execa");
    expect(packageJson.publishConfig?.access).toBe("public");
  });

  it("packs a tarball with the advertised CLI from a clean unbuilt checkout", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-pack-"));
    const packageDir = path.join(workspace, "package");
    const packDir = path.join(workspace, "pack");
    const consumerDir = path.join(workspace, "consumer");

    await copyCleanPackage(packageDir);
    await mkdir(packDir);
    await mkdir(consumerDir);

    await execa("pnpm", ["install", "--frozen-lockfile"], { cwd: packageDir });
    await execa("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: packageDir,
    });

    const packedFiles = await readdir(packDir);
    const tarball = packedFiles.find((file) => file.endsWith(".tgz"));
    expect(tarball).toBeDefined();

    const tarballPath = path.join(packDir, tarball!);
    const tarballContents = await execa("tar", ["-tf", tarballPath]);
    const packedPaths = tarballContents.stdout.split("\n");
    expect(packedPaths).toContain("package/dist/src/cli.js");
    expect(packedPaths).toContain("package/dist/src/devcontainer.js");
    expect(packedPaths).toContain("package/dist/src/generation-context.js");
    expect(packedPaths).toContain("package/dist/src/module-graph.js");
    expect(packedPaths).toContain("package/dist/src/next-step-instructions.js");
    expect(packedPaths).not.toContain("package/dist/post-commands.js");
    expect(packedPaths).toContain("package/templates/preset-source.json");
    expect(packedPaths).not.toContain("package/dist/templates/registry.js");
    expect(packedPaths).not.toContain(
      "package/dist/templates/projection-plans.js",
    );
    expect(packedPaths).not.toContain("package/dist/src/preset-registry.js");
    expect(packedPaths).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^package\/dist\/templates\/.+\.js$/),
      ]),
    );
    expect(packedPaths).toContain("package/dist/src/toolchain-resolution.js");
    expect(packedPaths).toContain("package/LICENSE");
    expect(packedPaths).toContain("package/pnpm-workspace.yaml");
    expect(packedPaths).toContain("package/README.md");
    expect(
      packedPaths.filter((packedPath) => packedPath.endsWith(".map")),
    ).toEqual([]);
    expect(packedPaths).not.toContain("package/templates/registry.ts");
    expect(packedPaths).not.toContain("package/templates/projection-plans.ts");
    expect(packedPaths).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^package\/templates\/[^/]+\/projection\.ts$/),
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
          "package/templates/shared/devcontainer/browser-test.Dockerfile",
          "package/templates/shared/devcontainer/node-pnpm.Dockerfile",
          "package/templates/shared/devcontainer/rust.Dockerfile",
          "package/templates/rust-bin/src/main.rs",
          "package/templates/shared/oxc/node/oxlint.config.ts",
          "package/templates/shared/oxc/vue/oxlint.config.ts",
          "package/templates/shared/oxc/oxfmt.config.ts",
        ]),
      );
      expect(packedPaths).not.toContain(
        `package/templates/${path.basename(localTemplateArtifact)}`,
      );
      expect(packedPaths).not.toEqual(
        expect.arrayContaining([expect.stringContaining("/node_modules/")]),
      );
    } finally {
      await rm(localTemplateArtifact, { force: true });
    }
    expect(packedPaths).not.toContain(
      "package/templates/shared/oxc/oxc-config-modules.d.ts",
    );
    expect(packedPaths).not.toContain(
      "package/templates/shared/oxc/package.json",
    );
    expect(packedPaths).not.toContain(
      "package/templates/shared/oxc/tsconfig.json",
    );

    await writeFile(
      path.join(consumerDir, "package.json"),
      `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    );
    await execa("pnpm", ["add", tarballPath], { cwd: consumerDir });

    const result = await execa("pnpm", ["exec", "template", "--help"], {
      cwd: consumerDir,
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
        { cwd: consumerDir },
      );
      const copiedTemplateSource = await readFile(
        path.join(generatedDir, copyOperation.to),
        "utf8",
      );
      expect(copiedTemplateSource.length).toBeGreaterThan(0);
    }

    const templateBin = path.join(consumerDir, "node_modules/.bin/template");
    const generatedWorkspaceDir = path.join(consumerDir, "generated-workspace");
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
      { cwd: consumerDir },
    );
    await execa(
      templateBin,
      ["add", "package", "--preset", "ts-lib", "--name", "shared"],
      {
        cwd: generatedWorkspaceDir,
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
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      bin: Record<string, string>;
    };
    expect(packageJson.bin.template).toBe("dist/src/cli.js");
  });
});
