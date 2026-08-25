import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  type GeneratedRepositoryPlan,
} from "#template-builtin-presets";
import { renderNewProject } from "#template-core/renderer";

import {
  assertDependabotContract,
  assertWorkflowContract,
} from "../packages/checks/src/check-builtin-preset-github-yaml.ts";

function rootOnlyPlan(): GeneratedRepositoryPlan {
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const plan = planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "root-only"),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    return !plan.manifests.some((manifest) => {
      const scripts = manifest.scripts;
      return (
        typeof scripts === "object" &&
        scripts !== null &&
        typeof (scripts as Record<string, unknown>).deployment === "string"
      );
    });
  });
  if (definition === undefined) {
    throw new Error("Expected a Root Check-only Built-in Preset Definition");
  }
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "root-only"),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    }),
  });
}

async function renderedGithubSource(
  plan: GeneratedRepositoryPlan,
  sourcePath: ".github/dependabot.yml" | ".github/workflows/check.yml",
): Promise<{
  readonly sourcePath: string;
  readonly source: string;
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-workflow-"));
  try {
    await renderNewProject({
      targetRoot: workspace,
      operations: [...plan.operations],
    });
    return {
      sourcePath,
      source: await readFile(path.join(workspace, sourcePath), "utf8"),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function renderedWorkflow(plan: GeneratedRepositoryPlan): Promise<{
  readonly sourcePath: string;
  readonly source: string;
}> {
  return renderedGithubSource(plan, ".github/workflows/check.yml");
}

async function renderedDependabot(plan: GeneratedRepositoryPlan): Promise<{
  readonly sourcePath: string;
  readonly source: string;
}> {
  return renderedGithubSource(plan, ".github/dependabot.yml");
}

async function rootOnlyWorkflowSource(): Promise<string> {
  return (await renderedWorkflow(rootOnlyPlan())).source;
}

function deploymentPlan(): GeneratedRepositoryPlan {
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const plan = planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "deployment"),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
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
  });
  if (definition === undefined) {
    throw new Error("Expected a deployment-capable Built-in Preset Definition");
  }
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "deployment"),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    }),
  });
}

async function deploymentWorkflowSource(): Promise<string> {
  return (await renderedWorkflow(deploymentPlan())).source;
}

async function expectDeploymentWorkflowRejected(source: string): Promise<void> {
  const plan = deploymentPlan();
  const baseline = await renderedWorkflow(plan);
  expect(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      baseline.source,
      parse(baseline.source) as Record<string, unknown>,
    ),
  ).not.toThrow();
  expect(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      source,
      parse(source) as Record<string, unknown>,
    ),
  ).toThrow();
}

async function expectRootOnlyWorkflowRejected(source: string): Promise<void> {
  const plan = rootOnlyPlan();
  const baseline = await renderedWorkflow(plan);
  expect(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      baseline.source,
      parse(baseline.source) as Record<string, unknown>,
    ),
  ).not.toThrow();
  expect(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      source,
      parse(source) as Record<string, unknown>,
    ),
  ).toThrow();
}

