import {
  type CheckEnvironmentNeed,
  type CheckPlan,
  deploymentCheckEnvironmentNeeds,
  deploymentCheckTaskName,
  renderPlaywrightBrowserInstallCommand,
} from "./module-graph.ts";

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
  const requiresRustToolchain =
    environmentPreparation.rustToolchain ||
    options.checkPlan.environmentNeeds.some(
      (need) => need.kind === "rust-toolchain",
    );
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
    ...(deploymentChecks.length === 0
      ? []
      : [
          "    strategy:",
          "      matrix:",
          "        check: [root, deployment]",
        ]),
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
    lines.push(
      "      - uses: docker/setup-buildx-action@v3",
      "        if: matrix.check == 'deployment'",
    );
  }

  if (requiresRustToolchain) lines.push(...rustCiPreparationLines());

  lines.push(`      - run: ${taskLayer.installCommand}`);
  const checkEnvironmentLines: string[] = [];
  for (const need of options.checkPlan.environmentNeeds) {
    if (need.kind === "rust-toolchain") continue;
    checkEnvironmentLines.push(
      `      - run: ${renderCiEnvironmentNeedCommand(need)}`,
    );
    if (deploymentChecks.length > 0 && need.kind === "shellcheck-command") {
      checkEnvironmentLines.push("        if: matrix.check == 'root'");
    }
  }
  lines.push(...checkEnvironmentLines);
  lines.push(`      - run: ${taskLayer.checkCommand}`);
  if (deploymentChecks.length > 0) {
    lines.push("        if: matrix.check == 'root'");
  }
  const deploymentCheck = deploymentChecks[0];
  if (deploymentCheck !== undefined) {
    lines.push(
      `      - run: pnpm run ${deploymentCheckTaskName(deploymentCheck)}`,
      "        if: matrix.check == 'deployment'",
    );
  }
  lines.push("");

  return lines.join("\n");
}

function rustCiPreparationLines(): string[] {
  return [
    "      - uses: dtolnay/rust-toolchain@stable",
    "        with:",
    "          components: rustfmt, clippy",
    "      - uses: Swatinem/rust-cache@v2",
  ];
}

/** Limited substitutions for the Foundation-owned workflow Template Source. */
export function projectCheckWorkflowTemplateReplacements(options: {
  readonly checkPlan: CheckPlan;
  readonly environmentPreparation?: Partial<CiEnvironmentPreparation>;
}): Record<string, string> {
  const requiresRustToolchain =
    options.environmentPreparation?.rustToolchain === true ||
    options.checkPlan.environmentNeeds.some(
      (need) => need.kind === "rust-toolchain",
    );
  const deploymentChecks = options.checkPlan.deploymentChecks ?? [];
  const needsDocker = deploymentChecks.some((check) =>
    deploymentCheckEnvironmentNeeds(check).some(
      (need) => need.kind === "docker-engine",
    ),
  );
  const deploymentCheck = deploymentChecks[0];
  const environmentSteps = options.checkPlan.environmentNeeds
    .filter((need) => need.kind !== "rust-toolchain")
    .map((need) =>
      [
        `      - run: ${renderCiEnvironmentNeedCommand(need)}`,
        ...(deploymentChecks.length > 0 && need.kind === "shellcheck-command"
          ? ["        if: matrix.check == 'root'"]
          : []),
      ].join("\n"),
    );
  return {
    RUST_CI_PREPARATION: requiresRustToolchain
      ? `\n${rustCiPreparationLines().join("\n")}`
      : "",
    CHECK_ENVIRONMENT_PREPARATION:
      environmentSteps.length === 0 ? "" : `\n${environmentSteps.join("\n")}`,
    DEPLOYMENT_MATRIX:
      deploymentChecks.length === 0
        ? ""
        : "\n    strategy:\n      matrix:\n        check: [root, deployment]",
    DEPLOYMENT_DOCKER_PREPARATION: needsDocker
      ? "\n      - uses: docker/setup-buildx-action@v3\n        if: matrix.check == 'deployment'"
      : "",
    ROOT_CHECK_CONDITION:
      deploymentChecks.length === 0
        ? ""
        : "\n        if: matrix.check == 'root'",
    DEPLOYMENT_CHECK:
      deploymentCheck === undefined
        ? ""
        : `\n      - run: pnpm run ${deploymentCheckTaskName(deploymentCheck)}\n        if: matrix.check == 'deployment'`,
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

function renderCiEnvironmentNeedCommand(need: CheckEnvironmentNeed): string {
  switch (need.kind) {
    case "playwright-browser-assets":
      return renderPlaywrightBrowserInstallCommand(need, { withDeps: true });
    case "shellcheck-command":
      return need.nextStep.display;
    case "rust-toolchain":
      return need.nextStep.display;
  }
}
