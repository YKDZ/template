import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import {
  assertDependabotContract,
  assertWorkflowContract,
  assertPublicationWorkflowContract,
} from "@ykdz/template-checks/workflow-contract";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { parse } from "yaml";

function rootOnlyPlan(): GeneratedRepositoryPlan {
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const plan = planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "root-only"),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    return plan.deploymentCheck === undefined;
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
  sourcePath:
    | ".github/dependabot.yml"
    | ".github/workflows/check.yml"
    | ".github/workflows/release.yml",
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
  // 遍历全部 Definition 新建初始化会派生新建公开 ts-cli 候选，需要发版快照的精确三段版本。
  const toolchain = {
    nodeLtsMajor: "24",
    packageManagerPin: "pnpm@11.11.0",
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
  } as const;
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const plan = planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "deployment"),
        toolchain,
      }),
    });
    return plan.deploymentCheck !== undefined;
  });
  if (definition === undefined) {
    throw new Error("Expected a deployment-capable Built-in Preset Definition");
  }
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "deployment"),
      toolchain,
    }),
  });
}

async function deploymentWorkflowSource(): Promise<string> {
  return (await renderedWorkflow(deploymentPlan())).source;
}

async function expectDeploymentWorkflowRejected(source: string): Promise<void> {
  const plan = deploymentPlan();
  const baseline = await renderedWorkflow(plan);
  assert.doesNotThrow(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      baseline.source,
      parse(baseline.source) as Record<string, unknown>,
    ),
  );
  assert.throws(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      source,
      parse(source) as Record<string, unknown>,
    ),
  );
}

async function expectRootOnlyWorkflowRejected(source: string): Promise<void> {
  const plan = rootOnlyPlan();
  const baseline = await renderedWorkflow(plan);
  assert.doesNotThrow(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      baseline.source,
      parse(baseline.source) as Record<string, unknown>,
    ),
  );
  assert.throws(() =>
    assertWorkflowContract(
      plan,
      baseline.sourcePath,
      source,
      parse(source) as Record<string, unknown>,
    ),
  );
}

function initializationPublicationPlan(): GeneratedRepositoryPlan {
  for (const definition of builtInPresetRegistry.all()) {
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: "generated-publication",
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    });
    if (
      plan.packageContributions.some(
        (contribution) =>
          contribution.foundation.npmPublication?.kind ===
          "public-cli-candidate",
      )
    ) {
      return plan;
    }
  }
  throw new Error("Expected a public CLI candidate capability");
}

