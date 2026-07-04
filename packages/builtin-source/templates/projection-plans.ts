import type {
  CheckComponent,
  CheckEnvironmentNeed,
  CheckPlan,
  ComponentOwner,
  FixComponent,
  FixPlan,
} from "@ykdz/template-core/module-graph";

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

export function selectNodeCheckComponents(
  target: NodeCheckPlanTarget,
): CheckComponent[] {
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

export function selectNodeFixComponents(
  target: NodeFixPlanTarget,
): FixComponent[] {
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

function checkEnvironmentNeeds(
  target: NodeCheckPlanTarget,
): CheckEnvironmentNeed[] {
  if (target === "vue-app") {
    return [
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: rootPackageBoundary,
      },
    ];
  }

  if (target === "vue-hono-root" || target === "vue-hono-web") {
    return [
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: webPackageBoundary,
      },
    ];
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
