import {
  type CheckEnvironmentNeed,
  type CheckPlan,
  deploymentCheckEnvironmentNeeds,
  deploymentCheckTaskName,
  renderPlaywrightBrowserInstallCommand,
} from "./module-graph.js";

export type CiCapability = {
  readonly workflowName: "Check";
  readonly jobName: "check";
  readonly runner: "ubuntu-latest";
};

export type CiEnvironmentPreparation = {
  readonly nodeFromPackageMetadata: boolean;
  readonly rustToolchain: boolean;
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
  readonly checkPlan: CheckPlan;
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
    rustToolchain: false,
    ...options.environmentPreparation,
  };
  const taskLayer = options.taskLayer ?? pnpmTaskLayer;
  const deploymentChecks = options.checkPlan.deploymentChecks ?? [];
  const needsDocker = deploymentChecks.some((check) =>
    deploymentCheckEnvironmentNeeds(check).some(
      (need) => need.kind === "docker-engine",
    ),
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
    "    steps:",
    "      - uses: actions/checkout@v7",
  ];

  if (environmentPreparation.nodeFromPackageMetadata) {
    lines.push(
      "      - uses: actions/setup-node@v6",
      "        with:",
      "          node-version-file: package.json",
      "      - run: corepack enable",
    );
  }

  if (needsDocker) {
    lines.push("      - uses: docker/setup-buildx-action@v3");
  }

  if (environmentPreparation.rustToolchain) {
    lines.push(
      "      - uses: dtolnay/rust-toolchain@stable",
      "        with:",
      "          components: rustfmt, clippy",
      "      - uses: Swatinem/rust-cache@v2",
    );
  }

  lines.push(`      - run: ${taskLayer.installCommand}`);
  lines.push(
    ...options.checkPlan.environmentNeeds.map(
      (need) => `      - run: ${renderCiEnvironmentNeedCommand(need)}`,
    ),
  );
  lines.push(`      - run: ${taskLayer.checkCommand}`);
  const deploymentCheck = deploymentChecks[0];
  if (deploymentCheck !== undefined) {
    lines.push(
      `      - run: pnpm run ${deploymentCheckTaskName(deploymentCheck)}`,
    );
  }
  lines.push("");

  return lines.join("\n");
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

function renderCiEnvironmentNeedCommand(need: CheckEnvironmentNeed): string {
  return renderPlaywrightBrowserInstallCommand(need, { withDeps: true });
}
