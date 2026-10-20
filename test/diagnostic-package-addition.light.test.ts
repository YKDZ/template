import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  type BuiltInGenerationContext,
  type BuiltInPresetDefinition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { parse } from "yaml";

const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

async function snapshot(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const entries: { path: string; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await snapshot(root, child)));
    } else if (entry.isFile()) {
      entries.push({
        path: child.split(path.sep).join("/"),
        content: (await readFile(path.join(root, child))).toString("base64"),
      });
    }
  }
  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

function context(targetDir: string): BuiltInGenerationContext {
  return createGenerationContext({
    targetDir,
    defaultPackageScope: "demo",
    toolchain,
  });
}

function diagnosticAddition(): BuiltInPresetDefinition {
  const context = createGenerationContext({
    targetDir: "generated-repository/diagnostic-addition-capability",
    defaultPackageScope: "demo",
    toolchain,
  });
  const definition = builtInPresetRegistry.all().find((candidate) => {
    if (candidate.planPackageAddition === undefined) return false;
    const packagePath = candidate.defaultPackagePath?.({
      context,
      packageLeafName: "diagnostic",
    });
    return (
      packagePath !== undefined &&
      (candidate.planPackageAddition({
        context,
        packageLeafName: "diagnostic",
        packagePath,
      }).ciDiagnosticArtifacts?.length ?? 0) > 0
    );
  });
  if (definition === undefined) {
    throw new Error(
      "Expected a registry-defined Package Addition with CI diagnostic capability",
    );
  }
  return definition;
}

function baseDefinition(): BuiltInPresetDefinition {
  const context = createGenerationContext({
    targetDir: "generated-repository/no-diagnostic-base",
    defaultPackageScope: "demo",
    toolchain,
  });
  const definition = builtInPresetRegistry.all().find(
    (candidate) =>
      planGeneratedRepositoryInitialization({
        definition: candidate,
        context,
      }).ciDiagnosticArtifacts.length === 0,
  );
  if (definition === undefined) {
    throw new Error(
      "Expected a registry-defined Built-in Preset without CI diagnostic capability",
    );
  }
  return definition;
}

function deploymentDefinition(): BuiltInPresetDefinition {
  // 该探测会直接规划 Registry 中每个 Preset 的新建初始化，含新建公开 ts-cli 候选，
  // 需要发版快照的精确三段版本；其余仅规划私有仓库的上下文保持大版本声明。
  const context = createGenerationContext({
    targetDir: "generated-repository/deployment-capability",
    defaultPackageScope: "demo",
    toolchain: {
      ...toolchain,
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
    },
  });
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const plan = planGeneratedRepositoryInitialization({
      definition: candidate,
      context,
    });
    return plan.deploymentCheck !== undefined;
  });
  if (definition === undefined) {
    throw new Error(
      "Expected a registry-defined Built-in Preset with Deployment capability",
    );
  }
  return definition;
}

async function initializedBase(targetDir: string) {
  const generationContext = context(targetDir);
  const initialization = planGeneratedRepositoryInitialization({
    definition: baseDefinition(),
    context: generationContext,
  });
  await renderNewProject({
    targetRoot: targetDir,
    operations: [...initialization.operations],
  });
  return { generationContext };
}

