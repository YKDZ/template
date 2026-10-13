import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeCiDiagnosticArtifacts,
  type CiDiagnosticArtifactDeclaration,
} from "@ykdz/template-core/ci-diagnostic-artifact";
import {
  assertPackageContribution,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import {
  projectCheckWorkflowTemplateSource,
  projectCheckWorkflowTemplateReplacements,
} from "@ykdz/template-core/project-github";

const playwright = (path: string): CiDiagnosticArtifactDeclaration => ({
  kind: "playwright",
  owner: { kind: "package-boundary", path },
});

const vitestBrowser = (path: string): CiDiagnosticArtifactDeclaration => ({
  kind: "vitest-browser",
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

void describe("CI Diagnostic Artifact contract", () => {
  void it("returns only ordered, deduplicated closed declarations", () => {
    assert.deepStrictEqual(
      composeCiDiagnosticArtifacts({
        packagePaths: ["apps/web", "apps/admin"],
        declarations: [
          playwright("apps/web"),
          playwright("apps/admin"),
          playwright("apps/web"),
        ],
      }),
      [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/admin" },
        },
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/web" },
        },
      ],
    );
  });

  void it("rejects unrecognized kinds, unsafe paths, unknown owners, and extra upload fields", () => {
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
      assert.throws(() =>
        composeCiDiagnosticArtifacts({
          packagePaths,
          declarations: [declaration],
        }),
      );
    }
  });

  void it("derives only ordered owner facts from actual Package Boundary paths", () => {
    const packagePaths = ["apps/web"];
    assert.strictEqual(
      projectCheckWorkflowTemplateSource({
        packagePaths,
        diagnosticArtifacts: [playwright("apps/web")],
      }),
      ".github/workflows/check-diagnostics.yml",
    );
    assert.deepStrictEqual(
      projectCheckWorkflowTemplateReplacements({
        packagePaths,
        diagnosticArtifacts: [
          playwright("apps/web"),
          vitestBrowser("apps/web"),
        ],
      }),
      {
        PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: "apps/web",
        VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS: "apps/web",
      },
    );
  });

  void it("requires exact Package Boundary membership at every public workflow entrypoint", () => {
    for (const entrypoint of [
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
      assert.throws(
        entrypoint,
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "CI Diagnostic Artifact owner is not a declared Package Boundary",
          ),
      );
    }
  });

  void it("rejects unsafe owners at every public workflow entrypoint", () => {
    const declarationWithPath = {
      ...playwright("apps/web"),
      paths: [".env", "**/*"],
    };

    for (const entrypoint of [
      () =>
        projectCheckWorkflowTemplateSource({
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
      assert.throws(entrypoint);
    }
  });

  void it("requires every Package Contribution diagnostic owner to be its boundary", () => {
    assert.throws(
      () =>
        assertPackageContribution(
          packageContribution("apps/web", [playwright("apps/admin")]),
        ),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "CI Diagnostic Artifact owner must match its Package Contribution",
        ),
    );
  });
});
