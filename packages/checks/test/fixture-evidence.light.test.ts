import { describe, it, mock } from "node:test";

import { contentIdentityKey } from "@ykdz/template-core/content-identity";

import {
  deriveDeploymentQualityContractIdentity,
  deriveDeploymentQualityPlanInput,
} from "../src/fixture-evidence/gates/deployment-quality/index.ts";
import {
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  assert,
  checkFixtureEvidenceHealth,
  chmod,
  cp,
  createBlockedConcurrencyProbe,
  createBlockedWorkProbe,
  createFixtureEvidenceScheduler,
  createSuccessfulFixturePhaseExecutor,
  deriveFixtureGateContractIdentity,
  deriveGeneratedRootQualityContractIdentity,
  execa,
  executeFocusedPackageLink,
  executeGeneratedRootQuality,
  findFixtureEvidenceArchitectureFindings,
  fixtureContainerEnvironmentFromEnvironment,
  fixtureDependencyCachesFromEnvironment,
  focusedMarker,
  formatFixtureEvidenceHealthReport,
  generatedRootQualityExecutionResources,
  generatedScenariosFor,
  initializeFixtureGitRepository,
  isolatedFixtureEnvironment,
  mkdir,
  path,
  readFile,
  readdir,
  recordSuccessfulFixturePhase,
  rm,
  renderMatrixScenario,
  runFixtureEvidenceGate,
  successfulRootEvidence,
  symlink,
  temporaryRepository,
  writeFile,
  writeGeneratedRepositoryTree,
} from "./fixture-evidence.test-support.ts";
import type {
  FixtureEvidenceGate,
  FixtureEvidenceInvocationEvent,
  FixtureEvidenceLifecycleEvent,
  FixtureEvidenceStorage,
} from "./fixture-evidence.test-support.ts";

