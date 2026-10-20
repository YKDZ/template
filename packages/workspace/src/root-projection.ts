import type { ProjectProjectionReconciliation } from "@ykdz/template-core/project-projection";
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

export function projectToolchainMirrorManifest(
  reconciliation: readonly ProjectProjectionReconciliation[],
): RenderOperation {
  return {
    kind: "writeJson",
    to: "scripts/toolchain-mirrors.json",
    value: reconciliation.flatMap((policy) =>
      policy.driver === "canonical"
        ? []
        : (policy.mirrorSlots ?? []).map((slot) => ({
            id: slot.id,
            path: policy.path,
            location: slot.location,
          })),
    ),
  };
}

export type WorkspaceRootInsertion = {
  readonly before: string;
  readonly values: Readonly<Record<string, string>>;
};

function insertBefore(
  values: Readonly<Record<string, string>>,
  insertions: readonly WorkspaceRootInsertion[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    for (const insertion of insertions) {
      if (insertion.before === key) {
        Object.assign(result, insertion.values);
      }
    }
    result[key] = value;
  }
  return result;
}

export function createWorkspaceRootManifest(options: {
  readonly name: string;
  readonly typescriptConfigurationPackageName?: string;
  readonly nodeDeclaration: string;
  readonly packageManagerPin: string;
  readonly imports?: Readonly<Record<string, string>>;
  readonly scriptOverrides?: Readonly<Record<string, string>>;
  readonly scriptInsertions?: readonly WorkspaceRootInsertion[];
  readonly dependencyInsertions?: readonly WorkspaceRootInsertion[];
}): Record<string, unknown> {
  const scripts = {
    check: "node --conditions=source scripts/task-gates.ts check",
    "check:heavy": "node --conditions=source scripts/task-gates.ts check:heavy",
    "check:full": "node --conditions=source scripts/task-gates.ts check:full",
    boundaries:
      "node --conditions=source scripts/run-turbo-boundaries.ts && node --conditions=source scripts/check-toolchain-versions.ts",
    fix: "node --conditions=source scripts/task-gates.ts fix",
    "format:check":
      "oxfmt --list-different --no-error-on-unmatched-pattern *.json pnpm-workspace.yaml pnpm-lock.yaml *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer scripts",
    "format:write":
      "oxfmt --write --no-error-on-unmatched-pattern *.json pnpm-workspace.yaml pnpm-lock.yaml *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer scripts",
    lint: "oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts",
    "lint:fix":
      "oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts --fix",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
    ...options.scriptOverrides,
  };
  const developmentDependencies = insertBefore(
    {
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
    },
    options.dependencyInsertions ?? [],
  );
  return {
    name: options.name,
    private: true,
    type: "module",
    ...(options.imports === undefined ? {} : { imports: options.imports }),
    scripts: insertBefore(scripts, options.scriptInsertions ?? []),
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
