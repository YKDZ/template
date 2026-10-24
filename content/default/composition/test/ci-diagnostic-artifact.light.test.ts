import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CiDiagnosticArtifactDeclaration } from "@ykdz/default-content-authoring/contracts";
import { composeCiDiagnosticArtifacts } from "@ykdz/template-workspace/default-environment";
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
          error.message.includes("CI 诊断制品所有者不是已声明的包边界"),
      );
    }
  });

  void it("工作流作业配置由通用根声明提供", () => {
    const packagePaths = ["apps/web"];
    assert.match(
      projectCheckWorkflow(
        {
          packagePaths,
          job: { name: "Full Check", timeoutMinutes: 45 },
        },
        checkWorkflowTemplate,
      ),
      /name: Full Check\n    runs-on: ubuntu-latest\n    timeout-minutes: 45/u,
    );
    assert.match(
      projectCheckWorkflow({ packagePaths }, checkWorkflowTemplate),
      /name: Root Check\n    runs-on: ubuntu-latest\n    timeout-minutes: 30/u,
    );
    assert.match(
      projectCheckWorkflow(
        { packagePaths, job: { name: "Full Check" } },
        checkWorkflowTemplate,
      ),
      /name: Full Check\n    runs-on: ubuntu-latest\n    timeout-minutes: 30/u,
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
});