void describe("Fixture Verification Evidence", () => {
  void it("invalidates Root proof when its covered Deployment contract changes", async () => {
    const workspace = await temporaryRepository("fixture-deployment-contract-");
    try {
      const selectedScenario = (await generatedScenariosFor("deployment"))[0]!;
      const rendered = await renderMatrixScenario({
        scenario: selectedScenario,
        workspace,
      });
      const result = rendered.receipt.result;
      const deployment = deriveDeploymentQualityPlanInput(
        result,
        selectedScenario.id,
      );
      assert.notStrictEqual(deployment, undefined);
      const deploymentContractIdentity =
        await deriveDeploymentQualityContractIdentity(deployment!);
      const changedDeploymentContractIdentity =
        await deriveDeploymentQualityContractIdentity({
          scenarioId: deployment!.scenarioId,
          requirement: {
            ...deployment!.requirement,
            environmentNeeds: [],
          },
        });
      const rootContractIdentity =
        await deriveGeneratedRootQualityContractIdentity(result, {
          deploymentContractIdentity,
        });
      const changedRootContractIdentity =
        await deriveGeneratedRootQualityContractIdentity(result, {
          deploymentContractIdentity: changedDeploymentContractIdentity,
        });

      assert.notStrictEqual(
        changedDeploymentContractIdentity,
        deploymentContractIdentity,
      );
      assert.notStrictEqual(changedRootContractIdentity, rootContractIdentity);

      const evidenceScenario = {
        id: "deployment-contract-invalidation",
        label: "deployment contract invalidation",
        presetIdentities: [contentIdentityKey(selectedScenario.base.identity)],
      };
      const generatedContentIdentity = "a".repeat(40);
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity,
        contractIdentity: rootContractIdentity,
        coversDeploymentContractIdentity: deploymentContractIdentity,
        scenario: evidenceScenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });
      const changedRootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity,
        contractIdentity: changedRootContractIdentity,
        coversDeploymentContractIdentity: changedDeploymentContractIdentity,
        scenario: evidenceScenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });
      const focusedContractIdentity = "b".repeat(64);
      const focusedEvidence = await runFixtureEvidenceGate({
        gate: "focused-package-link",
        rootEvidence,
        generatedContentIdentity,
        contractIdentity: focusedContractIdentity,
        scenario: evidenceScenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });
      const changedFocusedEvidence = await runFixtureEvidenceGate({
        gate: "focused-package-link",
        rootEvidence: changedRootEvidence,
        generatedContentIdentity,
        contractIdentity: focusedContractIdentity,
        scenario: evidenceScenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });
      const deploymentEvidence = await runFixtureEvidenceGate({
        gate: "deployment-quality",
        rootEvidence,
        generatedContentIdentity,
        contractIdentity: deploymentContractIdentity,
        scenario: evidenceScenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });
      const changedDeploymentEvidence = await runFixtureEvidenceGate({
        gate: "deployment-quality",
        rootEvidence: changedRootEvidence,
        generatedContentIdentity,
        contractIdentity: changedDeploymentContractIdentity,
        scenario: evidenceScenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });

      assert.notStrictEqual(
        changedRootEvidence.identity,
        rootEvidence.identity,
      );
      assert.notStrictEqual(
        changedFocusedEvidence.identity,
        focusedEvidence.identity,
      );
      assert.notStrictEqual(
        changedDeploymentEvidence.identity,
        deploymentEvidence.identity,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("accepts a complete writable miss only for its current run activity", async () => {
    const root = await temporaryRepository("fixture-evidence-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const scenario = {
      id: "fixture-current-run",
      label: "fixture current run",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: activityRoot,
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "run-42",
        runAttempt: "2",
        invocationId: "init-current-run",
        scenarioSet: "init",
        writeEnabled: true,
        clock: () => new Date("2026-07-28T00:00:00.000Z"),
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executePhases("generated-root-quality"),
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      const currentAttempt = await checkFixtureEvidenceHealth({
        ledger,
        runId: "run-42",
        runAttempt: "2",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(currentAttempt.healthy, true);
      assert.strictEqual(currentAttempt.stages.length, 1);
      assert.partialDeepStrictEqual(currentAttempt.stages[0], {
        scenarioSet: "init",
        hits: 0,
        misses: { absent: 1 },
        executions: 1,
        issuances: 1,
      });
      const previousAttempt = await checkFixtureEvidenceHealth({
        ledger,
        runId: "run-42",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(previousAttempt.healthy, false);
      assert.strictEqual(previousAttempt.failures.length, 1);
      assert.partialDeepStrictEqual(previousAttempt.failures[0], {
        code: "missing-scenario-set",
        scenarioSet: "init",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("derives Deployment evidence from the current complete Root proof without a second execution", async () => {
    const root = await temporaryRepository("fixture-deployment-derivation-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "deployment-derived-current-run",
      label: "deployment derived current run",
      presetIdentities: ["fixture"],
    };
    const deploymentContractIdentity = "3".repeat(64);
    let deploymentExecutions = 0;
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "deployment-derived-run",
        runAttempt: "1",
        invocationId: "deployment-derived-invocation",
        scenarioSet: "deployment",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        coversDeploymentContractIdentity: deploymentContractIdentity,
        scenario,
        producerCommit: "test",
        storage,
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executePhases("generated-root-quality"),
      });
      const deployment = await runFixtureEvidenceGate({
        gate: "deployment-quality",
        rootEvidence,
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: deploymentContractIdentity,
        scenario,
        producerCommit: "test",
        storage,
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => {
          deploymentExecutions += 1;
          await executePhases("deployment-quality");
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      assert.strictEqual(deployment.status, "derived");
      assert.strictEqual(deploymentExecutions, 0);
      assert.deepStrictEqual(
        JSON.parse(
          await readFile(
            path.join(
              evidenceRoot,
              "deployment-quality",
              `${deployment.identity}.json`,
            ),
            "utf8",
          ),
        ),
        {
          schema: "fixture-verification-evidence/v1",
          gate: "deployment-quality",
          identity: deployment.identity,
          components: {
            generatedContent: "1".repeat(40),
            contract: deploymentContractIdentity,
            rootEvidence: rootEvidence.identity,
          },
          issuedAt: deployment.record?.issuedAt,
          scenario,
          producerCommit: "test",
        },
      );

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "deployment-derived-run",
        runAttempt: "1",
        enabledScenarioSets: ["deployment"],
      });
      assert.strictEqual(report.healthy, true, JSON.stringify(report.failures));
      assert.deepStrictEqual(report.scenarios[0]?.gates, [
        {
          gate: "deployment-quality",
          status: "derived",
          missReason: "absent",
          issued: true,
        },
        {
          gate: "generated-root-quality",
          status: "executed",
          missReason: "absent",
          issued: true,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("derives read-only Deployment proof from a successful cold Root execution", async () => {
    const root = await temporaryRepository(
      "fixture-deployment-readonly-derivation-",
    );
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "deployment-readonly-derived",
      label: "deployment read-only derived",
      presetIdentities: ["fixture"],
    };
    const deploymentContractIdentity = "4".repeat(64);
    const executions: FixtureEvidenceGate[] = [];
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "deployment-readonly-run",
        runAttempt: "1",
        invocationId: "deployment-readonly-invocation",
        scenarioSet: "deployment",
        writeEnabled: false,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "5".repeat(40),
        contractIdentity: "6".repeat(64),
        coversDeploymentContractIdentity: deploymentContractIdentity,
        scenario,
        producerCommit: "readonly",
        storage,
        writeEnabled: false,
        recordLifecycle: invocation.record,
        execute: async () => {
          executions.push("generated-root-quality");
          await executePhases("generated-root-quality");
        },
      });
      const deployment = await runFixtureEvidenceGate({
        gate: "deployment-quality",
        rootEvidence,
        generatedContentIdentity: "5".repeat(40),
        contractIdentity: deploymentContractIdentity,
        scenario,
        producerCommit: "readonly",
        storage,
        writeEnabled: false,
        recordLifecycle: invocation.record,
        execute: async () => {
          executions.push("deployment-quality");
          await executePhases("deployment-quality");
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      assert.strictEqual(rootEvidence.status, "executed");
      assert.strictEqual(deployment.status, "derived-unissued");
      assert.deepStrictEqual(executions, ["generated-root-quality"]);
      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "deployment-readonly-run",
        runAttempt: "1",
        enabledScenarioSets: ["deployment"],
      });
      assert.strictEqual(report.healthy, true, JSON.stringify(report.failures));
      assert.partialDeepStrictEqual(report.stages[0], {
        executions: 1,
        derivations: 1,
        issuances: 0,
      });
      assert.deepStrictEqual(report.scenarios[0]?.gates, [
        {
          gate: "deployment-quality",
          status: "derived",
          missReason: "absent",
          issued: false,
        },
        {
          gate: "generated-root-quality",
          status: "executed",
          missReason: "absent",
          issued: false,
        },
      ]);
      await invocation.record({
        type: "issuance",
        gate: "deployment-quality",
        identity: deployment.identity,
        scenario,
        at: new Date().toISOString(),
        outcome: "issued",
      });
      const invalidReadOnlyIssue = await checkFixtureEvidenceHealth({
        ledger,
        runId: "deployment-readonly-run",
        runAttempt: "1",
        enabledScenarioSets: ["deployment"],
      });
      assert.strictEqual(invalidReadOnlyIssue.healthy, false);
      assert.ok(
        invalidReadOnlyIssue.failures.some(
          (failure) => failure.code === "invalid-derivation",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("reports deterministic cache activity alongside stage timing", async () => {
    const root = await temporaryRepository("fixture-evidence-cache-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "cache-activity",
      label: "cache activity",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "cache-run",
        runAttempt: "1",
        invocationId: "cache-invocation",
        scenarioSet: "package-addition-matrix",
        writeEnabled: true,
        clock: (() => {
          const timestamps = [
            "2026-07-28T00:00:00.000Z",
            "2026-07-28T00:00:00.025Z",
            "2026-07-28T00:00:00.050Z",
            "2026-07-28T00:00:00.075Z",
            "2026-07-28T00:00:00.100Z",
            "2026-07-28T00:00:00.125Z",
            "2026-07-28T00:00:00.150Z",
            "2026-07-28T00:00:00.175Z",
          ];
          let index = 0;
          return () => new Date(timestamps[index++] ?? timestamps.at(-1)!);
        })(),
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => {
          for (const fact of [
            { cache: "buildkit", outcome: "configured" },
            { cache: "pnpm-downloads", outcome: "mounted" },
            { cache: "cargo-downloads", outcome: "mounted" },
            { cache: "turbo", outcome: "configured" },
          ] as const) {
            await invocation.record({
              type: "cache",
              ...fact,
              scenario,
              at: "2026-07-28T00:00:00.050Z",
            });
          }
          await executePhases("generated-root-quality");
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "cache-run",
        runAttempt: "1",
        enabledScenarioSets: ["package-addition-matrix"],
      });
      assert.strictEqual(report.healthy, true);
      assert.strictEqual(report.stages.length, 1);
      assert.partialDeepStrictEqual(report.stages[0], {
        scenarioSet: "package-addition-matrix",
        cacheActivity: {
          "buildkit:configured": 1,
          "pnpm-downloads:mounted": 1,
          "cargo-downloads:mounted": 1,
          "turbo:configured": 1,
        },
        hits: 0,
        misses: { absent: 1 },
        executions: 1,
        issuances: 1,
        durationMilliseconds: 175,
      });
      assert.ok(
        formatFixtureEvidenceHealthReport(report).includes(
          "[Fixture Evidence] package-addition-matrix: scenarios=1 hits=0 misses=absent=1 executions=1 derivations=0 issuances=1 lifecycle-errors=0 duration-ms=175 phase-duration-ms=scheduler-queue=2,container-preparation=1,dependency-installation=1,semantic-gate=1 retries=0 recoveries=0 retry-duration-ms=0 cache-activity=buildkit:configured=1,cargo-downloads:mounted=1,pnpm-downloads:mounted=1,turbo:configured=1",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("reports paired phase duration and a recovered retry as healthy", async () => {
    const root = await temporaryRepository("fixture-phase-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "phase-recovery",
      label: "phase recovery",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "phase-run",
        runAttempt: "1",
        invocationId: "phase-invocation",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => {
          for (const [phase, offsetMilliseconds] of [
            ["scheduler-queue", 0],
            ["container-preparation", 20],
          ] as const) {
            await invocation.record({
              type: "phase",
              phase,
              scope: "development-container-session",
              scenario,
              at: new Date(offsetMilliseconds).toISOString(),
              outcome: "started",
            });
            await invocation.record({
              type: "phase",
              phase,
              scope: "development-container-session",
              scenario,
              at: new Date(offsetMilliseconds + 10).toISOString(),
              outcome: "succeeded",
              durationMilliseconds: 10,
            });
          }
          await invocation.record({
            type: "phase",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(40).toISOString(),
            outcome: "started",
          });
          await invocation.record({
            type: "retry",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(45).toISOString(),
            outcome: "started",
            classification: "npm-registry-transport-transient",
            firstError:
              "GET https://registry.npmjs.org/tinypool: read ECONNRESET",
          });
          await invocation.record({
            type: "retry",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(55).toISOString(),
            outcome: "recovered",
            durationMilliseconds: 10,
          });
          await invocation.record({
            type: "phase",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(60).toISOString(),
            outcome: "succeeded",
            durationMilliseconds: 20,
          });
          await recordSuccessfulFixturePhase({
            record: invocation.record,
            scenario,
            phase: "scheduler-queue",
            scope: "generated-root-quality",
            offsetMilliseconds: 70,
          });
          await recordSuccessfulFixturePhase({
            record: invocation.record,
            scenario,
            phase: "semantic-gate",
            scope: "generated-root-quality",
            offsetMilliseconds: 80,
          });
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "phase-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, true);
      assert.strictEqual(report.stages.length, 1);
      assert.partialDeepStrictEqual(report.stages[0], {
        phaseDurations: {
          "scheduler-queue": 11,
          "container-preparation": 10,
          "dependency-installation": 20,
          "semantic-gate": 1,
        },
        retries: 1,
        recoveries: 1,
        retryDurationMilliseconds: 10,
      });
      assert.ok(
        formatFixtureEvidenceHealthReport(report).some((line) =>
          line.includes(
            "phase-duration-ms=scheduler-queue=11,container-preparation=10,dependency-installation=20,semantic-gate=1 retries=1 recoveries=1 retry-duration-ms=10 cache-activity=none",
          ),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when a cache hit carries preparation and retry activity", async () => {
    const root = await temporaryRepository("fixture-hit-preparation-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "hit-preparation",
      label: "hit preparation",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "hit-preparation-run",
        runAttempt: "1",
        invocationId: "hit-preparation",
        scenarioSet: "init",
        writeEnabled: false,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "cache",
        cache: "buildkit",
        outcome: "configured",
        scenario,
        at: new Date(0).toISOString(),
      });
      await invocation.record({
        type: "phase",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(0).toISOString(),
        outcome: "started",
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(1).toISOString(),
        outcome: "started",
        classification: "npm-registry-transport-transient",
        firstError: "GET https://registry.npmjs.org/pkg: read ECONNRESET",
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(2).toISOString(),
        outcome: "recovered",
        durationMilliseconds: 1,
      });
      await invocation.record({
        type: "phase",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(3).toISOString(),
        outcome: "succeeded",
        durationMilliseconds: 3,
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity: "a".repeat(64),
        scenario,
        at: new Date(4).toISOString(),
        outcome: "hit",
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "hit-preparation-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      for (const code of [
        "invalid-phase-lifecycle",
        "invalid-retry-lifecycle",
        "lifecycle-error",
      ]) {
        assert.ok(
          report.failures.some(
            (failure) =>
              failure.code === code && failure.scenarioId === scenario.id,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when successful gate spans remain outside a cold execution", async () => {
    const root = await temporaryRepository("fixture-unused-gate-spans-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "unused-gate-spans",
      label: "unused gate spans",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "unused-gate-spans-run",
        runAttempt: "1",
        invocationId: "unused-gate-spans",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "b".repeat(40),
        contractIdentity: "c".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executePhases("generated-root-quality"),
      });
      await recordSuccessfulFixturePhase({
        record: invocation.record,
        scenario,
        phase: "scheduler-queue",
        scope: "generated-root-quality",
        offsetMilliseconds: 20,
      });
      await recordSuccessfulFixturePhase({
        record: invocation.record,
        scenario,
        phase: "semantic-gate",
        scope: "generated-root-quality",
        offsetMilliseconds: 22,
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "unused-gate-spans-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "invalid-phase-lifecycle" &&
            failure.scenarioId === scenario.id,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when lookup causality has no matching execution", async () => {
    const root = await temporaryRepository("fixture-lookup-causality-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "lookup-causality",
      label: "lookup causality",
      presetIdentities: ["fixture"],
    };
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    try {
      const afterExecution = ledger.invocation({
        runId: "lookup-causality-run",
        runAttempt: "1",
        invocationId: "lookup-after-execution",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await afterExecution.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const identity = "d".repeat(64);
      await afterExecution.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(0).toISOString(),
        outcome: "started",
      });
      await afterExecution.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(1).toISOString(),
        outcome: "miss",
        reason: "absent",
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: afterExecution.record,
        scenario,
      });
      await executePhases("generated-root-quality");
      await afterExecution.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(20).toISOString(),
        outcome: "succeeded",
      });
      await afterExecution.record({
        type: "issuance",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(21).toISOString(),
        outcome: "issued",
      });
      await afterExecution.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await afterExecution.record({
        type: "invocation",
        outcome: "completed",
      });

      const withoutExecution = ledger.invocation({
        runId: "lookup-causality-run",
        runAttempt: "1",
        invocationId: "miss-without-execution",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await withoutExecution.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await withoutExecution.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity: "e".repeat(64),
        scenario,
        at: new Date(0).toISOString(),
        outcome: "miss",
        reason: "absent",
      });
      await withoutExecution.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await withoutExecution.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "lookup-causality-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      for (const invocationId of [
        "lookup-after-execution",
        "miss-without-execution",
      ]) {
        assert.ok(
          report.failures.some(
            (failure) =>
              failure.code === "lifecycle-error" &&
              failure.invocationId === invocationId,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails hard-cut activity when a cold execution omits required phases", async () => {
    const root = await temporaryRepository("fixture-missing-cold-phases-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "missing-cold-phases",
      label: "missing cold phases",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "missing-cold-phases",
        runAttempt: "1",
        invocationId: "missing-cold-phases",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => undefined,
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "missing-cold-phases",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "invalid-phase-lifecycle" &&
            failure.scenarioId === scenario.id &&
            failure.gate === "generated-root-quality",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when complete preparation spans follow semantic execution", async () => {
    const root = await temporaryRepository("fixture-issuance-order-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "issuance-order",
      label: "issuance order",
      presetIdentities: ["fixture"],
    };
    const identity = "b".repeat(64);
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "issuance-order-run",
        runAttempt: "1",
        invocationId: "issuance-order",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.000Z",
        outcome: "miss",
        reason: "absent",
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.010Z",
        outcome: "started",
      });
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: "2026-07-28T00:00:00.020Z",
        outcome: "started",
      });
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: "2026-07-28T00:00:00.021Z",
        outcome: "succeeded",
        durationMilliseconds: 1,
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.030Z",
        outcome: "succeeded",
      });
      await invocation.record({
        type: "issuance",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.040Z",
        outcome: "issued",
      });
      for (const [phase, scope, offsetMilliseconds] of [
        ["scheduler-queue", "development-container-session", 50],
        ["container-preparation", "development-container-session", 60],
        ["dependency-installation", "development-container-session", 70],
        ["scheduler-queue", "generated-root-quality", 80],
      ] as const) {
        await recordSuccessfulFixturePhase({
          record: invocation.record,
          scenario,
          phase,
          scope,
          offsetMilliseconds,
        });
      }
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "issuance-order-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "invalid-phase-lifecycle" &&
            failure.scenarioId === scenario.id &&
            failure.gate === "generated-root-quality",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when a semantic span starts before its execution", async () => {
    const root = await temporaryRepository("fixture-semantic-span-order-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "semantic-span-order",
      label: "semantic span order",
      presetIdentities: ["fixture"],
    };
    const identity = "c".repeat(64);
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "semantic-span-order-run",
        runAttempt: "1",
        invocationId: "semantic-span-order",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(1).toISOString(),
        outcome: "miss",
        reason: "absent",
      });
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: new Date(2).toISOString(),
        outcome: "started",
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(3).toISOString(),
        outcome: "started",
      });
      for (const [phase, scope, offsetMilliseconds] of [
        ["scheduler-queue", "development-container-session", 4],
        ["container-preparation", "development-container-session", 6],
        ["dependency-installation", "development-container-session", 8],
        ["scheduler-queue", "generated-root-quality", 10],
      ] as const) {
        await recordSuccessfulFixturePhase({
          record: invocation.record,
          scenario,
          phase,
          scope,
          offsetMilliseconds,
        });
      }
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: new Date(12).toISOString(),
        outcome: "succeeded",
        durationMilliseconds: 10,
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(13).toISOString(),
        outcome: "succeeded",
      });
      await invocation.record({
        type: "issuance",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(14).toISOString(),
        outcome: "issued",
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "semantic-span-order-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "invalid-phase-lifecycle" &&
            failure.scenarioId === scenario.id &&
            failure.gate === "generated-root-quality",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when a retry finishes before its enclosing phase starts", async () => {
    const root = await temporaryRepository("fixture-retry-span-order-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "retry-span-order",
      label: "retry span order",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "retry-span-order-run",
        runAttempt: "1",
        invocationId: "retry-span-order",
        scenarioSet: "init",
        writeEnabled: false,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(10).toISOString(),
        outcome: "started",
        classification: "npm-registry-transport-transient",
        firstError: "GET https://registry.npmjs.org/tinypool: read ECONNRESET",
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(11).toISOString(),
        outcome: "recovered",
        durationMilliseconds: 1,
      });
      await recordSuccessfulFixturePhase({
        record: invocation.record,
        scenario,
        phase: "dependency-installation",
        scope: "development-container-session",
        offsetMilliseconds: 20,
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity: "d".repeat(64),
        scenario,
        at: new Date(30).toISOString(),
        outcome: "hit",
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "retry-span-order-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "invalid-retry-lifecycle" &&
            failure.scenarioId === scenario.id,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when multiple gates repeat scenario preparation", async () => {
    const root = await temporaryRepository("fixture-duplicate-preparation-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "duplicate-preparation",
      label: "duplicate preparation",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "duplicate-preparation-run",
        runAttempt: "1",
        invocationId: "duplicate-preparation",
        scenarioSet: "package-addition-matrix",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const executeRootPhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "1".repeat(64),
        scenario,
        producerCommit: "test",
        storage,
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executeRootPhases("generated-root-quality"),
      });
      const executeFocusedPhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "focused-package-link",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        rootEvidence,
        scenario,
        producerCommit: "test",
        storage,
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executeFocusedPhases("focused-package-link"),
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "duplicate-preparation-run",
        runAttempt: "1",
        enabledScenarioSets: ["package-addition-matrix"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "invalid-phase-lifecycle" &&
            failure.scenarioId === scenario.id,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("isolates activity from evidence through canonical paths and rejects either parent", async () => {
    const root = await temporaryRepository("fixture-activity-isolation-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const activityAlias = path.join(root, "activity-alias");
    const evidenceAlias = path.join(root, "evidence-alias");
    try {
      await Promise.all([
        mkdir(evidenceRoot, { recursive: true }),
        mkdir(activityRoot, { recursive: true }),
      ]);
      await Promise.all([
        symlink(evidenceRoot, activityAlias, "dir"),
        symlink(activityRoot, evidenceAlias, "dir"),
      ]);

      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityAlias,
            evidenceRoot,
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityRoot,
            evidenceRoot: evidenceAlias,
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: path.join(evidenceRoot, "activity"),
            evidenceRoot,
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityRoot,
            evidenceRoot: path.join(activityRoot, "evidence"),
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("preserves every JSONL record across concurrent ledger instances", async () => {
    const root = await temporaryRepository("fixture-concurrent-ledgers-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const ledgers = Array.from(
      { length: 8 },
      () =>
        new FileFixtureEvidenceActivityLedger({
          root: activityRoot,
          evidenceRoot,
        }),
    );
    try {
      const writes = ledgers.flatMap((ledger, ledgerIndex) => {
        const invocation = ledger.invocation({
          runId: "concurrent-run",
          runAttempt: "1",
          invocationId: `ledger-${ledgerIndex}`,
          scenarioSet: "init",
          writeEnabled: false,
        });
        return Array.from({ length: 50 }, (_, recordIndex) =>
          invocation.record({
            type: "invocation",
            outcome: "failed",
            error: `ledger-${ledgerIndex}-record-${recordIndex}`,
          }),
        );
      });
      await Promise.all(writes);

      const records = await new FileFixtureEvidenceActivityLedger({
        root: activityRoot,
        evidenceRoot,
      }).read();
      assert.strictEqual(records.length, 400);
      assert.strictEqual(
        new Set(
          records.map((record) =>
            record.event.type === "invocation" &&
            record.event.outcome === "failed"
              ? record.event.error
              : "",
          ),
        ).size,
        400,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects activity outside the closed schema before it reaches the ledger", async () => {
    const root = await temporaryRepository("fixture-activity-schema-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "schema-run",
      runAttempt: "1",
      invocationId: "schema-invocation",
      scenarioSet: "init",
      writeEnabled: true,
    });
    try {
      await assert.rejects(
        invocation.record({
          type: "lookup",
          gate: "generated-root-quality",
          identity: "1".repeat(64),
          scenario: {
            id: "schema",
            label: "schema",
            presetIdentities: [],
          },
          at: new Date().toISOString(),
          outcome: "miss",
          reason: "unbounded-human-reason",
        } as unknown as FixtureEvidenceInvocationEvent),
        (error) =>
          error instanceof Error &&
          error.message.includes("invalid Fixture Evidence lookup activity"),
      );
      for (const [cache, outcome] of [
        ["buildkit", "mounted"],
        ["turbo", "mounted"],
        ["pnpm-downloads", "configured"],
        ["cargo-downloads", "configured"],
      ] as const) {
        await assert.rejects(
          invocation.record({
            type: "cache",
            cache,
            scenario: {
              id: "schema",
              label: "schema",
              presetIdentities: [],
            },
            at: new Date().toISOString(),
            outcome,
          } as unknown as FixtureEvidenceInvocationEvent),
          (error) =>
            error instanceof Error &&
            error.message.includes("invalid Fixture Evidence cache activity"),
        );
      }
      assert.deepStrictEqual(await ledger.read(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects invocation activity with no lookup or no writable issuance", async () => {
    const root = await temporaryRepository("fixture-incomplete-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const scenario = {
      id: "incomplete-lifecycle",
      label: "incomplete lifecycle",
      presetIdentities: [],
    };
    try {
      const noLookup = ledger.invocation({
        runId: "incomplete-run",
        runAttempt: "1",
        invocationId: "no-lookup",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await noLookup.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await noLookup.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await noLookup.record({ type: "invocation", outcome: "completed" });

      const noIssuance = ledger.invocation({
        runId: "incomplete-run",
        runAttempt: "1",
        invocationId: "no-issuance",
        scenarioSet: "focused",
        writeEnabled: true,
      });
      await noIssuance.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "3".repeat(40),
        contractIdentity: "4".repeat(64),
        scenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: true,
        recordLifecycle: noIssuance.record,
        execute: async () => undefined,
      });
      await noIssuance.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await noIssuance.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "incomplete-run",
        runAttempt: "1",
        enabledScenarioSets: ["init", "focused"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "no-lookup" &&
            failure.invocationId === "no-lookup",
        ),
      );
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "missing-issuance" &&
            failure.invocationId === "no-issuance" &&
            failure.gate === "generated-root-quality",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects failed fixture executions in current-run activity", async () => {
    const root = await temporaryRepository("fixture-failed-execution-health-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const scenario = {
      id: "semantic-failure",
      label: "semantic failure",
      presetIdentities: [],
    };
    const invocation = ledger.invocation({
      runId: "failed-execution-run",
      runAttempt: "1",
      invocationId: "failed-execution",
      scenarioSet: "focused",
      writeEnabled: true,
    });
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await assert.rejects(
        runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: "5".repeat(40),
          contractIdentity: "6".repeat(64),
          scenario,
          producerCommit: "test",
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            await invocation.record({
              type: "phase",
              phase: "semantic-gate",
              scope: "generated-root-quality",
              scenario,
              at: "2026-07-28T00:00:00.000Z",
              outcome: "started",
            });
            await invocation.record({
              type: "phase",
              phase: "semantic-gate",
              scope: "generated-root-quality",
              scenario,
              at: "2026-07-28T00:00:00.001Z",
              outcome: "failed",
              durationMilliseconds: 1,
              classification: "not-retryable",
              error: "semantic fixture failure",
            });
            throw new Error("semantic fixture failure");
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("semantic fixture failure"),
      );
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "failed",
        error: "semantic fixture failure",
      });
      await invocation.record({
        type: "invocation",
        outcome: "failed",
        error: "semantic fixture failure",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "failed-execution-run",
        runAttempt: "1",
        enabledScenarioSets: ["focused"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "failed-execution" &&
            failure.invocationId === "failed-execution" &&
            failure.scenarioId === "semantic-failure" &&
            failure.gate === "generated-root-quality" &&
            failure.detail.includes("semantic fixture failure"),
        ),
      );
      assert.ok(
        formatFixtureEvidenceHealthReport(report).some((line) =>
          /failure code=failed-phase .*scenario=semantic-failure .*semantic-gate.*not-retryable.*semantic fixture failure/u.test(
            line,
          ),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("executes the semantic gate after storage read failure but leaves health failed", async () => {
    const root = await temporaryRepository("fixture-storage-health-");
    const evidenceRoot = path.join(root, "evidence");
    const fileStorage = new FileFixtureEvidenceStorage(evidenceRoot);
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const scenario = {
      id: "storage-read-failure",
      label: "storage read failure",
      presetIdentities: [],
    };
    const invocation = ledger.invocation({
      runId: "storage-failure-run",
      runAttempt: "1",
      invocationId: "storage-read-failure",
      scenarioSet: "init",
      writeEnabled: true,
    });
    let executions = 0;
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "5".repeat(40),
        contractIdentity: "6".repeat(64),
        scenario,
        producerCommit: "test",
        storage: {
          read: async () => {
            throw new Error("evidence volume unavailable");
          },
          writeAtomically: fileStorage.writeAtomically.bind(fileStorage),
        },
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => {
          executions += 1;
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "storage-failure-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(executions, 1);
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "lifecycle-error" &&
            failure.detail.includes("evidence volume unavailable"),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("keeps invalid individual evidence as executable healthy misses", async () => {
    const root = await temporaryRepository("fixture-invalid-health-");
    const cases = [
      { name: "missing", reason: "absent" },
      { name: "stale", reason: "stale" },
      { name: "corrupt", reason: "invalid" },
      { name: "partial", reason: "invalid" },
      { name: "unknown-schema", reason: "invalid" },
    ] as const;
    try {
      for (const evidenceCase of cases) {
        const caseRoot = path.join(root, evidenceCase.name);
        const evidenceRoot = path.join(caseRoot, "evidence");
        const storage = new FileFixtureEvidenceStorage(evidenceRoot);
        const ledger = new FileFixtureEvidenceActivityLedger({
          root: path.join(caseRoot, "activity"),
          evidenceRoot,
        });
        const scenario = {
          id: evidenceCase.name,
          label: evidenceCase.name,
          presetIdentities: [],
        };
        const input = {
          gate: "generated-root-quality" as const,
          generatedContentIdentity: "7".repeat(40),
          contractIdentity: "8".repeat(64),
          scenario,
          producerCommit: "test",
          storage,
          writeEnabled: true,
        };
        if (evidenceCase.name !== "missing") {
          const seeded = await runFixtureEvidenceGate({
            ...input,
            clock: () =>
              new Date(
                evidenceCase.name === "stale"
                  ? "2026-07-01T00:00:00.000Z"
                  : "2026-07-28T00:00:00.000Z",
              ),
            execute: async () => undefined,
          });
          const recordPath = path.join(
            evidenceRoot,
            "generated-root-quality",
            `${seeded.identity}.json`,
          );
          if (evidenceCase.name === "corrupt") {
            await writeFile(recordPath, '{"schema":');
          } else if (evidenceCase.name === "partial") {
            const record = JSON.parse(
              await readFile(recordPath, "utf8"),
            ) as Record<string, unknown>;
            delete record.producerCommit;
            await writeFile(recordPath, `${JSON.stringify(record)}\n`);
          } else if (evidenceCase.name === "unknown-schema") {
            const record = JSON.parse(
              await readFile(recordPath, "utf8"),
            ) as Record<string, unknown>;
            await writeFile(
              recordPath,
              `${JSON.stringify({
                ...record,
                schema: "fixture-verification-evidence/v999",
              })}\n`,
            );
          }
        }

        const invocation = ledger.invocation({
          runId: `invalid-${evidenceCase.name}`,
          runAttempt: "1",
          invocationId: evidenceCase.name,
          scenarioSet: "init",
          writeEnabled: true,
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        });
        await invocation.record({
          type: "invocation",
          outcome: "started",
          scenarios: [scenario],
        });
        const executePhases = createSuccessfulFixturePhaseExecutor({
          record: invocation.record,
          scenario,
        });
        let executions = 0;
        const result = await runFixtureEvidenceGate({
          ...input,
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
          recordLifecycle: invocation.record,
          execute: async () =>
            await executePhases("generated-root-quality", async () => {
              executions += 1;
            }),
        });
        await invocation.record({
          type: "scenario",
          scenario,
          outcome: "completed",
        });
        await invocation.record({
          type: "invocation",
          outcome: "completed",
        });

        assert.partialDeepStrictEqual(result, {
          status: "executed",
          missReason: evidenceCase.reason,
        });
        assert.strictEqual(executions, 1);
        assert.partialDeepStrictEqual(
          await checkFixtureEvidenceHealth({
            ledger,
            runId: `invalid-${evidenceCase.name}`,
            runAttempt: "1",
            enabledScenarioSets: ["init"],
          }),
          { healthy: true },
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("uses all four scenario sets by default and validates Health CLI arguments and exits", async () => {
    const root = await temporaryRepository("fixture-health-cli-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: activityRoot,
      evidenceRoot,
    });
    const scenario = {
      id: "health-cli-init",
      label: "health CLI init",
      presetIdentities: [],
    };
    const invocation = ledger.invocation({
      runId: "health-cli-run",
      runAttempt: "1",
      invocationId: "health-cli-init",
      scenarioSet: "init",
      writeEnabled: false,
    });
    const healthCliPath = path.join(
      process.cwd(),
      "src/check-fixture-evidence-health.ts",
    );
    const env = isolatedFixtureEnvironment({
      TEMPLATE_FIXTURE_EVIDENCE_DIR: evidenceRoot,
      TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR: activityRoot,
      TEMPLATE_FIXTURE_EVIDENCE_RUN_ID: "health-cli-run",
      TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: "1",
    });
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        recordLifecycle: invocation.record,
        execute: async () => await executePhases("generated-root-quality"),
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assert.strictEqual(
        (
          await execa("node", ["--conditions=source", healthCliPath, "init"], {
            cwd: process.cwd(),
            env,
          })
        ).exitCode,
        0,
      );
      await assert.rejects(
        execa("node", ["--conditions=source", healthCliPath], {
          cwd: process.cwd(),
          env,
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.strictEqual(Reflect.get(error, "exitCode"), 1);
          assert.ok(
            String(Reflect.get(error, "stderr")).includes(
              "Enabled scenario set focused has no current-run activity",
            ),
          );
          return true;
        },
      );
      await assert.rejects(
        execa("node", ["--conditions=source", healthCliPath, "unknown"], {
          cwd: process.cwd(),
          env,
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.strictEqual(Reflect.get(error, "exitCode"), 1);
          assert.ok(
            String(Reflect.get(error, "stderr")).includes(
              "启用场景集必须为 init、package-addition-matrix、focused、deployment 或 capabilities",
            ),
          );
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("enforces configured ordinary, browser, and Docker capacities with queued work", async () => {
    const scheduler = createFixtureEvidenceScheduler({ concurrency: 4 });

    const ordinary = createBlockedWorkProbe();
    const ordinaryJobs = ["a", "b", "c", "d", "e"].map(
      async (name) =>
        await scheduler.run(
          [],
          async () => await ordinary.run(`ordinary-${name}`),
        ),
    );
    await ordinary.whenStarted(4);
    assert.deepStrictEqual(ordinary.started(), [
      "ordinary-a",
      "ordinary-b",
      "ordinary-c",
      "ordinary-d",
    ]);
    ordinary.release("ordinary-a");
    await ordinary.whenStarted(5);
    assert.ok(ordinary.started().includes("ordinary-e"));
    ordinary.releaseAll();
    await Promise.all(ordinaryJobs);

    const browser = createBlockedWorkProbe();
    const browserJobs = [
      scheduler.run(["browser"], async () => await browser.run("browser-a")),
    ];
    await browser.whenStarted(1);
    assert.deepStrictEqual(browser.started(), ["browser-a"]);
    browserJobs.push(
      scheduler.run(["browser"], async () => await browser.run("browser-b")),
      scheduler.run(["browser"], async () => await browser.run("browser-c")),
      scheduler.run(["browser"], async () => await browser.run("browser-d")),
    );
    assert.deepStrictEqual(browser.started(), ["browser-a"]);
    for (const [current, next] of [
      ["browser-a", "browser-b"],
      ["browser-b", "browser-c"],
      ["browser-c", "browser-d"],
    ] as const) {
      browser.release(current);
      await browser.whenStarted(browser.started().length + 1);
      assert.ok(browser.started().includes(next));
    }
    browser.release("browser-d");
    await Promise.all(browserJobs);

    const docker = createBlockedWorkProbe();
    const dockerJobs = ["a", "b", "c"].map(
      async (name) =>
        await scheduler.run(
          ["docker"],
          async () => await docker.run(`docker-${name}`),
        ),
    );
    await docker.whenStarted(1);
    assert.deepStrictEqual(docker.started(), ["docker-a"]);
    docker.release("docker-a");
    await docker.whenStarted(2);
    assert.deepStrictEqual(docker.started(), ["docker-a", "docker-b"]);
    docker.release("docker-b");
    await docker.whenStarted(3);
    assert.deepStrictEqual(docker.started(), [
      "docker-a",
      "docker-b",
      "docker-c",
    ]);
    docker.release("docker-c");
    await Promise.all(dockerJobs);

    assert.strictEqual(ordinary.maximum(), 4);
    assert.strictEqual(browser.maximum(), 1);
    assert.strictEqual(docker.maximum(), 1);
  });

  void it("bounds Development Container sessions independently of ordinary work", async () => {
    const scheduler = createFixtureEvidenceScheduler({
      concurrency: 4,
      developmentContainerSessions: 2,
    });
    const sessions = createBlockedWorkProbe();
    const jobs = ["a", "b", "c"].map(
      async (name) =>
        await scheduler.run(
          ["development-container-session"],
          async () => await sessions.run(`session-${name}`),
        ),
    );

    await sessions.whenStarted(2);
    assert.deepStrictEqual(sessions.started(), ["session-a", "session-b"]);
    sessions.release("session-a");
    await sessions.whenStarted(3);
    assert.deepStrictEqual(sessions.started(), [
      "session-a",
      "session-b",
      "session-c",
    ]);
    sessions.releaseAll();
    await Promise.all(jobs);

    assert.strictEqual(sessions.maximum(), 2);
  });

  void it("does not retain Development Container sessions for browser-queued work", async () => {
    const scheduler = createFixtureEvidenceScheduler({
      concurrency: 4,
      developmentContainerSessions: 4,
    });
    const browser = createBlockedConcurrencyProbe();
    const ordinary = createBlockedConcurrencyProbe();
    const browserJobs = [
      scheduler.run(
        ["development-container-session", "browser"],
        async () => await browser.enter(),
      ),
    ];

    try {
      await browser.whenActive(1);
      browserJobs.push(
        scheduler.run(
          ["development-container-session", "browser"],
          async () => await browser.enter(),
        ),
        scheduler.run(
          ["development-container-session", "browser"],
          async () => await browser.enter(),
        ),
      );
      const ordinaryJobs = ["a", "b", "c"].map(
        async () =>
          await scheduler.run(
            ["development-container-session"],
            async () => await ordinary.enter(),
          ),
      );

      await ordinary.whenActive(3);

      ordinary.release();
      browser.release();
      await Promise.all([...browserJobs, ...ordinaryJobs]);
    } finally {
      ordinary.release();
      browser.release();
    }
  });

  void it("holds a Development Container session lease until explicit release", async () => {
    const scheduler = createFixtureEvidenceScheduler({
      concurrency: 4,
      developmentContainerSessions: 1,
    });
    const releaseFirst = await scheduler.acquire([
      "development-container-session",
    ]);
    let secondAcquired = false;
    const second = scheduler
      .acquire(["development-container-session"])
      .then((release) => {
        secondAcquired = true;
        return release;
      });

    const acquiredBeforeRelease = await Promise.race([
      second.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.strictEqual(acquiredBeforeRelease, false);
    assert.strictEqual(secondAcquired, false);
    releaseFirst();
    const releaseSecond = await second;
    assert.strictEqual(secondAcquired, true);
    releaseSecond();
  });

  void it("rejects malformed concurrency at the real generated-registry CLI environment boundary", async () => {
    const cliPath = path.join(process.cwd(), "src/check-generated-registry.ts");
    for (const value of [
      "0",
      "-1",
      "1.5",
      "",
      " ",
      "1 ",
      "1worker",
      "NaN",
      "9007199254740992",
    ]) {
      const result = await execa(
        process.execPath,
        ["--conditions=source", cliPath, "init"],
        {
          env: isolatedFixtureEnvironment({
            TEMPLATE_FIXTURE_CONCURRENCY: value,
          }),
          reject: false,
        },
      );

      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(
        result.stderr.includes(
          "TEMPLATE_FIXTURE_CONCURRENCY must be a positive integer",
        ),
      );
    }
  });

  void it("仅转换已声明的非空容器环境变量", () => {
    assert.deepStrictEqual(
      fixtureContainerEnvironmentFromEnvironment({
        TEMPLATE_FIXTURE_TURBO_TEAM: "fixture-team",
        TEMPLATE_FIXTURE_TURBO_TOKEN: "",
        TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY: "fixture-signature",
        TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY: "true",
        TURBO_TOKEN: "must-not-override-an-explicit-empty-fixture-token",
        NODE_USE_ENV_PROXY: "1",
        UNRELATED_SECRET: "must-not-be-forwarded",
      }),
      {
        NODE_USE_ENV_PROXY: "1",
        TURBO_TEAM: "fixture-team",
        TURBO_REMOTE_CACHE_SIGNATURE_KEY: "fixture-signature",
        TURBO_REMOTE_CACHE_READ_ONLY: "true",
      },
    );
    assert.deepStrictEqual(
      fixtureContainerEnvironmentFromEnvironment({
        TURBO_TEAM: "local-team",
        TURBO_TOKEN: "local-token",
      }),
      {
        TURBO_TEAM: "local-team",
        TURBO_TOKEN: "local-token",
      },
    );
  });

  void it("parses only external fixture dependency-download cache directories", () => {
    const pnpmCache = path.resolve(".fixture-native-cache/pnpm");
    const cargoCache = path.resolve(".fixture-native-cache/cargo");

    assert.deepStrictEqual(
      fixtureDependencyCachesFromEnvironment({
        TEMPLATE_FIXTURE_PNPM_CACHE_DIR: pnpmCache,
        TEMPLATE_FIXTURE_CARGO_CACHE_DIR: cargoCache,
      }),
      { pnpm: pnpmCache, cargo: cargoCache },
    );
    assert.strictEqual(fixtureDependencyCachesFromEnvironment({}), undefined);
    assert.throws(
      () =>
        fixtureDependencyCachesFromEnvironment({
          TEMPLATE_FIXTURE_PNPM_CACHE_DIR: "",
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "TEMPLATE_FIXTURE_PNPM_CACHE_DIR must not be empty",
        ),
    );
    assert.throws(
      () =>
        fixtureDependencyCachesFromEnvironment({
          TEMPLATE_FIXTURE_CARGO_CACHE_DIR: "",
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "TEMPLATE_FIXTURE_CARGO_CACHE_DIR must not be empty",
        ),
    );
  });

  void it("serializes Docker execution regardless of the ordinary concurrency override", async () => {
    const scheduler = createFixtureEvidenceScheduler({ concurrency: 4 });
    const docker = createBlockedWorkProbe();

    const jobs = [
      scheduler.run(["docker"], async () => await docker.run("docker-a")),
    ];
    await docker.whenStarted(1);
    assert.deepStrictEqual(docker.started(), ["docker-a"]);
    jobs.push(
      scheduler.run(["docker"], async () => await docker.run("docker-b")),
      scheduler.run(["docker"], async () => await docker.run("docker-c")),
    );
    assert.deepStrictEqual(docker.started(), ["docker-a"]);
    docker.release("docker-a");
    await docker.whenStarted(2);
    assert.deepStrictEqual(docker.started(), ["docker-a", "docker-b"]);
    docker.release("docker-b");
    await docker.whenStarted(3);
    assert.deepStrictEqual(docker.started(), [
      "docker-a",
      "docker-b",
      "docker-c",
    ]);
    docker.release("docker-c");
    await Promise.all(jobs);

    assert.strictEqual(docker.maximum(), 1);
  });

  void it("classifies Root Quality browser resources from real Check Environment Needs", async () => {
    const workspace = await temporaryRepository("resource-classification-");
    try {
      const classifications = await Promise.all(
        (await generatedScenariosFor("init")).map(async (scenario) => {
          const rendered = await renderMatrixScenario({ scenario, workspace });
          const result = rendered.receipt.result;
          const hasBrowserNeed =
            result.projection.ownerFacts.environmentNeeds.check.some(
              (need) => need.kind === "playwright-browser-assets",
            );
          return {
            hasBrowserNeed,
            resources: generatedRootQualityExecutionResources(result),
          };
        }),
      );

      assert.strictEqual(
        classifications.some(({ hasBrowserNeed }) => hasBrowserNeed),
        true,
      );
      assert.strictEqual(
        classifications.some(({ hasBrowserNeed }) => !hasBrowserNeed),
        true,
      );
      for (const classification of classifications) {
        assert.deepStrictEqual(
          classification.resources,
          classification.hasBrowserNeed ? ["browser"] : [],
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("identifies Generated Repository content from the prospective Git tree", async () => {
    const first = await temporaryRepository("fixture-evidence-first-");
    const second = await temporaryRepository("fixture-evidence-second-");
    try {
      for (const repositoryRoot of [first, second]) {
        await writeFile(
          path.join(repositoryRoot, ".gitignore"),
          "node_modules/\nlocal.txt\n",
        );
        await writeFile(path.join(repositoryRoot, "source.txt"), "same\n");
        await initializeFixtureGitRepository({ repositoryRoot });
      }
      await writeFile(path.join(first, "local.txt"), "first runtime value\n");
      await writeFile(path.join(second, "local.txt"), "second runtime value\n");

      const firstIdentity = await writeGeneratedRepositoryTree({
        repositoryRoot: first,
      });
      const secondIdentity = await writeGeneratedRepositoryTree({
        repositoryRoot: second,
      });

      assert.match(firstIdentity, /^[0-9a-f]{40}$/u);
      assert.strictEqual(secondIdentity, firstIdentity);
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  void it("lets Git identify bytes, paths, executable modes, symlinks, and rendered lockfiles", async () => {
    const roots: string[] = [];
    const identity = async (variant: {
      readonly content?: string;
      readonly filePath?: string;
      readonly executable?: boolean;
      readonly symlinkTarget?: string;
      readonly lockfile?: string;
    }) => {
      const root = await temporaryRepository("fixture-git-identity-");
      roots.push(root);
      const filePath = path.join(root, variant.filePath ?? "script.sh");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, variant.content ?? "echo baseline\n");
      if (variant.executable === true) await chmod(filePath, 0o755);
      await symlink(
        variant.symlinkTarget ?? variant.filePath ?? "script.sh",
        path.join(root, "entrypoint"),
      );
      if (variant.lockfile !== undefined) {
        await writeFile(path.join(root, "pnpm-lock.yaml"), variant.lockfile);
      }
      await initializeFixtureGitRepository({ repositoryRoot: root });
      return await writeGeneratedRepositoryTree({ repositoryRoot: root });
    };

    try {
      const baseline = await identity({});
      assert.notStrictEqual(
        await identity({ content: "echo changed\n" }),
        baseline,
      );
      assert.notStrictEqual(
        await identity({ filePath: "nested/script.sh" }),
        baseline,
      );
      assert.notStrictEqual(await identity({ executable: true }), baseline);
      assert.notStrictEqual(
        await identity({ symlinkTarget: "missing-target" }),
        baseline,
      );
      assert.notStrictEqual(
        await identity({ lockfile: "lockfileVersion: '9.0'\n" }),
        baseline,
      );
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  });

  void it("derives contract identity from a normalized plan and owned production source", async () => {
    const root = await temporaryRepository("fixture-contract-");
    const gateRoot = path.join(root, "gates/root-quality");
    const kernelRoot = path.join(root, "kernel");
    const testRoot = path.join(root, "test");
    try {
      await Promise.all([
        mkdir(gateRoot, { recursive: true }),
        mkdir(kernelRoot, { recursive: true }),
        mkdir(testRoot, { recursive: true }),
      ]);
      await writeFile(
        path.join(gateRoot, "index.ts"),
        "export const gate = 1;\n",
      );
      await writeFile(
        path.join(kernelRoot, "index.ts"),
        "export const kernel = 1;\n",
      );
      await writeFile(path.join(testRoot, "root.test.ts"), "expect(true);\n");

      const derive = async (plan: unknown) =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: plan,
          sourceProjections: [
            { name: "root-quality", root: gateRoot },
            { name: "kernel", root: kernelRoot },
          ],
        });
      const initial = await derive({ command: "check", args: ["--all"] });

      await writeFile(path.join(testRoot, "root.test.ts"), "expect(false);\n");
      assert.strictEqual(
        await derive({ args: ["--all"], command: "check" }),
        initial,
      );

      await writeFile(
        path.join(gateRoot, "index.ts"),
        "export const gate = 2;\n",
      );
      const gateChanged = await derive({
        command: "check",
        args: ["--all"],
      });
      assert.notStrictEqual(gateChanged, initial);

      await writeFile(
        path.join(kernelRoot, "index.ts"),
        "export const kernel = 2;\n",
      );
      assert.notStrictEqual(
        await derive({ command: "check", args: ["--all"] }),
        gateChanged,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("invalidates only the owning gate for plan and implementation changes while kernel changes invalidate every gate", async () => {
    const root = await temporaryRepository("fixture-contract-boundaries-");
    const rootGate = path.join(root, "root-quality");
    const focusedGate = path.join(root, "focused-package-link");
    const deploymentGate = path.join(root, "deployment-quality");
    const kernel = path.join(root, "kernel");
    try {
      await Promise.all([
        cp(path.resolve("src/fixture-evidence/gates/root-quality"), rootGate, {
          recursive: true,
        }),
        cp(
          path.resolve("src/fixture-evidence/gates/focused-package-link"),
          focusedGate,
          { recursive: true },
        ),
        cp(
          path.resolve("src/fixture-evidence/gates/deployment-quality"),
          deploymentGate,
          { recursive: true },
        ),
        cp(path.resolve("src/fixture-evidence/kernel"), kernel, {
          recursive: true,
        }),
      ]);
      const deriveRoot = async () =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: {
            gate: "generated-root-quality",
            rootCheck: true,
          },
          sourceProjections: [
            { name: "generated-root-quality", root: rootGate },
            { name: "fixture-evidence-kernel", root: kernel },
          ],
        });
      const deriveFocused = async (probe: string) =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: {
            gate: "focused-package-link",
            consumer: "@fixture/consumer",
            provider: "@fixture/provider",
            probe,
          },
          sourceProjections: [
            { name: "focused-package-link", root: focusedGate },
            { name: "fixture-evidence-kernel", root: kernel },
          ],
        });
      const deriveDeployment = async (command: string) =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: {
            gate: "deployment-quality",
            resources: ["docker"],
            command,
          },
          sourceProjections: [
            { name: "deployment-quality", root: deploymentGate },
            { name: "fixture-evidence-kernel", root: kernel },
          ],
        });
      const initialRoot = await deriveRoot();
      const initialFocused = await deriveFocused("source-and-default");
      const initialDeployment = await deriveDeployment(
        "pnpm run check:deployment",
      );

      const deploymentIndex = path.join(deploymentGate, "index.ts");
      await writeFile(
        deploymentIndex,
        `${await readFile(deploymentIndex, "utf8")}\n// deployment implementation change\n`,
      );
      assert.strictEqual(await deriveRoot(), initialRoot);
      assert.strictEqual(
        await deriveFocused("source-and-default"),
        initialFocused,
      );
      const deploymentImplementationChanged = await deriveDeployment(
        "pnpm run check:deployment",
      );
      assert.notStrictEqual(deploymentImplementationChanged, initialDeployment);

      const deploymentPlanChanged = await deriveDeployment(
        "pnpm run check:deployment:changed",
      );
      assert.notStrictEqual(
        deploymentPlanChanged,
        deploymentImplementationChanged,
      );
      assert.strictEqual(await deriveRoot(), initialRoot);
      assert.strictEqual(
        await deriveFocused("source-and-default"),
        initialFocused,
      );

      const focusedIndex = path.join(focusedGate, "index.ts");
      await writeFile(
        focusedIndex,
        `${await readFile(focusedIndex, "utf8")}\n// focused implementation change\n`,
      );
      assert.strictEqual(await deriveRoot(), initialRoot);
      const focusedImplementationChanged =
        await deriveFocused("source-and-default");
      assert.notStrictEqual(focusedImplementationChanged, initialFocused);
      assert.strictEqual(
        await deriveDeployment("pnpm run check:deployment:changed"),
        deploymentPlanChanged,
      );

      const focusedPlanChanged = await deriveFocused("different-plan");
      assert.notStrictEqual(focusedPlanChanged, focusedImplementationChanged);
      assert.strictEqual(await deriveRoot(), initialRoot);

      const rootIndex = path.join(rootGate, "index.ts");
      await writeFile(
        rootIndex,
        `${await readFile(rootIndex, "utf8")}\n// root implementation change\n`,
      );
      const rootImplementationChanged = await deriveRoot();
      assert.notStrictEqual(rootImplementationChanged, initialRoot);
      assert.strictEqual(
        await deriveFocused("different-plan"),
        focusedPlanChanged,
      );
      assert.strictEqual(
        await deriveDeployment("pnpm run check:deployment:changed"),
        deploymentPlanChanged,
      );

      const kernelIndex = path.join(kernel, "index.ts");
      await writeFile(
        kernelIndex,
        `${await readFile(kernelIndex, "utf8")}\n// kernel change\n`,
      );
      assert.notStrictEqual(await deriveRoot(), rootImplementationChanged);
      assert.notStrictEqual(
        await deriveFocused("different-plan"),
        focusedPlanChanged,
      );
      assert.notStrictEqual(
        await deriveDeployment("pnpm run check:deployment:changed"),
        deploymentPlanChanged,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("keeps selective invalidation and expiry healthy through the activity protocol", async () => {
    const root = await temporaryRepository("fixture-selective-health-");
    const baseline = {
      generatedContent: "a".repeat(40),
      rootContract: "1".repeat(64),
      focusedContract: "2".repeat(64),
      deploymentContract: "3".repeat(64),
    };
    const cases = [
      {
        name: "generated-content",
        current: { generatedContent: "b".repeat(40) },
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
      },
      {
        name: "root-contract",
        current: { rootContract: "4".repeat(64) },
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
      },
      {
        name: "focused-contract",
        current: { focusedContract: "5".repeat(64) },
        executions: ["focused-package-link"],
      },
      {
        name: "deployment-contract",
        current: { deploymentContract: "6".repeat(64) },
        executions: ["deployment-quality"],
      },
      {
        name: "shared-kernel",
        current: {
          rootContract: "7".repeat(64),
          focusedContract: "8".repeat(64),
          deploymentContract: "9".repeat(64),
        },
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
      },
      {
        name: "seven-day-expiry",
        current: {},
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
        expired: true,
      },
    ] as const;
    const scenario = {
      id: "selective-invalidation",
      label: "selective invalidation",
      presetIdentities: [],
    };
    try {
      for (const invalidation of cases) {
        const caseRoot = path.join(root, invalidation.name);
        const evidenceRoot = path.join(caseRoot, "evidence");
        const storage = new FileFixtureEvidenceStorage(evidenceRoot);
        const seedClock = () => new Date("2026-07-01T00:00:00.000Z");
        const seedShared = {
          generatedContentIdentity: baseline.generatedContent,
          scenario,
          producerCommit: "seed",
          storage,
          clock: seedClock,
          writeEnabled: true,
          execute: async () => undefined,
        };
        const seedRoot = await runFixtureEvidenceGate({
          ...seedShared,
          gate: "generated-root-quality",
          contractIdentity: baseline.rootContract,
        });
        await runFixtureEvidenceGate({
          ...seedShared,
          gate: "focused-package-link",
          rootEvidence: seedRoot,
          contractIdentity: baseline.focusedContract,
        });
        await runFixtureEvidenceGate({
          ...seedShared,
          gate: "deployment-quality",
          rootEvidence: seedRoot,
          contractIdentity: baseline.deploymentContract,
        });

        const current = { ...baseline, ...invalidation.current };
        const ledger = new FileFixtureEvidenceActivityLedger({
          root: path.join(caseRoot, "activity"),
          evidenceRoot,
        });
        const invocation = ledger.invocation({
          runId: invalidation.name,
          runAttempt: "1",
          invocationId: invalidation.name,
          scenarioSet: "focused",
          writeEnabled: true,
          clock: () =>
            new Date(
              "expired" in invalidation && invalidation.expired
                ? "2026-07-08T00:00:00.000Z"
                : "2026-07-01T00:00:00.000Z",
            ),
        });
        await invocation.record({
          type: "invocation",
          outcome: "started",
          scenarios: [scenario],
        });
        const executePhases = createSuccessfulFixturePhaseExecutor({
          record: invocation.record,
          scenario,
        });
        const executions: string[] = [];
        const currentShared = {
          generatedContentIdentity: current.generatedContent,
          scenario,
          producerCommit: "current",
          storage,
          clock: () =>
            new Date(
              "expired" in invalidation && invalidation.expired
                ? "2026-07-08T00:00:00.000Z"
                : "2026-07-01T00:00:00.000Z",
            ),
          writeEnabled: true,
          recordLifecycle: invocation.record,
        };
        const rootEvidence = await runFixtureEvidenceGate({
          ...currentShared,
          gate: "generated-root-quality",
          contractIdentity: current.rootContract,
          execute: async () =>
            await executePhases("generated-root-quality", async () => {
              executions.push("generated-root-quality");
            }),
        });
        await runFixtureEvidenceGate({
          ...currentShared,
          gate: "focused-package-link",
          rootEvidence,
          contractIdentity: current.focusedContract,
          execute: async () =>
            await executePhases("focused-package-link", async () => {
              executions.push("focused-package-link");
            }),
        });
        await runFixtureEvidenceGate({
          ...currentShared,
          gate: "deployment-quality",
          rootEvidence,
          contractIdentity: current.deploymentContract,
          execute: async () =>
            await executePhases("deployment-quality", async () => {
              executions.push("deployment-quality");
            }),
        });
        await invocation.record({
          type: "scenario",
          scenario,
          outcome: "completed",
        });
        await invocation.record({
          type: "invocation",
          outcome: "completed",
        });

        assert.deepStrictEqual(executions, invalidation.executions);
        assert.partialDeepStrictEqual(
          await checkFixtureEvidenceHealth({
            ledger,
            runId: invalidation.name,
            runAttempt: "1",
            enabledScenarioSets: ["focused"],
          }),
          { healthy: true },
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("executes a cold gate once and reuses its schema-validated evidence while warm", async () => {
    const root = await temporaryRepository("fixture-evidence-store-");
    const events: FixtureEvidenceLifecycleEvent[] = [];
    const storage = new FileFixtureEvidenceStorage(root);
    let executions = 0;
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    try {
      const cold = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario: {
          id: "fixture-first-init",
          label: "first diagnostic",
          presetIdentities: ["first"],
        },
        producerCommit: "cold-commit",
        storage,
        clock,
        writeEnabled: true,
        recordLifecycle: (event) => {
          events.push(event);
        },
        execute: async () => {
          executions += 1;
        },
      });

      assert.strictEqual(cold.status, "executed");
      assert.strictEqual(cold.missReason, "absent");
      assert.strictEqual(executions, 1);
      const gateDirectory = path.join(root, "generated-root-quality");
      const [recordName] = await readdir(gateDirectory);
      assert.strictEqual(recordName, `${cold.identity}.json`);
      assert.deepStrictEqual(
        JSON.parse(
          await readFile(path.join(gateDirectory, recordName), "utf8"),
        ),
        {
          schema: "fixture-verification-evidence/v1",
          gate: "generated-root-quality",
          identity: cold.identity,
          components: {
            generatedContent: "1".repeat(40),
            contract: "2".repeat(64),
          },
          issuedAt: "2026-07-28T00:00:00.000Z",
          scenario: {
            id: "fixture-first-init",
            label: "first diagnostic",
            presetIdentities: ["first"],
          },
          producerCommit: "cold-commit",
        },
      );

      const warm = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario: {
          id: "fixture-equivalent-init",
          label: "different diagnostics",
          presetIdentities: ["different"],
        },
        producerCommit: "warm-commit",
        storage,
        clock,
        writeEnabled: true,
        recordLifecycle: (event) => {
          events.push(event);
        },
        execute: async () => {
          executions += 1;
        },
      });

      assert.partialDeepStrictEqual(warm, {
        status: "hit",
        identity: cold.identity,
      });
      assert.strictEqual(executions, 1);
      assert.ok(
        events.some(
          (event) =>
            event.type === "lookup" &&
            event.outcome === "miss" &&
            event.reason === "absent",
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "execution" && event.outcome === "succeeded",
        ),
      );
      assert.ok(
        events.some(
          (event) => event.type === "issuance" && event.outcome === "issued",
        ),
      );
      assert.ok(
        events.some(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("issues and reuses Focused Package Link evidence independently from Root Quality", async () => {
    const root = await temporaryRepository("fixture-independent-gates-");
    const storage = new FileFixtureEvidenceStorage(root);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    let rootExecutions = 0;
    let focusedExecutions = 0;
    const shared = {
      generatedContentIdentity: "3".repeat(40),
      scenario: {
        id: "focused-independent",
        label: "focused independent",
        presetIdentities: ["consumer", "provider"],
      },
      producerCommit: "producer",
      storage,
      clock,
      writeEnabled: true,
    } as const;
    try {
      const coldRoot = await runFixtureEvidenceGate({
        ...shared,
        gate: "generated-root-quality",
        contractIdentity: "4".repeat(64),
        execute: async () => {
          rootExecutions += 1;
        },
      });
      const coldFocused = await runFixtureEvidenceGate({
        ...shared,
        gate: "focused-package-link",
        contractIdentity: "5".repeat(64),
        rootEvidence: coldRoot,
        execute: async () => {
          focusedExecutions += 1;
        },
      });

      assert.partialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...shared,
          gate: "generated-root-quality",
          contractIdentity: "4".repeat(64),
          execute: async () => {
            rootExecutions += 1;
          },
        }),
        { status: "hit", identity: coldRoot.identity },
      );
      assert.partialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...shared,
          gate: "focused-package-link",
          contractIdentity: "5".repeat(64),
          rootEvidence: coldRoot,
          scenario: {
            id: "different-focused-scenario",
            label: "different focused diagnostics",
            presetIdentities: ["different-consumer", "different-provider"],
          },
          producerCommit: "different-producer",
          execute: async () => {
            focusedExecutions += 1;
          },
        }),
        {
          status: "hit",
          identity: coldFocused.identity,
        },
      );

      const changedRoot = await runFixtureEvidenceGate({
        ...shared,
        gate: "generated-root-quality",
        contractIdentity: "6".repeat(64),
        execute: async () => {
          rootExecutions += 1;
        },
      });
      const changedFocused = await runFixtureEvidenceGate({
        ...shared,
        gate: "focused-package-link",
        contractIdentity: "5".repeat(64),
        rootEvidence: changedRoot,
        execute: async () => {
          focusedExecutions += 1;
        },
      });
      const focusedContractChanged = await runFixtureEvidenceGate({
        ...shared,
        gate: "focused-package-link",
        contractIdentity: "7".repeat(64),
        rootEvidence: changedRoot,
        execute: async () => {
          focusedExecutions += 1;
        },
      });

      assert.notStrictEqual(changedRoot.identity, coldRoot.identity);
      assert.notStrictEqual(changedFocused.identity, coldFocused.identity);
      assert.notStrictEqual(
        focusedContractChanged.identity,
        changedFocused.identity,
      );
      assert.partialDeepStrictEqual(
        JSON.parse(
          await readFile(
            path.join(
              root,
              "focused-package-link",
              `${changedFocused.identity}.json`,
            ),
            "utf8",
          ),
        ),
        {
          components: { rootEvidence: changedRoot.identity },
        },
      );
      assert.strictEqual(rootExecutions, 2);
      assert.strictEqual(focusedExecutions, 3);
      assert.strictEqual(
        (await readdir(path.join(root, "generated-root-quality"))).length,
        2,
      );
      assert.strictEqual(
        (await readdir(path.join(root, "focused-package-link"))).length,
        3,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("issues and reuses Deployment Quality evidence with its Root prerequisite proof", async () => {
    const root = await temporaryRepository("fixture-deployment-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    const generatedContentIdentity = "d".repeat(40);
    const rootEvidence = await successfulRootEvidence(generatedContentIdentity);
    let executions = 0;
    const input = {
      gate: "deployment-quality" as const,
      rootEvidence,
      generatedContentIdentity,
      contractIdentity: "e".repeat(64),
      scenario: {
        id: "deployment-independent",
        label: "deployment independent",
        presetIdentities: ["deployment"],
      },
      producerCommit: "producer",
      storage,
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
      writeEnabled: true,
      execute: async () => {
        executions += 1;
      },
    };
    try {
      const cold = await runFixtureEvidenceGate(input);
      const warm = await runFixtureEvidenceGate(input);

      assert.strictEqual(cold.status, "executed");
      assert.partialDeepStrictEqual(warm, {
        status: "hit",
        identity: cold.identity,
      });
      const changedRootEvidence = await successfulRootEvidence(
        generatedContentIdentity,
        "f".repeat(64),
      );
      const rootChanged = await runFixtureEvidenceGate({
        ...input,
        rootEvidence: changedRootEvidence,
      });
      const deploymentChanged = await runFixtureEvidenceGate({
        ...input,
        rootEvidence: changedRootEvidence,
        contractIdentity: "a".repeat(64),
      });

      assert.notStrictEqual(rootChanged.identity, cold.identity);
      assert.notStrictEqual(deploymentChanged.identity, rootChanged.identity);
      assert.strictEqual(executions, 3);
      assert.ok(
        (
          await readFile(
            path.join(root, "deployment-quality", `${cold.identity}.json`),
            "utf8",
          )
        ).includes(`"rootEvidence": "${rootEvidence.identity}"`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects a fabricated Root prerequisite before Focused evidence lookup", async () => {
    const read = mock.fn<FixtureEvidenceStorage["read"]>(async () => undefined);
    const generatedContentIdentity = "8".repeat(40);
    const fabricatedRootEvidence = {
      gate: "generated-root-quality",
      status: "hit",
      identity: "9".repeat(64),
      generatedContentIdentity,
      contractIdentity: "a".repeat(64),
    } as unknown as Awaited<ReturnType<typeof successfulRootEvidence>>;

    await assert.rejects(
      runFixtureEvidenceGate({
        gate: "focused-package-link",
        rootEvidence: fabricatedRootEvidence,
        generatedContentIdentity,
        contractIdentity: "b".repeat(64),
        scenario: {
          id: "fabricated-root",
          label: "fabricated root",
          presetIdentities: [],
        },
        producerCommit: "test",
        storage: {
          read,
          writeAtomically: async () => undefined,
        },
        execute: async () => undefined,
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "requires successful Root Quality evidence for the same Generated Repository content",
        ),
    );
    assert.strictEqual(read.mock.callCount(), 0);
  });

  void it("fails closed for corrupt, partial, unknown-schema, and mismatched records", async () => {
    const root = await temporaryRepository("fixture-invalid-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "a".repeat(40),
      contractIdentity: "b".repeat(64),
      scenario: {
        id: "invalid-record",
        label: "invalid record",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      storage,
      clock,
      writeEnabled: true,
    };
    let executions = 0;
    try {
      const seeded = await runFixtureEvidenceGate({
        ...input,
        execute: async () => {
          executions += 1;
        },
      });
      const recordPath = path.join(
        root,
        "generated-root-quality",
        `${seeded.identity}.json`,
      );
      const valid = JSON.parse(await readFile(recordPath, "utf8")) as Record<
        string,
        unknown
      >;
      const invalidRecords: readonly (string | Record<string, unknown>)[] = [
        '{"schema":',
        { ...valid, schema: "fixture-verification-evidence/v2" },
        Object.fromEntries(
          Object.entries(valid).filter(([key]) => key !== "producerCommit"),
        ),
        {
          ...valid,
          components: {
            ...(valid.components as Record<string, unknown>),
            contract: "c".repeat(64),
          },
        },
        { ...valid, issuedAt: "2026-07-28" },
      ];

      for (const invalid of invalidRecords) {
        await writeFile(
          recordPath,
          typeof invalid === "string"
            ? invalid
            : `${JSON.stringify(invalid)}\n`,
        );
        assert.partialDeepStrictEqual(
          await runFixtureEvidenceGate({
            ...input,
            execute: async () => {
              executions += 1;
            },
          }),
          {
            status: "executed",
            missReason: "invalid",
          },
        );
      }
      assert.strictEqual(executions, 1 + invalidRecords.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("does not expose evidence when atomic issuance writes only a partial temporary file", async () => {
    const root = await temporaryRepository("fixture-partial-issuance-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot, {
      writeTemporary: async (temporary, contents) => {
        await writeFile(temporary, contents.slice(0, 24), { flag: "wx" });
        throw new Error("simulated partial write");
      },
    });
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "partial-issuance-run",
      runAttempt: "1",
      invocationId: "partial-issuance",
      scenarioSet: "init",
      writeEnabled: true,
    });
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "7".repeat(40),
      contractIdentity: "8".repeat(64),
      scenario: {
        id: "partial-issuance",
        label: "partial issuance",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    };
    let executions = 0;
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [input.scenario],
      });
      assert.partialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage,
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed-unissued",
          issuanceError: "simulated partial write",
        },
      );
      await invocation.record({
        type: "scenario",
        scenario: input.scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assert.partialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: false,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed",
          missReason: "absent",
        },
      );
      assert.strictEqual(executions, 2);
      assert.deepStrictEqual(
        await readdir(path.join(evidenceRoot, "generated-root-quality")),
        [],
      );
      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "partial-issuance-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "lifecycle-error" &&
            failure.detail.includes("simulated partial write"),
        ),
      );
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "missing-issuance" &&
            failure.gate === "generated-root-quality",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("does not expose evidence when atomic replacement fails after the temporary write", async () => {
    const root = await temporaryRepository("fixture-replace-issuance-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot, {
      replace: async () => {
        throw new Error("simulated replace failure");
      },
    });
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "replace-issuance-run",
      runAttempt: "1",
      invocationId: "replace-issuance",
      scenarioSet: "init",
      writeEnabled: true,
    });
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "9".repeat(40),
      contractIdentity: "a".repeat(64),
      scenario: {
        id: "replace-issuance",
        label: "replace issuance",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    };
    let executions = 0;
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [input.scenario],
      });
      assert.partialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage,
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed-unissued",
          issuanceError: "simulated replace failure",
        },
      );
      await invocation.record({
        type: "scenario",
        scenario: input.scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assert.partialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: false,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed",
          missReason: "absent",
        },
      );
      assert.strictEqual(executions, 2);
      assert.deepStrictEqual(
        await readdir(path.join(evidenceRoot, "generated-root-quality")),
        [],
      );
      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "replace-issuance-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "lifecycle-error" &&
            failure.detail.includes("simulated replace failure"),
        ),
      );
      assert.ok(
        report.failures.some(
          (failure) =>
            failure.code === "missing-issuance" &&
            failure.gate === "generated-root-quality",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("expires at seven days and never refreshes evidence after failed execution", async () => {
    const root = await temporaryRepository("fixture-stale-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    let now = new Date("2026-07-01T00:00:00.000Z");
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "d".repeat(40),
      contractIdentity: "e".repeat(64),
      scenario: {
        id: "stale-record",
        label: "stale record",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      storage,
      clock: () => now,
      writeEnabled: true,
    };
    try {
      const seeded = await runFixtureEvidenceGate({
        ...input,
        execute: async () => undefined,
      });
      const recordPath = path.join(
        root,
        "generated-root-quality",
        `${seeded.identity}.json`,
      );

      now = new Date("2026-07-07T23:59:59.999Z");
      assert.partialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          execute: async () => {
            throw new Error("fresh evidence should not execute");
          },
        }),
        { status: "hit" },
      );

      now = new Date("2026-07-08T00:00:00.000Z");
      await assert.rejects(
        runFixtureEvidenceGate({
          ...input,
          execute: async () => {
            throw new Error("root quality failed");
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("root quality failed"),
      );
      assert.partialDeepStrictEqual(
        JSON.parse(await readFile(recordPath, "utf8")),
        {
          issuedAt: "2026-07-01T00:00:00.000Z",
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("prunes stale and structurally invalid records before publication", async () => {
    const root = await temporaryRepository("fixture-pruned-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    const input = {
      gate: "generated-root-quality" as const,
      contractIdentity: "c".repeat(64),
      scenario: {
        id: "pruning",
        label: "pruning",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      storage,
      writeEnabled: true,
      execute: async () => undefined,
    };
    try {
      const stale = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "1".repeat(40),
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      });
      const fresh = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "2".repeat(40),
        clock: () => new Date("2026-07-27T00:00:00.000Z"),
      });
      const gateRoot = path.join(root, "generated-root-quality");
      await writeFile(path.join(gateRoot, "invalid.json"), '{"schema":');

      assert.deepStrictEqual(
        await storage.prune({
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        }),
        { removed: 2 },
      );
      assert.deepStrictEqual(await readdir(gateRoot), [
        `${fresh.identity}.json`,
      ]);
      await assert.rejects(
        readFile(path.join(gateRoot, `${stale.identity}.json`), "utf8"),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual(Reflect.get(error, "code"), "ENOENT");
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("prunes stale and invalid Focused records without removing fresh evidence", async () => {
    const root = await temporaryRepository("fixture-pruned-focused-");
    const storage = new FileFixtureEvidenceStorage(root);
    const input = {
      gate: "focused-package-link" as const,
      contractIdentity: "d".repeat(64),
      scenario: {
        id: "focused-pruning",
        label: "focused pruning",
        presetIdentities: ["consumer", "provider"],
      },
      producerCommit: "producer",
      storage,
      writeEnabled: true,
      execute: async () => undefined,
    };
    try {
      const stale = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "3".repeat(40),
        rootEvidence: await successfulRootEvidence("3".repeat(40)),
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      });
      const fresh = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "4".repeat(40),
        rootEvidence: await successfulRootEvidence("4".repeat(40)),
        clock: () => new Date("2026-07-27T00:00:00.000Z"),
      });
      const gateRoot = path.join(root, "focused-package-link");
      await writeFile(path.join(gateRoot, "invalid.json"), '{"schema":');

      assert.deepStrictEqual(
        await storage.prune({
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        }),
        { removed: 2 },
      );
      assert.deepStrictEqual(await readdir(gateRoot), [
        `${fresh.identity}.json`,
      ]);
      await assert.rejects(
        readFile(path.join(gateRoot, `${stale.identity}.json`), "utf8"),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual(Reflect.get(error, "code"), "ENOENT");
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("owns the normalized Generated Root Quality contract and complete executor", async () => {
    const root = await temporaryRepository("fixture-root-contract-");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    try {
      const scenario = (await generatedScenariosFor("init"))[0]!;
      const rendered = await renderMatrixScenario({
        scenario,
        workspace: root,
      });
      const contractIdentity = await deriveGeneratedRootQualityContractIdentity(
        rendered.receipt.result,
      );
      assert.match(contractIdentity, /^[0-9a-f]{64}$/u);

      await executeGeneratedRootQuality({
        projectDir: path.join(root, "project"),
        run: async (command, args) => {
          calls.push({ command, args });
          return {};
        },
      });

      assert.deepStrictEqual(calls, [
        {
          command: "node",
          args: ["--conditions=source", "scripts/task-gates.ts", "check:full"],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("issues no Focused evidence when a provider probe fails after source consumption", async () => {
    const root = await temporaryRepository("fixture-focused-failure-");
    const projectDir = path.join(root, "project");
    const consumerPackagePath = "apps/consumer";
    const providerPackagePath = "packages/provider";
    const consumerRoot = path.join(projectDir, consumerPackagePath);
    const providerRoot = path.join(projectDir, providerPackagePath);
    const storage = new FileFixtureEvidenceStorage(path.join(root, "evidence"));
    try {
      await Promise.all([
        mkdir(consumerRoot, { recursive: true }),
        mkdir(path.join(providerRoot, "src"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(consumerRoot, "package.json"),
          `${JSON.stringify({ name: "@fixture/consumer" })}\n`,
        ),
        writeFile(
          path.join(providerRoot, "package.json"),
          `${JSON.stringify({
            name: "@fixture/provider",
            exports: {
              ".": {
                source: "./src/index.ts",
                default: "./dist/index.js",
              },
            },
          })}\n`,
        ),
        writeFile(
          path.join(providerRoot, "src/index.ts"),
          "export const provider = true;\n",
        ),
      ]);

      await assert.rejects(
        runFixtureEvidenceGate({
          gate: "focused-package-link",
          generatedContentIdentity: "6".repeat(40),
          contractIdentity: "7".repeat(64),
          rootEvidence: await successfulRootEvidence("6".repeat(40)),
          scenario: {
            id: "focused-failure",
            label: "focused failure",
            presetIdentities: ["consumer", "provider"],
          },
          producerCommit: "producer",
          storage,
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
          writeEnabled: true,
          execute: async () =>
            await executeFocusedPackageLink({
              scenarioLabel: "focused failure",
              projectDir,
              fixtureWorkspace: root,
              consumerPackagePath,
              providerPackagePath,
              run: async (command, args) => {
                if (args[0] === "install") return {};
                if (command === "node") {
                  return { stdout: await focusedMarker(projectDir) };
                }
                throw new Error("provider build cancelled");
              },
            }),
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("provider build cancelled"),
      );
      await assert.rejects(
        readdir(path.join(root, "evidence", "focused-package-link")),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual(Reflect.get(error, "code"), "ENOENT");
          return true;
        },
      );
      assert.deepStrictEqual(
        (await readdir(consumerRoot)).filter((entry) =>
          entry.includes("focused-provider-probe"),
        ),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("enforces gate and kernel ownership for dynamic imports and concatenated specifiers", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-import-architecture-",
    );
    const rootGate = path.join(root, "src/fixture-evidence/gates/root-quality");
    const focusedGate = path.join(root, "src/fixture-evidence/gates/focused");
    const kernel = path.join(root, "src/fixture-evidence/kernel");
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
        mkdir(kernel, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          'await import("../focused/" + "index.ts");\n',
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
        writeFile(
          path.join(kernel, "index.ts"),
          [
            'const gateModule = "../gates/root-quality/index.ts";',
            "await import(gateModule);",
            "",
          ].join("\n"),
        ),
      ]);

      const architectureFindings1 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings1.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "cross-gate-runtime-import",
        ),
      );
      assert.ok(
        architectureFindings1.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "kernel-runtime-import-outside-kernel",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects createRequire property calls that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-create-require-architecture-",
    );
    const rootGate = path.join(root, "src/fixture-evidence/gates/root-quality");
    const focusedGate = path.join(
      root,
      "src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          [
            'import { createRequire } from "node:module";',
            'createRequire(import.meta.url).require("../focused-package-link/index.ts");',
            "",
          ].join("\n"),
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      const architectureFindings2 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings2.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "cross-gate-runtime-import",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects direct CommonJS require calls that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-direct-require-architecture-",
    );
    const rootGate = path.join(root, "src/fixture-evidence/gates/root-quality");
    const focusedGate = path.join(
      root,
      "src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.cts"),
          'require("../focused-package-link/index.ts");\n',
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      const architectureFindings3 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings3.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "cross-gate-runtime-import",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects callable createRequire results that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-callable-create-require-architecture-",
    );
    const rootGate = path.join(root, "src/fixture-evidence/gates/root-quality");
    const focusedGate = path.join(
      root,
      "src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          [
            'import { createRequire } from "node:module";',
            'createRequire(import.meta.url)("../focused-package-link/index.ts");',
            "",
          ].join("\n"),
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      const architectureFindings4 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings4.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "cross-gate-runtime-import",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects aliased createRequire loaders that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-aliased-create-require-architecture-",
    );
    const rootGate = path.join(root, "src/fixture-evidence/gates/root-quality");
    const focusedGate = path.join(
      root,
      "src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          [
            'import { createRequire as makeRequire } from "node:module";',
            "const loadModule = makeRequire(import.meta.url);",
            "const loadAlias = loadModule;",
            'const target = "../focused-package-link/index.ts";',
            "loadAlias(target);",
            "",
          ].join("\n"),
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      const architectureFindings5 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings5.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "cross-gate-runtime-import",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when an aliased CommonJS loader target is dynamic", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-require-architecture-",
    );
    const rootGate = path.join(root, "src/fixture-evidence/gates/root-quality");
    try {
      await mkdir(rootGate, { recursive: true });
      await writeFile(
        path.join(rootGate, "index.ts"),
        [
          'import { createRequire } from "node:module";',
          "const loadModule = createRequire(import.meta.url);",
          "const loadAlias = loadModule;",
          "loadAlias(process.env.GATE_TARGET);",
          "",
        ].join("\n"),
      );

      const architectureFindings6 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings6.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "gate-runtime-import-outside-contract",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects hidden Root Quality commands regardless of orchestrator invocation form", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-orchestrator-boundary-",
    );
    const orchestrator = path.join(root, "src/check-generated-registry.ts");
    const bypasses = [
      'const invoke = run;\ninvoke("pnpm", ["run", "check"], { cwd: "." });\n',
      'options.run("pnpm", ["install"], { cwd: "." });\n',
      'execa("pnpm", ["run", "fix"], { cwd: "." });\n',
      'execa("node", ["--conditions=source", "scripts/task-gates.ts", "check:full"], { cwd: "." });\n',
      'run("node", ["--conditions=source", "scripts/task-gates.ts", "fix"], { cwd: "." });\n',
      'const invoke = (command, args) => processRunner(command, args);\ninvoke("pnpm", ["run", "check"]);\n',
      'const args = ["run", "check"];\nrun("pnpm", args, { cwd: "." });\n',
      'run("p" + "npm", ["r" + "un", `ch${"eck"}`], { cwd: "." });\n',
    ] as const;
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      for (const source of bypasses) {
        await writeFile(orchestrator, source);
        const architectureFindings7 =
          await findFixtureEvidenceArchitectureFindings(root);
        assert.ok(
          architectureFindings7.some(
            (finding) =>
              Object.hasOwn(finding, "rule") &&
              finding.rule === "hidden-root-quality-command",
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when an orchestrator executor receives dynamic gate arguments", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(root, "src/check-generated-registry.ts");
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          "async function scenario(run) {",
          '  await run("pnpm", ["run", process.env.TASK ?? "check:deployment"], { cwd: "." });',
          "}",
          "",
        ].join("\n"),
      );

      const architectureFindings8 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings8.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "unassigned-orchestrator-command",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed for dynamically computed gate arguments through a runner alias", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-aliased-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(root, "src/check-generated-registry.ts");
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          "type GeneratedCommandRunner = (command: string, args: readonly string[]) => Promise<unknown>;",
          "async function scenario(options: { readonly run: GeneratedCommandRunner }) {",
          "  const { run: invoke } = options;",
          '  await invoke("pnpm", ["run", process.env.TASK ?? "check:deployment"]);',
          "}",
          "",
        ].join("\n"),
      );

      const architectureFindings9 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings9.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "unassigned-orchestrator-command",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when an ordinary orchestrator function forwards dynamic commands", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-forwarded-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(root, "src/check-generated-registry.ts");
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          "async function scenario(command, args) {",
          "  await run(command, args);",
          "}",
          'await scenario("pnpm", ["run", "check:deployment"]);',
          "",
        ].join("\n"),
      );

      const architectureFindings10 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings10.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "unassigned-orchestrator-command",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects dependency installation contracts owned by the scenario orchestrator", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-orchestrator-install-contract-",
    );
    const orchestrator = path.join(root, "src/check-generated-registry.ts");
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          'import { fixtureDependencyInstallationPlan as installPlan } from "./fixture-evidence/kernel/index.ts";',
          'const dependencyInstallArgs = ["install", "--store-dir", "/tmp/store"];',
          "await executeDeploymentQuality({ dependencyInstallArgs, installPlan });",
          "",
        ].join("\n"),
      );

      const architectureFindings11 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings11.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "orchestrator-dependency-install-contract",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("allows command-runner adapters and ignores unrelated command-like values", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-command-false-positive-",
    );
    const orchestrator = path.join(root, "src/check-generated-registry.ts");
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          'import { execa } from "execa";',
          "type GeneratedCommandRunner = (command: string, args: readonly string[], options: { cwd: string }) => Promise<unknown>;",
          "const run: GeneratedCommandRunner = async (command, args, options) =>",
          "  await execa(command, [...args], options);",
          'const documentation = ["install", "check", "fix"];',
          'const markerExample = "focused-provider-marker:";',
          'const sourceConditionDocumentation = "--conditions=source";',
          "const renderExample = (command: string, args: readonly unknown[]) => ({ command, args });",
          'renderExample("pnpm", ["run", process.env.TASK ?? "check:deployment"]);',
          "const scheduler = { run: async (resources: readonly string[], work: () => Promise<void>) => await work() };",
          'await scheduler.run([process.env.RESOURCE ?? "docker"], async () => undefined);',
          "export { documentation, markerExample, run, sourceConditionDocumentation };",
          "",
        ].join("\n"),
      );

      assert.deepStrictEqual(
        await findFixtureEvidenceArchitectureFindings(root),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
