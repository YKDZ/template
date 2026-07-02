export type PackageRole = "shared-library";

export type PackageSourcePreset = "ts-lib";

export type PackageDefinition = {
  readonly name: string;
  readonly path: string;
  readonly role: PackageRole;
  readonly sourcePreset: PackageSourcePreset;
};

export type JitSourcePackageExposure = {
  readonly kind: "jit-source";
  readonly entrypoint: string;
  readonly packageLocalImportPattern: string;
  readonly packageLocalImportTarget: string;
};

export type PackageExposure = JitSourcePackageExposure;

export type PackageLinkPlan = {
  readonly exposuresByPackagePath: ReadonlyMap<string, PackageExposure>;
};

export type PackageManifestExposureFields = {
  readonly exports: Record<string, unknown>;
  readonly imports: Record<string, unknown>;
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

  throw new Error(
    `Unsupported Package Exposure for ${definition.name} at ${definition.path}`,
  );
}

export function planPackageLinks(
  definitions: readonly PackageDefinition[],
): PackageLinkPlan {
  return {
    exposuresByPackagePath: new Map(
      definitions.map((definition) => [
        definition.path,
        derivePackageExposure(definition),
      ]),
    ),
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
  }
}
