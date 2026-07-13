export type PackageBoundaryOwner = {
  readonly kind: "package-boundary";
  readonly path: string;
};

export type WorkspaceOrchestrationOwner = {
  readonly kind: "workspace-orchestration";
  readonly path: ".";
};

export type ComponentOwner = PackageBoundaryOwner | WorkspaceOrchestrationOwner;

export type FixComponentKind =
  | "oxc-format-write"
  | "oxc-lint-fix"
  | "turbo-fix"
  | "turbo-package-fix"
  | "rustfmt-write";

export type PlaywrightBrowserAssetsEnvironmentNeed = {
  readonly kind: "playwright-browser-assets";
  readonly browser: "chromium";
  readonly owner: ComponentOwner;
  readonly nextStep: {
    readonly id: string;
    readonly label: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly display: string;
    readonly machineVerifiable: boolean;
  };
};

export type ShellCheckEnvironmentNeed = {
  readonly kind: "shellcheck-command";
  readonly owner: ComponentOwner;
  readonly nextStep: {
    readonly id: "install-shellcheck";
    readonly label: "Install ShellCheck";
    readonly command: "sudo";
    readonly args: readonly string[];
    readonly display: "sudo apt-get update && sudo apt-get install -y shellcheck";
    readonly machineVerifiable: false;
  };
};

/** Rust check components require the maintained toolchain in local and CI plans. */
export type RustToolchainEnvironmentNeed = {
  readonly kind: "rust-toolchain";
  readonly owner: ComponentOwner;
  readonly toolchain: "stable";
  readonly nextStep: {
    readonly id: "install-rust-toolchain";
    readonly label: "Install Rust toolchain";
    readonly command: "rustup";
    readonly args: readonly string[];
    readonly display: "rustup toolchain install stable --component rustfmt --component clippy";
    readonly machineVerifiable: boolean;
  };
};

export type CheckEnvironmentNeed =
  | PlaywrightBrowserAssetsEnvironmentNeed
  | ShellCheckEnvironmentNeed
  | RustToolchainEnvironmentNeed;

export function rustToolchainEnvironmentNeed(
  owner: ComponentOwner,
): RustToolchainEnvironmentNeed {
  return {
    kind: "rust-toolchain",
    owner,
    toolchain: "stable",
    nextStep: {
      id: "install-rust-toolchain",
      label: "Install Rust toolchain",
      command: "rustup",
      args: [
        "toolchain",
        "install",
        "stable",
        "--component",
        "rustfmt",
        "--component",
        "clippy",
      ],
      display:
        "rustup toolchain install stable --component rustfmt --component clippy",
      machineVerifiable: false,
    },
  };
}

export type DeploymentCheckComponent = {
  readonly kind: "deployment-image";
  readonly owner: PackageBoundaryOwner;
};

export type DeploymentCheckEnvironmentNeed = {
  readonly kind: "docker-engine";
};

export type FixComponent = {
  readonly kind: FixComponentKind;
  readonly owner: ComponentOwner;
};

export type FixPlan = {
  readonly components: FixComponent[];
};

function renderTurboPackageFilter(owner: ComponentOwner): string {
  if (owner.kind !== "package-boundary") {
    throw new Error("Turbo package tasks require a Package Boundary owner.");
  }

  return `--filter './${owner.path}'`;
}

export const qualityTaskVocabulary = [
  "boundaries",
  "format:check",
  "lint",
  "typecheck",
  "build",
  "test",
  "test:e2e",
] as const;

export function renderTurboRunCommand(
  taskNames: readonly string[],
  args: readonly string[] = [],
  options: {
    readonly outputLogs?: "errors-only" | "full";
    readonly continueAfterFailure?: boolean;
    readonly taskPrefix?: boolean;
  } = {},
): string {
  return [
    "turbo run",
    ...taskNames,
    ...args,
    ...(options.continueAfterFailure
      ? ["--continue=dependencies-successful"]
      : []),
    `--output-logs=${options.outputLogs ?? "errors-only"}`,
    "--log-order=grouped",
    ...(options.taskPrefix ? ["--log-prefix=task"] : []),
  ].join(" ");
}

export function fixComponentTaskName(component: FixComponent): string {
  return fixComponentTaskNames(component)[0] ?? "fix:run";
}

function fixComponentTaskNames(component: FixComponent): readonly string[] {
  switch (component.kind) {
    case "oxc-format-write":
    case "rustfmt-write":
      return ["format:write:run"];
    case "oxc-lint-fix":
      return ["lint:fix:run"];
    case "turbo-fix":
    case "turbo-package-fix":
      return ["format:write:run", "lint:fix:run"];
  }
}

function uniqueTaskNames(taskNames: readonly string[]): string[] {
  return [...new Set(taskNames)];
}

