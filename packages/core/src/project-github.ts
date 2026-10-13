import {
  composeCiDiagnosticArtifacts,
  type CiDiagnosticArtifactDeclaration,
} from "./ci-diagnostic-artifact.ts";
import type { DeploymentEnvironmentNeed } from "./module-graph.ts";

export type DependencyEcosystem =
  | "npm"
  | "cargo"
  | "github-actions"
  | "docker"
  | "devcontainers"
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

function validatedDiagnosticArtifacts(options: {
  readonly packagePaths: readonly string[];
  readonly artifacts: readonly unknown[];
}): readonly CiDiagnosticArtifactDeclaration[] {
  return composeCiDiagnosticArtifacts({
    packagePaths: options.packagePaths,
    declarations: options.artifacts,
  });
}

/** Selects a complete Foundation-owned workflow Template Source. */
export function projectCheckWorkflowTemplateSource(
  options: ProjectCheckWorkflowDiagnosticOptions & {
    readonly deploymentCheck?:
      | {
          readonly environmentNeeds: readonly DeploymentEnvironmentNeed[];
        }
      | undefined;
  },
):
  | ".github/workflows/check.yml"
  | ".github/workflows/check-diagnostics.yml"
  | ".github/workflows/check-deployment.yml"
  | ".github/workflows/check-deployment-diagnostics.yml" {
  const hasDeploymentTask = options.deploymentCheck !== undefined;
  const needsDocker = (options.deploymentCheck?.environmentNeeds ?? []).some(
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
  const ownerPaths = (kind: CiDiagnosticArtifactDeclaration["kind"]) =>
    declarations
      .filter((declaration) => declaration.kind === kind)
      .map((declaration) => declaration.owner.path)
      .toSorted()
      .join("\n            ");
  return {
    PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: ownerPaths("playwright"),
    VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS: ownerPaths("vitest-browser"),
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
