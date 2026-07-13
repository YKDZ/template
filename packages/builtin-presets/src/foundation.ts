import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-core/dependency-catalog";
import { browserTestToolLayer } from "@ykdz/template-core/devcontainer";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
  type EditorCustomizationCapability,
} from "@ykdz/template-core/editor-customization";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
} from "@ykdz/template-core/module-graph";
import {
  dockerEngineEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
  renderDeploymentCheckCommand,
  renderFixCommand,
  renderRootCheckCommand,
  rustToolchainEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@ykdz/template-core/module-graph";
import {
  assertPackageContribution,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "@ykdz/template-core/preset-definition";
import {
  assertProjectBlueprintV2,
  validateProjectBlueprintV2 as validateCoreProjectBlueprintV2,
  type ProjectBlueprintV2,
} from "@ykdz/template-core/project-blueprint-v2";
import type {
  DependencyEcosystem,
  DependencyMaintenancePolicy,
} from "@ykdz/template-core/project-github";
import {
  projectCheckWorkflowTemplateReplacements,
  projectDependabotTemplateReplacements,
} from "@ykdz/template-core/project-github";
import { planExplicitProjectLinks } from "@ykdz/template-core/project-linking-v2";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";

import { rustBinDefinition } from "./rust-bin/definition.ts";
import { vuePnpmDependencyOverrides } from "./shared/vue.ts";
import { templateSources } from "./template-sources.ts";
import { tsLibDefinition } from "./ts-lib/definition.ts";
import { vikeAppDefinition } from "./vike-app/definition.ts";
import { vueAppDefinition } from "./vue-app/definition.ts";
import { vueHonoAppDefinition } from "./vue-hono-app/definition.ts";

export type {
  PackageDefinition,
  PackageLinkIntent,
  PackageRole,
  ProjectBlueprintV2,
} from "@ykdz/template-core/project-blueprint-v2";
export type { PackageContribution } from "@ykdz/template-core/package-contribution";

export type BuiltInGenerationContext = GenerationContext;
export type { BuiltInPresetDefinition } from "@ykdz/template-core/preset-definition";

export type NextStepInstruction = {
  readonly display: string;
};

export type GeneratedRepositoryPlan = {
  readonly definitionName: string;
  readonly plannerSourceFile: string;
  readonly planningContribution: "planInitialization" | "planPackageAddition";
  readonly blueprint: ProjectBlueprintV2;
  readonly generationRecord: {
    readonly preset: string;
    readonly templateVersion: "0.0.0";
    readonly toolchain: BuiltInGenerationContext["toolchain"];
  };
  readonly operations: readonly RenderOperation[];
  readonly environmentNeeds: readonly CheckEnvironmentNeed[];
  readonly deploymentEnvironmentNeeds: readonly DeploymentEnvironmentNeed[];
  /** Structured manifests used to derive the generated Dependency Catalog. */
  readonly manifests: readonly Readonly<Record<string, unknown>>[];
  readonly dependencyCatalog: Readonly<Record<string, string>>;
  readonly dependencyMaintenancePolicy: DependencyMaintenancePolicy;
  readonly nextStepInstructions: readonly NextStepInstruction[];
};

/** One independently checkable initial Package Contribution and its real plan. */
export type BuiltInPresetTemplateSourceCheckContext = {
  readonly definition: BuiltInPresetDefinition;
  readonly contribution: PackageContribution;
  readonly plan: GeneratedRepositoryPlan;
};

/**
 * The Foundation persists the non-rendering half of every Package
 * Contribution with the Generated Repository.  Package Addition cannot infer
 * fix, deployment, or maintenance semantics from a package name (or
 * from a lossy subset of scripts), so this is the durable topology it reads.
 */
/** Resolve an owned source handle for diagnostics and source checks. */
export function resolveBuiltInTemplateSource(
  source: TemplateSourceHandle,
  relativePath: string,
): string {
  return resolveTemplateSource(source, relativePath);
}

export function validateProjectBlueprintV2(value: unknown) {
  return validateCoreProjectBlueprintV2(value);
}

class PresetRegistry {
  readonly #definitions: readonly BuiltInPresetDefinition[];
  constructor(definitions: readonly BuiltInPresetDefinition[]) {
    const names = definitions.map((definition) => definition.metadata.name);
    if (
      names.some((name) => name.length === 0) ||
      new Set(names).size !== names.length
    ) {
      throw new Error(
        "Preset Registry requires unique non-empty Definition names",
      );
    }
    this.#definitions = [...definitions].toSorted((left, right) =>
      left.metadata.name.localeCompare(right.metadata.name),
    );
  }
  all(): readonly BuiltInPresetDefinition[] {
    return this.#definitions;
  }
  require(name: string): BuiltInPresetDefinition {
    const definition = this.#definitions.find(
      (item) => item.metadata.name === name,
    );
    if (!definition) throw new Error(`Unknown Built-in Preset: ${name}`);
    return definition;
  }
}