export function renderFixLeafCommand(component: FixComponent): string {
  switch (component.kind) {
    case "oxc-format-write":
      return "pnpm run format:write";
    case "oxc-lint-fix":
      return "pnpm run lint:fix";
    case "turbo-fix":
      return renderTurboRunCommand(["fix"]);
    case "turbo-package-fix":
      return renderTurboRunCommand(
        ["fix"],
        [renderTurboPackageFilter(component.owner)],
      );
    case "rustfmt-write":
      return "cargo fmt --all";
  }
}

export function renderRootCheckCommand(): string {
  return renderTurboRunCommand(qualityTaskVocabulary, [], {
    continueAfterFailure: true,
    taskPrefix: true,
  });
}

export function deploymentCheckEnvironmentNeeds(
  check: DeploymentCheckComponent,
): DeploymentCheckEnvironmentNeed[] {
  switch (check.kind) {
    case "deployment-image":
      return [{ kind: "docker-engine" }];
  }
}

export function deploymentCheckTaskName(
  check: DeploymentCheckComponent,
): "check:deployment" {
  switch (check.kind) {
    case "deployment-image":
      return "check:deployment";
  }
}

export function renderDeploymentCheckLeafCommand(
  check: DeploymentCheckComponent,
): string {
  return `pnpm --filter './${check.owner.path}' run ${deploymentCheckTaskName(check)}`;
}

export function renderDeploymentCheckCommand(plan: {
  readonly deploymentChecks?: readonly DeploymentCheckComponent[];
}): string {
  return uniqueTaskNames(
    (plan.deploymentChecks ?? []).map(renderDeploymentCheckLeafCommand),
  ).join(" && ");
}

export function renderFixCommand(plan: FixPlan): string {
  return renderTurboRunCommand(
    uniqueTaskNames([
      ...plan.components.flatMap(fixComponentTaskNames),
      "fix:run",
    ]),
  );
}

function playwrightBrowserInstallArgs(
  need: Pick<PlaywrightBrowserAssetsEnvironmentNeed, "browser" | "owner">,
  options: { readonly withDeps?: boolean } = {},
): string[] {
  const installArgs = [
    "exec",
    "playwright",
    "install",
    ...(options.withDeps ? ["--with-deps"] : []),
    need.browser,
  ];

  if (need.owner.kind === "package-boundary" && need.owner.path !== ".") {
    return ["--filter", `./${need.owner.path}`, ...installArgs];
  }

  return installArgs;
}

export function renderPlaywrightBrowserInstallCommand(
  need: CheckEnvironmentNeed,
  options: { readonly withDeps?: boolean } = {},
): string {
  if (need.kind !== "playwright-browser-assets") {
    throw new Error("Playwright install requires browser assets.");
  }
  return ["pnpm", ...playwrightBrowserInstallArgs(need, options)].join(" ");
}

export function playwrightBrowserAssetsNextStepDescriptor(
  owner: ComponentOwner,
): Pick<CheckEnvironmentNeed["nextStep"], "id" | "label"> {
  if (owner.kind === "package-boundary" && owner.path !== ".") {
    return {
      id: `install-${owner.path.replaceAll("/", "-")}-playwright-browsers`,
      label: `Install Playwright browser assets for ${owner.path} package`,
    };
  }

  return {
    id: "install-workspace-playwright-browsers",
    label: "Install Playwright browser assets for workspace",
  };
}

export function playwrightBrowserAssetsEnvironmentNeed(options: {
  readonly browser: "chromium";
  readonly owner: ComponentOwner;
  readonly id?: string;
  readonly label?: string;
  readonly machineVerifiable?: boolean;
}): PlaywrightBrowserAssetsEnvironmentNeed {
  const args = playwrightBrowserInstallArgs(options);
  const descriptor = playwrightBrowserAssetsNextStepDescriptor(options.owner);

  return {
    kind: "playwright-browser-assets",
    browser: options.browser,
    owner: options.owner,
    nextStep: {
      id: options.id ?? descriptor.id,
      label: options.label ?? descriptor.label,
      command: "pnpm",
      args,
      display: ["pnpm", ...args].join(" "),
      machineVerifiable: options.machineVerifiable ?? true,
    },
  };
}

export function shellCheckEnvironmentNeed(
  owner: ComponentOwner,
): ShellCheckEnvironmentNeed {
  return {
    kind: "shellcheck-command",
    owner,
    nextStep: {
      id: "install-shellcheck",
      label: "Install ShellCheck",
      command: "sudo",
      args: ["sh", "-c", "apt-get update && apt-get install -y shellcheck"],
      display: "sudo apt-get update && sudo apt-get install -y shellcheck",
      machineVerifiable: false,
    },
  };
}
