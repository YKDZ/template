export type PackageBoundaryOwner = {
  readonly kind: "package-boundary";
  readonly path: string;
};

export type WorkspaceOrchestrationOwner = {
  readonly kind: "workspace-orchestration";
  readonly path: ".";
};

export type ComponentOwner = PackageBoundaryOwner | WorkspaceOrchestrationOwner;

export type CheckComponentKind =
  | "typescript-typecheck"
  | "oxc-lint"
  | "oxc-format-check"
  | "build"
  | "unit-test"
  | "e2e-test"
  | "turbo-check"
  | "turbo-package-typecheck"
  | "turbo-package-build"
  | "turbo-package-test"
  | "turbo-package-e2e-test"
  | "turbo-package-check"
  | "rustfmt-check"
  | "cargo-clippy"
  | "cargo-test";

export type FixComponentKind =
  | "oxc-format-write"
  | "oxc-lint-fix"
  | "turbo-fix"
  | "turbo-package-fix"
  | "rustfmt-write";

export type CheckEnvironmentNeed = {
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

export type CheckComponent = {
  readonly kind: CheckComponentKind;
  readonly owner: ComponentOwner;
};

export type FixComponent = {
  readonly kind: FixComponentKind;
  readonly owner: ComponentOwner;
};

export type CheckPlan = {
  readonly components: CheckComponent[];
  readonly environmentNeeds: CheckEnvironmentNeed[];
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

const turboAgentOutputArgs = [
  "--output-logs=errors-only",
  "--log-order=grouped",
] as const;

export function renderTurboRunCommand(
  taskNames: readonly string[],
  args: readonly string[] = [],
): string {
  return ["turbo run", ...taskNames, ...args, ...turboAgentOutputArgs].join(
    " ",
  );
}

export function checkComponentTaskName(component: CheckComponent): string {
  return checkComponentTaskNames(component)[0] ?? "check:run";
}

function checkComponentTaskNames(component: CheckComponent): readonly string[] {
  switch (component.kind) {
    case "typescript-typecheck":
    case "turbo-package-typecheck":
      return ["typecheck:run"];
    case "oxc-lint":
    case "cargo-clippy":
      return ["lint:run"];
    case "oxc-format-check":
    case "rustfmt-check":
      return ["format:check:run"];
    case "build":
    case "turbo-package-build":
      return ["build:run"];
    case "unit-test":
    case "cargo-test":
    case "turbo-package-test":
      return ["test:run"];
    case "e2e-test":
    case "turbo-package-e2e-test":
      return ["test:e2e:run"];
    case "turbo-check":
    case "turbo-package-check":
      return [
        "format:check:run",
        "lint:run",
        "typecheck:run",
        "build:run",
        "test:run",
        "test:e2e:run",
      ];
  }
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

export function renderCheckLeafCommand(component: CheckComponent): string {
  switch (component.kind) {
    case "typescript-typecheck":
      return "pnpm run typecheck";
    case "oxc-lint":
      return "pnpm run lint";
    case "oxc-format-check":
      return "pnpm run format:check";
    case "build":
      return "pnpm run build";
    case "unit-test":
      return "pnpm run test";
    case "e2e-test":
      return "pnpm run test:e2e";
    case "turbo-check":
      return renderTurboRunCommand(["check"]);
    case "turbo-package-typecheck":
      return renderTurboRunCommand(
        ["typecheck"],
        [renderTurboPackageFilter(component.owner)],
      );
    case "turbo-package-build":
      return renderTurboRunCommand(
        ["build"],
        [renderTurboPackageFilter(component.owner)],
      );
    case "turbo-package-test":
      return renderTurboRunCommand(
        ["test"],
        [renderTurboPackageFilter(component.owner)],
      );
    case "turbo-package-e2e-test":
      return renderTurboRunCommand(
        ["test:e2e"],
        [renderTurboPackageFilter(component.owner)],
      );
    case "turbo-package-check":
      return renderTurboRunCommand(
        ["check"],
        [renderTurboPackageFilter(component.owner)],
      );
    case "rustfmt-check":
      return "cargo fmt --all -- --check";
    case "cargo-clippy":
      return "cargo clippy --workspace --all-targets -- -D warnings";
    case "cargo-test":
      return "cargo test --workspace";
  }
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

export function renderRootCheckCommand(plan: CheckPlan): string {
  return renderTurboRunCommand(
    uniqueTaskNames([
      ...plan.components.flatMap(checkComponentTaskNames),
      "check:run",
    ]),
  );
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
  need: Pick<CheckEnvironmentNeed, "browser" | "owner">,
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
}): CheckEnvironmentNeed {
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
