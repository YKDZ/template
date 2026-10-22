import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parse } from "yaml";

type WorkflowStep = {
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly env?: Record<string, string>;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, boolean | number | string>;
};

type CheckWorkflow = {
  readonly concurrency: {
    readonly group: string;
    readonly "cancel-in-progress": string;
  };
  readonly on: {
    readonly pull_request: Record<string, never> | null;
    readonly push: { readonly branches: readonly string[] };
    readonly workflow_dispatch: null;
    readonly workflow_call: {
      readonly inputs: Record<
        string,
        {
          readonly default: boolean | string;
          readonly description: string;
          readonly required: boolean;
          readonly type: string;
        }
      >;
      readonly secrets: Record<string, { readonly required: boolean }>;
      readonly outputs: Record<
        string,
        { readonly description: string; readonly value: string }
      >;
    };
  };
  readonly jobs: {
    readonly check: {
      readonly env?: Record<string, string>;
      readonly permissions?: Record<string, string>;
      readonly outputs: { readonly pack_artifact_id: string };
      readonly steps: readonly WorkflowStep[];
      readonly "timeout-minutes": number;
    };
  };
};

async function checkWorkflow(): Promise<CheckWorkflow> {
  return parse(
    await readFile(".github/workflows/check.yml", "utf8"),
  ) as CheckWorkflow;
}

