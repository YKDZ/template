import type {
  CheckComponent,
  CheckEnvironmentNeed,
  CheckPlan,
  ComponentOwner,
  FixComponent,
  FixPlan,
} from "@ykdz/template-core/module-graph";
import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-core/module-graph";

const appsWorkspaceBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/*",
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
      return honoApiCheckComponents(apiPackageBoundary);
    case "vue-app":
      return vueAppCheckComponents(webPackageBoundary);
    case "vue-hono-root":
      return [{ kind: "turbo-check", owner: appsWorkspaceBoundary }];
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
      return nodeFixComponents(apiPackageBoundary);
    case "vue-app":
      return nodeFixComponents(webPackageBoundary);
    case "vue-hono-root":
      return [{ kind: "turbo-fix", owner: appsWorkspaceBoundary }];
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
      playwrightBrowserAssetsEnvironmentNeed({
        browser: "chromium",
        owner: webPackageBoundary,
        id: "install-playwright-browsers",
        label: "Install Playwright browser assets",
      }),
    ];
  }

  if (target === "vue-hono-root" || target === "vue-hono-web") {
    return [
      playwrightBrowserAssetsEnvironmentNeed({
        browser: "chromium",
        owner: webPackageBoundary,
        id: "install-web-playwright-browsers",
        label: "Install Playwright browser assets for web workspace",
      }),
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
