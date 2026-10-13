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
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { parse } from "yaml";

import {
  any,
  arrayContaining,
  assertLength,
  assertPartialDeepStrictEqual,
  objectContaining,
} from "./assertions.ts";

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
      assertPartialDeepStrictEqual(preview, {
        ok: true,
        actions: arrayContaining([
          {
            path: ".github/workflows/check.yml",
            driver: "text",
            action: "update",
          },
        ]),
      });
      assert.deepStrictEqual(await snapshot(targetDir), beforeDryRun);

      assertPartialDeepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...first.projectProjections,
        }),
        { ok: true },
      );
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
      assertLength(firstWorkflow.match(/Upload Root Check diagnostics/gu), 1);

      const second = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        localTemplateMetadata: loadLocalTemplateMetadata(
          generationContext.targetDir,
        ),
        packageLeafName: "admin",
        packagePath: "apps/admin",
      });
      assertPartialDeepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...second.projectProjections,
        }),
        { ok: true },
      );
      const secondWorkflow = await readFile(workflowPath, "utf8");
      assertLength(
        secondWorkflow.match(/PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: \|-/gu),
        1,
      );
      assertLength(
        secondWorkflow.match(/VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS: \|-/gu),
        1,
      );
      assertLength(secondWorkflow.match(/apps\/admin/gu), 2);
      assert.ok(
        secondWorkflow.includes(
          "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/admin\n            apps/web",
        ),
      );
      assertLength(secondWorkflow.match(/Upload Root Check diagnostics/gu), 1);

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
      assertPartialDeepStrictEqual(staleRepeat, {
        ok: false,
        conflicts: [
          objectContaining({ path: "apps/web", driver: "precondition" }),
        ],
      });
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
          assertPartialDeepStrictEqual(
            await reconcileAndApplyProjectProjections({
              targetRoot: targetDir,
              ...addition.projectProjections,
            }),
            { ok: true },
          );
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
      assertPartialDeepStrictEqual(result, { ok: true });
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

  void it("reports overlapping workflow edits atomically and composes deployment with root-only diagnostics", async () => {
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
          "      - name: Run Root Check\n        run: pnpm run check\n",
          "      - name: Run Root Check\n        run: pnpm run check\n      - name: Upload Root Check diagnostics\n        run: echo user-owned\n",
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
      assertPartialDeepStrictEqual(result, {
        ok: false,
        conflicts: [
          objectContaining({
            path: ".github/workflows/check.yml",
            driver: "text",
            region: any(Object),
          }),
        ],
      });
      assert.deepStrictEqual(await snapshot(targetDir), before);

      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "      - name: Upload Root Check diagnostics\n        run: echo user-owned\n",
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
      assertPartialDeepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot: deploymentTargetDir,
          ...combined.projectProjections,
        }),
        { ok: true },
      );
      const deploymentWorkflowSource = await readFile(
        path.join(deploymentTargetDir, ".github/workflows/check.yml"),
        "utf8",
      );
      const workflow = parse(deploymentWorkflowSource) as {
        readonly jobs: {
          readonly check: {
            readonly strategy: {
              readonly matrix: {
                readonly include: readonly { readonly job_name: string }[];
              };
            };
            readonly steps: readonly {
              readonly name: string;
              readonly if?: string;
              readonly with?: { readonly path?: string };
            }[];
          };
        };
      };
      assert.deepStrictEqual(
        workflow.jobs.check.strategy.matrix.include.map(
          (entry) => entry.job_name,
        ),
        ["Root Check", "Deployment Check"],
      );
      const upload = workflow.jobs.check.steps.find(
        (step) => step.name === "Upload Root Check diagnostics",
      );
      assertPartialDeepStrictEqual(upload, {
        if: "failure() && matrix.capability == 'root'",
      });
      assert.strictEqual(upload?.with?.path, ".template-ci-diagnostics");
      assert.ok(deploymentWorkflowSource.includes("apps/admin"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
