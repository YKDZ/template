import type { PresetName } from "./declarations.js";
import {
  type CheckEnvironmentNeed,
  type CheckPlan,
  planPresetChecks,
  planRustBinChecks,
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

export type DependencyEcosystem = "npm" | "cargo" | "github-actions";

export type DependencyMaintenancePolicy = {
  readonly ecosystems: DependencyEcosystem[];
  readonly interval: "weekly";
};

type ProjectCheckWorkflowOptions = {
  readonly checkPlan: CheckPlan;
  readonly capability?: CiCapability;
  readonly environmentPreparation?: Partial<CiEnvironmentPreparation>;
  readonly taskLayer?: PnpmTaskLayer;
  readonly rustToolchain?: boolean;
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

export function projectPresetGithubCheckWorkflow(preset: PresetName): string {
  const checkPlan = planPresetChecks(preset);

  if (!checkPlan) {
    throw new Error(`Unsupported preset for GitHub check workflow projection: ${preset}`);
  }

  return projectCheckWorkflow({
    checkPlan,
    rustToolchain: preset === "rust-bin",
  });
}

export function projectCheckWorkflow(options: ProjectCheckWorkflowOptions): string {
  const capability = options.capability ?? defaultCiCapability;
  const environmentPreparation: CiEnvironmentPreparation = {
    nodeFromPackageMetadata: true,
    rustToolchain: options.rustToolchain ?? false,
    ...options.environmentPreparation,
  };
  const taskLayer = options.taskLayer ?? pnpmTaskLayer;
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
    "      - uses: actions/checkout@v6",
  ];

  if (environmentPreparation.nodeFromPackageMetadata) {
    lines.push(
      "      - uses: actions/setup-node@v6",
      "        with:",
      "          node-version-file: package.json",
      "      - run: corepack enable",
    );
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
  lines.push(`      - run: ${taskLayer.checkCommand}`, "");

  return lines.join("\n");
}

export function projectPresetDependencyMaintenancePolicy(
  preset: PresetName,
): DependencyMaintenancePolicy {
  switch (preset) {
    case "ts-lib":
    case "hono-api":
    case "vue-app":
    case "vue-hono-app":
      return { ecosystems: ["npm", "github-actions"], interval: "weekly" };
    case "rust-bin":
      return { ecosystems: ["npm", "cargo", "github-actions"], interval: "weekly" };
    case "ts-app":
    case "node-cli":
      throw new Error(`Unsupported preset for Dependency Maintenance Policy projection: ${preset}`);
  }
}

export function projectPresetDependabotConfig(preset: PresetName): string {
  return projectDependabotConfig(projectPresetDependencyMaintenancePolicy(preset));
}

export function projectDependabotConfig(policy: DependencyMaintenancePolicy): string {
  return [
    "version: 2",
    "updates:",
    ...policy.ecosystems.flatMap((ecosystem) => [
      `  - package-ecosystem: ${ecosystem}`,
      "    directory: /",
      "    schedule:",
      `      interval: ${policy.interval}`,
    ]),
    "",
  ].join("\n");
}

function renderCiEnvironmentNeedCommand(need: CheckEnvironmentNeed): string {
  if (need.kind === "playwright-browser-assets" && need.owner.path === "apps/web") {
    return `pnpm --filter ./apps/web exec playwright install --with-deps ${need.browser}`;
  }

  return `pnpm exec playwright install --with-deps ${need.browser}`;
}

export function projectRustBinGithubCheckWorkflow(): string {
  return projectCheckWorkflow({ checkPlan: planRustBinChecks(), rustToolchain: true });
}
