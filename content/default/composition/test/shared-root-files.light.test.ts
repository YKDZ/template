import assert from "node:assert/strict";
import { it } from "node:test";

import type { SharedRootContribution } from "@ykdz/default-content-authoring/contracts";
import {
  composeCheckWorkflow,
  composeSharedRootFiles,
} from "@ykdz/template-workspace/shared-root-files";
import { parse as parseYaml } from "yaml";

function compose(declarations: readonly SharedRootContribution[]) {
  return composeSharedRootFiles({
    source: "基础工作区",
    manifest: { scripts: { "base:check": "node --version" } },
    turboTasks: {},
    typescript: { compilerOptions: {}, include: [] },
    declarations,
  });
}

void it("合并共享根脚本并复用等价声明", () => {
  const result = compose([
    {
      kind: "shared-root-files",
      source: "文档拥有者",
      manifest: { scripts: { "docs:check": "node --version" } },
    },
    {
      kind: "shared-root-files",
      source: "检查拥有者",
      manifest: {
        scripts: {
          "docs:check": "node --version",
          "assets:check": "pnpm --version",
        },
      },
    },
  ]);

  assert.deepEqual(result.manifest.scripts, {
    "base:check": "node --version",
    "docs:check": "node --version",
    "assets:check": "pnpm --version",
  });
});

void it("共享声明冲突指出字段与双方来源", () => {
  assert.throws(
    () =>
      compose([
        {
          kind: "shared-root-files",
          source: "文档拥有者",
          manifest: { scripts: { "docs:check": "node --version" } },
        },
        {
          kind: "shared-root-files",
          source: "检查拥有者",
          manifest: { scripts: { "docs:check": "pnpm --version" } },
        },
      ]),
    /package\.json#\/scripts\/docs:check.*文档拥有者.*检查拥有者/u,
  );
});

void it("组合独占CI步骤和部分作业设置", () => {
  const result = compose([
    {
      kind: "shared-root-files",
      source: "文档拥有者",
      ciJob: { name: "检查" },
      ciSteps: [{ steps: [{ id: "docs-check", run: "pnpm run docs:check" }] }],
    },
    {
      kind: "shared-root-files",
      source: "检查拥有者",
      ciJob: { timeoutMinutes: 30 },
      ciSteps: [
        { steps: [{ id: "assets-check", run: "pnpm run assets:check" }] },
      ],
    },
  ]);

  assert.deepEqual(result.ciJob, { name: "检查", timeoutMinutes: 30 });
  assert.deepEqual(
    result.ciSteps.map(({ source, steps }) => ({
      source,
      ids: steps.map((step) => ("id" in step ? step.id : undefined)),
    })),
    [
      { source: "文档拥有者", ids: ["docs-check"] },
      { source: "检查拥有者", ids: ["assets-check"] },
    ],
  );

  const workflow = parseYaml(
    composeCheckWorkflow(
      [
        "name: Check",
        "jobs:",
        "  check:",
        "    steps:",
        "      - id: default-check",
        "        run: pnpm run check",
      ].join("\n"),
      "基础工作区",
      result.ciSteps,
    ),
  ) as {
    readonly jobs: {
      readonly check: {
        readonly steps: readonly { readonly id: string }[];
      };
    };
  };
  assert.deepEqual(
    workflow.jobs.check.steps.map(({ id }) => id),
    ["default-check", "docs-check", "assets-check"],
  );
});

void it("拒绝共享CI身份冲突", () => {
  const duplicateStep = compose([
    {
      kind: "shared-root-files",
      source: "文档拥有者",
      ciSteps: [{ steps: [{ id: "same-step", run: "node --version" }] }],
    },
    {
      kind: "shared-root-files",
      source: "检查拥有者",
      ciSteps: [{ steps: [{ id: "same-step", run: "pnpm --version" }] }],
    },
  ]);
  assert.throws(
    () =>
      composeCheckWorkflow(
        "jobs:\n  check:\n    steps: []\n",
        "基础工作区",
        duplicateStep.ciSteps,
      ),
    /same-step.*文档拥有者.*检查拥有者/u,
  );
});
