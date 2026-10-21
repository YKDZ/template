import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assertDependabotContract,
  assertWorkflowContract,
} from "@ykdz/template-checks/workflow-contract";
import { templatePresets } from "@ykdz/template-content";
import { parse } from "yaml";

import {
  initializePreset,
  type GeneratedPresetReceipt,
} from "../test-support/generated-preset-receipt.ts";

async function renderedPresetSource(
  ownsDeploymentCheck: boolean,
  sourcePath: ".github/dependabot.yml" | ".github/workflows/check.yml",
): Promise<{
  readonly receipt: GeneratedPresetReceipt;
  readonly sourcePath: string;
  readonly source: string;
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-workflow-"));
  try {
    for (const preset of templatePresets) {
      const targetRoot = path.join(workspace, preset.alias);
      const receipt = await initializePreset({
        preset,
        targetRoot,
        repositoryName: preset.alias,
      });
      const hasDeploymentCheck =
        receipt.result.projection.ownerFacts.environmentNeeds.deployment.some(
          (need) => need.kind === "docker-engine",
        );
      if (hasDeploymentCheck !== ownsDeploymentCheck) continue;
      return {
        receipt,
        sourcePath,
        source: await readFile(path.join(targetRoot, sourcePath), "utf8"),
      };
    }
    throw new Error(
      `Expected generated preset with deployment=${ownsDeploymentCheck}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function rootOnlyWorkflow(): Promise<{
  readonly receipt: GeneratedPresetReceipt;
  readonly sourcePath: string;
  readonly source: string;
}> {
  return renderedPresetSource(false, ".github/workflows/check.yml");
}

async function deploymentWorkflow(): Promise<{
  readonly receipt: GeneratedPresetReceipt;
  readonly sourcePath: string;
  readonly source: string;
}> {
  return renderedPresetSource(true, ".github/workflows/check.yml");
}

async function expectWorkflowRejected(
  baseline: Awaited<ReturnType<typeof rootOnlyWorkflow>>,
  source: string,
): Promise<void> {
  assert.doesNotThrow(() =>
    assertWorkflowContract(
      baseline.receipt,
      baseline.sourcePath,
      baseline.source,
      parse(baseline.source) as Record<string, unknown>,
    ),
  );
  assert.throws(() =>
    assertWorkflowContract(
      baseline.receipt,
      baseline.sourcePath,
      source,
      parse(source) as Record<string, unknown>,
    ),
  );
}

async function renderedDependabot(): Promise<{
  readonly receipt: GeneratedPresetReceipt;
  readonly sourcePath: string;
  readonly source: string;
}> {
  return renderedPresetSource(false, ".github/dependabot.yml");
}

function receiptWithOwnerFacts(
  receipt: GeneratedPresetReceipt,
  ownerFacts: GeneratedPresetReceipt["result"]["projection"]["ownerFacts"],
  blueprint = receipt.result.blueprint,
): GeneratedPresetReceipt {
  const result = {
    ...receipt.result,
    blueprint,
    projection: { ...receipt.result.projection, blueprint, ownerFacts },
  } as GeneratedPresetReceipt["result"];
  return { ...receipt, initialization: result, result };
}

void describe("Built-in Preset GitHub YAML checker", () => {
  void it("accepts independent immutable upgrades and presentation-only YAML edits", async () => {
    for (const baseline of [
      await rootOnlyWorkflow(),
      await deploymentWorkflow(),
    ]) {
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
        assertWorkflowContract(
          baseline.receipt,
          baseline.sourcePath,
          source,
          workflow,
        ),
      );
    }
  });

  void it("rejects damaged Dependabot update, ignore, and directory semantics from a real generated file", async () => {
    const baseline = await renderedDependabot();
    assert.doesNotThrow(() =>
      assertDependabotContract(
        baseline.receipt,
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
            baseline.receipt,
            baseline.sourcePath,
            parse(mutation.source),
          ),
        (error: unknown) =>
          error instanceof Error && mutation.diagnostic.test(error.message),
      );
    }
  });

  void it("rejects root-only workflows with extra jobs or job-level permissions", async () => {
    const baseline = await rootOnlyWorkflow();
    const source = baseline.source;
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "    steps:\n",
        "    permissions:\n      contents: write\n    steps:\n",
      ),
    );
    await expectWorkflowRejected(
      baseline,
      `${source}\n  cache:\n    runs-on: ubuntu-latest\n    steps: []\n`,
    );
  });

  void it("rejects every workflow-level execution bypass", async () => {
    const baseline = await rootOnlyWorkflow();
    const source = baseline.source;
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "permissions:\n",
        "defaults:\n  run:\n    shell: bash\n\npermissions:\n",
      ),
    );
    await expectWorkflowRejected(baseline, `${source}\nenv:\n  CI: true\n`);
  });

  void it("rejects root-only workflows with extra steps or a second checkout", async () => {
    const baseline = await rootOnlyWorkflow();
    const source = baseline.source;
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "      - name: Install dependencies\n",
        "      - name: Parse logs\n        run: node scripts/parse-logs.js\n      - name: Install dependencies\n",
      ),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "      - name: Install dependencies\n",
        "      - name: Checkout another repository\n        uses: actions/checkout@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v123\n      - name: Install dependencies\n",
      ),
    );
  });

  void it("rejects mutable references, wrong Action identities, and detached release comments", async () => {
    const baseline = await rootOnlyWorkflow();
    const source = baseline.source;
    await expectWorkflowRejected(
      baseline,
      source.replace(/(uses: pnpm\/action-setup)@[a-f0-9]{40}/u, "$1@main"),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace("uses: pnpm/action-setup@", "uses: unexpected/setup@"),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace(/(uses: pnpm\/action-setup@[^ #]+) #[^\n]+/u, "$1") +
        "\n# v123\n",
    );
  });

  void it("rejects lost setup configuration, credentials, and frozen installation before the check", async () => {
    const baseline = await rootOnlyWorkflow();
    const source = baseline.source;
    for (const mutated of [
      source.replace("persist-credentials: false", "persist-credentials: true"),
      source.replace("node-version-file: package.json", "node-version: latest"),
      source.replace("pnpm install --frozen-lockfile", "pnpm install"),
      source.replace(
        "run: pnpm install --frozen-lockfile",
        "run: node --conditions=source scripts/task-gates.ts check",
      ),
    ])
      await expectWorkflowRejected(baseline, mutated);
  });

  void it("拒绝重验收缺少时限、Docker 准备或正确顺序", async () => {
    const baseline = await deploymentWorkflow();
    const source = baseline.source;
    await expectWorkflowRejected(
      baseline,
      source.replace("timeout-minutes: 45", "timeout-minutes: 30"),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "run: node --conditions=source scripts/task-gates.ts check:heavy",
        "run: node --conditions=source scripts/task-gates.ts check",
      ),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "uses: docker/setup-buildx-action@",
        "uses: unexpected/setup@",
      ),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace(
        /(?<light>      - name: Run Light Check\n        run: node --conditions=source scripts\/task-gates\.ts check\n)(?<buildx>      - name: Set up Docker Buildx\n(?:        id: [^\n]+\n)?        uses: docker\/setup-buildx-action@[^\n]+\n)/u,
        "$2$1",
      ),
    );
  });

  void it("拒绝诊断材料脱离失败阶段、声明所有者或固定上传目录", async () => {
    const baseline = await deploymentWorkflow();
    const source = baseline.source;
    await expectWorkflowRejected(
      baseline,
      source.replace(
        /(?<stage>      - name: Stage Check diagnostics\n(?:        id: [^\n]+\n)?        if: )failure\(\)/u,
        "$1success()",
      ),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "path: .template-ci-diagnostics",
        "path: apps/web/test-results",
      ),
    );
    await expectWorkflowRejected(
      baseline,
      source.replace(
        "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
        "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web\n            apps/admin",
      ),
    );
  });

  void it("rejects malformed owner facts before using diagnostic paths", async () => {
    const baseline = await deploymentWorkflow();
    assert.doesNotThrow(() =>
      assertWorkflowContract(
        baseline.receipt,
        baseline.sourcePath,
        baseline.source,
        parse(baseline.source) as Record<string, unknown>,
      ),
    );

    const ownerFacts = baseline.receipt.result.projection.ownerFacts;
    const malformedOwnerFacts = {
      ...ownerFacts,
      diagnosticArtifacts: [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/web" },
          paths: [".env", "**/*"],
        },
      ],
    } as unknown as typeof ownerFacts;
    assert.throws(
      () =>
        assertWorkflowContract(
          receiptWithOwnerFacts(baseline.receipt, malformedOwnerFacts),
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

    const undeclaredOwnerFacts = {
      ...ownerFacts,
      diagnosticArtifacts: [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/admin" },
        },
      ],
    } as unknown as typeof ownerFacts;
    assert.throws(
      () =>
        assertWorkflowContract(
          receiptWithOwnerFacts(baseline.receipt, undeclaredOwnerFacts),
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

    const unsafeOwnerFacts = {
      ...ownerFacts,
      diagnosticArtifacts: [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "node_modules/private" },
        },
      ],
    } as unknown as typeof ownerFacts;
    assert.throws(
      () =>
        assertWorkflowContract(
          receiptWithOwnerFacts(baseline.receipt, unsafeOwnerFacts),
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
    const baseline = await deploymentWorkflow();
    const ownerFacts = baseline.receipt.result.projection.ownerFacts;
    const declarations = [
      ...ownerFacts.diagnosticArtifacts,
      {
        kind: "playwright" as const,
        owner: { kind: "package-boundary" as const, path: "apps/admin" },
      },
    ] as typeof ownerFacts.diagnosticArtifacts;
    const source = baseline.source.replace(
      "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
      "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/admin\n            apps/web",
    );
    const blueprint = {
      ...baseline.receipt.result.blueprint,
      packages: [
        ...baseline.receipt.result.blueprint.packages,
        {
          name: "@demo/admin",
          path: "apps/admin",
          role: "runtime-service",
          packageDefinitionId: "package-admin",
        },
      ],
    } as typeof baseline.receipt.result.blueprint;
    const multipleOwnersReceipt = receiptWithOwnerFacts(
      baseline.receipt,
      { ...ownerFacts, diagnosticArtifacts: declarations },
      blueprint,
    );

    assert.doesNotThrow(() =>
      assertWorkflowContract(
        multipleOwnersReceipt,
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
      VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS: "apps/web\npackages/vue-shared",
    });
  });
});
