import {
  packageManifestExposureFields,
  planPackageLinks,
} from "../src/package-linking.js";

describe("Package Link Planning", () => {
  it("derives JIT source exposure and Package-Local Imports for a TypeScript shared library", () => {
    const plan = planPackageLinks([
      {
        name: "@demo/shared",
        path: "packages/shared",
        role: "shared-library",
        sourcePreset: "ts-lib",
      },
    ]);
    const exposure = plan.exposuresByPackagePath.get("packages/shared");

    expect(exposure).toEqual({
      kind: "jit-source",
      entrypoint: "./src/index.ts",
      packageLocalImportPattern: "#/*",
      packageLocalImportTarget: "./src/*.ts",
    });
    expect(packageManifestExposureFields(exposure!)).toEqual({
      exports: {
        ".": {
          default: "./src/index.ts",
          types: "./src/index.ts",
        },
      },
      imports: {
        "#/*": {
          default: "./src/*.ts",
          types: "./src/*.ts",
        },
      },
    });
  });
});
