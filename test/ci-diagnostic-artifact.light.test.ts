import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeCiDiagnosticArtifacts,
  type CiDiagnosticArtifactDeclaration,
} from "@ykdz/template-environment/ci-diagnostic-artifact";
import {
  dockerEngineEnvironmentNeed,
  type DeploymentEnvironmentNeed,
} from "@ykdz/template-environment/module-graph";
import {
  assertPackageContribution,
  type PackageContribution,
} from "@ykdz/template-workspace/package-contribution";
import {
  prepareProjectGithubTemplates,
  projectCheckWorkflow,
} from "@ykdz/template-workspace/project-github";

const checkWorkflowTemplate = prepareProjectGithubTemplates().checkWorkflow;

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

void describe("CI 诊断产物合同", () => {
  void it("只返回排序且去重的封闭声明", () => {
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

  void it("拒绝未知类型、不安全路径、未知所有者与额外上传字段", () => {
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

  void it("工作流只投影实际包边界中的诊断所有者", () => {
    const packagePaths = ["apps/web"];
    const workflow = projectCheckWorkflow(
      {
        packagePaths,
        diagnosticArtifacts: [
          playwright("apps/web"),
          vitestBrowser("apps/web"),
        ],
      },
      checkWorkflowTemplate,
    );
    assert.match(workflow, /PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS/u);
    assert.match(workflow, /VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS/u);
    assert.match(workflow, /apps\/web/u);
  });

  void it("要求工作流声明的诊断所有者属于真实包边界", () => {
    for (const declaration of [
      playwright("apps/admin"),
      playwright("services/private"),
    ]) {
      assert.throws(
        () =>
          projectCheckWorkflow(
            {
              packagePaths: ["apps/web"],
              diagnosticArtifacts: [declaration],
            },
            checkWorkflowTemplate,
          ),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "CI Diagnostic Artifact owner is not a declared Package Boundary",
          ),
      );
    }
  });

  void it("部署工作流必须声明 Docker 环境需求", () => {
    const packagePaths = ["apps/web"];
    assert.throws(() =>
      projectCheckWorkflow(
        {
          packagePaths,
          deploymentCheck: {
            environmentNeeds: [] as DeploymentEnvironmentNeed[],
          },
        },
        checkWorkflowTemplate,
      ),
    );
    assert.match(
      projectCheckWorkflow(
        {
          packagePaths,
          deploymentCheck: {
            environmentNeeds: [dockerEngineEnvironmentNeed()],
          },
        },
        checkWorkflowTemplate,
      ),
      /prepare-deployment/u,
    );
  });

  void it("拒绝不安全的诊断所有者", () => {
    const declarationWithPath = {
      ...playwright("apps/web"),
      paths: [".env", "**/*"],
    };

    assert.throws(() =>
      projectCheckWorkflow(
        {
          packagePaths: ["apps/web"],
          diagnosticArtifacts: [declarationWithPath],
        },
        checkWorkflowTemplate,
      ),
    );
    assert.throws(() =>
      projectCheckWorkflow(
        {
          packagePaths: ["node_modules/private"],
          diagnosticArtifacts: [playwright("node_modules/private")],
        },
        checkWorkflowTemplate,
      ),
    );
  });

  void it("每个包贡献的诊断所有者必须属于自身边界", () => {
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
