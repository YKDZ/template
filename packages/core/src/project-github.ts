import {
  composeCiDiagnosticArtifacts,
  type CiDiagnosticArtifactDeclaration,
} from "./ci-diagnostic-artifact.ts";
import type { DeploymentEnvironmentNeed } from "./module-graph.ts";

export type CiCapability = {
  readonly workflowName: "Check";
  readonly jobName: "check";
  readonly jobDisplayName: "Root Check";
  readonly runner: "ubuntu-latest";
  readonly timeoutMinutes: 30;
};

export type CiEnvironmentPreparation = {
  readonly nodeFromPackageMetadata: boolean;
  readonly packageManagerFromPackageMetadata: boolean;
  readonly pnpmStoreCache: boolean;
};

export type PnpmTaskLayer = {
  readonly installCommand: "pnpm install --frozen-lockfile";
  readonly checkCommand: "pnpm run check";
};

export type CiCheckMatrixEntry = {
  readonly capability: "root" | "deployment";
  readonly jobDisplayName: "Root Check" | "Deployment Check";
  readonly taskEntrypoint: "pnpm run check" | "pnpm run check:deployment";
  readonly timeoutMinutes: 30 | 45;
  readonly requiresDocker: boolean;
};

export type ProjectCheckWorkflowPlan = {
  readonly workflowName: "Check";
  readonly triggers: {
    readonly pullRequest: true;
    readonly pushBranches: readonly ["main"];
  };
  readonly permissions: { readonly contents: "read" };
  readonly concurrency: {
    readonly group: "${{ github.workflow }}-${{ github.ref }}";
    readonly cancelInProgress: true;
  };
  readonly rootCheck: CiCapability;
  readonly matrix:
    | {
        readonly failFast: false;
        readonly include: readonly CiCheckMatrixEntry[];
      }
    | undefined;
  readonly environmentPreparation: CiEnvironmentPreparation;
  readonly taskLayer: PnpmTaskLayer;
  /** Actual Package Boundaries allowed to own retained native diagnostics. */
  readonly packagePaths: readonly string[];
  readonly diagnosticArtifacts: readonly CiDiagnosticArtifactDeclaration[];
};

export type DependencyEcosystem =
  | "npm"
  | "cargo"
  | "github-actions"
  | "docker"
  | "rust-toolchain";

export type DependabotDirectory = `/${string}`;

export type DependencyMaintenancePolicy = {
  readonly ecosystems: DependencyEcosystem[];
  readonly directories?: Partial<
    Record<DependencyEcosystem, DependabotDirectory>
  >;
  readonly extraDirectories?: Partial<
    Record<DependencyEcosystem, readonly DependabotDirectory[]>
  >;
  readonly interval: "weekly";
};

export type ProjectCheckWorkflowDiagnosticOptions = {
  /** Package Paths from the real Project Blueprint or Package Contributions. */
  readonly packagePaths: readonly string[];
  readonly diagnosticArtifacts?: readonly unknown[] | undefined;
};

type ProjectCheckWorkflowOptions = ProjectCheckWorkflowDiagnosticOptions & {
  readonly deploymentEnvironmentNeeds?: readonly DeploymentEnvironmentNeed[];
  readonly hasDeploymentTask?: boolean | undefined;
  readonly capability?: CiCapability | undefined;
  readonly environmentPreparation?:
    | Partial<CiEnvironmentPreparation>
    | undefined;
  readonly taskLayer?: PnpmTaskLayer | undefined;
};

function validatedDiagnosticArtifacts(options: {
  readonly packagePaths: readonly string[];
  readonly artifacts: readonly unknown[];
}): readonly CiDiagnosticArtifactDeclaration[] {
  return composeCiDiagnosticArtifacts({
    packagePaths: options.packagePaths,
    declarations: options.artifacts,
  });
}

const defaultCiCapability: CiCapability = {
  workflowName: "Check",
  jobName: "check",
  jobDisplayName: "Root Check",
  runner: "ubuntu-latest",
  timeoutMinutes: 30,
};

const pnpmTaskLayer: PnpmTaskLayer = {
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
};

/** Capability facts for the Foundation-owned GitHub Actions Template Source. */
export function projectCheckWorkflowPlan(
  options: ProjectCheckWorkflowOptions,
): ProjectCheckWorkflowPlan {
  const capability = options.capability ?? defaultCiCapability;
  const environmentPreparation: CiEnvironmentPreparation = {
    nodeFromPackageMetadata: true,
    packageManagerFromPackageMetadata: true,
    pnpmStoreCache: true,
    ...options.environmentPreparation,
  };
  const taskLayer = options.taskLayer ?? pnpmTaskLayer;
  const hasDeploymentTask = options.hasDeploymentTask === true;
  const needsDocker = (options.deploymentEnvironmentNeeds ?? []).some(
    (need) => need.kind === "docker-engine",
  );
  if (hasDeploymentTask && !needsDocker) {
    throw new Error("Deployment Check requires a Docker environment need");
  }
  const packagePaths = [...options.packagePaths];
  const diagnosticArtifacts = validatedDiagnosticArtifacts({
    packagePaths,
    artifacts: options.diagnosticArtifacts ?? [],
  });
  return {
    workflowName: capability.workflowName,
    triggers: { pullRequest: true, pushBranches: ["main"] },
    permissions: { contents: "read" },
    concurrency: {
      group: "${{ github.workflow }}-${{ github.ref }}",
      cancelInProgress: true,
    },
    rootCheck: capability,
    matrix: hasDeploymentTask
      ? {
          failFast: false,
          include: [
            {
              capability: "root",
              jobDisplayName: capability.jobDisplayName,
              taskEntrypoint: taskLayer.checkCommand,
              timeoutMinutes: capability.timeoutMinutes,
              requiresDocker: false,
            },
            {
              capability: "deployment",
              jobDisplayName: "Deployment Check",
              taskEntrypoint: "pnpm run check:deployment",
              timeoutMinutes: 45,
              requiresDocker: true,
            },
          ],
        }
      : undefined,
    environmentPreparation,
    taskLayer,
    packagePaths,
    diagnosticArtifacts,
  };
}

