import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parse } from "yaml";

import { assertLength, assertPartialDeepStrictEqual } from "./assertions.ts";

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
      readonly secrets: Record<string, { readonly required: boolean }>;
    };
  };
  readonly jobs: {
    readonly check: {
      readonly env?: Record<string, string>;
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

type ReleaseWorkflow = {
  readonly jobs: {
    readonly check: {
      readonly name: string;
      readonly secrets?: Record<string, string>;
      readonly uses: string;
      readonly with?: Record<string, unknown>;
    };
    readonly publish: {
      readonly needs: string;
      readonly steps: readonly WorkflowStep[];
    };
  };
};

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
    assertPartialDeepStrictEqual(prerequisites, {
      name: "Validate Fixture Gate Prerequisites",
      run: [
        "docker version --format '{{.Server.Version}}'",
        "pnpm --filter @ykdz/template-checks exec devcontainer --version",
        "",
      ].join("\n"),
    });

    for (const command of [
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
    ]) {
      assert.strictEqual(
        steps.find((step) => step.run === command)?.if,
        "always() && steps.fixture-prerequisites.outcome == 'success'",
      );
    }
    assert.strictEqual(
      steps.find((step) => step.id === "fixture-evidence-health")?.if,
      "always()",
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
    });

    const scenarioCommands = new Set([
      "pnpm run check",
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
    ]);
    const scenarioSteps = job.steps.filter(
      (step) => step.run !== undefined && scenarioCommands.has(step.run),
    );
    assertLength(scenarioSteps, 4);
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
      (step) => step.run === "pnpm run check",
    );
    const release = parse(
      await readFile(".github/workflows/release.yml", "utf8"),
    ) as ReleaseWorkflow;
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
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
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
    assert.deepStrictEqual(release.jobs.check.secrets, {
      TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
      TURBO_REMOTE_CACHE_SIGNATURE_KEY:
        "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
    });
    assert.deepStrictEqual(
      release.jobs.publish.steps.find(
        (step) =>
          step.run ===
          "pnpm --filter @ykdz/template run publish:bundled --no-git-checks --access public --provenance",
      )?.env,
      {
        TURBO_TEAM: "${{ vars.TURBO_TEAM }}",
        TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
        TURBO_REMOTE_CACHE_SIGNATURE_KEY:
          "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
        TURBO_REMOTE_CACHE_READ_ONLY: "true",
      },
    );
    assert.deepStrictEqual(turboConfig.remoteCache, { signature: true });
  });

  void it("runs every later scenario stage and Evidence Health after an earlier gate fails", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    for (const command of [
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
    ]) {
      assert.ok(
        steps.find((step) => step.run === command)?.if?.includes("always()"),
      );
    }

    assertPartialDeepStrictEqual(
      steps.find((step) => step.id === "fixture-evidence-health"),
      {
        name: "Check Fixture Evidence Health",
        if: "always()",
        run: "pnpm --filter @ykdz/template-checks run check:evidence-health",
      },
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

    assert.strictEqual(uploadIndex, healthIndex + 1);
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
    assertPartialDeepStrictEqual(save, {
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
          "hashFiles('packages/builtin-presets/templates/**/*.Dockerfile', 'packages/builtin-presets/templates/foundation/devcontainer.json', 'packages/core/src/development-container-tool-layer.ts')",
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
          "hashFiles('Cargo.lock', 'packages/builtin-presets/templates/**/Cargo.lock', 'packages/builtin-presets/templates/**/rust-toolchain.toml')",
      },
    ] as const;

    for (const cache of caches) {
      const restore = job.steps.find(
        (step) => step.name === `Restore ${cache.name} cache`,
      );
      const save = job.steps.find(
        (step) => step.name === `Save ${cache.name} cache`,
      );

      assertPartialDeepStrictEqual(restore, {
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
      assertPartialDeepStrictEqual(save, {
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

  void it("keeps Release on the same read-only reusable check workflow", async () => {
    const workflow = parse(
      await readFile(".github/workflows/release.yml", "utf8"),
    ) as ReleaseWorkflow;

    assert.strictEqual(workflow.jobs.check.with, undefined);
    assert.deepStrictEqual(workflow.jobs.check, {
      name: "Check package",
      uses: "./.github/workflows/check.yml",
      secrets: {
        TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
        TURBO_REMOTE_CACHE_SIGNATURE_KEY:
          "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
      },
    });
    assert.strictEqual(workflow.jobs.publish.needs, "check");
  });

  void it("keeps Release readiness tied to packed Rust addition and container-backed generated quality", async () => {
    const check = (await checkWorkflow()).jobs.check.steps;
    const release = parse(
      await readFile(".github/workflows/release.yml", "utf8"),
    ) as ReleaseWorkflow;
    const packedConsumerSource = await readFile(
      "test/packed-publication.test.ts",
      "utf8",
    );

    assert.strictEqual(
      release.jobs.check.uses,
      "./.github/workflows/check.yml",
    );
    assert.strictEqual(release.jobs.publish.needs, "check");
    assert.notStrictEqual(
      check.find((step) => step.run === "pnpm run check"),
      undefined,
    );
    assert.ok(
      packedConsumerSource.includes(
        'addableDefinitionWithPackageRole("native-package")',
      ),
    );
    assert.match(
      packedConsumerSource,
      /"--preset",\s*rustDefinition\.metadata\.name,/u,
    );
    assert.ok(
      packedConsumerSource.includes(
        'await execa("pnpm", ["run", "check"], { cwd: rustAdditionTarget });',
      ),
    );
    for (const command of [
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
    ]) {
      assert.strictEqual(
        check.find((step) => step.run === command)?.if,
        "always() && steps.fixture-prerequisites.outcome == 'success'",
      );
    }
  });

  void it("keeps only the new evidence store and current-run activity local", async () => {
    const ignored = new Set(
      (await readFile(".gitignore", "utf8"))
        .split("\n")
        .filter((line) => line.length > 0),
    );

    assert.ok(ignored.has(".fixture-evidence/"));
    assert.ok(ignored.has(".fixture-evidence-activity/"));
    assert.ok(ignored.has(".fixture-native-cache/"));
  });
});
