export type PackageBoundaryOwner = {
  readonly kind: "package-boundary";
  readonly path: "." | "apps/api" | "apps/web";
};

export type ComponentOwner = PackageBoundaryOwner;

export type CheckComponentKind =
  | "typescript-typecheck"
  | "oxc-lint"
  | "oxc-format-check"
  | "build"
  | "unit-test"
  | "e2e-test"
  | "turbo-check"
  | "rustfmt-check"
  | "cargo-clippy"
  | "cargo-test";

export type FixComponentKind =
  | "oxc-format-write"
  | "oxc-lint-fix"
  | "turbo-fix"
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
  if (need.owner.path === "apps/web") {
    return `pnpm --filter ./apps/web exec playwright install ${need.browser}`;
  }

  return `pnpm exec playwright install ${need.browser}`;
}
