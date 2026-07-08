import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetProjectionDeclaration,
} from "@ykdz/template-builtin-source";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  playwrightBrowserAssetsEnvironmentNeed,
  renderFixCommand,
  renderRootCheckCommand,
  renderTurboRunCommand,
} from "@ykdz/template-core/module-graph";
import type {
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "@ykdz/template-core/preset-projection";
import { interpretPresetProjectionDeclaration } from "@ykdz/template-core/projection-capabilities";
import { renderNewProject } from "@ykdz/template-core/renderer";
import {
  PackageAdditionSupport,
  type BuiltInPreset,
  type ProjectBlueprint,
} from "@ykdz/template-shared";

export const vueHonoAppPresetMetadata: BuiltInPreset = {
  name: "vue-hono-app",
  title: "Vue Hono app",
  description:
    "Full-stack Vue and Hono workspace with separated app package boundaries.",
  generation: "supported",
  supportedPackageManagers: ["pnpm"],
  supportedProjectKinds: ["multi-package"],
  packageAdditionSupport: PackageAdditionSupport.Unsupported,
  features: [
    "pnpm-catalog",
    "oxc-format-lint",
    "strict-typescript",
    "root-check",
    "fix-command",
    "devcontainer",
    "github-actions",
    "dependabot",
  ],
};

const rootBoundary: ComponentOwner = {
  kind: "workspace-orchestration",
  path: ".",
};

const workspacePackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/*",
};

const webWorkspaceBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/web",
};

function planVueHonoRootChecks(): CheckPlan {
  return {
    components: [
      { kind: "oxc-format-check", owner: rootBoundary },
      { kind: "oxc-lint", owner: rootBoundary },
      { kind: "typescript-typecheck", owner: rootBoundary },
      { kind: "turbo-package-check", owner: workspacePackageBoundary },
    ],
    environmentNeeds: [
      playwrightBrowserAssetsEnvironmentNeed({
        browser: "chromium",
        owner: webWorkspaceBoundary,
        id: "install-web-playwright-browsers",
        label: "Install Playwright browser assets for web workspace",
      }),
    ],
  };
}

function planVueHonoRootFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: rootBoundary },
      { kind: "oxc-lint-fix", owner: rootBoundary },
      { kind: "turbo-package-fix", owner: workspacePackageBoundary },
    ],
  };
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageScopeFromOptions(options: PresetBlueprintOptions): string {
  return options.scope ?? projectNameFromDir(options.targetDir);
}

function scopedPackageName(packageScope: string, leaf: "api" | "web"): string {
  return `@${packageScope}/${leaf}`;
}

export function vueHonoAppBlueprint(
  options: PresetBlueprintOptions,
): ProjectBlueprint {
  const packageScope = packageScopeFromOptions(options);

  return {
    schemaVersion: 1,
    preset: "vue-hono-app",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...vueHonoAppPresetMetadata.features],
    packages: [
      { name: scopedPackageName(packageScope, "web"), path: "apps/web" },
      { name: scopedPackageName(packageScope, "api"), path: "apps/api" },
    ],
  };
}

export function projectVueHonoRootPackageScripts(): Record<string, string> {
  return {
    check: `pnpm run check:boundaries && ${renderRootCheckCommand(planVueHonoRootChecks())}`,
    "check:boundaries": "turbo boundaries",
    "check:run": 'node -e ""',
    dev: "turbo run dev --parallel",
    fix: renderFixCommand(planVueHonoRootFixes()),
    "fix:run": 'node -e ""',
    "format:check": renderTurboRunCommand(["format:check:run"]),
    "format:check:run":
      "oxfmt --list-different oxlint.config.ts oxfmt.config.ts",
    "format:write": renderTurboRunCommand(["format:write:run"]),
    "format:write:run": "oxfmt --write oxlint.config.ts oxfmt.config.ts",
    lint: renderTurboRunCommand(["lint:run"]),
    "lint:fix": renderTurboRunCommand(["lint:fix:run"]),
    "lint:fix:run":
      "oxlint --format=unix oxlint.config.ts oxfmt.config.ts --fix",
    "lint:run": "oxlint --quiet --format=unix oxlint.config.ts oxfmt.config.ts",
    typecheck: renderTurboRunCommand(["typecheck:run"]),
    "typecheck:run": "tsc -p tsconfig.config.json --noEmit --pretty false",
  };
}

export function projectVueHonoApiPackageScripts(): Record<string, string> {
  return {
    "build:run":
      "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    dev: "tsx watch src/server.ts",
    "format:check:run":
      "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
    "lint:run":
      "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix:run":
      "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    start: "node dist/server.js",
    "test:run": "vitest run --reporter=agent --silent=passed-only",
    "typecheck:run": "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

export function projectVueHonoWebPackageScripts(): Record<string, string> {
  return {
    "build:run": "vite build",
    dev: "vite",
    "format:check:run":
      "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
    "lint:run":
      "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix:run":
      "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    preview: "vite preview",
    "test:run": "vitest run --reporter=agent --silent=passed-only",
    "test:e2e:run": "node --experimental-strip-types scripts/run-playwright.ts",
    "typecheck:run": "vue-tsc --build --pretty false",
  };
}

export const vueHonoAppPresetProjection: PresetProjection = {
  metadata: vueHonoAppPresetMetadata,
  blueprint: vueHonoAppBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    return interpretPresetProjectionDeclaration({
      preset: vueHonoAppPresetMetadata,
      declaration: loadBuiltInPresetProjectionDeclaration("vue-hono-app"),
      context,
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });
  },
  async render({ targetDir, plan }): Promise<void> {
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
  },
};
