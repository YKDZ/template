import type {
  PackageLinkIntent,
  PackageRole,
  PackageSourcePreset,
} from "@ykdz/template-shared";

export type {
  PackageLinkIntent,
  PackageRole,
  PackageSourcePreset,
} from "@ykdz/template-shared";

export type PackageDefinition = {
  readonly name: string;
  readonly path: string;
  readonly role?: PackageRole;
  readonly sourcePreset?: PackageSourcePreset;
};

export type JitSourcePackageExposure = {
  readonly kind: "jit-source";
  readonly entrypoint: string;
  readonly packageLocalImportPattern: string;
  readonly packageLocalImportTarget: string;
};

export type CompiledPackageExposure = {
  readonly kind: "compiled";
  readonly entrypoint: string;
  readonly sourceTypes: string;
  readonly packageLocalImportPattern: string;
  readonly packageLocalImportRuntimeTarget: string;
  readonly packageLocalImportTypesTarget: string;
};

export type PackageExposure =
  | CompiledPackageExposure
  | JitSourcePackageExposure;

export type PackageLinkPlan = {
  readonly exposuresByPackagePath: ReadonlyMap<string, PackageExposure>;
  readonly manifestDependenciesByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, "workspace:*">>
  >;
  readonly turboTasks: TurboTaskGraph;
};

export type PackageManifestExposureFields = {
  readonly exports: Record<string, unknown>;
  readonly imports: Record<string, unknown>;
  readonly types?: string;
};

export type PackageLinkBoundaryDirection = "consumer" | "provider";

export type PackageLinkIntentCompatibility = {
  readonly consumer: PackageDefinition;
  readonly provider: PackageDefinition;
};

export type TurboTaskDefinition = {
  readonly dependsOn?: readonly string[];
  readonly outputs?: readonly string[];
  readonly cache?: boolean;
};

export type TurboTaskGraph = Readonly<Record<string, TurboTaskDefinition>>;

export type TurboBoundaryRule = {
  readonly dependencies?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly dependents?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
};

export type TurboBoundaries = {
  readonly tags: Readonly<Record<string, TurboBoundaryRule>>;
};

export type TurboConfig = {
  readonly tasks: TurboTaskGraph;
  readonly boundaries: TurboBoundaries;
};

export type PackageTurboTaskOptions = {
  readonly dependencyBuildsRequired: boolean;
};

export function derivePackageExposure(
  definition: PackageDefinition,
): PackageExposure {
  if (
    definition.role === "shared-library" &&
    definition.sourcePreset === "ts-lib"
  ) {
    return {
      kind: "jit-source",
      entrypoint: "./src/index.ts",
      packageLocalImportPattern: "#/*",
      packageLocalImportTarget: "./src/*.ts",
    };
  }

  if (
    definition.role === "runtime-service" &&
    definition.sourcePreset === "hono-api"
  ) {
    return {
      kind: "compiled",
      entrypoint: "./dist/index.js",
      sourceTypes: "./src/index.ts",
      packageLocalImportPattern: "#/*",
      packageLocalImportRuntimeTarget: "./dist/*.js",
      packageLocalImportTypesTarget: "./src/*.ts",
    };
  }

  throw new Error(
    `Unsupported Package Exposure for ${definition.name} at ${definition.path}`,
  );
}

export function assertTypeScriptPackageBoundaryForLinkIntent(
  definition: PackageDefinition,
  direction: PackageLinkBoundaryDirection,
): asserts definition is PackageDefinition & {
  readonly role: PackageRole;
  readonly sourcePreset: PackageSourcePreset;
} {
  if (definition.role !== undefined && definition.sourcePreset !== undefined) {
    return;
  }

  const relationship =
    direction === "consumer" ? "from native package" : "to native package";

  throw new Error(
    `Package Link Intent ${relationship} ${definition.path} is unsupported in V1 TypeScript-only Project Linking`,
  );
}

export function canPlanPackageLinkIntent({
  consumer,
  provider,
}: PackageLinkIntentCompatibility): boolean {
  try {
    assertTypeScriptPackageBoundaryForLinkIntent(consumer, "consumer");
    assertTypeScriptPackageBoundaryForLinkIntent(provider, "provider");
    derivePackageExposure(provider);
    return true;
  } catch {
    return false;
  }
}

