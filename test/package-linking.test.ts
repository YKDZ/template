import {
  packageManifestExposureFields,
  planPackageLinks,
} from "@ykdz/template-core/package-linking";

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

  it("derives compiled runtime exposure with source types for a Hono API service", () => {
    const plan = planPackageLinks([
      {
        name: "@demo/api",
        path: "apps/api",
        role: "runtime-service",
        sourcePreset: "hono-api",
      },
    ]);
    const exposure = plan.exposuresByPackagePath.get("apps/api");

    expect(exposure).toEqual({
      kind: "compiled",
      entrypoint: "./dist/index.js",
      sourceTypes: "./src/index.ts",
      packageLocalImportPattern: "#/*",
      packageLocalImportRuntimeTarget: "./dist/*.js",
      packageLocalImportTypesTarget: "./src/*.ts",
    });
    expect(packageManifestExposureFields(exposure!)).toEqual({
      types: "./src/index.ts",
      exports: {
        ".": {
          default: "./dist/index.js",
          types: "./src/index.ts",
        },
      },
      imports: {
        "#/*": {
          default: "./dist/*.js",
          types: "./src/*.ts",
        },
      },
    });
  });

  it("derives a workspace dependency and provider exposure for a consumer link intent", () => {
    const plan = planPackageLinks(
      [
        {
          name: "@demo/api",
          path: "apps/api",
          role: "runtime-service",
          sourcePreset: "hono-api",
        },
      ],
      [{ consumerPackagePath: "apps/web", providerPackagePath: "apps/api" }],
    );

    expect(plan.manifestDependenciesByPackagePath.get("apps/web")).toEqual({
      "@demo/api": "workspace:*",
    });
    expect(plan.exposuresByPackagePath.get("apps/api")).toEqual(
      expect.objectContaining({ kind: "compiled" }),
    );
  });

  it("derives one provider exposure and idempotent workspace dependencies for repeated link intents", () => {
    const plan = planPackageLinks(
      [
        {
          name: "@demo/shared",
          path: "packages/shared",
          role: "shared-library",
          sourcePreset: "ts-lib",
        },
      ],
      [
        {
          consumerPackagePath: "apps/web",
          providerPackagePath: "packages/shared",
        },
        {
          consumerPackagePath: "apps/api",
          providerPackagePath: "packages/shared",
        },
        {
          consumerPackagePath: "apps/web",
          providerPackagePath: "packages/shared",
        },
      ],
    );

    expect([...plan.exposuresByPackagePath.keys()]).toEqual([
      "packages/shared",
    ]);
    expect(plan.manifestDependenciesByPackagePath.get("apps/web")).toEqual({
      "@demo/shared": "workspace:*",
    });
    expect(plan.manifestDependenciesByPackagePath.get("apps/api")).toEqual({
      "@demo/shared": "workspace:*",
    });
  });

  it("rejects a Package Link Intent to a native provider in V1 TypeScript-only Project Linking", () => {
    expect(() =>
      planPackageLinks(
        [
          {
            name: "@demo/shared",
            path: "packages/shared",
            role: "shared-library",
            sourcePreset: "ts-lib",
          },
          {
            name: "demo-native",
            path: "packages/native",
          },
        ],
        [
          {
            consumerPackagePath: "packages/shared",
            providerPackagePath: "packages/native",
          },
        ],
      ),
    ).toThrow(
      "Package Link Intent to native package packages/native is unsupported in V1 TypeScript-only Project Linking",
    );
  });

  it("rejects a Package Link Intent from a native package to a native provider in V1 TypeScript-only Project Linking", () => {
    expect(() =>
      planPackageLinks(
        [
          {
            name: "demo-consumer",
            path: "packages/consumer",
          },
          {
            name: "demo-provider",
            path: "packages/provider",
          },
        ],
        [
          {
            consumerPackagePath: "packages/consumer",
            providerPackagePath: "packages/provider",
          },
        ],
      ),
    ).toThrow(
      "Package Link Intent from native package packages/consumer is unsupported in V1 TypeScript-only Project Linking",
    );
  });

  it("derives Turbo task relationships for typecheck invalidation and compiled runtime artifacts", () => {
    const jitPlan = planPackageLinks(
      [
        {
          name: "@demo/web",
          path: "apps/web",
          role: "shared-library",
          sourcePreset: "ts-lib",
        },
        {
          name: "@demo/shared",
          path: "packages/shared",
          role: "shared-library",
          sourcePreset: "ts-lib",
        },
      ],
      [
        {
          consumerPackagePath: "apps/web",
          providerPackagePath: "packages/shared",
        },
      ],
    );

    expect(jitPlan.turboTasks).toEqual({
      typecheck: { dependsOn: ["^typecheck"] },
      build: { outputs: ["dist/**"] },
      test: { dependsOn: ["^typecheck"] },
      "test:e2e": { dependsOn: ["build"] },
      check: { dependsOn: ["typecheck", "build", "test", "test:e2e"] },
      fix: { cache: false },
    });

    const compiledPlan = planPackageLinks(
      [
        {
          name: "@demo/web",
          path: "apps/web",
          role: "shared-library",
          sourcePreset: "ts-lib",
        },
        {
          name: "@demo/api",
          path: "apps/api",
          role: "runtime-service",
          sourcePreset: "hono-api",
        },
      ],
      [{ consumerPackagePath: "apps/web", providerPackagePath: "apps/api" }],
    );

    expect(compiledPlan.turboTasks).toEqual({
      typecheck: { dependsOn: ["^typecheck"] },
      build: { dependsOn: ["^build"], outputs: ["dist/**"] },
      test: { dependsOn: ["^typecheck"] },
      "test:e2e": { dependsOn: ["build", "^build"] },
      check: { dependsOn: ["typecheck", "build", "test", "test:e2e"] },
      fix: { cache: false },
    });
  });
});
