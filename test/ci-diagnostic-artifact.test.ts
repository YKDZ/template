import { describe, expect, it } from "vitest";

import {
  composeCiDiagnosticArtifacts,
  type CiDiagnosticArtifactDeclaration,
} from "#template-core/ci-diagnostic-artifact";
import {
  assertPackageContribution,
  type PackageContribution,
} from "#template-core/package-contribution";
import {
  projectCheckWorkflowPlan,
  projectCheckWorkflowTemplateSource,
  projectCheckWorkflowTemplateReplacements,
} from "#template-core/project-github";

const playwright = (path: string): CiDiagnosticArtifactDeclaration => ({
  kind: "playwright",
  owner: { kind: "package-boundary", path },
});

function packageContribution(
  path: string,
  artifacts: readonly CiDiagnosticArtifactDeclaration[],
): PackageContribution {
  return {
    definition: { name: "@demo/web", path, role: "runtime-service" },
    manifest: { name: "@demo/web" },
    exposure: { exports: {}, imports: {} },
    operations: [],
    foundation: {
      toolchains: {},
      editorCapabilities: [],
      dependencyMaintenance: { ecosystems: [], interval: "weekly" },
    },
    environmentNeeds: [],
    ciDiagnosticArtifacts: artifacts,
  };
}

describe("CI Diagnostic Artifact contract", () => {
  it("returns only ordered, deduplicated closed declarations", () => {
    expect(
      composeCiDiagnosticArtifacts({
        packagePaths: ["apps/web", "apps/admin"],
        declarations: [
          playwright("apps/web"),
          playwright("apps/admin"),
          playwright("apps/web"),
        ],
      }),
    ).toEqual([
      {
        kind: "playwright",
        owner: { kind: "package-boundary", path: "apps/admin" },
      },
      {
        kind: "playwright",
        owner: { kind: "package-boundary", path: "apps/web" },
      },
    ]);
  });

  it("rejects unrecognized kinds, unsafe paths, unknown owners, and extra upload fields", () => {
    const packagePaths = ["apps/web"];
    for (const declaration of [
      {
        kind: "coverage",
        owner: { kind: "package-boundary", path: "apps/web" },
      },
      playwright("../secrets"),
      playwright("apps/admin"),
      {
        ...playwright("apps/web"),
        path: "**/*",
      },
    ]) {
      expect(() =>
        composeCiDiagnosticArtifacts({
          packagePaths,
          declarations: [declaration],
        }),
      ).toThrow();
    }
  });

  it("derives only ordered owner facts from actual Package Boundary paths", () => {
    const packagePaths = ["apps/web"];
    expect(
      projectCheckWorkflowPlan({
        packagePaths,
        diagnosticArtifacts: [playwright("apps/web")],
      }).packagePaths,
    ).toEqual(packagePaths);
    expect(
      projectCheckWorkflowTemplateSource({
        packagePaths,
        diagnosticArtifacts: [playwright("apps/web")],
      }),
    ).toBe(".github/workflows/check-diagnostics.yml");
    expect(
      projectCheckWorkflowTemplateReplacements({
        packagePaths,
        diagnosticArtifacts: [playwright("apps/web")],
      }),
    ).toEqual({ DIAGNOSTIC_OWNER_PATHS: "apps/web" });
  });

  it("requires exact Package Boundary membership at every public workflow entrypoint", () => {
    for (const entrypoint of [
      () =>
        projectCheckWorkflowPlan({
          packagePaths: ["apps/web"],
          diagnosticArtifacts: [playwright("packages/private")],
        }),
      () =>
        projectCheckWorkflowTemplateSource({
          packagePaths: ["apps/web"],
          diagnosticArtifacts: [playwright("apps/admin")],
        }),
      () =>
        projectCheckWorkflowTemplateReplacements({
          packagePaths: ["apps/web"],
          diagnosticArtifacts: [playwright("services/private")],
        }),
    ]) {
      expect(entrypoint).toThrow(
        "CI Diagnostic Artifact owner is not a declared Package Boundary",
      );
    }
  });

  it("rejects unsafe owners at every public workflow entrypoint", () => {
    const declarationWithPath = {
      ...playwright("apps/web"),
      paths: [".env", "**/*"],
    };

    for (const entrypoint of [
      () =>
        projectCheckWorkflowPlan({
          packagePaths: ["apps/web"],
          diagnosticArtifacts: [declarationWithPath],
        }),
      () =>
        projectCheckWorkflowTemplateSource({
          packagePaths: ["apps/web"],
          diagnosticArtifacts: [playwright("node_modules/private")],
        }),
      () =>
        projectCheckWorkflowTemplateReplacements({
          packagePaths: ["apps/web"],
          diagnosticArtifacts: [playwright("node_modules/private")],
        }),
      () =>
        projectCheckWorkflowPlan({
          packagePaths: ["node_modules/private"],
          diagnosticArtifacts: [playwright("node_modules/private")],
        }),
      () =>
        projectCheckWorkflowTemplateSource({
          packagePaths: ["node_modules/private"],
          diagnosticArtifacts: [playwright("node_modules/private")],
        }),
      () =>
        projectCheckWorkflowTemplateReplacements({
          packagePaths: ["node_modules/private"],
          diagnosticArtifacts: [playwright("node_modules/private")],
        }),
    ]) {
      expect(entrypoint).toThrow();
    }
  });

  it("requires every Package Contribution diagnostic owner to be its boundary", () => {
    expect(() =>
      assertPackageContribution(
        packageContribution("apps/web", [playwright("apps/admin")]),
      ),
    ).toThrow(
      "CI Diagnostic Artifact owner must match its Package Contribution",
    );
  });
});
