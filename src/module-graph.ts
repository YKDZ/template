import type { PresetName } from "./declarations.js";

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

const rootPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const apiPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/api",
};

const webPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/web",
};

const rustPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

export type NodeCheckPlanTarget =
  | "hono-api"
  | "vue-app"
  | "vue-hono-root"
  | "vue-hono-api"
  | "vue-hono-web";

export type NodeFixPlanTarget =
  | "hono-api"
  | "vue-app"
  | "vue-hono-root"
  | "vue-hono-api"
  | "vue-hono-web";

function honoApiCheckComponents(owner: ComponentOwner): CheckComponent[] {
  return [
    { kind: "oxc-format-check", owner },
    { kind: "oxc-lint", owner },
    { kind: "typescript-typecheck", owner },
    { kind: "build", owner },
    { kind: "unit-test", owner },
  ];
}

function vueAppCheckComponents(owner: ComponentOwner): CheckComponent[] {
  return [
    { kind: "oxc-format-check", owner },
    { kind: "oxc-lint", owner },
    { kind: "typescript-typecheck", owner },
    { kind: "build", owner },
    { kind: "unit-test", owner },
    { kind: "e2e-test", owner },
  ];
}

function nodeFixComponents(owner: ComponentOwner): FixComponent[] {
  return [
    { kind: "oxc-format-write", owner },
    { kind: "oxc-lint-fix", owner },
  ];
}

export function selectNodeCheckComponents(target: NodeCheckPlanTarget): CheckComponent[] {
  switch (target) {
    case "hono-api":
      return honoApiCheckComponents(rootPackageBoundary);
    case "vue-app":
      return vueAppCheckComponents(rootPackageBoundary);
    case "vue-hono-root":
      return [{ kind: "turbo-check", owner: rootPackageBoundary }];
    case "vue-hono-api":
      return honoApiCheckComponents(apiPackageBoundary);
    case "vue-hono-web":
      return vueAppCheckComponents(webPackageBoundary);
  }
}

export function selectNodeFixComponents(target: NodeFixPlanTarget): FixComponent[] {
  switch (target) {
    case "hono-api":
    case "vue-app":
      return nodeFixComponents(rootPackageBoundary);
    case "vue-hono-root":
      return [{ kind: "turbo-fix", owner: rootPackageBoundary }];
    case "vue-hono-api":
      return nodeFixComponents(apiPackageBoundary);
    case "vue-hono-web":
      return nodeFixComponents(webPackageBoundary);
  }
}

function checkEnvironmentNeeds(target: NodeCheckPlanTarget): CheckEnvironmentNeed[] {
  if (target === "vue-app") {
    return [
      { kind: "playwright-browser-assets", browser: "chromium", owner: rootPackageBoundary },
    ];
  }

  if (target === "vue-hono-root" || target === "vue-hono-web") {
    return [{ kind: "playwright-browser-assets", browser: "chromium", owner: webPackageBoundary }];
  }

  return [];
}

export function planNodeChecks(target: NodeCheckPlanTarget): CheckPlan {
  return {
    components: selectNodeCheckComponents(target),
    environmentNeeds: checkEnvironmentNeeds(target),
  };
}

export function planNodeFixes(target: NodeFixPlanTarget): FixPlan {
  return { components: selectNodeFixComponents(target) };
}

export function planRustBinChecks(): CheckPlan {
  return {
    components: [
      { kind: "rustfmt-check", owner: rustPackageBoundary },
      { kind: "cargo-clippy", owner: rustPackageBoundary },
      { kind: "cargo-test", owner: rustPackageBoundary },
    ],
    environmentNeeds: [],
  };
}

export function planRustBinFixes(): FixPlan {
  return {
    components: [{ kind: "rustfmt-write", owner: rustPackageBoundary }],
  };
}

export function planPresetChecks(preset: PresetName): CheckPlan | undefined {
  switch (preset) {
    case "hono-api":
    case "vue-app":
      return planNodeChecks(preset);
    case "vue-hono-app":
      return planNodeChecks("vue-hono-root");
    case "rust-bin":
      return planRustBinChecks();
    default:
      return undefined;
  }
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

export function renderPlaywrightBrowserInstallCommand(need: CheckEnvironmentNeed): string {
  if (need.owner.path === "apps/web") {
    return `pnpm --filter ./apps/web exec playwright install ${need.browser}`;
  }

  return `pnpm exec playwright install ${need.browser}`;
}
