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

function renderCheckComponentCommand(component: CheckComponent): string {
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
      return "turbo run check";
    case "turbo-package-typecheck":
      return `turbo run typecheck ${renderTurboPackageFilter(component.owner)}`;
    case "turbo-package-build":
      return `turbo run build ${renderTurboPackageFilter(component.owner)}`;
    case "turbo-package-test":
      return `turbo run test ${renderTurboPackageFilter(component.owner)}`;
    case "turbo-package-e2e-test":
      return `turbo run test:e2e ${renderTurboPackageFilter(component.owner)}`;
    case "turbo-package-check":
      return `turbo run check ${renderTurboPackageFilter(component.owner)}`;
    case "rustfmt-check":
      return "cargo fmt --all -- --check";
    case "cargo-clippy":
      return "cargo clippy --workspace --all-targets -- -D warnings";
    case "cargo-test":
      return "cargo test --workspace";
  }
}

function renderFixComponentCommand(component: FixComponent): string {
  switch (component.kind) {
    case "oxc-format-write":
      return "pnpm run format:write";
    case "oxc-lint-fix":
      return "pnpm run lint:fix";
    case "turbo-fix":
      return "turbo run fix";
    case "turbo-package-fix":
      return `turbo run fix ${renderTurboPackageFilter(component.owner)}`;
    case "rustfmt-write":
      return "cargo fmt --all";
  }
}

export function renderRootCheckCommand(plan: CheckPlan): string {
  return plan.components.map(renderCheckComponentCommand).join(" && ");
}

export function renderFixCommand(plan: FixPlan): string {
  return plan.components.map(renderFixComponentCommand).join(" && ");
}

export function renderPlaywrightBrowserInstallCommand(
  need: CheckEnvironmentNeed,
): string {
  if (need.owner.kind === "package-boundary" && need.owner.path !== ".") {
    return `pnpm --filter ./${need.owner.path} exec playwright install ${need.browser}`;
  }

  return `pnpm exec playwright install ${need.browser}`;
}
