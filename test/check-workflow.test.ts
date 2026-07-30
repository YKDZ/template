import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly env?: Record<string, string>;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, string>;
};

type CheckWorkflow = {
  readonly on: {
    readonly workflow_call: {
      readonly secrets: Record<string, { readonly required: boolean }>;
    };
  };
  readonly jobs: {
    readonly check: {
      readonly env?: Record<string, string>;
      readonly steps: readonly WorkflowStep[];
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

describe("Fixture Verification Evidence check workflow", () => {
  it("validates fixture prerequisites before running container-backed gates", async () => {
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

    expect(
      steps.find((step) => step.uses === "docker/setup-buildx-action@v3"),
    ).toBeDefined();
    expect(workspace.catalog["@devcontainers/cli"]).toBe("0.88.0");
    expect(checksManifest.devDependencies["@devcontainers/cli"]).toBe(
      "catalog:",
    );
    expect(prerequisites).toMatchObject({
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
      expect(steps.find((step) => step.run === command)?.if).toBe(
        "always() && steps.fixture-prerequisites.outcome == 'success'",
      );
    }
    expect(
      steps.find((step) => step.id === "fixture-evidence-health")?.if,
    ).toBe("always()");
  });

  it("propagates one job-level evidence policy with publication limited to trusted main pushes", async () => {
    const workflow = await checkWorkflow();
    const job = workflow.jobs.check;

    expect(job.env).toEqual({
      TEMPLATE_FIXTURE_EVIDENCE_DIR:
        "${{ github.workspace }}/.fixture-evidence",
      TEMPLATE_FIXTURE_EVIDENCE_READ: "1",
      TEMPLATE_FIXTURE_EVIDENCE_WRITE: "0",
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
    expect(scenarioSteps).toHaveLength(4);
    expect(
      scenarioSteps.every((step) =>
        Object.keys(step.env ?? {}).every(
          (name) => !name.startsWith("TEMPLATE_FIXTURE_EVIDENCE_"),
        ),
      ),
    ).toBe(true);
    expect(
      job.steps.find(
        (step) => step.name === "Enable trusted evidence publication",
      ),
    ).toMatchObject({
      if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && job.workflow_ref == github.workflow_ref",
      run: 'echo "TEMPLATE_FIXTURE_EVIDENCE_WRITE=1" >> "$GITHUB_ENV"',
    });
  });

  it("shares signed Turbo cache only with trusted producers and read-only Release consumers", async () => {
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

    expect(checkWorkflowDocument.on.workflow_call.secrets).toEqual({
      TURBO_TOKEN: { required: false },
      TURBO_REMOTE_CACHE_SIGNATURE_KEY: { required: false },
    });
    expect(packageCheck?.env).toBeUndefined();
    expect(
      check.steps.every((step) =>
        Object.keys(step.env ?? {}).every((name) => !name.startsWith("TURBO_")),
      ),
    ).toBe(true);
    for (const command of [
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
    ]) {
      expect(check.steps.find((step) => step.run === command)?.env).toEqual({
        TEMPLATE_FIXTURE_TURBO_TEAM: "${{ vars.TURBO_TEAM }}",
        TEMPLATE_FIXTURE_TURBO_TOKEN: `${trustedCacheCredential}TURBO_TOKEN || '' }}`,
        TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY: `${trustedCacheCredential}TURBO_REMOTE_CACHE_SIGNATURE_KEY || '' }}`,
        TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY:
          "${{ (((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch') && job.workflow_ref == github.workflow_ref) && 'false' || 'true' }}",
      });
    }
    expect(release.jobs.check.secrets).toEqual({
      TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
      TURBO_REMOTE_CACHE_SIGNATURE_KEY:
        "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
    });
    expect(
      release.jobs.publish.steps.find(
        (step) =>
          step.run ===
          "pnpm --filter @ykdz/template run publish:bundled --no-git-checks --access public --provenance",
      )?.env,
    ).toEqual({
      TURBO_TEAM: "${{ vars.TURBO_TEAM }}",
      TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
      TURBO_REMOTE_CACHE_SIGNATURE_KEY:
        "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
      TURBO_REMOTE_CACHE_READ_ONLY: "true",
    });
    expect(turboConfig.remoteCache).toEqual({ signature: true });
  });

  it("runs every later scenario stage and Evidence Health after an earlier gate fails", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    for (const command of [
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
    ]) {
      expect(steps.find((step) => step.run === command)?.if).toContain(
        "always()",
      );
    }

    expect(
      steps.find((step) => step.id === "fixture-evidence-health"),
    ).toMatchObject({
      name: "Check Fixture Evidence Health",
      if: "always()",
      run: "pnpm --filter @ykdz/template-checks run check:evidence-health",
    });
  });

  it("uses a new Actions transport namespace and publishes only after healthy trusted work", async () => {
    const steps = (await checkWorkflow()).jobs.check.steps;
    const restore = steps.find(
      (step) => step.name === "Restore Fixture Verification Evidence",
    );
    const save = steps.find(
      (step) => step.name === "Save Fixture Verification Evidence",
    );

    expect(restore?.with).toEqual({
      path: ".fixture-evidence",
      key: "fixture-verification-evidence-${{ runner.os }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "restore-keys": "fixture-verification-evidence-${{ runner.os }}-\n",
    });
    expect(save).toMatchObject({
      name: "Save Fixture Verification Evidence",
      if: "always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && job.workflow_ref == github.workflow_ref && steps.fixture-evidence-health.outcome == 'success'",
      with: {
        path: ".fixture-evidence",
        key: "fixture-verification-evidence-${{ runner.os }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      },
    });
  });

  it("persists isolated native caches only for trusted healthy fixture work", async () => {
    const job = (await checkWorkflow()).jobs.check;
    const trustedRead =
      "(github.event_name == 'push' && github.ref == 'refs/heads/main' && job.workflow_ref == github.workflow_ref) || github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && job.workflow_ref == github.workflow_ref)";
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

      expect(restore).toMatchObject({
        if: trustedRead,
        uses: "actions/cache/restore@v6",
        with: { path: cache.path },
      });
      expect(restore?.with?.key).toContain(cache.keyInput);
      expect(restore?.with?.key).toContain("${{ github.run_id }}");
      expect(restore?.with?.["restore-keys"]).toContain(cache.keyInput);
      expect(save).toMatchObject({
        if: trustedHealthyWrite,
        uses: "actions/cache/save@v6",
        with: {
          path: cache.path,
          key: restore?.with?.key,
        },
      });
      expect(cache.path).not.toMatch(
        /(?:node_modules|pnpm-lock|workspace|target)/u,
      );
    }
  });

  it("keeps Release on the same read-only reusable check workflow", async () => {
    const workflow = parse(
      await readFile(".github/workflows/release.yml", "utf8"),
    ) as ReleaseWorkflow;

    expect(workflow.jobs.check).toEqual({
      name: "Check package",
      uses: "./.github/workflows/check.yml",
      secrets: {
        TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
        TURBO_REMOTE_CACHE_SIGNATURE_KEY:
          "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
      },
    });
    expect(workflow.jobs.check.with).toBeUndefined();
    expect(workflow.jobs.publish.needs).toBe("check");
  });

  it("keeps Release readiness tied to packed Rust addition and container-backed generated quality", async () => {
    const check = (await checkWorkflow()).jobs.check.steps;
    const release = parse(
      await readFile(".github/workflows/release.yml", "utf8"),
    ) as ReleaseWorkflow;
    const packedConsumerSource = await readFile(
      "test/packed-publication.test.ts",
      "utf8",
    );

    expect(release.jobs.check.uses).toBe("./.github/workflows/check.yml");
    expect(release.jobs.publish.needs).toBe("check");
    expect(check.find((step) => step.run === "pnpm run check")).toBeDefined();
    expect(packedConsumerSource).toContain(
      'addableDefinitionWithPackageRole("native-package")',
    );
    expect(packedConsumerSource).toContain(
      '"--preset",\n          rustDefinition.metadata.name,',
    );
    expect(packedConsumerSource).toContain(
      'await execa("pnpm", ["run", "check"], { cwd: rustAdditionTarget });',
    );
    for (const command of [
      "pnpm run check:fixtures",
      "pnpm run check:focused",
      "pnpm run check:deployment",
    ]) {
      expect(check.find((step) => step.run === command)?.if).toBe(
        "always() && steps.fixture-prerequisites.outcome == 'success'",
      );
    }
  });

  it("keeps only the new evidence store and current-run activity local", async () => {
    const ignored = new Set(
      (await readFile(".gitignore", "utf8"))
        .split("\n")
        .filter((line) => line.length > 0),
    );

    expect(ignored).toContain(".fixture-evidence/");
    expect(ignored).toContain(".fixture-evidence-activity/");
    expect(ignored).toContain(".fixture-native-cache/");
  });
});
