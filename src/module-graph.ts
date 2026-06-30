export type PackageBoundaryOwner = {
  readonly kind: "package-boundary";
  readonly path: ".";
};

export type ComponentOwner = PackageBoundaryOwner;

export type CheckComponentKind = "typescript-typecheck" | "oxc-lint" | "oxc-format-check";

export type FixComponentKind = "oxc-format-write" | "oxc-lint-fix";

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
};

export type FixPlan = {
  readonly components: FixComponent[];
};

const tsLibPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

export function selectTsLibCheckComponents(): CheckComponent[] {
  return [
    { kind: "typescript-typecheck", owner: tsLibPackageBoundary },
    { kind: "oxc-lint", owner: tsLibPackageBoundary },
    { kind: "oxc-format-check", owner: tsLibPackageBoundary },
  ];
}

export function selectTsLibFixComponents(): FixComponent[] {
  return [
    { kind: "oxc-format-write", owner: tsLibPackageBoundary },
    { kind: "oxc-lint-fix", owner: tsLibPackageBoundary },
  ];
}

export function planTsLibChecks(): CheckPlan {
  return { components: selectTsLibCheckComponents() };
}

export function planTsLibFixes(): FixPlan {
  return { components: selectTsLibFixComponents() };
}

function renderCheckComponentCommand(component: CheckComponent): string {
  switch (component.kind) {
    case "typescript-typecheck":
      return "pnpm run typecheck";
    case "oxc-lint":
      return "pnpm run lint";
    case "oxc-format-check":
      return "pnpm run format:check";
  }
}

function renderFixComponentCommand(component: FixComponent): string {
  switch (component.kind) {
    case "oxc-format-write":
      return "pnpm run format:write";
    case "oxc-lint-fix":
      return "pnpm run lint:fix";
  }
}

export function renderRootCheckCommand(plan: CheckPlan): string {
  return plan.components.map(renderCheckComponentCommand).join(" && ");
}

export function renderFixCommand(plan: FixPlan): string {
  return plan.components.map(renderFixComponentCommand).join(" && ");
}
