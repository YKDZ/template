import type { RenderOperation } from "@ykdz/template-core/renderer";
import { mapPackageNamesInJson } from "@ykdz/template-workspace-authoring/package-name-projection";
import { stringify as stringifyYaml } from "yaml";

import { workspaceInstallPolicySnapshot } from "./workspace-policy-snapshot.ts";

export const packageManifestKeyOrder = [
  "name",
  "version",
  "private",
  "bin",
  "files",
  "type",
  "types",
  "imports",
  "exports",
  "publishConfig",
  "scripts",
  "dependencies",
  "devDependencies",
  "dependenciesMeta",
  "peerDependencies",
  "optionalDependencies",
  "engines",
  "packageManager",
] as const;

export const packageConditionKeyOrder = ["source", "types", "default"] as const;

export function createWorkspaceRootManifest(options: {
  readonly name: string;
  readonly typescriptConfigurationPackageName?: string;
  readonly nodeDeclaration: string;
  readonly packageManagerPin: string;
}): Record<string, unknown> {
  const scripts = {
    check: "node --conditions=source scripts/task-gates.ts check",
    "check:heavy": "node --conditions=source scripts/task-gates.ts check:heavy",
    "check:full": "node --conditions=source scripts/task-gates.ts check:full",
    boundaries: "turbo boundaries",
    fix: "node --conditions=source scripts/task-gates.ts fix",
    "format:check":
      "oxfmt --list-different --no-error-on-unmatched-pattern *.json pnpm-workspace.yaml pnpm-lock.yaml *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer scripts",
    "format:write":
      "oxfmt --write --no-error-on-unmatched-pattern *.json pnpm-workspace.yaml pnpm-lock.yaml *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer scripts",
    lint: "oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts",
    "lint:fix":
      "oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts --fix",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
  const developmentDependencies = {
    ...(options.typescriptConfigurationPackageName === undefined
      ? {}
      : {
          [options.typescriptConfigurationPackageName]: "workspace:*",
        }),
    "@types/node": "catalog:",
    oxfmt: "catalog:",
    oxlint: "catalog:",
    "oxlint-tsgolint": "catalog:",
    "smol-toml": "catalog:",
    turbo: "catalog:",
    "typescript-7": "catalog:",
  };

  return {
    name: options.name,
    private: true,
    type: "module",
    scripts,
    devDependencies: developmentDependencies,
    engines: { node: options.nodeDeclaration },
    packageManager: options.packageManagerPin,
  };
}

export function projectPreparedWorkspaceRoot(options: {
  readonly rootManifest: Readonly<Record<string, unknown>>;
  readonly packageGlobs: readonly string[];
  readonly dependencyCatalog: Readonly<Record<string, string>>;
  readonly dependencyOverrides: Readonly<Record<string, string>>;
  readonly turboTemplate: Readonly<Record<string, unknown>>;
  readonly referenceNames: ReadonlyMap<string, string>;
  readonly turboBoundaryTags?: readonly ("app" | "library")[];
  readonly rootTsconfigTemplate: Readonly<Record<string, unknown>>;
  readonly rootTsconfigCompilerOptions: Readonly<Record<string, unknown>>;
  readonly rootTsconfigInclude: readonly string[];
  readonly tsconfigConfigTemplate: Readonly<Record<string, unknown>>;
}): {
  readonly manifest: RenderOperation;
  readonly workspace: RenderOperation;
  readonly turbo: RenderOperation;
  readonly tsconfig: RenderOperation;
  readonly tsconfigConfig: RenderOperation;
} {
  const workspace = {
    ...workspaceInstallPolicySnapshot,
    packages: options.packageGlobs,
    overrides: options.dependencyOverrides,
    catalog: options.dependencyCatalog,
  };
  const rootTurbo = mapPackageNamesInJson(
    options.turboTemplate,
    options.referenceNames,
  ) as {
    tasks: Record<string, unknown>;
    boundaries?: { tags: Record<string, unknown> };
  };
  rootTurbo.tasks = Object.fromEntries(
    Object.entries(rootTurbo.tasks).filter(
      ([task]) =>
        task.startsWith("//#") &&
        Object.hasOwn(
          (options.rootManifest.scripts ?? {}) as object,
          task.slice(3),
        ),
    ),
  );
  if (
    rootTurbo.boundaries !== undefined &&
    options.turboBoundaryTags !== undefined
  ) {
    rootTurbo.boundaries.tags = Object.fromEntries(
      Object.entries(rootTurbo.boundaries.tags).filter(([tag]) =>
        options.turboBoundaryTags?.includes(tag as "app" | "library"),
      ),
    );
  }
  const rootTsconfig = {
    ...options.rootTsconfigTemplate,
    compilerOptions: {
      ...((options.rootTsconfigTemplate.compilerOptions ?? {}) as Record<
        string,
        unknown
      >),
      ...options.rootTsconfigCompilerOptions,
    },
    include: options.rootTsconfigInclude,
  };

  return {
    manifest: {
      kind: "writeJson",
      to: "package.json",
      value: options.rootManifest,
      keyOrder: packageManifestKeyOrder,
      nestedKeyOrder: packageConditionKeyOrder,
    },
    workspace: {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: stringifyYaml(workspace),
    },
    turbo: { kind: "writeJson", to: "turbo.json", value: rootTurbo },
    tsconfig: { kind: "writeJson", to: "tsconfig.json", value: rootTsconfig },
    tsconfigConfig: {
      kind: "writeJson",
      to: "tsconfig.config.json",
      value: mapPackageNamesInJson(
        options.tsconfigConfigTemplate,
        options.referenceNames,
      ),
    },
  };
}