void describe("diagnostic Package Addition", () => {
  void it("adds and extends one aggregate native artifact without overwriting unrelated workflow edits", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-diagnostic-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      const { generationContext } = await initializedBase(targetDir);
      const workflowPath = path.join(targetDir, ".github/workflows/check.yml");
      await writeFile(
        workflowPath,
        `# user workflow policy\n${await readFile(workflowPath, "utf8")}`,
      );
      const first = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        localTemplateMetadata: loadLocalTemplateMetadata(
          generationContext.targetDir,
        ),
        packageLeafName: "web",
        packagePath: "apps/web",
      });

      const beforeDryRun = await snapshot(targetDir);
      const preview = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...first.projectProjections,
        dryRun: true,
      });
      assert.ok(preview.ok);
      assert.ok(
        preview.actions.some((action) =>
          isDeepStrictEqual(action, {
            path: ".github/workflows/check.yml",
            driver: "text",
            action: "update",
          }),
        ),
      );
      assert.deepStrictEqual(await snapshot(targetDir), beforeDryRun);

      const firstApplication = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...first.projectProjections,
      });
      assert.strictEqual(firstApplication.ok, true);
      const firstWorkflow = await readFile(workflowPath, "utf8");
      assert.match(firstWorkflow, /^# user workflow policy\n/u);
      assert.ok(
        firstWorkflow.includes(
          "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
        ),
      );
      assert.ok(
        firstWorkflow.includes(
          "for diagnostic_directory in test-results playwright-report; do",
        ),
      );
      assert.ok(firstWorkflow.includes("path: .template-ci-diagnostics"));
      assert.strictEqual(
        firstWorkflow.match(/Upload Root Check diagnostics/gu)?.length,
        1,
      );

      const second = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        localTemplateMetadata: loadLocalTemplateMetadata(
          generationContext.targetDir,
        ),
        packageLeafName: "admin",
        packagePath: "apps/admin",
      });
      const secondApplication = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...second.projectProjections,
      });
      assert.strictEqual(secondApplication.ok, true);
      const secondWorkflow = await readFile(workflowPath, "utf8");
      assert.strictEqual(
        secondWorkflow.match(/PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: \|-/gu)
          ?.length,
        1,
      );
      assert.strictEqual(
        secondWorkflow.match(/VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS: \|-/gu)
          ?.length,
        1,
      );
      assert.strictEqual(secondWorkflow.match(/apps\/admin/gu)?.length, 2);
      assert.ok(
        secondWorkflow.includes(
          "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/admin\n            apps/web",
        ),
      );
      assert.strictEqual(
        secondWorkflow.match(/Upload Root Check diagnostics/gu)?.length,
        1,
      );

      const repeated = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        localTemplateMetadata: loadLocalTemplateMetadata(
          generationContext.targetDir,
        ),
        packageLeafName: "admin",
        packagePath: "apps/admin",
      });
      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...repeated.projectProjections,
        }),
        { ok: true, changedPaths: [], actions: [] },
      );

      const staleRepeat = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...first.projectProjections,
      });
      assert.strictEqual(staleRepeat.ok, false);
      assert.ok(
        staleRepeat.conflicts.some(
          (conflict) =>
            conflict.path === "apps/web" && conflict.driver === "precondition",
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("is deterministic across diagnostic addition order and does not inspect an unchanged workflow", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-diagnostic-order-"),
    );
    try {
      const rendered: string[] = [];
      for (const names of [
        ["web", "admin"],
        ["admin", "web"],
      ] as const) {
        const targetDir = path.join(workspace, names.join("-"));
        const { generationContext } = await initializedBase(targetDir);
        for (const name of names) {
          const addition = planGeneratedRepositoryPackageAddition({
            definition: diagnosticAddition(),
            localTemplateMetadata: loadLocalTemplateMetadata(
              generationContext.targetDir,
            ),
            packageLeafName: name,
            packagePath: `apps/${name}`,
          });
          const result = await reconcileAndApplyProjectProjections({
            targetRoot: targetDir,
            ...addition.projectProjections,
          });
          assert.strictEqual(result.ok, true);
        }
        rendered.push(
          await readFile(
            path.join(targetDir, ".github/workflows/check.yml"),
            "utf8",
          ),
        );
      }
      assert.strictEqual(rendered[0], rendered[1]);

      const targetDir = path.join(workspace, "no-diagnostic");
      const { generationContext } = await initializedBase(targetDir);
      const workflowPath = path.join(targetDir, ".github/workflows/check.yml");
      await rm(workflowPath);
      await mkdir(workflowPath);
      const addition = planGeneratedRepositoryPackageAddition({
        definition: baseDefinition(),
        localTemplateMetadata: loadLocalTemplateMetadata(
          generationContext.targetDir,
        ),
        packageLeafName: "utility",
        packagePath: "packages/utility",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      assert.strictEqual(result.ok, true);
      if (result.ok)
        assert.ok(
          !result.actions
            .map((action) => action.path)
            .includes(".github/workflows/check.yml"),
        );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("原子报告 workflow 重叠编辑并组合部署与诊断制品", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-diagnostic-conflict-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      const { generationContext } = await initializedBase(targetDir);
      const workflowPath = path.join(targetDir, ".github/workflows/check.yml");
      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "      - name: Run Heavy Check\n        run: node --conditions=source scripts/task-gates.ts check:heavy\n",
          "      - name: Run Heavy Check\n        run: node --conditions=source scripts/task-gates.ts check:heavy\n      - name: Upload User-owned diagnostics\n        run: echo user-owned\n",
        ),
      );
      const before = await snapshot(targetDir);
      const conflict = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        localTemplateMetadata: loadLocalTemplateMetadata(
          generationContext.targetDir,
        ),
        packageLeafName: "web",
        packagePath: "apps/web",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...conflict.projectProjections,
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.conflicts.length, 1);
      assert.partialDeepStrictEqual(result.conflicts[0], {
        path: ".github/workflows/check.yml",
        driver: "text",
      });
      assert.ok(
        typeof result.conflicts[0]?.region === "object" &&
          result.conflicts[0].region !== null,
      );
      assert.deepStrictEqual(await snapshot(targetDir), before);

      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "      - name: Upload User-owned diagnostics\n        run: echo user-owned\n",
          "",
        ),
      );

      const deploymentTargetDir = path.join(workspace, "deployment-project");
      const deploymentContext = context(deploymentTargetDir);
      const deploymentInitialization = planGeneratedRepositoryInitialization({
        definition: deploymentDefinition(),
        context: deploymentContext,
      });
      await renderNewProject({
        targetRoot: deploymentTargetDir,
        operations: [...deploymentInitialization.operations],
      });
      const combined = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        localTemplateMetadata: loadLocalTemplateMetadata(
          deploymentContext.targetDir,
        ),
        packageLeafName: "admin",
        packagePath: "apps/admin",
      });
      const combinedApplication = await reconcileAndApplyProjectProjections({
        targetRoot: deploymentTargetDir,
        ...combined.projectProjections,
      });
      assert.strictEqual(combinedApplication.ok, true);
      const deploymentWorkflowSource = await readFile(
        path.join(deploymentTargetDir, ".github/workflows/check.yml"),
        "utf8",
      );
      const workflow = parse(deploymentWorkflowSource) as {
        readonly jobs: {
          readonly check: {
            readonly name: string;
            readonly "timeout-minutes": number;
            readonly steps: readonly {
              readonly name: string;
              readonly run?: string;
              readonly uses?: string;
              readonly if?: string;
              readonly env?: Readonly<Record<string, string>>;
              readonly with?: { readonly path?: string };
            }[];
          };
        };
      };
      const job = workflow.jobs.check;
      assert.strictEqual(job.name, "Full Check");
      assert.strictEqual(job["timeout-minutes"], 45);
      const steps = job.steps;
      const lightCheckIndex = steps.findIndex(
        (step) => step.name === "Run Light Check",
      );
      const buildxSetupIndex = steps.findIndex((step) =>
        step.uses?.startsWith("docker/setup-buildx-action@"),
      );
      const heavyCheckIndex = steps.findIndex(
        (step) => step.name === "Run Heavy Check",
      );
      assert.ok(lightCheckIndex >= 0);
      assert.ok(buildxSetupIndex > lightCheckIndex);
      assert.ok(heavyCheckIndex > buildxSetupIndex);
      assert.strictEqual(
        steps[lightCheckIndex]?.run,
        "node --conditions=source scripts/task-gates.ts check",
      );
      assert.strictEqual(
        steps[heavyCheckIndex]?.run,
        "node --conditions=source scripts/task-gates.ts check:heavy",
      );
      const diagnosticStaging = steps.find(
        (step) => step.name === "Stage Check diagnostics",
      );
      assert.strictEqual(
        diagnosticStaging?.env?.PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS,
        "apps/admin\napps/web",
      );
      const upload = steps.find(
        (step) => step.name === "Upload Check diagnostics",
      );
      assert.strictEqual(upload?.if, "failure()");
      assert.strictEqual(upload?.with?.path, ".template-ci-diagnostics");
      assert.ok(deploymentWorkflowSource.includes("apps/admin"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
