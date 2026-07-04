import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetProjectionDeclaration,
} from "@ykdz/template-builtin-source";
import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "@ykdz/template-core/declarations";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "@ykdz/template-core/module-graph";
import { PackageAdditionSupport } from "@ykdz/template-core/package-addition-support";
import type {
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "@ykdz/template-core/preset-projection";
import { interpretPresetProjectionDeclaration } from "@ykdz/template-core/projection-capabilities";
import { renderNewProject } from "@ykdz/template-core/renderer";

export const vueHonoAppPresetMetadata: BuiltInPreset = {
  name: "vue-hono-app",
  title: "Vue Hono app",
  description: "Full-stack Vue and Hono workspace with Hono RPC typing.",
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

const apiPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const webPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
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

function honoApiCheckComponents(owner: ComponentOwner) {
  return [
    { kind: "oxc-format-check", owner },
    { kind: "oxc-lint", owner },
    { kind: "typescript-typecheck", owner },
    { kind: "build", owner },
    { kind: "unit-test", owner },
  ] as const;
}

function vueWebCheckComponents(owner: ComponentOwner) {
  return [
    { kind: "oxc-format-check", owner },
    { kind: "oxc-lint", owner },
    { kind: "typescript-typecheck", owner },
    { kind: "build", owner },
    { kind: "unit-test", owner },
    { kind: "e2e-test", owner },
  ] as const;
}

function nodeFixComponents(owner: ComponentOwner) {
  return [
    { kind: "oxc-format-write", owner },
    { kind: "oxc-lint-fix", owner },
  ] as const;
}

function planVueHonoRootChecks(): CheckPlan {
  return {
    components: [
      { kind: "oxc-format-check", owner: rootBoundary },
      { kind: "oxc-lint", owner: rootBoundary },
      { kind: "typescript-typecheck", owner: rootBoundary },
      { kind: "turbo-package-typecheck", owner: workspacePackageBoundary },
      { kind: "turbo-package-build", owner: workspacePackageBoundary },
      { kind: "turbo-package-test", owner: workspacePackageBoundary },
      { kind: "turbo-package-check", owner: workspacePackageBoundary },
    ],
    environmentNeeds: [
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: webWorkspaceBoundary,
      },
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

function planVueHonoApiChecks(): CheckPlan {
  return {
    components: [...honoApiCheckComponents(apiPackageBoundary)],
    environmentNeeds: [],
  };
}

function planVueHonoWebChecks(): CheckPlan {
  return {
    components: [...vueWebCheckComponents(webPackageBoundary)],
    environmentNeeds: [],
  };
}

function planVueHonoPackageFixes(owner: ComponentOwner): FixPlan {
  return {
    components: [...nodeFixComponents(owner)],
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
    check: renderRootCheckCommand(planVueHonoRootChecks()),
    dev: "turbo run dev --parallel",
    fix: renderFixCommand(planVueHonoRootFixes()),
    "format:check":
      "oxfmt --check --config oxfmt.config.ts oxlint.config.ts oxfmt.config.ts",
    "format:write":
      "oxfmt --write --config oxfmt.config.ts oxlint.config.ts oxfmt.config.ts",
    lint: "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts",
    "lint:fix":
      "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts --fix",
    typecheck: "tsc -p tsconfig.config.json --noEmit",
  };
}

export function projectVueHonoApiPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    check: renderRootCheckCommand(planVueHonoApiChecks()),
    dev: "tsx watch src/server.ts",
    fix: renderFixCommand(planVueHonoPackageFixes(apiPackageBoundary)),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --config ../../oxlint.config.ts . --fix",
    start: "node dist/server.js",
    test: "vitest run",
    typecheck: "tsc -p tsconfig.json --noEmit",
  };
}

export function projectVueHonoWebPackageScripts(): Record<string, string> {
  return {
    build: "vite build",
    check: renderRootCheckCommand(planVueHonoWebChecks()),
    dev: "vite",
    fix: renderFixCommand(planVueHonoPackageFixes(webPackageBoundary)),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --config ../../oxlint.config.ts . --fix",
    preview: "vite preview",
    test: "vitest run",
    "test:e2e":
      "pnpm run build && node --experimental-strip-types scripts/run-playwright.ts",
    typecheck: "vue-tsc --build",
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
