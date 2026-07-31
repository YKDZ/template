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

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  type BuiltInGenerationContext,
  type BuiltInPresetDefinition,
} from "#template-builtin-presets";
import { dockerEngineEnvironmentNeed } from "#template-core/module-graph";
import type { PackageContribution } from "#template-core/package-contribution";
import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import {
  createTemplateSourceHandle,
  renderNewProject,
} from "#template-core/renderer";

const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };
const source = createTemplateSourceHandle(process.cwd());

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
  return createGenerationContext({ targetDir, scope: "demo", toolchain });
}

function diagnosticAddition(): BuiltInPresetDefinition {
  const context = createGenerationContext({
    targetDir: "generated-repository/diagnostic-addition-capability",
    scope: "demo",
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
    scope: "demo",
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

function diagnosticDeploymentContribution(options: {
  readonly context: BuiltInGenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
}): PackageContribution {
  const name = `@${options.context.scope}/${options.packageLeafName}`;
  const owner = {
    kind: "package-boundary" as const,
    path: options.packagePath,
  };
  return {
    definition: { name, path: options.packagePath, role: "runtime-service" },
    manifest: {
      name,
      private: true,
      scripts: { deployment: "node scripts/check-deployment.js" },
    },
    exposure: { exports: {}, imports: {} },
    operations: [
      {
        kind: "writeJson",
        to: `${options.packagePath}/package.json`,
        value: {},
      },
    ],
    foundation: {
      toolchains: {},
      editorCapabilities: [],
      dependencyMaintenance: {
        ecosystems: ["github-actions"],
        interval: "weekly",
      },
    },
    environmentNeeds: [],
    deploymentEnvironmentNeeds: [dockerEngineEnvironmentNeed()],
    ciDiagnosticArtifacts: [{ kind: "playwright", owner }],
  };
}

const diagnosticDeploymentAddition: BuiltInPresetDefinition = {
  metadata: {
    name: "synthetic-diagnostic-deployment-addition",
    title: "Synthetic diagnostic deployment addition",
    description: "Test-only capability composition.",
  },
  source,
  plannerSourceFile: import.meta.filename,
  blueprint(generationContext) {
    return {
      schemaVersion: 2,
      packages: [
        diagnosticDeploymentContribution({
          context: generationContext,
          packageLeafName: "deployment",
          packagePath: "services/deployment",
        }).definition,
      ],
    };
  },
  planInitialization(generationContext) {
    return diagnosticDeploymentContribution({
      context: generationContext,
      packageLeafName: "deployment",
      packagePath: "services/deployment",
    });
  },
  defaultPackagePath({ packageLeafName }) {
    return `services/${packageLeafName}`;
  },
  planPackageAddition({
    context: generationContext,
    packageLeafName,
    packagePath,
  }) {
    return diagnosticDeploymentContribution({
      context: generationContext,
      packageLeafName,
      packagePath,
    });
  },
};

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
  return { generationContext, initialization };
}

describe("diagnostic Package Addition", () => {
  it("adds and extends one aggregate native artifact without overwriting unrelated workflow edits", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-diagnostic-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      const { generationContext, initialization } =
        await initializedBase(targetDir);
      const workflowPath = path.join(targetDir, ".github/workflows/check.yml");
      await writeFile(
        workflowPath,
        `# user workflow policy\n${await readFile(workflowPath, "utf8")}`,
      );
      const first = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        context: generationContext,
        blueprint: initialization.blueprint,
        packageLeafName: "web",
        packagePath: "apps/web",
      });

      const beforeDryRun = await snapshot(targetDir);
      const preview = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...first.projectProjections,
        dryRun: true,
      });
      expect(preview).toMatchObject({
        ok: true,
        actions: expect.arrayContaining([
          {
            path: ".github/workflows/check.yml",
            driver: "text",
            action: "update",
          },
        ]),
      });
      expect(await snapshot(targetDir)).toEqual(beforeDryRun);

      expect(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...first.projectProjections,
        }),
      ).toMatchObject({ ok: true });
      const firstWorkflow = await readFile(workflowPath, "utf8");
      expect(firstWorkflow).toMatch(/^# user workflow policy\n/u);
      expect(firstWorkflow).toContain(
        "DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
      );
      expect(firstWorkflow).toContain(
        "for diagnostic_directory in test-results playwright-report; do",
      );
      expect(firstWorkflow).toContain("path: .template-ci-diagnostics");
      expect(
        firstWorkflow.match(/Upload Root Check diagnostics/gu),
      ).toHaveLength(1);

      const second = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        context: generationContext,
        blueprint: first.blueprint,
        packageLeafName: "admin",
        packagePath: "apps/admin",
      });
      expect(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...second.projectProjections,
        }),
      ).toMatchObject({ ok: true });
      const secondWorkflow = await readFile(workflowPath, "utf8");
      expect(
        secondWorkflow.match(/DIAGNOSTIC_OWNER_PATHS: \|-/gu),
      ).toHaveLength(1);
      expect(secondWorkflow.match(/apps\/admin/gu)).toHaveLength(1);
      expect(secondWorkflow).toContain(
        "DIAGNOSTIC_OWNER_PATHS: |-\n            apps/admin\n            apps/web",
      );
      expect(
        secondWorkflow.match(/Upload Root Check diagnostics/gu),
      ).toHaveLength(1);

      const repeated = planGeneratedRepositoryPackageAddition({
        definition: diagnosticAddition(),
        context: generationContext,
        blueprint: second.blueprint,
        packageLeafName: "admin",
        packagePath: "apps/admin",
      });
      expect(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...repeated.projectProjections,
        }),
      ).toEqual({ ok: true, changedPaths: [], actions: [] });

      const staleRepeat = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...first.projectProjections,
      });
      expect(staleRepeat).toMatchObject({
        ok: false,
        conflicts: [
          expect.objectContaining({ path: "apps/web", driver: "precondition" }),
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("is deterministic across diagnostic addition order and does not inspect an unchanged workflow", async () => {
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
        const { generationContext, initialization } =
          await initializedBase(targetDir);
        let blueprint = initialization.blueprint;
        for (const name of names) {
          const addition = planGeneratedRepositoryPackageAddition({
            definition: diagnosticAddition(),
            context: generationContext,
            blueprint,
            packageLeafName: name,
            packagePath: `apps/${name}`,
          });
          expect(
            await reconcileAndApplyProjectProjections({
              targetRoot: targetDir,
              ...addition.projectProjections,
            }),
          ).toMatchObject({ ok: true });
          blueprint = addition.blueprint;
        }
        rendered.push(
          await readFile(
            path.join(targetDir, ".github/workflows/check.yml"),
            "utf8",
          ),
        );
      }
      expect(rendered[0]).toBe(rendered[1]);

      const targetDir = path.join(workspace, "no-diagnostic");
      const { generationContext, initialization } =
        await initializedBase(targetDir);
      const workflowPath = path.join(targetDir, ".github/workflows/check.yml");
      await rm(workflowPath);
      await mkdir(workflowPath);
      const addition = planGeneratedRepositoryPackageAddition({
        definition: baseDefinition(),
        context: generationContext,
        blueprint: initialization.blueprint,
        packageLeafName: "utility",
        packagePath: "packages/utility",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      expect(result).toMatchObject({ ok: true });
      if (result.ok)
        expect(result.actions.map((action) => action.path)).not.toContain(
          ".github/workflows/check.yml",
        );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports overlapping workflow edits atomically and composes deployment with root-only diagnostics", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-diagnostic-conflict-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      const { generationContext, initialization } =
        await initializedBase(targetDir);
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
        context: generationContext,
        blueprint: initialization.blueprint,
        packageLeafName: "web",
        packagePath: "apps/web",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...conflict.projectProjections,
      });
      expect(result).toMatchObject({
        ok: false,
        conflicts: [
          expect.objectContaining({
            path: ".github/workflows/check.yml",
            driver: "text",
            region: expect.any(Object),
          }),
        ],
      });
      expect(await snapshot(targetDir)).toEqual(before);

      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "      - name: Upload Root Check diagnostics\n        run: echo user-owned\n",
          "",
        ),
      );
      const combined = planGeneratedRepositoryPackageAddition({
        definition: diagnosticDeploymentAddition,
        context: generationContext,
        blueprint: initialization.blueprint,
        packageLeafName: "deployment",
        packagePath: "services/deployment",
      });
      expect(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...combined.projectProjections,
        }),
      ).toMatchObject({ ok: true });
      const workflow = parse(await readFile(workflowPath, "utf8")) as {
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
      expect(
        workflow.jobs.check.strategy.matrix.include.map(
          (entry) => entry.job_name,
        ),
      ).toEqual(["Root Check", "Deployment Check"]);
      const upload = workflow.jobs.check.steps.find(
        (step) => step.name === "Upload Root Check diagnostics",
      );
      expect(upload).toMatchObject({
        if: "failure() && matrix.capability == 'root'",
      });
      expect(upload?.with?.path).toBe(".template-ci-diagnostics");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