void describe("Fixture Verification Evidence check workflow", () => {
  void it("checks every pull request while avoiding duplicate branch-push checks outside main", async () => {
    const workflow = await checkWorkflow();

    assert.strictEqual(workflow.on.pull_request, null);
    assert.deepStrictEqual(workflow.on.push, { branches: ["main"] });
    assert.strictEqual(workflow.on.workflow_dispatch, null);
  });

  void it("cancels only stale checks for the same pull request", async () => {
    const workflow = await checkWorkflow();

    assert.deepStrictEqual(workflow.concurrency, {
      group:
        "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    const eventTable = [
      {
        caller: "direct Check",
        event: "pull_request",
        ref: "refs/pull/17/merge",
        runId: "101",
        workflow: "Check",
      },
      {
        caller: "direct Check",
        event: "pull_request",
        ref: "refs/pull/18/merge",
        runId: "102",
        workflow: "Check",
      },
      {
        caller: "direct Check",
        event: "push",
        ref: "refs/heads/main",
        runId: "103",
        workflow: "Check",
      },
      {
        caller: "direct Check",
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        runId: "104",
        workflow: "Check",
      },
      {
        caller: "reusable Release",
        event: "release",
        ref: "refs/tags/v1.0.0",
        runId: "105",
        workflow: "Release",
      },
      {
        caller: "reusable Release",
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        runId: "106",
        workflow: "Release",
      },
      {
        caller: "reusable PR Check",
        event: "pull_request",
        ref: "refs/pull/19/merge",
        runId: "107",
        workflow: "PR Check",
      },
    ] as const;
    assert.deepStrictEqual(
      eventTable.map(({ caller, event, ref, runId, workflow }) => ({
        caller,
        event,
        group:
          event === "pull_request"
            ? `${workflow}-${ref}`
            : `${workflow}-${runId}`,
        cancelInProgress: event === "pull_request",
      })),
      [
        {
          caller: "direct Check",
          event: "pull_request",
          group: "Check-refs/pull/17/merge",
          cancelInProgress: true,
        },
        {
          caller: "direct Check",
          event: "pull_request",
          group: "Check-refs/pull/18/merge",
          cancelInProgress: true,
        },
        {
          caller: "direct Check",
          event: "push",
          group: "Check-103",
          cancelInProgress: false,
        },
        {
          caller: "direct Check",
          event: "workflow_dispatch",
          group: "Check-104",
          cancelInProgress: false,
        },
        {
          caller: "reusable Release",
          event: "release",
          group: "Release-105",
          cancelInProgress: false,
        },
        {
          caller: "reusable Release",
          event: "workflow_dispatch",
          group: "Release-106",
          cancelInProgress: false,
        },
        {
          caller: "reusable PR Check",
          event: "pull_request",
          group: "PR Check-refs/pull/19/merge",
          cancelInProgress: true,
        },
      ],
    );
  });

  void it("bounds the observed cold Check runtime with a 120 minute timeout", async () => {
    const job = (await checkWorkflow()).jobs.check;

    assert.strictEqual(job["timeout-minutes"], 120);
  });

  void it("runs the heavy gate only after the light gate and its prerequisites", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const lightGateIndex = steps.findIndex(
      (step) =>
        step.run ===
        "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check",
    );
    const heavyGateIndex = steps.findIndex(
      (step) =>
        step.run ===
        "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
    );
    const dockerSetupIndex = steps.findIndex(
      (step) => step.uses === "docker/setup-buildx-action@v4",
    );

    assert.ok(lightGateIndex >= 0);
    assert.ok(heavyGateIndex > lightGateIndex);
    assert.ok(dockerSetupIndex > lightGateIndex);
    assert.strictEqual(steps[lightGateIndex]?.id, "package-check");
  });

  void it("validates fixture prerequisites before running container-backed gates", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const prerequisites = steps.find(
      (step) => step.id === "fixture-prerequisites",
    );
    const workspace = parse(await readFile("pnpm-workspace.yaml", "utf8")) as {
      readonly catalog: Record<string, string>;
    };
    const checksManifest = JSON.parse(
      await readFile("packages/checks/package.json", "utf8"),
    ) as {
      readonly devDependencies: Record<string, string>;
    };

    assert.notStrictEqual(
      steps.find((step) => step.uses === "docker/setup-buildx-action@v4"),
      undefined,
    );
    assert.strictEqual(workspace.catalog["@devcontainers/cli"], "0.89.0");
    assert.strictEqual(
      checksManifest.devDependencies["@devcontainers/cli"],
      "catalog:",
    );
    assert.partialDeepStrictEqual(prerequisites, {
      name: "Validate Fixture Gate Prerequisites",
      run: [
        "docker version --format '{{.Server.Version}}'",
        "pnpm --filter @ykdz/template-checks exec devcontainer --version",
        "",
      ].join("\n"),
    });

    const heavyGate = steps.find(
      (step) =>
        step.run ===
        "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
    );
    assert.strictEqual(
      heavyGate?.if,
      "always() && steps.package-check.outcome == 'success'",
    );
    assert.ok(
      steps.findIndex(
        (step) =>
          step.run ===
          "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
      ) > steps.findIndex((step) => step.id === "fixture-prerequisites"),
    );
    assert.strictEqual(
      steps.find((step) => step.id === "fixture-evidence-health")?.if,
      "always() && steps.package-check.outcome == 'success'",
    );
  });

  void it("enables job-local evidence while limiting publication to trusted main pushes", async () => {
    const workflow = await checkWorkflow();
    const job = workflow.jobs.check;

    assert.deepStrictEqual(job.env, {
      TEMPLATE_FIXTURE_EVIDENCE_DIR:
        "${{ github.workspace }}/.fixture-evidence",
      TEMPLATE_FIXTURE_EVIDENCE_READ: "1",
      TEMPLATE_FIXTURE_EVIDENCE_WRITE: "1",
      TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR:
        "${{ github.workspace }}/.fixture-evidence-activity",
      TEMPLATE_FIXTURE_EVIDENCE_RUN_ID: "${{ github.run_id }}",
      TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: "${{ github.run_attempt }}",
      TEMPLATE_FIXTURE_BUILDKIT_CACHE_DIR:
        "${{ github.workspace }}/.fixture-native-cache/buildkit",
      TEMPLATE_FIXTURE_PNPM_CACHE_DIR:
        "${{ github.workspace }}/.fixture-native-cache/pnpm",
      TEMPLATE_FIXTURE_CARGO_CACHE_DIR:
        "${{ github.workspace }}/.fixture-native-cache/cargo",
      TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR:
        "${{ github.workspace }}/.cli-journey-diagnostics",
      TEMPLATE_BUILTIN_PRESET_DIAGNOSTICS_DIR:
        "${{ github.workspace }}/.preset-behavior-diagnostics",
    });

    const scenarioCommands = new Set([
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check",
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
    ]);
    const scenarioSteps = job.steps.filter(
      (step) => step.run !== undefined && scenarioCommands.has(step.run),
    );
    assert.strictEqual(scenarioSteps.length, 2);
    assert.strictEqual(
      scenarioSteps.every((step) =>
        Object.keys(step.env ?? {}).every(
          (name) => !name.startsWith("TEMPLATE_FIXTURE_EVIDENCE_"),
        ),
      ),
      true,
    );
    assert.strictEqual(
      job.steps.find(
        (step) => step.name === "Enable trusted evidence publication",
      ),
      undefined,
    );
  });

  void it("shares signed Turbo cache only with trusted producers and read-only Release consumers", async () => {
    const trustedCacheCredential =
      "${{ (((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch') && job.workflow_ref == github.workflow_ref || github.event_name == 'release') && secrets.";
    const checkWorkflowDocument = await checkWorkflow();
    const check = checkWorkflowDocument.jobs.check;
    const packageCheck = check.steps.find(
      (step) =>
        step.run ===
        "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check",
    );
    const turboConfig = parse(await readFile("turbo.json", "utf8")) as Record<
      string,
      unknown
    >;

    assert.deepStrictEqual(checkWorkflowDocument.on.workflow_call.secrets, {
      TURBO_TOKEN: { required: false },
      TURBO_REMOTE_CACHE_SIGNATURE_KEY: { required: false },
    });
    assert.strictEqual(packageCheck?.env, undefined);
    assert.strictEqual(
      check.steps.every((step) =>
        Object.keys(step.env ?? {}).every((name) => !name.startsWith("TURBO_")),
      ),
      true,
    );
    for (const command of [
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
    ]) {
      assert.deepStrictEqual(
        check.steps.find((step) => step.run === command)?.env,
        {
          TEMPLATE_FIXTURE_TURBO_TEAM: "${{ vars.TURBO_TEAM }}",
          TEMPLATE_FIXTURE_TURBO_TOKEN: `${trustedCacheCredential}TURBO_TOKEN || '' }}`,
          TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY: `${trustedCacheCredential}TURBO_REMOTE_CACHE_SIGNATURE_KEY || '' }}`,
          TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY:
            "${{ (((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch') && job.workflow_ref == github.workflow_ref) && 'false' || 'true' }}",
        },
      );
    }
    assert.deepStrictEqual(turboConfig.remoteCache, { signature: true });
  });

  void it("runs every later scenario stage and Evidence Health after an earlier gate fails", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    for (const command of [
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
    ]) {
      assert.ok(
        steps.find((step) => step.run === command)?.if?.includes("always()"),
      );
    }

    assert.partialDeepStrictEqual(
      steps.find((step) => step.id === "fixture-evidence-health"),
      {
        name: "Check Fixture Evidence Health",
        if: "always() && steps.package-check.outcome == 'success'",
        run: "pnpm --filter @ykdz/template-checks run check:evidence-health",
      },
    );

    assert.strictEqual(
      steps.find(
        (step) =>
          step.run ===
          "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
      )?.if,
      steps.find((step) => step.id === "fixture-evidence-health")?.if,
    );
  });

  void it("always preserves the current run activity after Evidence Health", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const healthIndex = steps.findIndex(
      (step) => step.id === "fixture-evidence-health",
    );
    const uploadIndex = steps.findIndex(
      (step) => step.name === "Upload Fixture Evidence Activity",
    );
    const restoreIndex = steps.findIndex(
      (step) =>
        step.run?.includes("sudo chown -hR") &&
        step.run.includes(".fixture-workspace"),
    );

    assert.ok(uploadIndex > healthIndex);
    assert.ok(restoreIndex < uploadIndex);
    assert.deepStrictEqual(steps[uploadIndex], {
      name: "Upload Fixture Evidence Activity",
      if: "always()",
      uses: "actions/upload-artifact@v7",
      with: {
        name: "fixture-evidence-activity-${{ github.run_id }}-${{ github.run_attempt }}",
        path: ".fixture-evidence-activity/activity.jsonl",
        "include-hidden-files": true,
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
  });

  void it("uploads retained Fixture failures without dependency and download caches", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const upload = steps.find(
      (step) => step.name === "Upload Fixture Failure Diagnostics",
    );
    assert.ok(upload);
    assert.equal(
      upload.if,
      "always() && steps.fixture-prerequisites.outcome == 'success'",
    );
    assert.equal(upload.uses, "actions/upload-artifact@v7");
    assert.equal(
      upload.with?.name,
      "fixture-failure-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    const artifactPath = upload.with?.path;
    if (typeof artifactPath !== "string") {
      throw new TypeError(
        "Fixture failure diagnostics artifact path is missing",
      );
    }
    assert.deepEqual(artifactPath.split("\n").filter(Boolean), [
      ".fixture-workspace/**",
      "!.fixture-workspace/**/node_modules/**",
      "!.fixture-workspace/**/.pnpm-store/**",
      "!.fixture-workspace/**/.npm/**",
      "!.fixture-workspace/**/.cargo/registry/**",
      "!.fixture-workspace/**/.cargo/git/**",
      "!.fixture-workspace/**/target/**",
      "!.fixture-workspace/**/.cache/**",
      "!.fixture-workspace/**/.turbo/cache/**",
    ]);
    assert.equal(upload.with?.["include-hidden-files"], true);
    assert.equal(upload.with?.["if-no-files-found"], "ignore");
    assert.equal(upload.with?.["retention-days"], 7);
  });

  void it("在诊断上传前清理 Fixture 容器并恢复工作区属主", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const prerequisiteCondition =
      "always() && steps.fixture-prerequisites.outcome == 'success'";
    const cleanupIndex = steps.findIndex(
      (step) =>
        step.run?.includes(
          "docker ps -aq --filter label=com.ykdz.template.fixture.project",
        ) && step.run.includes('docker rm -f "${fixture_containers[@]}"'),
    );
    const restoreIndex = steps.findIndex(
      (step) =>
        step.run?.includes("sudo chown -hR") &&
        step.run.includes(".fixture-workspace"),
    );
    const uploadIndex = steps.findIndex(
      (step) => step.name === "Upload Fixture Failure Diagnostics",
    );
    const firstArtifactUploadIndex = steps.findIndex(
      (step) => step.uses === "actions/upload-artifact@v7",
    );
    const cleanup = steps[cleanupIndex];
    const restore = steps[restoreIndex];

    assert.ok(cleanupIndex >= 0);
    assert.ok(restoreIndex >= 0);
    assert.ok(uploadIndex >= 0);
    assert.ok(cleanupIndex < restoreIndex);
    assert.ok(restoreIndex < firstArtifactUploadIndex);
    assert.ok(firstArtifactUploadIndex < uploadIndex);
    assert.equal(cleanup?.if, prerequisiteCondition);
    assert.equal(restore?.if, prerequisiteCondition);
    assert.match(
      restore?.run ?? "",
      /if \[ -d \.fixture-workspace \]; then\n\s+sudo chown -hR "\$\(id -u\):\$\(id -g\)" -- \.fixture-workspace\n\s*fi/u,
    );
    assert.doesNotMatch(restore?.run ?? "", /\|\|\s*true/u);
  });

  void it("always uploads CLI journey diagnostics from the durable workspace directory", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const upload = steps.find(
      (step) => step.name === "Upload CLI Journey Diagnostics",
    );

    assert.partialDeepStrictEqual(upload, {
      if: "always()",
      uses: "actions/upload-artifact@v7",
      with: {
        name: "cli-journey-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
        "include-hidden-files": true,
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
    const artifactPath = upload?.with?.path;
    assert.ok(typeof artifactPath === "string");
    assert.deepStrictEqual(artifactPath.trimEnd().split("\n"), [
      ".cli-journey-diagnostics/**",
      "!.cli-journey-diagnostics/**/node_modules/**",
      "!.cli-journey-diagnostics/**/.pnpm-store/**",
      "!.cli-journey-diagnostics/**/.npm/**",
      "!.cli-journey-diagnostics/**/.cargo/registry/**",
      "!.cli-journey-diagnostics/**/.cargo/git/**",
      "!.cli-journey-diagnostics/**/target/**",
      "!.cli-journey-diagnostics/**/.cache/**",
      "!.cli-journey-diagnostics/**/.turbo/cache/**",
    ]);
  });

  void it("uses a new Actions transport namespace and publishes only after healthy trusted work", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const restore = steps.find(
      (step) => step.name === "Restore Fixture Verification Evidence",
    );
    const save = steps.find(
      (step) => step.name === "Save Fixture Verification Evidence",
    );

    assert.deepStrictEqual(restore?.with, {
      path: ".fixture-evidence",
      key: "fixture-verification-evidence-${{ runner.os }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "restore-keys": "fixture-verification-evidence-${{ runner.os }}-\n",
    });
    assert.partialDeepStrictEqual(save, {
      name: "Save Fixture Verification Evidence",
      if: "always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && job.workflow_ref == github.workflow_ref && steps.fixture-evidence-health.outcome == 'success'",
      with: {
        path: ".fixture-evidence",
        key: "fixture-verification-evidence-${{ runner.os }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      },
    });
  });

  void it("restores native caches for pull requests and saves only trusted healthy fixture work", async () => {
    const job = (await checkWorkflow()).jobs.check;
    const pullRequestOrTrustedRead =
      "github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main' && job.workflow_ref == github.workflow_ref) || github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && job.workflow_ref == github.workflow_ref)";
    const trustedHealthyWrite =
      "always() && ((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch') && job.workflow_ref == github.workflow_ref && steps.fixture-evidence-health.outcome == 'success'";
    const caches = [
      {
        name: "BuildKit",
        path: ".fixture-native-cache/buildkit",
        keyInput:
          "hashFiles('workspace-policies/default/assets/environment/**/*.Dockerfile', 'workspace-policies/default/assets/environment/devcontainer/workspace-template.json', 'workspace-policies/default/resources/deployment/Dockerfile', 'packages/environment/src/development-container-tool-layer.ts')",
      },
      {
        name: "pnpm downloads",
        path: ".fixture-native-cache/pnpm",
        keyInput: "hashFiles('pnpm-lock.yaml')",
      },
      {
        name: "Cargo downloads",
        path: ".fixture-native-cache/cargo",
        keyInput:
          "hashFiles('references/rust-bin/Cargo.lock', 'rust-toolchain.toml')",
      },
    ] as const;

    for (const cache of caches) {
      const restore = job.steps.find(
        (step) => step.name === `Restore ${cache.name} cache`,
      );
      const save = job.steps.find(
        (step) => step.name === `Save ${cache.name} cache`,
      );

      assert.partialDeepStrictEqual(restore, {
        if: pullRequestOrTrustedRead,
        uses: "actions/cache/restore@v6",
        with: { path: cache.path },
      });
      const restoreKey = restore?.with?.key;
      const restoreKeys = restore?.with?.["restore-keys"];
      assert.ok(typeof restoreKey === "string");
      assert.ok(typeof restoreKeys === "string");
      assert.ok(restoreKey.includes(cache.keyInput));
      assert.ok(restoreKey.includes("${{ github.run_id }}"));
      assert.ok(restoreKeys.includes(cache.keyInput));
      assert.partialDeepStrictEqual(save, {
        if: trustedHealthyWrite,
        uses: "actions/cache/save@v6",
        with: {
          path: cache.path,
          key: restore?.with?.key,
        },
      });
      assert.doesNotMatch(
        cache.path,
        /(?:node_modules|pnpm-lock|workspace|target)/u,
      );
    }
  });
});
