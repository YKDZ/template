import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "../../src/declarations.js";
import {
  collectGeneratedManifestCatalogDependencies,
  renderGeneratedPnpmWorkspaceYaml,
} from "../../src/dependency-catalog.js";
import {
  dockerfileFirstRustPnpmDevcontainer,
  nodePnpmToolLayer,
  rustToolLayer,
} from "../../src/devcontainer.js";
import { editorCustomizationForCapabilities } from "../../src/editor-customization.js";
import type { GenerationContext } from "../../src/generation-context.js";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "../../src/module-graph.js";
import type {
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "../../src/preset-projection.js";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
  type DependencyMaintenancePolicy,
} from "../../src/project-github.js";
import { renderNewProject, type RenderOperation } from "../../src/renderer.js";

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset rust-bin",
};

export const rustBinPresetMetadata: BuiltInPreset = {
  name: "rust-bin",
  title: "Rust binary",
  description:
    "Rust native binary workspace with rustfmt, clippy, and cargo tests.",
  generation: "supported",
  supportedPackageManagers: ["pnpm"],
  supportedProjectKinds: ["multi-package"],
  features: [
    "root-check",
    "fix-command",
    "devcontainer",
    "github-actions",
    "dependabot",
    "rustfmt-clippy",
    "cargo-test",
  ],
};

const rustPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const rustWorkspacePackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "packages/*",
};

function cargoPackageNameFromProjectName(projectName: string): string {
  const slug = projectName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "rust-bin";
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function rustWorkspacePackageName(projectName: string): string {
  return `${cargoPackageNameFromProjectName(projectName)}-native`;
}

function rustWorkspacePackagePath(projectName: string): string {
  return `packages/${cargoPackageNameFromProjectName(projectName)}`;
}

function rustDependencyMaintenancePolicy(
  projectName: string,
): DependencyMaintenancePolicy {
  return {
    ecosystems: ["npm", "cargo", "github-actions", "docker", "rust-toolchain"],
    directories: {
      cargo: `/${rustWorkspacePackagePath(projectName)}`,
    },
    interval: "weekly",
  };
}

export function planRustBinChecks(): CheckPlan {
  return {
    components: [
      { kind: "rustfmt-check", owner: rustPackageBoundary },
      { kind: "cargo-clippy", owner: rustPackageBoundary },
      { kind: "cargo-test", owner: rustPackageBoundary },
    ],
    environmentNeeds: [],
  };
}

function planRustBinRootChecks(): CheckPlan {
  return {
    components: [
      { kind: "turbo-package-check", owner: rustWorkspacePackageBoundary },
    ],
    environmentNeeds: [],
  };
}

export function planRustBinFixes(): FixPlan {
  return {
    components: [{ kind: "rustfmt-write", owner: rustPackageBoundary }],
  };
}

function planRustBinRootFixes(): FixPlan {
  return {
    components: [
      { kind: "turbo-package-fix", owner: rustWorkspacePackageBoundary },
    ],
  };
}

export function rustBinBlueprint(
  options: PresetBlueprintOptions = { targetDir: process.cwd() },
): ProjectBlueprint {
  const projectName = projectNameFromDir(options.targetDir);

  return {
    schemaVersion: 1,
    preset: "rust-bin",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...rustBinPresetMetadata.features],
    packages: [
      {
        name: rustWorkspacePackageName(projectName),
        path: rustWorkspacePackagePath(projectName),
      },
    ],
  };
}

export function projectRustBinPackageScripts(): Record<string, string> {
  return {
    check: renderRootCheckCommand(planRustBinChecks()),
    fix: renderFixCommand(planRustBinFixes()),
  };
}

function projectRustBinRootPackageScripts(): Record<string, string> {
  return {
    check: renderRootCheckCommand(planRustBinRootChecks()),
    fix: renderFixCommand(planRustBinRootFixes()),
  };
}

function cargoToml(projectName: string): string {
  return [
    "[package]",
    `name = "${projectName}"`,
    'version = "0.1.0"',
    'edition = "2024"',
    "",
    "[dependencies]",
    "",
    "[lints]",
    "workspace = true",
    "",
    "[workspace]",
    'members = ["."]',
    'resolver = "3"',
    "",
    "[workspace.lints.rust]",
    'unsafe_code = "forbid"',
    "",
    "[workspace.lints.clippy]",
    'all = "deny"',
    'pedantic = "deny"',
    'nursery = "deny"',
    "",
    "[profile.release]",
    'strip = "symbols"',
    'lto = "thin"',
    "codegen-units = 1",
    "",
  ].join("\n");
}

function cargoLock(projectName: string): string {
  return [
    "# This file is automatically @generated by Cargo.",
    "# It is not intended for manual editing.",
    "version = 4",
    "",
    "[[package]]",
    `name = "${projectName}"`,
    'version = "0.1.0"',
    "",
  ].join("\n");
}

function rustToolchainToml(toolchain: string): string {
  return [
    "[toolchain]",
    `channel = "${toolchain}"`,
    'components = ["rustfmt", "clippy"]',
    "",
  ].join("\n");
}