export const builtInPresetRegistry = new PresetRegistry([
  tsLibDefinition,
  rustBinDefinition,
  vueAppDefinition,
  vueHonoAppDefinition,
  vikeAppDefinition,
]);

/** Registry-derived Template Source roots checked independently of render plans. */
export function builtInPresetTemplateSourceContexts(): readonly {
  readonly name: string;
  readonly root: string;
}[] {
  return [
    ...builtInPresetRegistry.all().map((definition) => ({
      name: definition.metadata.name,
      root: resolveBuiltInTemplateSource(definition.source, "."),
    })),
    {
      name: "foundation",
      root: resolveBuiltInTemplateSource(templateSources.foundation, "."),
    },
    {
      name: "shared-devcontainer",
      root: resolveBuiltInTemplateSource(
        templateSources.sharedDevcontainer,
        ".",
      ),
    },
    {
      name: "shared-oxc",
      root: resolveBuiltInTemplateSource(templateSources.sharedOxc, "."),
    },
    {
      name: "shared-vue",
      root: resolveBuiltInTemplateSource(templateSources.vue, "."),
    },
  ];
}

/**
 * Derives direct Template Source checks from every registered Definition's
 * actual initial contributions, without maintaining a second Preset catalog.
 */
export function builtInPresetTemplateSourceCheckContexts(): readonly BuiltInPresetTemplateSourceCheckContext[] {
  return builtInPresetRegistry.all().flatMap((definition) => {
    const context = createGenerationContext({
      targetDir: path.join(
        "generated-repository",
        "template-source",
        definition.metadata.name,
      ),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const plan = planGeneratedRepositoryInitialization({ definition, context });
    const contributions = definition.planInitializationContributions?.(
      context,
    ) ?? [definition.planInitialization(context)];

    return contributions.map((contribution) => ({
      definition,
      contribution,
      plan,
    }));
  });
}

export function createGenerationContext(options: {
  readonly targetDir: string;
  readonly scope?: string;
  readonly toolchain: BuiltInGenerationContext["toolchain"];
}): BuiltInGenerationContext {
  const projectName = path.basename(path.resolve(options.targetDir));
  return {
    targetDir: options.targetDir,
    projectName,
    scope: options.scope ?? projectName,
    toolchain: options.toolchain,
  };
}

/**
 * Package Addition reconstructs generic current facts from the Blueprint
 * topology and each package's real manifest/configuration.  A second durable
 * Contribution database would drift from the generated repository. Package
 * task scripts and explicit environment needs are enough to reconstruct it.
 */
function existingPackageContribution(options: {
  readonly context: BuiltInGenerationContext;
  readonly definition: ProjectBlueprintV2["packages"][number];
}): PackageContribution {
  const packageRoot = path.join(
    options.context.targetDir,
    options.definition.path,
  );
  const manifestPath = path.join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Package Addition requires manifest truth for ${options.definition.path}: package.json is missing`,
    );
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    (manifest as { name?: unknown }).name !== options.definition.name
  ) {
    throw new Error(
      `Package Addition requires manifest truth for ${options.definition.path}: expected name ${options.definition.name}`,
    );
  }
  const record = manifest as Record<string, unknown>;
  const scripts =
    typeof record.scripts === "object" && record.scripts !== null
      ? (record.scripts as Record<string, unknown>)
      : {};
  const owner = {
    kind: "package-boundary" as const,
    path: options.definition.path,
  };
  const dependencyMaintenance = existingDependencyMaintenancePolicy(
    options.context.targetDir,
  );
  const rust = existsSync(path.join(packageRoot, "Cargo.toml"));
  const editorRecommendationsPath = path.join(
    options.context.targetDir,
    ".vscode/extensions.json",
  );
  const editorRecommendations = existsSync(editorRecommendationsPath)
    ? (
        JSON.parse(readFileSync(editorRecommendationsPath, "utf8")) as {
          recommendations?: unknown;
        }
      ).recommendations
    : [];
  const existingExtensions = Array.isArray(editorRecommendations)
    ? new Set(
        editorRecommendations.filter(
          (item): item is string => typeof item === "string",
        ),
      )
    : new Set<string>();
  const editorCapabilities: readonly EditorCustomizationCapability[] = rust
    ? (["rust-tooling"] as const)
    : [
        "oxc-format-lint",
        ...(existingExtensions.has("Vue.volar") ? (["vue"] as const) : []),
        ...(existingExtensions.has("bradlc.vscode-tailwindcss")
          ? (["tailwind"] as const)
          : []),
        ...(existingExtensions.has("vitest.explorer")
          ? (["vitest"] as const)
          : []),
      ];
  return {
    definition: options.definition,
    manifest: record,
    exposure: {
      exports:
        typeof record.exports === "object" && record.exports !== null
          ? (record.exports as Record<string, unknown>)
          : {},
      imports:
        typeof record.imports === "object" && record.imports !== null
          ? (record.imports as Record<string, unknown>)
          : {},
    },
    operations: [],
    environmentNeeds: [
      ...(rust ? [rustToolchainEnvironmentNeed(owner)] : []),
      ...(scripts["test:e2e"] === undefined
        ? []
        : [
            playwrightBrowserAssetsEnvironmentNeed({
              browser: "chromium",
              owner,
            }),
          ]),
      ...(Object.values(scripts).some(
        (script) => typeof script === "string" && script.includes("shellcheck"),
      )
        ? [shellCheckEnvironmentNeed(owner)]
        : []),
    ],
    ...(scripts.deployment === undefined
      ? {}
      : { deploymentEnvironmentNeeds: [dockerEngineEnvironmentNeed()] }),
    foundation: {
      toolchains: rust
        ? { rust: { toolchain: "stable", components: ["rustfmt", "clippy"] } }
        : {},
      editorCapabilities,
      dependencyMaintenance: {
        ...dependencyMaintenance,
      },
    },
  };
}

/**
 * Dependabot is the Foundation-owned durable declaration of maintenance
 * coverage. Package Addition reads it back so rebuilding root policy cannot
 * silently discard a base repository's non-default directories.
 */
function existingDependencyMaintenancePolicy(
  targetDir: string,
): DependencyMaintenancePolicy {
  const dependabotPath = path.join(targetDir, ".github/dependabot.yml");
  if (!existsSync(dependabotPath)) {
    throw new Error(
      "Package Addition requires maintenance truth: .github/dependabot.yml is missing",
    );
  }
  const ecosystems: DependencyEcosystem[] = [];
  const directories: Partial<Record<DependencyEcosystem, `/${string}`>> = {};
  const extraDirectories: Partial<Record<DependencyEcosystem, `/${string}`[]>> =
    {};
  const supportedEcosystems = new Set<DependencyEcosystem>([
    "npm",
    "cargo",
    "github-actions",
    "docker",
    "rust-toolchain",
  ]);
  let ecosystem: DependencyEcosystem | undefined;
  for (const line of readFileSync(dependabotPath, "utf8").split("\n")) {
    const ecosystemMatch = /^\s*- package-ecosystem: (\S+)\s*$/u.exec(line);
    if (ecosystemMatch) {
      if (!supportedEcosystems.has(ecosystemMatch[1] as DependencyEcosystem)) {
        throw new Error(
          `Package Addition requires supported Dependabot ecosystems: ${ecosystemMatch[1]}`,
        );
      }
      ecosystem = ecosystemMatch[1] as DependencyEcosystem;
      if (!ecosystems.includes(ecosystem)) ecosystems.push(ecosystem);
      continue;
    }
    const directoryMatch = /^\s+directory: "?(\/[^"\s]*)"?\s*$/u.exec(line);
    if (!directoryMatch || ecosystem === undefined) continue;
    const directory = directoryMatch[1] as `/${string}`;
    if (directories[ecosystem] === undefined) {
      directories[ecosystem] = directory;
    } else {
      (extraDirectories[ecosystem] ??= []).push(directory);
    }
  }
  if (ecosystems.length === 0) {
    throw new Error(
      "Package Addition requires maintenance truth: .github/dependabot.yml has no update entries",
    );
  }
  return {
    ecosystems,
    directories,
    ...(Object.keys(extraDirectories).length === 0 ? {} : { extraDirectories }),
    interval: "weekly",
  };
}

function devcontainerDockerfileOperations(options: {
  readonly context: BuiltInGenerationContext;
  readonly environmentNeeds: readonly CheckEnvironmentNeed[];
}): RenderOperation[] {
  const hasBrowserTests = options.environmentNeeds.some(
    (need) => need.kind === "playwright-browser-assets",
  );
  const hasShellChecks = options.environmentNeeds.some(
    (need) => need.kind === "shellcheck-command",
  );
  const browserLayer = hasBrowserTests ? browserTestToolLayer() : undefined;
  return [
    {
      kind: "writeTextTemplate",
      source: templateSources.foundation,
      from: "devcontainer.json",
      to: ".devcontainer/devcontainer.json",
      replacements: {
        PROJECT_NAME: options.context.projectName,
        NODE_LTS_MAJOR: options.context.toolchain.nodeLtsMajor,
        PACKAGE_MANAGER_PIN: options.context.toolchain.packageManagerPin,
        PLAYWRIGHT_CLI_PACKAGE: browserLayer?.playwrightCliPackage ?? "unused",
      },
    },
    {
      kind: "writeTextFromFragments",
      to: ".devcontainer/Dockerfile",
      fragments: [
        {
          source: templateSources.sharedDevcontainer,
          from: "node-pnpm.Dockerfile",
        },
        ...(browserLayer === undefined
          ? []
          : [
              {
                source: templateSources.sharedDevcontainer,
                from: "browser-test.Dockerfile",
              },
            ]),
        ...(hasShellChecks
          ? [
              {
                source: templateSources.sharedDevcontainer,
                from: "shellcheck.Dockerfile",
              },
            ]
          : []),
      ],
    },
  ];
}

function foundationPlan(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprintV2;
  readonly contributions: readonly PackageContribution[];
  /** Contributions whose package-owned operations are rendered in this pass. */
  readonly renderContributions?: readonly PackageContribution[];
  readonly mode: "initialization" | "addition";
}): GeneratedRepositoryPlan {
  assertProjectBlueprintV2(options.blueprint);
  const environmentNeeds = options.contributions.flatMap(
    (item) => item.environmentNeeds,
  );
  const deploymentEnvironmentNeeds = options.contributions.flatMap(
    (item) => item.deploymentEnvironmentNeeds ?? [],
  );
  const hasDeploymentTask = options.contributions.some((contribution) => {
    const scripts = contribution.manifest.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).deployment === "string"
    );
  });
  const packagePaths = options.contributions.map(
    (contribution) => contribution.definition.path,
  );
  if (new Set(packagePaths).size !== packagePaths.length)
    throw new Error("Package Contributions must have unique Package Paths");
  const packageNames = options.contributions.map(
    (contribution) => contribution.definition.name,
  );
  if (new Set(packageNames).size !== packageNames.length)
    throw new Error("Package Contributions must have unique package names");
  const rustToolchain = options.contributions
    .map((contribution) => contribution.foundation.toolchains.rust)
    .find((toolchain) => toolchain !== undefined);
  if (
    options.contributions.some(
      (contribution) =>
        contribution.foundation.toolchains.rust !== undefined &&
        contribution.foundation.toolchains.rust !== rustToolchain,
    )
  ) {
    throw new Error("Foundation requires one coordinated Rust toolchain");
  }
  const workspacePackageGlobs = [
    "apps/*",
    "packages/*",
    ...new Set([
      ...options.blueprint.packages
        .map((definition) => `${definition.path.split("/")[0]}/*`)
        .filter((glob) => glob !== "apps/*" && glob !== "packages/*"),
      ...options.contributions
        .flatMap(
          (contribution) => contribution.foundation.workspacePackageGlobs ?? [],
        )
        .filter((glob) => glob !== "apps/*" && glob !== "packages/*"),
    ]),
  ];
  const editorCustomization = editorCustomizationForCapabilities(
    options.contributions.flatMap(
      (contribution) => contribution.foundation.editorCapabilities,
    ),
    loadEditorCustomizationDeclarations(
      resolveTemplateSource(
        templateSources.editorCustomization,
        "capabilities.json",
      ),
    ),
  );
  const dependencyMaintenancePolicy: DependencyMaintenancePolicy = {
    ecosystems: [
      ...new Set(
        options.contributions.flatMap(
          (contribution) =>
            contribution.foundation.dependencyMaintenance.ecosystems,
        ),
      ),
    ],
    directories: Object.assign(
      {},
      ...options.contributions.map(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.directories ?? {},
      ),
    ),
    extraDirectories: Object.assign(
      {},
      ...options.contributions.map(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.extraDirectories ?? {},
      ),
    ),
    interval: "weekly",
  };
  const rootManifest = {
    name: options.context.projectName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      check: renderRootCheckCommand(),
      boundaries: "node scripts/check-boundaries.ts",
      ...(hasDeploymentTask
        ? { "check:deployment": renderDeploymentCheckCommand() }
        : {}),
      fix: renderFixCommand(),
      "format:check": "node scripts/run-root-owned-task.ts format:check",
      "format:write": "node scripts/run-root-owned-task.ts format:write",
      lint: "node scripts/run-root-owned-task.ts lint",
      "lint:fix": "node scripts/run-root-owned-task.ts lint:fix",
      typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      turbo: "catalog:",
      "typescript-7": "catalog:",
    },
    engines: { node: options.context.toolchain.nodeLtsMajor },
    packageManager: options.context.toolchain.packageManagerPin,
  };
  const dependencyCatalog = selectTemplateDependencyCatalogEntries(
    collectGeneratedManifestCatalogReferences([
      ...options.contributions.map((contribution) => contribution.manifest),
      rootManifest,
    ]),
  );
  const dependencyOverrides = {
    ...(Object.hasOwn(dependencyCatalog, "vue") ||
    Object.hasOwn(dependencyCatalog, "pinia")
      ? vuePnpmDependencyOverrides
      : {}),
  };
  const requiresCoordinatedWorkspaceRefresh = true;
  const workspaceOperation: RenderOperation =
    requiresCoordinatedWorkspaceRefresh
      ? {
          kind: "writeTextTemplate",
          source: templateSources.foundation,
          from: "pnpm-workspace.dynamic.txt",
          to: "pnpm-workspace.yaml",
          replacements: {
            WORKSPACE_PACKAGE_GLOBS: workspacePackageGlobs
              .map((glob) => `  - ${glob}`)
              .join("\n"),
            DEPENDENCY_CATALOG: Object.entries(dependencyCatalog)
              .toSorted(([left], [right]) => left.localeCompare(right))
              .map(
                ([name, version]) =>
                  `  ${JSON.stringify(name)}: ${String(version)}`,
              )
              .join("\n"),
            DEPENDENCY_OVERRIDES_SECTION:
              Object.keys(dependencyOverrides).length === 0
                ? ""
                : [
                    "",
                    "overrides:",
                    ...Object.entries(dependencyOverrides)
                      .toSorted(([left], [right]) => left.localeCompare(right))
                      .map(
                        ([dependency, version]) =>
                          `  ${JSON.stringify(dependency)}: ${JSON.stringify(version)}`,
                      ),
                    "",
                  ].join("\n"),
          },
          ...(options.mode === "addition" ? { overwrite: true } : {}),
        }
      : {
          kind: "copyFile",
          source: templateSources.foundation,
          from: "pnpm-workspace.yaml",
          to: "pnpm-workspace.yaml",
        };
  const workflowOperation: RenderOperation = {
    kind: "writeTextTemplate",
    source: templateSources.foundation,
    from: ".github/workflows/check.dynamic.template",
    to: ".github/workflows/check.yml",
    replacements: projectCheckWorkflowTemplateReplacements({
      environment: { needs: environmentNeeds },
      deploymentEnvironmentNeeds,
      hasDeploymentTask,
    }),
    ...(options.mode === "addition" ? { overwrite: true } : {}),
  };
  const workflowOperations: RenderOperation[] = [
    workflowOperation,
    {
      kind: "writeTextTemplate" as const,
      source: templateSources.foundation,
      from: ".github/dependabot.dynamic.template",
      to: ".github/dependabot.yml",
      replacements: projectDependabotTemplateReplacements(
        dependencyMaintenancePolicy,
      ),
      ...(options.mode === "addition" ? { overwrite: true } : {}),
    },
  ];
  const projectLinkPlan = planExplicitProjectLinks({
    blueprint: options.blueprint,
    contributions: options.contributions,
  });
  const initializationFoundationOperations: RenderOperation[] = [
    { kind: "writeJson", to: "package.json", value: rootManifest },
    workspaceOperation,
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "gitignore",
      to: ".gitignore",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "turbo.json",
      to: "turbo.json",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "scripts/check-boundaries.ts",
      to: "scripts/check-boundaries.ts",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "scripts/run-root-owned-task.ts",
      to: "scripts/run-root-owned-task.ts",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "tsconfig.json",
      to: "tsconfig.json",
    },
    {
      kind: "copyFile",
      source: templateSources.sharedOxc,
      from: "tsconfig.config.json",
      to: "tsconfig.config.json",
    },
    {
      kind: "copyFile",
      source: templateSources.sharedOxc,
      from: "node/oxlint.config.ts",
      to: "oxlint.config.ts",
    },
    {
      kind: "copyFile",
      source: templateSources.sharedOxc,
      from: "oxfmt.config.ts",
      to: "oxfmt.config.ts",
    },
    {
      kind: "writeJson",
      to: ".vscode/extensions.json",
      value: { recommendations: editorCustomization.extensions },
      ...(editorCustomization.extensions.length > 2
        ? { multilineArrays: ["recommendations"] }
        : {}),
    },
    {
      kind: "writeJson",
      to: ".vscode/settings.json",
      value: editorCustomization.settings,
    },
    ...(rustToolchain === undefined
      ? [
          ...devcontainerDockerfileOperations({
            context: options.context,
            environmentNeeds,
          }),
        ]
      : [
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.foundation,
            from: "rust/rust-toolchain.toml",
            to: "rust-toolchain.toml",
            replacements: { RUST_TOOLCHAIN: rustToolchain.toolchain },
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.foundation,
            from: "rust/devcontainer/devcontainer.json",
            to: ".devcontainer/devcontainer.json",
            replacements: {
              PROJECT_NAME: options.context.projectName,
              NODE_LTS_MAJOR: options.context.toolchain.nodeLtsMajor,
              PACKAGE_MANAGER_PIN: options.context.toolchain.packageManagerPin,
              RUST_TOOLCHAIN: rustToolchain.toolchain,
            },
          },
          {
            kind: "writeTextFromFragments" as const,
            to: ".devcontainer/Dockerfile",
            fragments: [
              {
                source: templateSources.sharedDevcontainer,
                from: "node-pnpm.Dockerfile",
              },
              {
                source: templateSources.foundation,
                from: "rust/devcontainer/rust.Dockerfile",
              },
            ],
          },
        ]),
    ...workflowOperations,
    {
      kind: "writeJson",
      to: ".template/blueprint.json",
      value: options.blueprint,
    },
    {
      kind: "writeJson",
      to: ".template/generation.json",
      value: {
        preset: options.definition.metadata.name,
        templateVersion: "0.0.0",
        toolchain: options.context.toolchain,
      },
    },
  ];
  const refreshFoundationOperation = (
    operation: RenderOperation,
  ): RenderOperation => {
    switch (operation.kind) {
      case "copyFile":
      case "writeTextTemplate":
      case "writeTextFromFragments":
      case "writeJson":
        return { ...operation, overwrite: true };
      case "mergeJson":
      case "replaceAnchors":
      case "setExecutable":
      case "writeText":
        return operation;
    }
  };
  const plannedFoundationOperations: RenderOperation[] =
    options.mode === "addition"
      ? initializationFoundationOperations
          .filter(
            (operation) =>
              !(
                "to" in operation &&
                operation.to === ".template/generation.json"
              ),
          )
          .map(refreshFoundationOperation)
      : initializationFoundationOperations;
  const linkOperations: RenderOperation[] = [
    ...projectLinkPlan.manifestDependenciesByPackagePath,
  ].map(([packagePath, dependencies]) => ({
    kind: "mergeJson" as const,
    to: `${packagePath}/package.json`,
    value: { dependencies },
    multilineArrays: ["files"],
  }));
  const contributionProvenance = {
    definitionName: options.definition.metadata.name,
    plannerSourceFile: options.definition.plannerSourceFile,
    planningContribution:
      options.mode === "addition"
        ? "planPackageAddition"
        : "planInitialization",
    ownershipRule:
      "Package Contribution may write only its owned Package Boundary",
  } as const;
  const foundationProvenance = {
    definitionName: options.definition.metadata.name,
    plannerSourceFile: fileURLToPath(import.meta.url),
    planningContribution: "foundationPlan",
    ownershipRule: "Foundation owns coordinated root outputs",
  } as const;
  const withProvenance = (
    operation: RenderOperation,
    provenance: typeof contributionProvenance | typeof foundationProvenance,
  ): RenderOperation => ({ ...operation, provenance });
  const operations: RenderOperation[] = [
    ...(options.renderContributions ?? options.contributions)
      .map((item) =>
        assertPackageContribution(item, {
          definitionName: options.definition.metadata.name,
          planner:
            options.mode === "addition"
              ? "planPackageAddition"
              : "planInitialization",
        }),
      )
      .flatMap((item) =>
        item.operations.map((operation) =>
          operation.kind === "writeJson" &&
          operation.to.endsWith("/package.json")
            ? { ...operation, value: item.manifest }
            : operation,
        ),
      )
      .map((operation) => withProvenance(operation, contributionProvenance)),
    ...plannedFoundationOperations.map((operation) =>
      withProvenance(operation, foundationProvenance),
    ),
    ...linkOperations.map((operation) =>
      withProvenance(operation, foundationProvenance),
    ),
  ];
  return {
    definitionName: options.definition.metadata.name,
    plannerSourceFile: options.definition.plannerSourceFile,
    planningContribution:
      options.mode === "addition"
        ? "planPackageAddition"
        : "planInitialization",
    blueprint: options.blueprint,
    generationRecord: {
      preset: options.definition.metadata.name,
      templateVersion: "0.0.0",
      toolchain: options.context.toolchain,
    },
    operations,
    environmentNeeds,
    deploymentEnvironmentNeeds,
    manifests: [
      ...options.contributions.map((item) => item.manifest),
      rootManifest,
    ],
    dependencyCatalog,
    dependencyMaintenancePolicy,
    nextStepInstructions: [
      { display: "pnpm install" },
      ...environmentNeeds.map((need) => ({ display: need.nextStep.display })),
      { display: "pnpm run fix" },
      { display: "pnpm run check" },
    ],
  };
}

export function planGeneratedRepositoryInitialization(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
}): GeneratedRepositoryPlan {
  const blueprint = options.definition.blueprint(options.context);
  return foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint,
    contributions: options.definition.planInitializationContributions?.(
      options.context,
    ) ?? [options.definition.planInitialization(options.context)],
    mode: "initialization",
  });
}

export function planGeneratedRepositoryPackageAddition(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprintV2;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  /** Existing consumers that explicitly import the newly added provider. */
  readonly linkFrom?: readonly string[];
}): GeneratedRepositoryPlan {
  assertProjectBlueprintV2(options.blueprint);
  if (!options.definition.planPackageAddition)
    throw new Error(
      `Built-in Preset ${options.definition.metadata.name} does not support Package Addition`,
    );
  const packagePath =
    options.packagePath ??
    options.definition.defaultPackagePath?.({
      context: options.context,
      packageLeafName: options.packageLeafName,
    });
  if (packagePath === undefined) {
    throw new Error(
      `Built-in Preset ${options.definition.metadata.name} must own a default Package Path or receive an explicit Package Path`,
    );
  }
  const contribution = options.definition.planPackageAddition({
    context: options.context,
    packageLeafName: options.packageLeafName,
    packagePath,
  });
  const conflictingPackage = options.blueprint.packages.find(
    (existing) =>
      existing.name === contribution.definition.name ||
      existing.path === contribution.definition.path,
  );
  if (conflictingPackage !== undefined) {
    throw new Error(
      `Package Addition conflicts with existing Package Definition ${conflictingPackage.name} at ${conflictingPackage.path}`,
    );
  }
  const blueprint: ProjectBlueprintV2 = {
    ...options.blueprint,
    packages: [...options.blueprint.packages, contribution.definition],
    ...(options.linkFrom && options.linkFrom.length > 0
      ? {
          packageLinkIntents: [
            ...(options.blueprint.packageLinkIntents ?? []),
            ...[...new Set(options.linkFrom)].map((consumerPackagePath) => ({
              consumerPackagePath,
              providerPackagePath: contribution.definition.path,
            })),
          ],
        }
      : {}),
  };
  assertProjectBlueprintV2(blueprint);
  const existingContributions = options.blueprint.packages.map((definition) =>
    existingPackageContribution({ context: options.context, definition }),
  );
  if (
    existingContributions.length !== options.blueprint.packages.length ||
    existingContributions.some(
      (existing) =>
        !options.blueprint.packages.some(
          (definition) =>
            definition.path === existing.definition.path &&
            definition.name === existing.definition.name,
        ),
    )
  ) {
    throw new Error(
      "Migration Package Addition check Contributions must match the current Project Blueprint",
    );
  }
  return foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint,
    contributions: [...existingContributions, contribution],
    renderContributions: [contribution],
    mode: "addition",
  });
}