void describe("Built-in Preset GitHub YAML checker", () => {
  void it("accepts independent immutable upgrades and presentation-only YAML edits", async () => {
    for (const plan of [rootOnlyPlan(), deploymentPlan()]) {
      const baseline = await renderedWorkflow(plan);
      const source = baseline.source
        .replace(
          /@[a-f0-9]{40} # v[^\n]+/gu,
          "@" + "a".repeat(40) + " # v123.4.5",
        )
        .replace(/- name: [^\n]+/gu, "- name: 自定义展示名称")
        .replace("contents: read", "contents: read  ");
      const workflow = parse(source);
      workflow.concurrency = Object.fromEntries(
        Object.entries(workflow.concurrency).toReversed(),
      );
      assert.doesNotThrow(() =>
        assertWorkflowContract(plan, baseline.sourcePath, source, workflow),
      );
    }
  });

  void it("accepts publication Action upgrades and presentation changes from a real generation", async () => {
    const plan = initializationPublicationPlan();
    const baseline = await renderedGithubSource(
      plan,
      ".github/workflows/release.yml",
    );
    const source = baseline.source
      .replace(/@[a-f0-9]{40} # v[^\n]+/gu, "@" + "c".repeat(40) + " # v456")
      .replace(/- name: [^\n]+/gu, "- name: 发布展示文字");
    const workflow = parse(source);
    workflow.jobs.publish.permissions = Object.fromEntries(
      Object.entries(workflow.jobs.publish.permissions).toReversed(),
    );
    assert.doesNotThrow(() =>
      assertPublicationWorkflowContract(plan, source, workflow),
    );
  });

  void it("rejects damaged Dependabot update, ignore, and directory semantics from a real generated file", async () => {
    const plan = rootOnlyPlan();
    const baseline = await renderedDependabot(plan);
    assert.doesNotThrow(() =>
      assertDependabotContract(
        plan,
        baseline.sourcePath,
        parse(baseline.source),
      ),
    );

    const mutations = [
      {
        source: baseline.source.replace("interval: weekly", "interval: daily"),
        diagnostic: /weekly update schedule/u,
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
      assert.throws(
        () =>
          assertDependabotContract(
            plan,
            baseline.sourcePath,
            parse(mutation.source),
          ),
        (error: unknown) =>
          error instanceof Error && mutation.diagnostic.test(error.message),
      );
    }
  });

  void it("rejects root-only workflows with extra jobs or job-level permissions", async () => {
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

  void it("rejects every workflow-level execution bypass", async () => {
    const source = await rootOnlyWorkflowSource();
    await expectRootOnlyWorkflowRejected(
      source.replace(
        "permissions:\n",
        "defaults:\n  run:\n    shell: bash\n\npermissions:\n",
      ),
    );
    await expectRootOnlyWorkflowRejected(`${source}\nenv:\n  CI: true\n`);
  });

  void it("rejects root-only workflows with extra steps or a second checkout", async () => {
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
        "      - name: Checkout another repository\n        uses: actions/checkout@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v123\n      - name: Install dependencies\n",
      ),
    );
  });

  void it("rejects mutable references, wrong Action identities, and detached release comments", async () => {
    const source = await rootOnlyWorkflowSource();
    await expectRootOnlyWorkflowRejected(
      source.replace(/(uses: pnpm\/action-setup)@[a-f0-9]{40}/u, "$1@main"),
    );
    await expectRootOnlyWorkflowRejected(
      source.replace("uses: pnpm/action-setup@", "uses: unexpected/setup@"),
    );
    await expectRootOnlyWorkflowRejected(
      source.replace(/(uses: pnpm\/action-setup@[^ #]+) #[^\n]+/u, "$1") +
        "\n# v123\n",
    );
  });

  void it("rejects lost setup configuration, credentials, and frozen installation before the check", async () => {
    const source = await rootOnlyWorkflowSource();
    for (const mutated of [
      source.replace("persist-credentials: false", "persist-credentials: true"),
      source.replace("node-version-file: package.json", "node-version: latest"),
      source.replace("pnpm install --frozen-lockfile", "pnpm install"),
      source.replace(
        "run: pnpm install --frozen-lockfile",
        "run: pnpm run check",
      ),
    ])
      await expectRootOnlyWorkflowRejected(mutated);
  });

  void it("要求 Full Check 有限时长且在重验收前准备 Docker", async () => {
    const source = await deploymentWorkflowSource();
    await expectDeploymentWorkflowRejected(
      source.replace("timeout-minutes: 45", "timeout-minutes: 30"),
    );
    await expectDeploymentWorkflowRejected(
      source.replace("name: Full Check", "name: Root Check"),
    );
    await expectDeploymentWorkflowRejected(
      source.replace("run: pnpm run check:heavy", "run: pnpm run check"),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        "uses: docker/setup-buildx-action@",
        "uses: unexpected/setup@",
      ),
    );
  });

  void it("拒绝诊断材料脱离失败阶段、声明所有者或固定上传目录", async () => {
    const source = await deploymentWorkflowSource();
    await expectDeploymentWorkflowRejected(
      source.replace("if: failure()", "if: success()"),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        "path: .template-ci-diagnostics",
        "path: apps/web/test-results",
      ),
    );
    await expectDeploymentWorkflowRejected(
      source.replace(
        "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
        "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web\n            apps/admin",
      ),
    );
  });

  void it("does not let a malformed plan supply diagnostic paths to the structured checker", async () => {
    const plan = deploymentPlan();
    const baseline = await renderedWorkflow(plan);
    assert.doesNotThrow(() =>
      assertWorkflowContract(
        plan,
        baseline.sourcePath,
        baseline.source,
        parse(baseline.source) as Record<string, unknown>,
      ),
    );

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
    assert.throws(
      () =>
        assertWorkflowContract(
          maliciousPlan,
          baseline.sourcePath,
          baseline.source,
          parse(baseline.source) as Record<string, unknown>,
        ),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "CI Diagnostic Artifact declarations may contain only kind and owner",
        ),
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
    assert.throws(
      () =>
        assertWorkflowContract(
          undeclaredOwnerPlan,
          baseline.sourcePath,
          baseline.source,
          parse(baseline.source) as Record<string, unknown>,
        ),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "CI Diagnostic Artifact owner is not a declared Package Boundary",
        ),
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
    assert.throws(
      () =>
        assertWorkflowContract(
          unsafeOwnerPlan,
          baseline.sourcePath,
          baseline.source,
          parse(baseline.source) as Record<string, unknown>,
        ),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "CI Diagnostic Artifact owner has an unsafe Package Boundary path",
        ),
    );
  });

  void it("accepts a parsed deployment workflow with multiple validated diagnostic owners", async () => {
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
      {
        kind: "vitest-browser" as const,
        owner: { kind: "package-boundary" as const, path: "apps/web" },
      },
    ];
    const source = baseline.source.replace(
      "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
      "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/admin\n            apps/web",
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

    assert.doesNotThrow(() =>
      assertWorkflowContract(
        multipleOwnersPlan,
        baseline.sourcePath,
        source,
        parse(source) as Record<string, unknown>,
      ),
    );
    const steps = (
      parse(source) as {
        readonly jobs: {
          readonly check: {
            readonly steps: readonly {
              readonly run?: string;
              readonly with?: { readonly path?: string };
              readonly env?: {
                readonly PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS?: string;
                readonly VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS?: string;
              };
            }[];
          };
        };
      }
    ).jobs.check.steps;
    assert.strictEqual(steps.at(-1)?.with?.path, ".template-ci-diagnostics");
    assert.ok(
      steps
        .at(-2)
        ?.run?.includes(
          "for diagnostic_directory in test-results playwright-report; do",
        ),
    );
    assert.ok(
      steps
        .at(-2)
        ?.run?.includes(
          'destination_path=".template-ci-diagnostics/$owner_path/$diagnostic_directory"',
        ),
    );
    assert.deepStrictEqual(steps.at(-2)?.env, {
      PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: "apps/admin\napps/web",
      VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS: "apps/web",
    });
  });
});