export function planPackageLinks(
  definitions: readonly PackageDefinition[],
  intents: readonly PackageLinkIntent[] = [],
): PackageLinkPlan {
  const definitionsByPath = new Map(
    definitions.map((definition) => [definition.path, definition]),
  );
  const manifestDependenciesByPackagePath = new Map<
    string,
    Record<string, "workspace:*">
  >();

  for (const intent of intents) {
    const consumer = definitionsByPath.get(intent.consumerPackagePath);
    const provider = definitionsByPath.get(intent.providerPackagePath);

    if (consumer !== undefined) {
      assertTypeScriptPackageBoundaryForLinkIntent(consumer, "consumer");
    }

    if (provider === undefined) {
      throw new Error(
        `Package Link Intent references unknown provider package at ${intent.providerPackagePath}`,
      );
    }

    assertTypeScriptPackageBoundaryForLinkIntent(provider, "provider");
  }

  const exposuresByPackagePath = new Map(
    definitions.map((definition) => [
      definition.path,
      derivePackageExposure(definition),
    ]),
  );
  let dependencyBuildsRequired = false;

  for (const intent of intents) {
    const provider = definitionsByPath.get(intent.providerPackagePath);

    if (provider === undefined) {
      throw new Error(
        `Package Link Intent references unknown provider package at ${intent.providerPackagePath}`,
      );
    }

    if (exposuresByPackagePath.get(provider.path)?.kind === "compiled") {
      dependencyBuildsRequired = true;
    }

    const dependencies =
      manifestDependenciesByPackagePath.get(intent.consumerPackagePath) ?? {};
    dependencies[provider.name] = "workspace:*";
    manifestDependenciesByPackagePath.set(
      intent.consumerPackagePath,
      dependencies,
    );
  }

  return {
    exposuresByPackagePath,
    manifestDependenciesByPackagePath,
    turboTasks: packageTurboTasks({ dependencyBuildsRequired }),
  };
}

export function packageTurboTasks({
  dependencyBuildsRequired,
}: PackageTurboTaskOptions): TurboTaskGraph {
  return {
    "format:check:run": {},
    "format:write:run": { cache: false },
    "lint:run": {},
    "lint:fix:run": { cache: false },
    "typecheck:run": { dependsOn: ["^typecheck:run"] },
    "build:run": dependencyBuildsRequired
      ? { dependsOn: ["^build:run"], outputs: ["dist/**"] }
      : { outputs: ["dist/**"] },
    "test:run": { dependsOn: ["^typecheck:run"] },
    "test:e2e:run": {
      dependsOn: dependencyBuildsRequired
        ? ["build:run", "^build:run"]
        : ["build:run"],
    },
    "check:run": { cache: false },
    "fix:run": { cache: false },
  };
}

// Boundary violations are architecture problems. Do not loosen these rules to
// make a failing dependency graph pass; fix the dependency direction instead.
export function generatedRepositoryTurboBoundaries(): TurboBoundaries {
  return {
    tags: {
      app: {
        dependencies: {
          deny: ["app"],
        },
      },
      library: {
        dependencies: {
          deny: ["app"],
        },
      },
    },
  };
}

export function packageTurboConfig(
  options: PackageTurboTaskOptions,
): TurboConfig {
  return {
    tasks: packageTurboTasks(options),
    boundaries: generatedRepositoryTurboBoundaries(),
  };
}

export function packageManifestExposureFields(
  exposure: PackageExposure,
): PackageManifestExposureFields {
  switch (exposure.kind) {
    case "jit-source":
      return {
        imports: {
          [exposure.packageLocalImportPattern]: {
            default: exposure.packageLocalImportTarget,
            types: exposure.packageLocalImportTarget,
          },
        },
        exports: {
          ".": {
            default: exposure.entrypoint,
            types: exposure.entrypoint,
          },
        },
      };
    case "compiled":
      return {
        types: exposure.sourceTypes,
        imports: {
          [exposure.packageLocalImportPattern]: {
            default: exposure.packageLocalImportRuntimeTarget,
            types: exposure.packageLocalImportTypesTarget,
          },
        },
        exports: {
          ".": {
            default: exposure.entrypoint,
            types: exposure.sourceTypes,
          },
        },
      };
  }
}