function packageJson(
  context: GenerationContext,
  projectName: string,
  packageScripts: Record<string, string>,
): Record<string, unknown> {
  return {
    name: projectName,
    version: "0.0.0",
    private: true,
    scripts: packageScripts,
    devDependencies: {
      turbo: "catalog:",
    },
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
    packageManager: context.toolchain.packageManagerPin.value,
  };
}

function rustWorkspacePackageJson(
  context: GenerationContext,
  projectName: string,
): Record<string, unknown> {
  return {
    name: rustWorkspacePackageName(projectName),
    version: "0.0.0",
    private: true,
    scripts: projectRustBinPackageScripts(),
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
  };
}

function generationRecord(context: GenerationContext): Record<string, unknown> {
  return {
    ...generatedBy,
    toolchain: {
      nodeLtsMajor: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
      source: context.toolchain.source,
    },
  };
}

function operationsForRustBin(
  context: GenerationContext,
  projectName: string,
  packageScripts: Record<string, string>,
  checkPlan: CheckPlan,
): RenderOperation[] {
  const editorCustomization = editorCustomizationForCapabilities([
    "rust-tooling",
  ]);
  const rustLayer = rustToolLayer();
  const developmentContainer = dockerfileFirstRustPnpmDevcontainer({
    name: projectName,
    nodeLayer: nodePnpmToolLayer({
      nodeVersion: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
    }),
    rustLayer,
    extensions: editorCustomization.extensions,
    settings: editorCustomization.settings,
  });
  const workspacePackagePath = rustWorkspacePackagePath(projectName);
  const rootManifest = packageJson(context, projectName, packageScripts);
  const packageManifest = rustWorkspacePackageJson(context, projectName);
  const dependencyMaintenancePolicy =
    rustDependencyMaintenancePolicy(projectName);

  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: rootManifest,
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: renderGeneratedPnpmWorkspaceYaml({
        packages: ["packages/*"],
        dependencies: collectGeneratedManifestCatalogDependencies([
          rootManifest,
          packageManifest,
        ]),
      }),
    },
    {
      kind: "writeJson",
      to: "turbo.json",
      value: {
        tasks: {
          check: {},
          fix: {
            cache: false,
          },
        },
      },
    },
    {
      kind: "writeJson",
      to: `${workspacePackagePath}/package.json`,
      value: packageManifest,
    },
    {
      kind: "writeText",
      to: `${workspacePackagePath}/Cargo.toml`,
      text: cargoToml(projectName),
    },
    {
      kind: "writeText",
      to: `${workspacePackagePath}/Cargo.lock`,
      text: cargoLock(projectName),
    },
    {
      kind: "writeText",
      to: `${workspacePackagePath}/rustfmt.toml`,
      text: ['edition = "2024"', "max_width = 100", ""].join("\n"),
    },
    {
      kind: "writeText",
      to: "rust-toolchain.toml",
      text: rustToolchainToml(rustLayer.toolchain),
    },
    {
      kind: "writeText",
      to: ".gitignore",
      text: ["target", ".env", ".template/", ".pnpm-store/", ""].join("\n"),
    },
    {
      kind: "copyFile",
      from: "src/main.rs",
      to: `${workspacePackagePath}/src/main.rs`,
    },
    {
      kind: "writeJson",
      to: ".template/blueprint.json",
      value: context.blueprint,
    },
    {
      kind: "writeJson",
      to: ".template/generated-by.json",
      value: generationRecord(context),
    },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: developmentContainer.devcontainer,
    },
    {
      kind: "writeText",
      to: ".devcontainer/Dockerfile",
      text: developmentContainer.dockerfile,
    },
    {
      kind: "writeJson",
      to: ".vscode/extensions.json",
      value: {
        recommendations: editorCustomization.extensions,
      },
    },
    {
      kind: "writeJson",
      to: ".vscode/settings.json",
      value: editorCustomization.settings,
    },
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectCheckWorkflow({
        checkPlan,
        environmentPreparation: { rustToolchain: true },
      }),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectDependabotConfig(dependencyMaintenancePolicy),
    },
  ];
}

function templateSourceRoot(): string {
  const projectionDir = path.dirname(fileURLToPath(import.meta.url));
  const publishedTemplateRoot = path.join(
    projectionDir,
    "..",
    "..",
    "..",
    "templates",
    "rust-bin",
  );

  return existsSync(path.join(publishedTemplateRoot, "src", "main.rs"))
    ? publishedTemplateRoot
    : projectionDir;
}

export const rustBinPresetProjection: PresetProjection = {
  metadata: rustBinPresetMetadata,
  blueprint: rustBinBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planRustBinRootChecks();
    const fixPlan = planRustBinRootFixes();
    const packageScripts = projectRustBinRootPackageScripts();
    const projectName = cargoPackageNameFromProjectName(
      context.projectName.value,
    );
    const dependencyMaintenancePolicy =
      rustDependencyMaintenancePolicy(projectName);

    return {
      sourceRoot: templateSourceRoot(),
      operations: operationsForRustBin(
        context,
        projectName,
        packageScripts,
        checkPlan,
      ),
      checkPlan,
      fixPlan,
      dependencyMaintenancePolicy,
      packageScripts,
      capabilities: {
        rootCheck: true,
        fixCommand: true,
        githubActions: true,
        dependabot: true,
        devcontainer: true,
      },
    };
  },
  async render({ targetDir, plan }): Promise<void> {
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
  },
};
