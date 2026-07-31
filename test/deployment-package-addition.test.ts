import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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

const syntheticSource = createTemplateSourceHandle(process.cwd());

function hasDeploymentCapability(plan: {
  readonly deploymentEnvironmentNeeds: readonly { readonly kind: string }[];
  readonly manifests: readonly Readonly<Record<string, unknown>>[];
}): boolean {
  return (
    plan.deploymentEnvironmentNeeds.some(
      (need) => need.kind === "docker-engine",
    ) &&
    plan.manifests.some((manifest) => {
      const scripts = manifest.scripts;
      return (
        typeof scripts === "object" &&
        scripts !== null &&
        typeof (scripts as Record<string, unknown>).deployment === "string"
      );
    })
  );
}

function requireRootOnlyAddableDefinition(
  context: BuiltInGenerationContext,
): BuiltInPresetDefinition {
  const definition = builtInPresetRegistry.all().find((candidate) => {
    if (candidate.planPackageAddition === undefined) return false;
    return !hasDeploymentCapability(
      planGeneratedRepositoryInitialization({ definition: candidate, context }),
    );
  });
  if (definition === undefined) {
    throw new Error("Expected a Root Check-only addable Built-in Preset");
  }
  return definition;
}

function syntheticDeploymentContribution(options: {
  readonly context: BuiltInGenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
}): PackageContribution {
  const name = `@${options.context.scope}/${options.packageLeafName}`;
  return {
    definition: {
      name,
      path: options.packagePath,
      role: "runtime-service",
    },
    manifest: {
      name,
      version: "0.0.0",
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
        ecosystems: ["npm", "github-actions"],
        interval: "weekly",
      },
    },
    environmentNeeds: [],
    deploymentEnvironmentNeeds: [dockerEngineEnvironmentNeed()],
  };
}

const syntheticDeploymentAddition: BuiltInPresetDefinition = {
  metadata: {
    name: "synthetic-deployment-addition",
    title: "Synthetic deployment addition",
    description: "Test-only deployment capability contribution.",
  },
  source: syntheticSource,
  plannerSourceFile: import.meta.filename,
  blueprint(context) {
    return {
      schemaVersion: 2,
      packages: [
        syntheticDeploymentContribution({
          context,
          packageLeafName: "deployment",
          packagePath: "services/deployment",
        }).definition,
      ],
    };
  },
  planInitialization(context) {
    return syntheticDeploymentContribution({
      context,
      packageLeafName: "deployment",
      packagePath: "services/deployment",
    });
  },
  defaultPackagePath({ packageLeafName }) {
    return `services/${packageLeafName}`;
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return syntheticDeploymentContribution({
      context,
      packageLeafName,
      packagePath,
    });
  },
};

async function workspaceSnapshot(
  root: string,
  relative = "",
): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }[]
> {
  const files: { path: string; mode: number; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workspaceSnapshot(root, child)));
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(root, child);
    files.push({
      path: child.split(path.sep).join("/"),
      mode: (await stat(filePath)).mode & 0o777,
      content: (await readFile(filePath)).toString("base64"),
    });
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

describe("Deployment-changing Package Addition", () => {
  it("reconciles Root Check into stable deployment matrix legs and atomically rejects a repeated apply", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-deployment-package-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const definition = requireRootOnlyAddableDefinition(context);

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const workflowPath = path.join(targetDir, ".github/workflows/check.yml");
      await writeFile(
        workflowPath,
        `# user workflow customization\n${await readFile(workflowPath, "utf8")}`,
      );

      const additionOptions = {
        definition: syntheticDeploymentAddition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "deployment",
        packagePath: "services/deployment",
      };
      const addition = planGeneratedRepositoryPackageAddition(additionOptions);
      const repeatedAddition =
        planGeneratedRepositoryPackageAddition(additionOptions);
      expect(repeatedAddition).toEqual(addition);
      expect(repeatedAddition.projectProjections).toEqual(
        addition.projectProjections,
      );
      expect(repeatedAddition.projectProjections.preconditions).toEqual(
        addition.projectProjections.preconditions,
      );

      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.actions).toContainEqual({
        path: ".github/workflows/check.yml",
        driver: "text",
        action: "update",
      });

      const workflowSource = await readFile(workflowPath, "utf8");
      expect(workflowSource).toMatch(/^# user workflow customization\n/u);
      const workflow = parse(workflowSource) as {
        readonly jobs: {
          readonly check: {
            readonly strategy: {
              readonly matrix: {
                readonly include: readonly {
                  readonly capability: string;
                  readonly job_name: string;
                }[];
              };
            };
          };
        };
      };
      expect(workflow.jobs.check.strategy.matrix.include).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "root",
            job_name: "Root Check",
          }),
          expect.objectContaining({
            capability: "deployment",
            job_name: "Deployment Check",
          }),
        ]),
      );

      const beforeRepeatedApply = await workspaceSnapshot(targetDir);
      const repeatedResult = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeatedAddition.projectProjections,
      });
      expect(repeatedResult).toMatchObject({
        ok: false,
        conflicts: [
          expect.objectContaining({
            path: "services/deployment",
            driver: "precondition",
            reason: expect.stringContaining(
              "already exists and cannot be used for a new Package Addition",
            ),
          }),
        ],
      });
      expect(await workspaceSnapshot(targetDir)).toEqual(beforeRepeatedApply);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an overlapping workflow edit atomically", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-deployment-package-conflict-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const definition = requireRootOnlyAddableDefinition(context);

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const workflowPath = path.join(targetDir, ".github/workflows/check.yml");
      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "name: Root Check",
          "name: User Root Check",
        ),
      );
      const before = await workspaceSnapshot(targetDir);
      const addition = planGeneratedRepositoryPackageAddition({
        definition: syntheticDeploymentAddition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "deployment",
        packagePath: "services/deployment",
      });

      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      expect(result).toMatchObject({
        ok: false,
        conflicts: [
          expect.objectContaining({
            path: ".github/workflows/check.yml",
            driver: "text",
          }),
        ],
      });
      expect(await workspaceSnapshot(targetDir)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