/** Selects a complete Foundation-owned workflow Template Source. */
export function projectCheckWorkflowTemplateSource(
  options: ProjectCheckWorkflowDiagnosticOptions & {
    readonly deploymentEnvironmentNeeds?: readonly DeploymentEnvironmentNeed[];
    readonly hasDeploymentTask?: boolean | undefined;
  },
):
  | ".github/workflows/check.yml"
  | ".github/workflows/check-diagnostics.yml"
  | ".github/workflows/check-deployment.yml"
  | ".github/workflows/check-deployment-diagnostics.yml" {
  const hasDeploymentTask = options.hasDeploymentTask === true;
  const needsDocker = (options.deploymentEnvironmentNeeds ?? []).some(
    (need) => need.kind === "docker-engine",
  );
  if (hasDeploymentTask && !needsDocker) {
    throw new Error("Deployment Check requires a Docker environment need");
  }
  const hasDiagnostics =
    validatedDiagnosticArtifacts({
      packagePaths: options.packagePaths,
      artifacts: options.diagnosticArtifacts ?? [],
    }).length > 0;
  if (hasDeploymentTask) {
    return hasDiagnostics
      ? ".github/workflows/check-deployment-diagnostics.yml"
      : ".github/workflows/check-deployment.yml";
  }
  return hasDiagnostics
    ? ".github/workflows/check-diagnostics.yml"
    : ".github/workflows/check.yml";
}

/** Limited, validated facts for static Foundation diagnostic staging. */
export function projectCheckWorkflowTemplateReplacements(
  options: ProjectCheckWorkflowDiagnosticOptions,
): Record<string, string> {
  const declarations = validatedDiagnosticArtifacts({
    packagePaths: options.packagePaths,
    artifacts: options.diagnosticArtifacts ?? [],
  });
  if (declarations.length === 0) return {};
  return {
    DIAGNOSTIC_OWNER_PATHS: declarations
      .map((declaration) => declaration.owner.path)
      .join("\n            "),
  };
}

export function projectDependabotConfig(
  policy: DependencyMaintenancePolicy,
): string {
  return [
    "version: 2",
    "",
    "updates:",
    ...policy.ecosystems.flatMap((ecosystem) =>
      [
        policy.directories?.[ecosystem] ??
          defaultDependabotDirectory(ecosystem),
        ...(policy.extraDirectories?.[ecosystem] ?? []),
      ].flatMap((directory) =>
        renderDependabotUpdate(ecosystem, directory, policy.interval),
      ),
    ),
    "",
  ].join("\n");
}

/** Limited substitution for the Foundation-owned Dependabot Template Source. */
export function projectDependabotTemplateReplacements(
  policy: DependencyMaintenancePolicy,
): Record<string, string> {
  const header = "version: 2\n\nupdates:\n";
  const configuration = projectDependabotConfig(policy);
  if (!configuration.startsWith(header)) {
    throw new Error(
      "Dependabot configuration must retain its Template Source header",
    );
  }
  return { DEPENDABOT_UPDATES: configuration.slice(header.length).trimEnd() };
}

function renderDependabotUpdate(
  ecosystem: DependencyEcosystem,
  directory: DependabotDirectory,
  interval: DependencyMaintenancePolicy["interval"],
): string[] {
  const lines = [
    `  - package-ecosystem: ${ecosystem}`,
    `    directory: ${renderDependabotDirectory(ecosystem, directory)}`,
    "    schedule:",
    `      interval: ${interval}`,
  ];

  if (ecosystem === "npm") {
    lines.push(
      "    groups:",
      "      drizzle:",
      "        patterns:",
      '          - "drizzle-*"',
      '          - "drizzle-orm"',
      "    ignore:",
      '      - dependency-name: "@types/node"',
      "        update-types:",
      "          - version-update:semver-major",
      '      - dependency-name: "pnpm"',
      "        update-types:",
      "          - version-update:semver-major",
      "          - version-update:semver-minor",
      "          - version-update:semver-patch",
    );
  }

  if (ecosystem === "docker" && directory === "/.devcontainer") {
    lines.push(
      "    ignore:",
      "      - dependency-name: mcr.microsoft.com/devcontainers/typescript-node",
      "        update-types:",
      "          - version-update:semver-major",
    );
  }

  return lines;
}

function renderDependabotDirectory(
  ecosystem: DependencyEcosystem,
  directory: DependabotDirectory,
): string {
  return ecosystem === "cargo" ? JSON.stringify(directory) : directory;
}

function defaultDependabotDirectory(
  ecosystem: DependencyEcosystem,
): DependabotDirectory {
  return ecosystem === "docker" ? "/.devcontainer" : "/";
}
