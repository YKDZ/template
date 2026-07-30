import type { DeploymentEnvironmentNeed } from "./module-graph.ts";

export type CiCapability = {
  readonly workflowName: "Check";
  readonly jobName: "check";
  readonly runner: "ubuntu-latest";
};

export type CiEnvironmentPreparation = {
  readonly nodeFromPackageMetadata: boolean;
};

export type PnpmTaskLayer = {
  readonly installCommand: "pnpm install";
  readonly checkCommand: "pnpm run check";
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

type ProjectCheckWorkflowOptions = {
  readonly deploymentEnvironmentNeeds?: readonly DeploymentEnvironmentNeed[];
  readonly hasDeploymentTask?: boolean | undefined;
  readonly capability?: CiCapability | undefined;
  readonly environmentPreparation?:
    | Partial<CiEnvironmentPreparation>
    | undefined;
  readonly taskLayer?: PnpmTaskLayer | undefined;
};

const defaultCiCapability: CiCapability = {
  workflowName: "Check",
  jobName: "check",
  runner: "ubuntu-latest",
};

const pnpmTaskLayer: PnpmTaskLayer = {
  installCommand: "pnpm install",
  checkCommand: "pnpm run check",
};

export function projectCheckWorkflow(
  options: ProjectCheckWorkflowOptions,
): string {
  const capability = options.capability ?? defaultCiCapability;
  const environmentPreparation: CiEnvironmentPreparation = {
    nodeFromPackageMetadata: true,
    ...options.environmentPreparation,
  };
  const taskLayer = options.taskLayer ?? pnpmTaskLayer;
  const hasDeploymentTask = options.hasDeploymentTask === true;
  const needsDocker = (options.deploymentEnvironmentNeeds ?? []).some(
    (need) => need.kind === "docker-engine",
  );
  const lines = [
    `name: ${capability.workflowName}`,
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches:",
    "      - main",
    "",
    "jobs:",
    `  ${capability.jobName}:`,
    `    runs-on: ${capability.runner}`,
    ...(hasDeploymentTask
      ? ["    strategy:", "      matrix:", "        check: [root, deployment]"]
      : []),
    "    steps:",
    "      - uses: actions/checkout@v7",
  ];

  if (environmentPreparation.nodeFromPackageMetadata) {
    lines.push(
      "      - uses: actions/setup-node@v7",
      "        with:",
      "          node-version-file: package.json",
      "      - run: corepack enable",
    );
  }

  if (hasDeploymentTask && needsDocker) {
    lines.push(
      "      - uses: docker/setup-buildx-action@v3",
      "        if: matrix.check == 'deployment'",
    );
  }

  lines.push(`      - run: ${taskLayer.installCommand}`);
  lines.push(`      - run: ${taskLayer.checkCommand}`);
  if (hasDeploymentTask) {
    lines.push("        if: matrix.check == 'root'");
  }
  if (hasDeploymentTask) {
    lines.push(
      "      - run: pnpm run check:deployment",
      "        if: matrix.check == 'deployment'",
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** Limited substitutions for the Foundation-owned workflow Template Source. */
export function projectCheckWorkflowTemplateReplacements(options: {
  readonly deploymentEnvironmentNeeds?: readonly DeploymentEnvironmentNeed[];
  readonly hasDeploymentTask?: boolean | undefined;
}): Record<string, string> {
  const hasDeploymentTask = options.hasDeploymentTask === true;
  const needsDocker = (options.deploymentEnvironmentNeeds ?? []).some(
    (need) => need.kind === "docker-engine",
  );
  return {
    DEPLOYMENT_MATRIX: hasDeploymentTask
      ? "\n    strategy:\n      matrix:\n        check: [root, deployment]"
      : "",
    DEPLOYMENT_DOCKER_PREPARATION:
      hasDeploymentTask && needsDocker
        ? "\n      - uses: docker/setup-buildx-action@v3\n        if: matrix.check == 'deployment'"
        : "",
    ROOT_CHECK_CONDITION: hasDeploymentTask
      ? "\n        if: matrix.check == 'root'"
      : "",
    DEPLOYMENT_CHECK: hasDeploymentTask
      ? "\n      - run: pnpm run check:deployment\n        if: matrix.check == 'deployment'"
      : "",
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