describe("Built-in Preset GitHub YAML checker", () => {
  it("rejects damaged Dependabot update, ignore, and directory semantics from a real generated file", async () => {
    const plan = rootOnlyPlan();
    const baseline = await renderedDependabot(plan);
    expect(() =>
      assertDependabotContract(
        plan,
        baseline.sourcePath,
        parse(baseline.source),
      ),
    ).not.toThrow();

    const mutations = [
      {
        source: baseline.source.replace("interval: weekly", "interval: daily"),
        diagnostic: /npm.*weekly update schedule/u,
      },
      {
        source: baseline.source.replace(
          "version-update:semver-patch",
          "version-update:semver-major",
        ),
        diagnostic: /pnpm.*update types/u,
      },
      {
        source: baseline.source.replace(
          "directory: /.devcontainer",
          "directory: /containers",
        ),
        diagnostic: /docker.*\.devcontainer.*update/u,
      },
    ];
    for (const mutation of mutations) {
      expect(() =>
        assertDependabotContract(
          plan,
          baseline.sourcePath,
          parse(mutation.source),
        ),
      ).toThrow(mutation.diagnostic);
    }
  });

  it("rejects root-only workflows with extra jobs or job-level permissions", async () => {
    const source = await rootOnlyWorkflowSource();
    await expectRootOnlyWorkflowRejected(
      source.replace(
        "    steps:\n",
        "    permissions:\n      contents: write\n    steps:\n",
      ),
    );
    await expectRootOnlyWorkflowRejected(
      `${source}\n  cache:\n    runs-on: ubuntu-latest\n    steps: []\n`,
    );
  });

  it("rejects every workflow-level execution bypass", async () => {
    const source = await rootOnlyWorkflowSource();
    await expectRootOnlyWorkflowRejected(
      source.replace(
        "permissions:\n",
        "defaults:\n  run:\n    shell: bash\n\npermissions:\n",
      ),
    );
    await expectRootOnlyWorkflowRejected(`${source}\nenv:\n  CI: true\n`);
  });

  it("rejects root-only workflows with extra steps or a second checkout", async () => {
    const source = await rootOnlyWorkflowSource();
    await expectRootOnlyWorkflowRejected(
      source.replace(
        "      - name: Install dependencies\n",
        "      - name: Parse logs\n        run: node scripts/parse-logs.js\n      - name: Install dependencies\n",
      ),
    );
    await expectRootOnlyWorkflowRejected(
      source.replace(
        "      - name: Install dependencies\n",
        "      - name: Checkout another repository\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5\n      - name: Install dependencies\n",
      ),
    );
  });

  it("rejects an action pin or release comment outside the checked contract", async () => {
    const source = await rootOnlyWorkflowSource();
    await expectRootOnlyWorkflowRejected(
      source.replace(
        "fc06bc1257f339d1d5d8b3a19a8cae5388b55320",
        "0000000000000000000000000000000000000000",
      ),
    );
    await expectRootOnlyWorkflowRejected(
      source.replace("# v4.4.0", "# v4.4.1"),
    );
  });

  it("rejects deployment matrices without independent bounded capability legs", async () => {
    const source = await deploymentWorkflowSource();
    await expectDeploymentWorkflowRejected(
      source.replace("      fail-fast: false", "      fail-fast: true"),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        `        include:
          - capability: root
            job_name: Root Check
            task_entrypoint: pnpm run check
            timeout_minutes: 30
            requires_docker: false
          - capability: deployment
            job_name: Deployment Check
            task_entrypoint: pnpm run check:deployment
            timeout_minutes: 45
            requires_docker: true`,
        "        check: [root, deployment]",
      ),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        "    runs-on: ubuntu-latest\n",
        "    runs-on: ubuntu-latest\n    needs: root\n",
      ),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        "if: matrix.requires_docker",
        "if: matrix.capability == 'deployment'",
      ),
    );
    await expectDeploymentWorkflowRejected(
      `${source.replace(
        "uses: docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c # v4.2.0",
        "uses: docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
      )}\n# uses: docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c # v4.2.0\n`,
    );
  });

  it("rejects diagnostics that lose root-only staging scope, owner facts, or upload outside its fixed LCA", async () => {
    const source = await deploymentWorkflowSource();
    await expectDeploymentWorkflowRejected(
      source.replace(
        "if: failure() && matrix.capability == 'root'",
        "if: failure()",
      ),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        "path: .template-ci-diagnostics",
        "path: apps/web/test-results",
      ),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        "DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
        "DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web\n            apps/admin",
      ),
    );
  });

  it("does not let a malformed plan supply diagnostic paths to the structured checker", async () => {
    const plan = deploymentPlan();
    const baseline = await renderedWorkflow(plan);
    expect(() =>
      assertWorkflowContract(
        plan,
        baseline.sourcePath,
        baseline.source,
        parse(baseline.source) as Record<string, unknown>,
      ),
    ).not.toThrow();

    const maliciousPlan = {
      ...plan,
      ciDiagnosticArtifacts: [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/web" },
          paths: [".env", "**/*"],
        },
      ],
    } as unknown as GeneratedRepositoryPlan;
    expect(() =>
      assertWorkflowContract(
        maliciousPlan,
        baseline.sourcePath,
        baseline.source,
        parse(baseline.source) as Record<string, unknown>,
      ),
    ).toThrow(
      "CI Diagnostic Artifact declarations may contain only kind and owner",
    );

    const undeclaredOwnerPlan = {
      ...plan,
      ciDiagnosticArtifacts: [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/admin" },
        },
      ],
    } as unknown as GeneratedRepositoryPlan;
    expect(() =>
      assertWorkflowContract(
        undeclaredOwnerPlan,
        baseline.sourcePath,
        baseline.source,
        parse(baseline.source) as Record<string, unknown>,
      ),
    ).toThrow(
      "CI Diagnostic Artifact owner is not a declared Package Boundary",
    );

    const unsafeOwnerPlan = {
      ...plan,
      ciDiagnosticArtifacts: [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "node_modules/private" },
        },
      ],
    } as unknown as GeneratedRepositoryPlan;
    expect(() =>
      assertWorkflowContract(
        unsafeOwnerPlan,
        baseline.sourcePath,
        baseline.source,
        parse(baseline.source) as Record<string, unknown>,
      ),
    ).toThrow(
      "CI Diagnostic Artifact owner has an unsafe Package Boundary path",
    );
  });

  it("accepts a parsed deployment workflow with multiple validated diagnostic owners", async () => {
    const plan = deploymentPlan();
    const baseline = await renderedWorkflow(plan);
    const declarations = [
      {
        kind: "playwright" as const,
        owner: { kind: "package-boundary" as const, path: "apps/admin" },
      },
      {
        kind: "playwright" as const,
        owner: { kind: "package-boundary" as const, path: "apps/web" },
      },
    ];
    const source = baseline.source.replace(
      "DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
      "DIAGNOSTIC_OWNER_PATHS: |-\n            apps/admin\n            apps/web",
    );
    const multipleOwnersPlan = {
      ...plan,
      blueprint: {
        ...plan.blueprint,
        packages: [
          ...plan.blueprint.packages,
          { name: "@demo/admin", path: "apps/admin", role: "runtime-service" },
        ],
      },
      ciDiagnosticArtifacts: declarations,
    } as GeneratedRepositoryPlan;

    expect(() =>
      assertWorkflowContract(
        multipleOwnersPlan,
        baseline.sourcePath,
        source,
        parse(source) as Record<string, unknown>,
      ),
    ).not.toThrow();
    const steps = (
      parse(source) as {
        readonly jobs: {
          readonly check: {
            readonly steps: readonly {
              readonly run?: string;
              readonly with?: { readonly path?: string };
              readonly env?: { readonly DIAGNOSTIC_OWNER_PATHS?: string };
            }[];
          };
        };
      }
    ).jobs.check.steps;
    expect(steps.at(-1)?.with?.path).toBe(".template-ci-diagnostics");
    expect(steps.at(-2)?.run).toContain(
      "for diagnostic_directory in test-results playwright-report; do",
    );
    expect(steps.at(-2)?.run).toContain(
      'destination_path=".template-ci-diagnostics/$owner_path/$diagnostic_directory"',
    );
    expect(steps.at(-2)?.env).toEqual({
      DIAGNOSTIC_OWNER_PATHS: "apps/admin\napps/web",
    });
  });
});
