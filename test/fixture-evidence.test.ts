import { AsyncLocalStorage } from "node:async_hooks";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  type BuiltInPresetDefinition,
  type GeneratedRepositoryPlan,
  type PackageContribution,
} from "#template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import {
  createTemplateSourceHandle,
  renderNewProject,
  type RenderOperation,
  type TemplateSourceHandle,
} from "#template-core/renderer";

import {
  validatePlanDependencyCatalog,
  validatePlanSources,
} from "../packages/builtin-presets/src/registry-checks.ts";
import { findFixtureEvidenceArchitectureFindings } from "../packages/checks/src/check-fixture-evidence-architecture.ts";
import {
  generatedScenariosFor,
  runGeneratedRegistryCli,
  runGeneratedScenarioSet,
} from "../packages/checks/src/check-generated-registry.ts";
import {
  deriveFocusedPackageLinkContractIdentity,
  deriveFocusedPackageLinkPlanInput,
  executeFocusedPackageLink,
  normalizedFocusedPackageLinkPlan,
} from "../packages/checks/src/fixture-evidence/gates/focused-package-link/index.ts";
import {
  deriveGeneratedRootQualityContractIdentity,
  executeGeneratedRootQuality,
  generatedRootQualityExecutionResources,
} from "../packages/checks/src/fixture-evidence/gates/root-quality/index.ts";
import {
  checkFixtureEvidenceHealth,
  createFixtureEvidenceScheduler,
  deriveFixtureGateContractIdentity,
  ensureFixtureDependencies,
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  initializeFixtureGitRepository,
  runFixtureEvidenceGate,
  type FixtureEvidenceActivityLedger,
  type FixtureEvidenceExecutionResource,
  type FixtureEvidenceInvocationEvent,
  type FixtureEvidenceLifecycleEvent,
  type FixtureEvidenceSchedulerFactory,
  type FixtureEvidenceStorage,
  writeGeneratedRepositoryTree,
} from "../packages/checks/src/fixture-evidence/kernel/index.ts";

async function temporaryRepository(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

function isolatedFixtureEnvironment(
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "TEMPLATE_FIXTURE_CONCURRENCY",
    "TEMPLATE_FIXTURE_EVIDENCE_DIR",
    "TEMPLATE_FIXTURE_EVIDENCE_READ",
    "TEMPLATE_FIXTURE_EVIDENCE_WRITE",
    "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
    "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
    "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
  ]) {
    delete environment[name];
  }
  return { ...environment, ...overrides };
}

async function successfulRootEvidence(
  generatedContentIdentity: string,
  contractIdentity = "0".repeat(64),
) {
  return await runFixtureEvidenceGate({
    gate: "generated-root-quality",
    generatedContentIdentity,
    contractIdentity,
    scenario: {
      id: "root-prerequisite",
      label: "root prerequisite",
      presetIdentities: [],
    },
    producerCommit: "test",
    readEnabled: false,
    writeEnabled: false,
    execute: async () => undefined,
  });
}

async function generatedTaskIds(root: string): Promise<readonly string[]> {
  const taskIds: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(entryPath, "utf8")) as {
          readonly name: string;
          readonly scripts?: Record<string, string>;
        };
        for (const taskName of Object.keys(manifest.scripts ?? {})) {
          taskIds.push(
            `${manifest.name.startsWith("@") ? manifest.name : "//"}#${taskName}`,
          );
        }
      }
    }
  }

  await visit(root);
  return taskIds;
}

async function materializeFocusedProviderBuild(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = JSON.parse(await readFile(entryPath, "utf8")) as {
        readonly exports?: {
          readonly "."?: {
            readonly source?: unknown;
            readonly default?: unknown;
          };
        };
      };
      const source = manifest.exports?.["."]?.source;
      const target = manifest.exports?.["."]?.default;
      if (
        typeof source !== "string" ||
        !source.startsWith("./") ||
        typeof target !== "string" ||
        !target.startsWith("./")
      ) {
        continue;
      }
      const packageRoot = path.dirname(entryPath);
      const sourcePath = path.resolve(packageRoot, source);
      const targetPath = path.resolve(packageRoot, target);
      try {
        const contents = await readFile(sourcePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, contents);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }

  await visit(root);
}

async function focusedMarker(root: string): Promise<string> {
  async function visit(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await visit(entryPath);
        if (nested !== undefined) return nested;
        continue;
      }
      const match = /focused-provider-marker:[0-9a-f]+/u.exec(
        await readFile(entryPath, "utf8"),
      );
      if (match !== null) return match[0];
    }
    return undefined;
  }

  const marker = await visit(root);
  if (marker === undefined) {
    throw new Error("Focused marker was not injected into the provider");
  }
  return marker;
}

function createBlockedConcurrencyProbe() {
  let active = 0;
  let maximum = 0;
  let released = false;
  const waiters = new Set<() => void>();
  return {
    enter: async (): Promise<void> => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (!released) {
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      }
      active -= 1;
    },
    release: (): void => {
      released = true;
      for (const resolve of waiters) resolve();
      waiters.clear();
    },
    active: (): number => active,
    maximum: (): number => maximum,
  };
}

function createBlockedWorkProbe() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  let active = 0;
  let maximum = 0;
  return {
    run: async (name: string): Promise<void> => {
      started.push(name);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => {
        releases.set(name, resolve);
      });
      active -= 1;
    },
    release: (name: string): void => {
      releases.get(name)?.();
    },
    releaseAll: (): void => {
      for (const release of releases.values()) release();
    },
    started: (): readonly string[] => started,
    maximum: (): number => maximum,
  };
}

async function releaseAfterActive(options: {
  readonly execution: Promise<void>;
  readonly probe: ReturnType<typeof createBlockedConcurrencyProbe>;
  readonly expected: number;
}): Promise<void> {
  let observationFailure: unknown;
  try {
    await vi.waitFor(
      () => {
        expect(options.probe.active()).toBe(options.expected);
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    observationFailure = error;
  } finally {
    options.probe.release();
  }
  await options.execution;
  if (observationFailure !== undefined) throw observationFailure;
}

type MatrixScenario = Awaited<ReturnType<typeof generatedScenariosFor>>[number];

function replaceTemplateSource(options: {
  readonly operation: RenderOperation;
  readonly from: TemplateSourceHandle;
  readonly to: TemplateSourceHandle;
}): RenderOperation {
  if (
    "source" in options.operation &&
    options.operation.source === options.from
  ) {
    return { ...options.operation, source: options.to } as RenderOperation;
  }
  if (options.operation.kind === "writeTextFromFragments") {
    return {
      ...options.operation,
      fragments: options.operation.fragments.map((fragment) =>
        fragment.source === options.from
          ? { ...fragment, source: options.to }
          : fragment,
      ),
    };
  }
  return options.operation;
}

function replaceContributionTemplateSource(options: {
  readonly contribution: PackageContribution;
  readonly from: TemplateSourceHandle;
  readonly to: TemplateSourceHandle;
}): PackageContribution {
  return {
    ...options.contribution,
    operations: options.contribution.operations.map((operation) =>
      replaceTemplateSource({ operation, from: options.from, to: options.to }),
    ),
  };
}

async function renderMatrixScenario(options: {
  readonly scenario: MatrixScenario;
  readonly workspace: string;
  readonly addition?: BuiltInPresetDefinition;
}): Promise<{
  readonly generatedContentIdentity: string;
  readonly plan: GeneratedRepositoryPlan;
}> {
  const projectDir = path.join(options.workspace, options.scenario.id);
  const context = createGenerationContext({
    targetDir: projectDir,
    scope: "fixture",
    toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
  });
  const initialization = planGeneratedRepositoryInitialization({
    definition: options.scenario.base,
    context,
  });
  await validatePlanSources({
    definition: options.scenario.base,
    plan: initialization,
  });
  validatePlanDependencyCatalog(initialization);
  await renderNewProject({
    targetRoot: projectDir,
    operations: [...initialization.operations],
  });
  await initializeFixtureGitRepository({ repositoryRoot: projectDir });
  await writeGeneratedRepositoryTree({ repositoryRoot: projectDir });

  let plan: GeneratedRepositoryPlan = initialization;
  const addition = options.addition ?? options.scenario.addition;
  if (addition !== undefined) {
    const additionPlan = planGeneratedRepositoryPackageAddition({
      definition: addition,
      context,
      blueprint: initialization.blueprint,
      packageLeafName: `fixture-${addition.metadata.name}`,
      ...(options.scenario.linkFrom === undefined
        ? {}
        : { linkFrom: options.scenario.linkFrom }),
    });
    await validatePlanSources({ definition: addition, plan: additionPlan });
    validatePlanDependencyCatalog(additionPlan);
    const result = await reconcileAndApplyProjectProjections({
      targetRoot: projectDir,
      ...additionPlan.projectProjections,
    });
    if (!result.ok) {
      throw new Error(
        `Generated Package Addition reconciliation conflicted: ${JSON.stringify(result.conflicts)}`,
      );
    }
    plan = additionPlan;
  }

  return {
    generatedContentIdentity: await writeGeneratedRepositoryTree({
      repositoryRoot: projectDir,
    }),
    plan,
  };
}

describe("Fixture Verification Evidence", () => {
  it("accepts a complete writable miss only for its current run activity", async () => {
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
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      await expect(
        checkFixtureEvidenceHealth({
          ledger,
          runId: "run-42",
          runAttempt: "2",
          enabledScenarioSets: ["init"],
        }),
      ).resolves.toMatchObject({
        healthy: true,
        stages: [
          expect.objectContaining({
            scenarioSet: "init",
            hits: 0,
            misses: { absent: 1 },
            executions: 1,
            issuances: 1,
          }),
        ],
      });
      await expect(
        checkFixtureEvidenceHealth({
          ledger,
          runId: "run-42",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
      ).resolves.toMatchObject({
        healthy: false,
        failures: [
          expect.objectContaining({
            code: "missing-scenario-set",
            scenarioSet: "init",
          }),
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates activity from evidence through canonical paths and rejects either parent", async () => {
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

      expect(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityAlias,
            evidenceRoot,
          }),
      ).toThrow(
        "Fixture Evidence activity must be isolated from shared evidence storage",
      );
      expect(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityRoot,
            evidenceRoot: evidenceAlias,
          }),
      ).toThrow(
        "Fixture Evidence activity must be isolated from shared evidence storage",
      );
      expect(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: path.join(evidenceRoot, "activity"),
            evidenceRoot,
          }),
      ).toThrow(
        "Fixture Evidence activity must be isolated from shared evidence storage",
      );
      expect(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityRoot,
            evidenceRoot: path.join(activityRoot, "evidence"),
          }),
      ).toThrow(
        "Fixture Evidence activity must be isolated from shared evidence storage",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves every JSONL record across concurrent ledger instances", async () => {
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
      expect(records).toHaveLength(400);
      expect(
        new Set(
          records.map((record) =>
            record.event.type === "invocation" &&
            record.event.outcome === "failed"
              ? record.event.error
              : "",
          ),
        ).size,
      ).toBe(400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects activity outside the closed schema before it reaches the ledger", async () => {
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
      await expect(
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
      ).rejects.toThrow("invalid Fixture Evidence lookup activity");
      await expect(ledger.read()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invocation activity with no lookup or no writable issuance", async () => {
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
      expect(report.healthy).toBe(false);
      expect(report.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "no-lookup",
            invocationId: "no-lookup",
          }),
          expect.objectContaining({
            code: "missing-issuance",
            invocationId: "no-issuance",
            gate: "generated-root-quality",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes the semantic gate after storage read failure but leaves health failed", async () => {
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
      expect(executions).toBe(1);
      expect(report.healthy).toBe(false);
      expect(report.failures).toContainEqual(
        expect.objectContaining({
          code: "lifecycle-error",
          detail: expect.stringContaining("evidence volume unavailable"),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps invalid individual evidence as executable healthy misses", async () => {
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
        let executions = 0;
        const result = await runFixtureEvidenceGate({
          ...input,
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
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

        expect(result).toMatchObject({
          status: "executed",
          missReason: evidenceCase.reason,
        });
        expect(executions).toBe(1);
        await expect(
          checkFixtureEvidenceHealth({
            ledger,
            runId: `invalid-${evidenceCase.name}`,
            runAttempt: "1",
            enabledScenarioSets: ["init"],
          }),
        ).resolves.toMatchObject({ healthy: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues semantic execution when the current-run activity ledger has I/O failure", async () => {
    const workspace = await temporaryRepository("fixture-activity-io-");
    const brokenLedger: FixtureEvidenceActivityLedger = {
      invocation: () => ({
        record: async () => {
          throw new Error("activity disk is read-only");
        },
      }),
      read: async () => {
        throw new Error("activity disk is read-only");
      },
    };
    let rootChecks = 0;
    try {
      await runGeneratedScenarioSet("init", {
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          if (args[0] === "run" && args[1] === "check") {
            rootChecks += 1;
          }
          return {};
        },
        evidence: {
          readEnabled: false,
          writeEnabled: false,
          activity: {
            ledger: brokenLedger,
            runId: "activity-io-run",
            runAttempt: "1",
          },
        },
      });

      expect(rootChecks).toBe((await generatedScenariosFor("init")).length);
      await expect(
        checkFixtureEvidenceHealth({
          ledger: brokenLedger,
          runId: "activity-io-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
      ).resolves.toMatchObject({
        healthy: false,
        failures: [
          expect.objectContaining({
            code: "activity-io-error",
            detail: expect.stringContaining("activity disk is read-only"),
          }),
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses all four scenario sets by default and validates Health CLI arguments and exits", async () => {
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
      "packages/checks/src/check-fixture-evidence-health.ts",
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
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        recordLifecycle: invocation.record,
        execute: async () => undefined,
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      await expect(
        execa("node", ["--conditions=source", healthCliPath, "init"], {
          cwd: process.cwd(),
          env,
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(
        execa("node", ["--conditions=source", healthCliPath], {
          cwd: process.cwd(),
          env,
        }),
      ).rejects.toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          "Enabled scenario set package-addition-matrix has no current-run activity",
        ),
      });
      await expect(
        execa("node", ["--conditions=source", healthCliPath, "unknown"], {
          cwd: process.cwd(),
          env,
        }),
      ).rejects.toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          "Expected enabled scenario set: init, package-addition-matrix, focused, or deployment",
        ),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records initialization participation through the real scenario-set invocation", async () => {
    const root = await temporaryRepository("fixture-init-health-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    try {
      await runGeneratedScenarioSet("init", {
        workspace: path.join(root, "workspace"),
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          return {};
        },
        evidence: {
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: true,
          activity: {
            ledger,
            runId: "initialization-health",
            runAttempt: "1",
          },
        },
      });

      const scenarioCount = (await generatedScenariosFor("init")).length;
      await expect(
        checkFixtureEvidenceHealth({
          ledger,
          runId: "initialization-health",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
      ).resolves.toMatchObject({
        healthy: true,
        stages: [
          expect.objectContaining({
            scenarioSet: "init",
            invocations: 1,
            scenarios: scenarioCount,
            misses: { absent: scenarioCount },
            executions: scenarioCount,
            issuances: scenarioCount,
          }),
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a complete warm run healthy without invoking any expensive executor", async () => {
    const root = await temporaryRepository("fixture-complete-health-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const sets = [
      "init",
      "package-addition-matrix",
      "focused",
      "deployment",
    ] as const;
    type Command = {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    };
    const createRunner =
      (commands: Command[]) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        if (
          command === "pnpm" &&
          args.includes("build") &&
          args.includes("--force")
        ) {
          await materializeFocusedProviderBuild(options.cwd);
        }
        if (command === "node") {
          return {
            stdout: await focusedMarker(
              path.dirname(path.dirname(options.cwd)),
            ),
          };
        }
        return {};
      };
    const coldCommands: Command[] = [];
    const warmCommands: Command[] = [];
    const runComplete = async (
      runId: string,
      workspace: string,
      commands: Command[],
    ) => {
      for (const set of sets) {
        await runGeneratedScenarioSet(set, {
          workspace: path.join(workspace, set),
          run: createRunner(commands),
          scheduling: { concurrency: 4 },
          evidence: {
            storage,
            clock: () => new Date("2026-07-28T00:00:00.000Z"),
            writeEnabled: true,
            activity: { ledger, runId, runAttempt: "1" },
          },
        });
      }
    };
    try {
      await runComplete("complete-cold", path.join(root, "cold"), coldCommands);
      await runComplete("complete-warm", path.join(root, "warm"), warmCommands);

      const warmHealth = await checkFixtureEvidenceHealth({
        ledger,
        runId: "complete-warm",
        runAttempt: "1",
        enabledScenarioSets: sets,
      });
      expect(warmHealth.healthy).toBe(true);
      expect(warmHealth.stages.map(({ scenarioSet }) => scenarioSet)).toEqual(
        sets,
      );
      expect(
        warmHealth.stages.every(
          (stage) =>
            stage.hits > 0 && stage.executions === 0 && stage.issuances === 0,
        ),
      ).toBe(true);
      expect(warmCommands.filter(({ command }) => command !== "git")).toEqual(
        [],
      );
      expect(
        coldCommands.some(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
      ).toBe(true);
      expect(coldCommands.some(({ command }) => command === "node")).toBe(true);
      expect(coldCommands.some(({ command }) => command === "docker")).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces configured ordinary, browser, and Docker capacities with queued work", async () => {
    const scheduler = createFixtureEvidenceScheduler({ concurrency: 4 });

    const ordinary = createBlockedWorkProbe();
    const ordinaryJobs = ["a", "b", "c", "d", "e"].map(
      async (name) =>
        await scheduler.run(
          [],
          async () => await ordinary.run(`ordinary-${name}`),
        ),
    );
    await vi.waitFor(() => {
      expect(ordinary.started()).toEqual([
        "ordinary-a",
        "ordinary-b",
        "ordinary-c",
        "ordinary-d",
      ]);
    });
    ordinary.release("ordinary-a");
    await vi.waitFor(() => {
      expect(ordinary.started()).toContain("ordinary-e");
    });
    ordinary.releaseAll();
    await Promise.all(ordinaryJobs);

    const browser = createBlockedWorkProbe();
    const browserJobs = [
      scheduler.run(["browser"], async () => await browser.run("browser-a")),
    ];
    await vi.waitFor(() => {
      expect(browser.started()).toEqual(["browser-a"]);
    });
    browserJobs.push(
      scheduler.run(["browser"], async () => await browser.run("browser-b")),
      scheduler.run(["browser"], async () => await browser.run("browser-c")),
      scheduler.run(["browser"], async () => await browser.run("browser-d")),
    );
    expect(browser.started()).toEqual(["browser-a"]);
    for (const [current, next] of [
      ["browser-a", "browser-b"],
      ["browser-b", "browser-c"],
      ["browser-c", "browser-d"],
    ] as const) {
      browser.release(current);
      await vi.waitFor(() => {
        expect(browser.started()).toContain(next);
      });
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
    await vi.waitFor(() => {
      expect(docker.started()).toEqual(["docker-a"]);
    });
    docker.release("docker-a");
    await vi.waitFor(() => {
      expect(docker.started()).toEqual(["docker-a", "docker-b"]);
    });
    docker.release("docker-b");
    await vi.waitFor(() => {
      expect(docker.started()).toEqual(["docker-a", "docker-b", "docker-c"]);
    });
    docker.release("docker-c");
    await Promise.all(dockerJobs);

    expect(ordinary.maximum()).toBe(4);
    expect(browser.maximum()).toBe(1);
    expect(docker.maximum()).toBe(1);
  });

  it("serializes ordinary evidence misses when the CLI environment sets concurrency to one", async () => {
    const workspace = await temporaryRepository("fixture-cli-concurrency-");
    const installs = createBlockedConcurrencyProbe();
    try {
      const cli = runGeneratedRegistryCli({
        scenarioSet: "focused",
        environment: { TEMPLATE_FIXTURE_CONCURRENCY: "1" },
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            await installs.enter();
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          if (
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force")
          ) {
            await materializeFocusedProviderBuild(options.cwd);
          }
          if (command === "node") {
            return {
              stdout: await focusedMarker(
                path.dirname(path.dirname(options.cwd)),
              ),
            };
          }
          return {};
        },
      });
      await releaseAfterActive({
        execution: cli,
        probe: installs,
        expected: 1,
      });

      expect(installs.maximum()).toBe(1);
    } finally {
      installs.release();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("defaults the initialization CLI to two concurrent ordinary misses", async () => {
    const workspace = await temporaryRepository(
      "fixture-cli-default-concurrency-",
    );
    const installs = createBlockedConcurrencyProbe();
    try {
      const cli = runGeneratedRegistryCli({
        scenarioSet: "init",
        environment: {},
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            await installs.enter();
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          return {};
        },
      });
      await releaseAfterActive({
        execution: cli,
        probe: installs,
        expected: Math.min(2, (await generatedScenariosFor("init")).length),
      });

      expect(installs.maximum()).toBe(2);
    } finally {
      installs.release();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects malformed concurrency at the real generated-registry CLI environment boundary", async () => {
    const cliPath = path.join(
      process.cwd(),
      "packages/checks/src/check-generated-registry.ts",
    );
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

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        "TEMPLATE_FIXTURE_CONCURRENCY must be a positive integer",
      );
    }
  });

  it("applies CLI ordinary concurrency to every scenario set and controls Deployment Docker work", async () => {
    const root = await temporaryRepository("fixture-cli-resource-caps-");
    const sets = [
      "init",
      "package-addition-matrix",
      "focused",
      "deployment",
    ] as const;
    const maxActiveInstalls = new Map<(typeof sets)[number], number>();
    const dockerCommands = createBlockedConcurrencyProbe();
    let completedDeploymentRootChecks = 0;
    try {
      for (const scenarioSet of sets) {
        const installs = createBlockedConcurrencyProbe();
        const cli = runGeneratedRegistryCli({
          scenarioSet,
          environment: { TEMPLATE_FIXTURE_CONCURRENCY: "4" },
          workspace: path.join(root, scenarioSet),
          reporter: { info: () => undefined },
          run: async (command, args, options) => {
            if (command === "git") {
              return await execa(command, [...args], options);
            }
            if (args[0] === "install") {
              await installs.enter();
            }
            if (args.includes("--dry-run=json")) {
              return {
                stdout: JSON.stringify({
                  tasks: (await generatedTaskIds(options.cwd)).map(
                    (taskId) => ({ taskId }),
                  ),
                }),
              };
            }
            if (
              command === "pnpm" &&
              args.includes("build") &&
              args.includes("--force")
            ) {
              await materializeFocusedProviderBuild(options.cwd);
            }
            if (command === "node") {
              return {
                stdout: await focusedMarker(
                  path.dirname(path.dirname(options.cwd)),
                ),
              };
            }
            if (command === "docker") {
              await dockerCommands.enter();
            }
            if (
              scenarioSet === "deployment" &&
              command === "pnpm" &&
              args[0] === "run" &&
              args[1] === "check"
            ) {
              completedDeploymentRootChecks += 1;
            }
            return {};
          },
        });
        const expected =
          scenarioSet === "deployment"
            ? 1
            : Math.min(4, (await generatedScenariosFor(scenarioSet)).length);
        let observationFailure: unknown;
        try {
          await vi.waitFor(
            () => {
              expect(installs.active()).toBe(expected);
            },
            { timeout: 30_000 },
          );
        } catch (error) {
          observationFailure = error;
        } finally {
          installs.release();
        }
        if (scenarioSet === "deployment") {
          try {
            await vi.waitFor(
              () => {
                expect(dockerCommands.active()).toBe(1);
                expect(completedDeploymentRootChecks).toBeGreaterThan(1);
              },
              { timeout: 30_000 },
            );
          } catch (error) {
            observationFailure ??= error;
          } finally {
            dockerCommands.release();
          }
        }
        await cli;
        if (observationFailure !== undefined) throw observationFailure;
        maxActiveInstalls.set(scenarioSet, installs.maximum());
      }

      expect(maxActiveInstalls).toEqual(
        new Map([
          ["init", 4],
          ["package-addition-matrix", 4],
          ["focused", 4],
          ["deployment", 1],
        ]),
      );
      expect(dockerCommands.maximum()).toBe(1);
    } finally {
      dockerCommands.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes Docker execution regardless of the ordinary concurrency override", async () => {
    const scheduler = createFixtureEvidenceScheduler({ concurrency: 4 });
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let activeDocker = 0;
    let maxActiveDocker = 0;
    const work = async (name: string): Promise<void> => {
      started.push(name);
      activeDocker += 1;
      maxActiveDocker = Math.max(maxActiveDocker, activeDocker);
      await new Promise<void>((resolve) => {
        releases.set(name, resolve);
      });
      activeDocker -= 1;
    };

    const jobs = [
      scheduler.run(["docker"], async () => await work("docker-a")),
    ];
    await vi.waitFor(() => {
      expect(started).toEqual(["docker-a"]);
    });
    jobs.push(
      scheduler.run(["docker"], async () => await work("docker-b")),
      scheduler.run(["docker"], async () => await work("docker-c")),
    );
    expect(started).toEqual(["docker-a"]);
    releases.get("docker-a")!();
    await vi.waitFor(() => {
      expect(started).toEqual(["docker-a", "docker-b"]);
    });
    releases.get("docker-b")!();
    await vi.waitFor(() => {
      expect(started).toEqual(["docker-a", "docker-b", "docker-c"]);
    });
    releases.get("docker-c")!();
    await Promise.all(jobs);

    expect(maxActiveDocker).toBe(1);
  });

  it("classifies Root Quality browser resources from real Check Environment Needs", async () => {
    const classifications = (await generatedScenariosFor("init")).map(
      (scenario) => {
        const plan = planGeneratedRepositoryInitialization({
          definition: scenario.base,
          context: createGenerationContext({
            targetDir: path.join("/tmp/resource-classification", scenario.id),
            scope: "fixture",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
            },
          }),
        });
        return {
          hasBrowserNeed: plan.environmentNeeds.some(
            (need) => need.kind === "playwright-browser-assets",
          ),
          resources: generatedRootQualityExecutionResources(plan),
        };
      },
    );

    expect(classifications.some(({ hasBrowserNeed }) => hasBrowserNeed)).toBe(
      true,
    );
    expect(classifications.some(({ hasBrowserNeed }) => !hasBrowserNeed)).toBe(
      true,
    );
    for (const classification of classifications) {
      expect(classification.resources).toEqual(
        classification.hasBrowserNeed ? ["browser"] : [],
      );
    }
  });

  it("identifies Generated Repository content from the prospective Git tree", async () => {
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

      expect(firstIdentity).toMatch(/^[0-9a-f]{40}$/u);
      expect(secondIdentity).toBe(firstIdentity);
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it("lets Git identify bytes, paths, executable modes, symlinks, and rendered lockfiles", async () => {
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
      await expect(identity({ content: "echo changed\n" })).resolves.not.toBe(
        baseline,
      );
      await expect(
        identity({ filePath: "nested/script.sh" }),
      ).resolves.not.toBe(baseline);
      await expect(identity({ executable: true })).resolves.not.toBe(baseline);
      await expect(
        identity({ symlinkTarget: "missing-target" }),
      ).resolves.not.toBe(baseline);
      await expect(
        identity({ lockfile: "lockfileVersion: '9.0'\n" }),
      ).resolves.not.toBe(baseline);
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("derives contract identity from a normalized plan and owned production source", async () => {
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
      expect(await derive({ args: ["--all"], command: "check" })).toBe(initial);

      await writeFile(
        path.join(gateRoot, "index.ts"),
        "export const gate = 2;\n",
      );
      const gateChanged = await derive({
        command: "check",
        args: ["--all"],
      });
      expect(gateChanged).not.toBe(initial);

      await writeFile(
        path.join(kernelRoot, "index.ts"),
        "export const kernel = 2;\n",
      );
      expect(await derive({ command: "check", args: ["--all"] })).not.toBe(
        gateChanged,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates only the owning gate for plan and implementation changes while kernel changes invalidate every gate", async () => {
    const root = await temporaryRepository("fixture-contract-boundaries-");
    const rootGate = path.join(root, "root-quality");
    const focusedGate = path.join(root, "focused-package-link");
    const deploymentGate = path.join(root, "deployment-quality");
    const kernel = path.join(root, "kernel");
    try {
      await Promise.all([
        cp(
          path.resolve(
            "packages/checks/src/fixture-evidence/gates/root-quality",
          ),
          rootGate,
          { recursive: true },
        ),
        cp(
          path.resolve(
            "packages/checks/src/fixture-evidence/gates/focused-package-link",
          ),
          focusedGate,
          { recursive: true },
        ),
        cp(
          path.resolve(
            "packages/checks/src/fixture-evidence/gates/deployment-quality",
          ),
          deploymentGate,
          { recursive: true },
        ),
        cp(
          path.resolve("packages/checks/src/fixture-evidence/kernel"),
          kernel,
          { recursive: true },
        ),
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
      expect(await deriveRoot()).toBe(initialRoot);
      expect(await deriveFocused("source-and-default")).toBe(initialFocused);
      const deploymentImplementationChanged = await deriveDeployment(
        "pnpm run check:deployment",
      );
      expect(deploymentImplementationChanged).not.toBe(initialDeployment);

      const deploymentPlanChanged = await deriveDeployment(
        "pnpm run check:deployment:changed",
      );
      expect(deploymentPlanChanged).not.toBe(deploymentImplementationChanged);
      expect(await deriveRoot()).toBe(initialRoot);
      expect(await deriveFocused("source-and-default")).toBe(initialFocused);

      const focusedIndex = path.join(focusedGate, "index.ts");
      await writeFile(
        focusedIndex,
        `${await readFile(focusedIndex, "utf8")}\n// focused implementation change\n`,
      );
      expect(await deriveRoot()).toBe(initialRoot);
      const focusedImplementationChanged =
        await deriveFocused("source-and-default");
      expect(focusedImplementationChanged).not.toBe(initialFocused);
      expect(await deriveDeployment("pnpm run check:deployment:changed")).toBe(
        deploymentPlanChanged,
      );

      const focusedPlanChanged = await deriveFocused("different-plan");
      expect(focusedPlanChanged).not.toBe(focusedImplementationChanged);
      expect(await deriveRoot()).toBe(initialRoot);

      const rootIndex = path.join(rootGate, "index.ts");
      await writeFile(
        rootIndex,
        `${await readFile(rootIndex, "utf8")}\n// root implementation change\n`,
      );
      const rootImplementationChanged = await deriveRoot();
      expect(rootImplementationChanged).not.toBe(initialRoot);
      expect(await deriveFocused("different-plan")).toBe(focusedPlanChanged);
      expect(await deriveDeployment("pnpm run check:deployment:changed")).toBe(
        deploymentPlanChanged,
      );

      const kernelIndex = path.join(kernel, "index.ts");
      await writeFile(
        kernelIndex,
        `${await readFile(kernelIndex, "utf8")}\n// kernel change\n`,
      );
      expect(await deriveRoot()).not.toBe(rootImplementationChanged);
      expect(await deriveFocused("different-plan")).not.toBe(
        focusedPlanChanged,
      );
      expect(
        await deriveDeployment("pnpm run check:deployment:changed"),
      ).not.toBe(deploymentPlanChanged);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps selective invalidation and expiry healthy through the activity protocol", async () => {
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
              "expired" in invalidation && invalidation.expired === true
                ? "2026-07-08T00:00:00.000Z"
                : "2026-07-01T00:00:00.000Z",
            ),
        });
        await invocation.record({
          type: "invocation",
          outcome: "started",
          scenarios: [scenario],
        });
        const executions: string[] = [];
        const currentShared = {
          generatedContentIdentity: current.generatedContent,
          scenario,
          producerCommit: "current",
          storage,
          clock: () =>
            new Date(
              "expired" in invalidation && invalidation.expired === true
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
          execute: async () => {
            executions.push("generated-root-quality");
          },
        });
        await runFixtureEvidenceGate({
          ...currentShared,
          gate: "focused-package-link",
          rootEvidence,
          contractIdentity: current.focusedContract,
          execute: async () => {
            executions.push("focused-package-link");
          },
        });
        await runFixtureEvidenceGate({
          ...currentShared,
          gate: "deployment-quality",
          rootEvidence,
          contractIdentity: current.deploymentContract,
          execute: async () => {
            executions.push("deployment-quality");
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

        expect(executions).toEqual(invalidation.executions);
        await expect(
          checkFixtureEvidenceHealth({
            ledger,
            runId: invalidation.name,
            runAttempt: "1",
            enabledScenarioSets: ["focused"],
          }),
        ).resolves.toMatchObject({ healthy: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes a cold gate once and reuses its schema-validated evidence while warm", async () => {
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

      expect(cold.status).toBe("executed");
      expect(cold.missReason).toBe("absent");
      expect(executions).toBe(1);
      const gateDirectory = path.join(root, "generated-root-quality");
      const [recordName] = await readdir(gateDirectory);
      expect(recordName).toBe(`${cold.identity}.json`);
      expect(
        JSON.parse(
          await readFile(path.join(gateDirectory, recordName!), "utf8"),
        ),
      ).toEqual({
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
      });

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

      expect(warm).toMatchObject({
        status: "hit",
        identity: cold.identity,
      });
      expect(executions).toBe(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "lookup",
            outcome: "miss",
            reason: "absent",
          }),
          expect.objectContaining({
            type: "execution",
            outcome: "succeeded",
          }),
          expect.objectContaining({
            type: "issuance",
            outcome: "issued",
          }),
          expect.objectContaining({ type: "lookup", outcome: "hit" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("issues and reuses Focused Package Link evidence independently from Root Quality", async () => {
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

      await expect(
        runFixtureEvidenceGate({
          ...shared,
          gate: "generated-root-quality",
          contractIdentity: "4".repeat(64),
          execute: async () => {
            rootExecutions += 1;
          },
        }),
      ).resolves.toMatchObject({ status: "hit", identity: coldRoot.identity });
      await expect(
        runFixtureEvidenceGate({
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
      ).resolves.toMatchObject({
        status: "hit",
        identity: coldFocused.identity,
      });

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

      expect(changedRoot.identity).not.toBe(coldRoot.identity);
      expect(changedFocused.identity).not.toBe(coldFocused.identity);
      expect(focusedContractChanged.identity).not.toBe(changedFocused.identity);
      expect(
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
      ).toMatchObject({
        components: { rootEvidence: changedRoot.identity },
      });
      expect(rootExecutions).toBe(2);
      expect(focusedExecutions).toBe(3);
      await expect(
        readdir(path.join(root, "generated-root-quality")),
      ).resolves.toHaveLength(2);
      await expect(
        readdir(path.join(root, "focused-package-link")),
      ).resolves.toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("issues and reuses Deployment Quality evidence with its Root prerequisite proof", async () => {
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

      expect(cold.status).toBe("executed");
      expect(warm).toMatchObject({
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

      expect(rootChanged.identity).not.toBe(cold.identity);
      expect(deploymentChanged.identity).not.toBe(rootChanged.identity);
      expect(executions).toBe(3);
      await expect(
        readFile(
          path.join(root, "deployment-quality", `${cold.identity}.json`),
          "utf8",
        ),
      ).resolves.toContain(`"rootEvidence": "${rootEvidence.identity}"`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a fabricated Root prerequisite before Focused evidence lookup", async () => {
    const read = vi.fn<FixtureEvidenceStorage["read"]>(async () => undefined);
    const generatedContentIdentity = "8".repeat(40);
    const fabricatedRootEvidence = {
      gate: "generated-root-quality",
      status: "hit",
      identity: "9".repeat(64),
      generatedContentIdentity,
      contractIdentity: "a".repeat(64),
    } as unknown as Awaited<ReturnType<typeof successfulRootEvidence>>;

    await expect(
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
    ).rejects.toThrow(
      "requires successful Root Quality evidence for the same Generated Repository content",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("fails closed for corrupt, partial, unknown-schema, and mismatched records", async () => {
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
        await expect(
          runFixtureEvidenceGate({
            ...input,
            execute: async () => {
              executions += 1;
            },
          }),
        ).resolves.toMatchObject({
          status: "executed",
          missReason: "invalid",
        });
      }
      expect(executions).toBe(1 + invalidRecords.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose evidence when atomic issuance writes only a partial temporary file", async () => {
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
      await expect(
        runFixtureEvidenceGate({
          ...input,
          storage,
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            executions += 1;
          },
        }),
      ).resolves.toMatchObject({
        status: "executed-unissued",
        issuanceError: "simulated partial write",
      });
      await invocation.record({
        type: "scenario",
        scenario: input.scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      await expect(
        runFixtureEvidenceGate({
          ...input,
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: false,
          execute: async () => {
            executions += 1;
          },
        }),
      ).resolves.toMatchObject({
        status: "executed",
        missReason: "absent",
      });
      expect(executions).toBe(2);
      await expect(
        readdir(path.join(evidenceRoot, "generated-root-quality")),
      ).resolves.toEqual([]);
      await expect(
        checkFixtureEvidenceHealth({
          ledger,
          runId: "partial-issuance-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
      ).resolves.toMatchObject({
        healthy: false,
        failures: expect.arrayContaining([
          expect.objectContaining({
            code: "lifecycle-error",
            detail: expect.stringContaining("simulated partial write"),
          }),
          expect.objectContaining({
            code: "missing-issuance",
            gate: "generated-root-quality",
          }),
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose evidence when atomic replacement fails after the temporary write", async () => {
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
      await expect(
        runFixtureEvidenceGate({
          ...input,
          storage,
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            executions += 1;
          },
        }),
      ).resolves.toMatchObject({
        status: "executed-unissued",
        issuanceError: "simulated replace failure",
      });
      await invocation.record({
        type: "scenario",
        scenario: input.scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      await expect(
        runFixtureEvidenceGate({
          ...input,
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: false,
          execute: async () => {
            executions += 1;
          },
        }),
      ).resolves.toMatchObject({
        status: "executed",
        missReason: "absent",
      });
      expect(executions).toBe(2);
      await expect(
        readdir(path.join(evidenceRoot, "generated-root-quality")),
      ).resolves.toEqual([]);
      await expect(
        checkFixtureEvidenceHealth({
          ledger,
          runId: "replace-issuance-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
      ).resolves.toMatchObject({
        healthy: false,
        failures: expect.arrayContaining([
          expect.objectContaining({
            code: "lifecycle-error",
            detail: expect.stringContaining("simulated replace failure"),
          }),
          expect.objectContaining({
            code: "missing-issuance",
            gate: "generated-root-quality",
          }),
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expires at seven days and never refreshes evidence after failed execution", async () => {
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
      await expect(
        runFixtureEvidenceGate({
          ...input,
          execute: async () => {
            throw new Error("fresh evidence should not execute");
          },
        }),
      ).resolves.toMatchObject({ status: "hit" });

      now = new Date("2026-07-08T00:00:00.000Z");
      await expect(
        runFixtureEvidenceGate({
          ...input,
          execute: async () => {
            throw new Error("root quality failed");
          },
        }),
      ).rejects.toThrow("root quality failed");
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
        issuedAt: "2026-07-01T00:00:00.000Z",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes stale and structurally invalid records before publication", async () => {
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

      await expect(
        storage.prune({
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        }),
      ).resolves.toEqual({ removed: 2 });
      await expect(readdir(gateRoot)).resolves.toEqual([
        `${fresh.identity}.json`,
      ]);
      await expect(
        readFile(path.join(gateRoot, `${stale.identity}.json`), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes stale and invalid Focused records without removing fresh evidence", async () => {
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

      await expect(
        storage.prune({
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        }),
      ).resolves.toEqual({ removed: 2 });
      await expect(readdir(gateRoot)).resolves.toEqual([
        `${fresh.identity}.json`,
      ]);
      await expect(
        readFile(path.join(gateRoot, `${stale.identity}.json`), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("owns the normalized Generated Root Quality contract and complete executor", async () => {
    const root = await temporaryRepository("fixture-root-contract-");
    const definition = builtInPresetRegistry.all()[0]!;
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: "/different/temporary/paths/do-not-identify-contracts",
        scope: "fixture",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    });
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const expectedTasks = plan.manifests.flatMap((manifest) => {
      if (
        typeof manifest.name !== "string" ||
        typeof manifest.scripts !== "object" ||
        manifest.scripts === null
      ) {
        return [];
      }
      const packageName = manifest.name;
      return Object.keys(manifest.scripts).map((taskName) => ({
        taskId: `${packageName.startsWith("@") ? packageName : "//"}#${taskName}`,
      }));
    });

    try {
      const contractIdentity =
        await deriveGeneratedRootQualityContractIdentity(plan);
      expect(contractIdentity).toMatch(/^[0-9a-f]{64}$/u);

      await executeGeneratedRootQuality({
        plan,
        projectDir: path.join(root, "project"),
        fixtureWorkspace: root,
        run: async (command, args) => {
          calls.push({ command, args });
          return args.includes("--dry-run=json")
            ? { stdout: JSON.stringify({ tasks: expectedTasks }) }
            : {};
        },
      });

      expect(calls[0]).toEqual({
        command: "pnpm",
        args: ["install", "--store-dir", path.join(root, ".pnpm-store")],
      });
      expect(calls).toContainEqual({
        command: "pnpm",
        args: ["run", "check"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records dependency installation completion from the installed lockfile state", async () => {
    const root = await temporaryRepository("fixture-dependency-installation-");
    const projectDir = path.join(root, "project");
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
    }> = [];
    try {
      await mkdir(path.join(projectDir, "node_modules"), { recursive: true });
      await Promise.all([
        writeFile(
          path.join(projectDir, "package.json"),
          `${JSON.stringify({ name: "fixture" })}\n`,
        ),
        writeFile(
          path.join(projectDir, "pnpm-lock.yaml"),
          "lockfileVersion: 9\n",
        ),
      ]);
      const install = async () =>
        await ensureFixtureDependencies({
          projectDir,
          fixtureWorkspace: root,
          run: async (command, args) => {
            calls.push({ command, args });
            await writeFile(
              path.join(projectDir, "pnpm-lock.yaml"),
              `lockfileVersion: 9\ninstallRevision: ${calls.length}\n`,
            );
            return {};
          },
        });

      await expect(install()).resolves.toBe("installed");
      await expect(install()).resolves.toBe("ready");
      await writeFile(
        path.join(projectDir, "pnpm-lock.yaml"),
        "lockfileVersion: 9\nsettings: {}\n",
      );
      await expect(install()).resolves.toBe("installed");
      await expect(install()).resolves.toBe("ready");

      expect(calls).toEqual([
        {
          command: "pnpm",
          args: ["install", "--store-dir", path.join(root, ".pnpm-store")],
        },
        {
          command: "pnpm",
          args: ["install", "--store-dir", path.join(root, ".pnpm-store")],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not record dependency installation completion after a failed install mutates the lockfile", async () => {
    const root = await temporaryRepository(
      "fixture-dependency-installation-failure-",
    );
    const projectDir = path.join(root, "project");
    let attempts = 0;
    try {
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, "package.json"),
        `${JSON.stringify({ name: "fixture" })}\n`,
      );
      const install = async () =>
        await ensureFixtureDependencies({
          projectDir,
          fixtureWorkspace: root,
          run: async () => {
            attempts += 1;
            await writeFile(
              path.join(projectDir, "pnpm-lock.yaml"),
              `lockfileVersion: 9\ninstallAttempt: ${attempts}\n`,
            );
            if (attempts === 1) throw new Error("install failed");
            return {};
          },
        });

      await expect(install()).rejects.toThrow("install failed");
      await expect(install()).resolves.toBe("installed");
      await expect(install()).resolves.toBe("ready");
      expect(attempts).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives the Focused contract from the normalized consumer and provider plan", async () => {
    const workspace = await temporaryRepository("fixture-focused-contract-");
    try {
      const scenario = (await generatedScenariosFor("focused"))[0]!;
      const rendered = await renderMatrixScenario({ scenario, workspace });
      const consumerPackagePath = scenario.linkFrom![0]!;
      const providerPackagePath =
        rendered.plan.blueprint.packageLinkIntents!.find(
          (intent) =>
            intent.consumerPackagePath === consumerPackagePath &&
            !scenario.base
              .blueprint(
                createGenerationContext({
                  targetDir: path.join(workspace, scenario.id),
                  scope: "focused",
                  toolchain: {
                    nodeLtsMajor: "24",
                    packageManagerPin: "pnpm@11.11.0",
                  },
                }),
              )
              .packages.some(
                (definition) => definition.path === intent.providerPackagePath,
              ),
        )!.providerPackagePath;
      const input = {
        plan: rendered.plan,
        consumerPackagePath,
        providerPackagePath,
      } as const;

      expect(normalizedFocusedPackageLinkPlan(input)).toMatchObject({
        gate: "focused-package-link",
        consumer: expect.objectContaining({
          path: consumerPackagePath,
          name: expect.any(String),
          role: expect.any(String),
        }),
        provider: expect.objectContaining({
          path: providerPackagePath,
          name: expect.any(String),
          role: expect.any(String),
        }),
        intent: {
          consumerPackagePath,
          providerPackagePath,
        },
      });
      await expect(
        deriveFocusedPackageLinkContractIdentity(input),
      ).resolves.toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("selects the Focused provider from the final Package Link Intent when addition also creates a helper package", async () => {
    const workspace = await temporaryRepository(
      "fixture-focused-provider-intent-",
    );
    try {
      const scenario = (await generatedScenariosFor("focused"))[0]!;
      const rendered = await renderMatrixScenario({ scenario, workspace });
      const consumerPackagePath = scenario.linkFrom![0]!;
      const expectedIntent = rendered.plan.blueprint.packageLinkIntents?.find(
        (intent) =>
          intent.consumerPackagePath === consumerPackagePath &&
          !scenario.base
            .blueprint(
              createGenerationContext({
                targetDir: path.join(workspace, scenario.id),
                scope: "fixture",
                toolchain: {
                  nodeLtsMajor: "24",
                  packageManagerPin: "pnpm@11.11.0",
                },
              }),
            )
            .packages.some(
              (definition) => definition.path === intent.providerPackagePath,
            ),
      );
      expect(expectedIntent).toBeDefined();
      const finalPlan = {
        ...rendered.plan,
        blueprint: {
          ...rendered.plan.blueprint,
          packages: [
            ...rendered.plan.blueprint.packages,
            {
              name: "@fixture/addition-helper",
              path: "packages/addition-helper",
              role: "shared-library" as const,
            },
          ],
        },
      };

      expect(
        deriveFocusedPackageLinkPlanInput({
          initialPlan: planGeneratedRepositoryInitialization({
            definition: scenario.base,
            context: createGenerationContext({
              targetDir: path.join(workspace, "initial"),
              scope: "fixture",
              toolchain: {
                nodeLtsMajor: "24",
                packageManagerPin: "pnpm@11.11.0",
              },
            }),
          }),
          finalPlan,
          consumerPackagePaths: [consumerPackagePath],
        }).providerPackagePath,
      ).toBe(expectedIntent!.providerPackagePath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("issues no Focused evidence when a provider probe fails after source consumption", async () => {
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

      await expect(
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
      ).rejects.toThrow("provider build cancelled");
      await expect(
        readdir(path.join(root, "evidence", "focused-package-link")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(consumerRoot)).filter((entry) =>
          entry.includes("focused-provider-probe"),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reruns production initialization on a warm invocation without installing or executing Root Quality", async () => {
    const root = await temporaryRepository("fixture-init-evidence-");
    const evidenceRoot = path.join(root, "evidence");
    const firstWorkspace = path.join(root, "cold");
    const secondWorkspace = path.join(root, "warm");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");

    const createRunner =
      (
        commands: Array<{
          command: string;
          args: readonly string[];
          cwd: string;
        }>,
      ) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (args[0] === "install") {
          await mkdir(path.join(options.cwd, "node_modules"), {
            recursive: true,
          });
          await writeFile(
            path.join(options.cwd, "pnpm-lock.yaml"),
            "fixture-created: true\n",
          );
        }
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        return {};
      };

    const coldCommands: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
    }> = [];
    const warmCommands: typeof coldCommands = [];
    const coldEvents: FixtureEvidenceLifecycleEvent[] = [];
    const warmEvents: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await runGeneratedScenarioSet("init", {
        workspace: firstWorkspace,
        run: createRunner(coldCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "cold-producer",
          recordLifecycle: (event) => {
            coldEvents.push(event);
          },
        },
      });
      await runGeneratedScenarioSet("init", {
        workspace: secondWorkspace,
        run: createRunner(warmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "warm-producer",
          recordLifecycle: (event) => {
            warmEvents.push(event);
          },
        },
      });

      const scenarioCount = (await generatedScenariosFor("init")).length;
      expect(
        coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        coldCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "check",
        ),
      ).toHaveLength(scenarioCount);
      expect(warmCommands.filter(({ command }) => command === "pnpm")).toEqual(
        [],
      );
      expect(new Set(warmCommands.map(({ command }) => command))).toEqual(
        new Set(["git"]),
      );
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "add",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        coldEvents.filter(
          (event) => event.type === "issuance" && event.outcome === "issued",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ),
      ).toHaveLength(scenarioCount);
      expect(warmEvents.filter((event) => event.type === "execution")).toEqual(
        [],
      );
      for (const scenario of await generatedScenariosFor("init")) {
        await expect(
          readFile(
            path.join(secondWorkspace, scenario.id, "package.json"),
            "utf8",
          ),
        ).resolves.toContain('"packageManager"');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("establishes Root Evidence before independent Focused lookup and skips every warm executor", async () => {
    const root = await temporaryRepository("fixture-focused-evidence-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    type Command = {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    };
    const focusedMisses = createBlockedConcurrencyProbe();
    const createRunner =
      (commands: Command[]) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (command === "pnpm" && args[0] === "install") {
          await writeFile(
            path.join(options.cwd, "pnpm-lock.yaml"),
            "fixture-created: true\n",
          );
        }
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        if (
          command === "pnpm" &&
          args.includes("build") &&
          args.includes("--force")
        ) {
          await materializeFocusedProviderBuild(options.cwd);
        }
        if (command === "node") {
          const sourceProbe = args.includes("--conditions=source");
          if (sourceProbe) {
            await focusedMisses.enter();
          }
          return {
            stdout: await focusedMarker(
              path.dirname(path.dirname(options.cwd)),
            ),
          };
        }
        return {};
      };
    const coldCommands: Command[] = [];
    const warmCommands: Command[] = [];
    const rootChangedCommands: Command[] = [];
    const rootExpiredCommands: Command[] = [];
    const coldEvents: FixtureEvidenceLifecycleEvent[] = [];
    const warmEvents: FixtureEvidenceLifecycleEvent[] = [];
    const rootChangedEvents: FixtureEvidenceLifecycleEvent[] = [];
    const rootExpiredEvents: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await releaseAfterActive({
        execution: runGeneratedScenarioSet("focused", {
          workspace: path.join(root, "cold"),
          run: createRunner(coldCommands),
          evidence: {
            storage,
            clock,
            writeEnabled: true,
            producerCommit: "cold",
            recordLifecycle: (event) => {
              coldEvents.push(event);
            },
          },
        }),
        probe: focusedMisses,
        expected: 2,
      });
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "warm"),
        run: createRunner(warmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "warm",
          recordLifecycle: (event) => {
            warmEvents.push(event);
          },
        },
      });
      await rm(path.join(evidenceRoot, "generated-root-quality"), {
        recursive: true,
        force: true,
      });
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "root-changed"),
        run: createRunner(rootChangedCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "root-changed",
          recordLifecycle: (event) => {
            rootChangedEvents.push(event);
          },
        },
      });
      const rootEvidenceDirectory = path.join(
        evidenceRoot,
        "generated-root-quality",
      );
      for (const recordName of await readdir(rootEvidenceDirectory)) {
        const recordPath = path.join(rootEvidenceDirectory, recordName);
        const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<
          string,
          unknown
        >;
        await writeFile(
          recordPath,
          `${JSON.stringify({
            ...record,
            issuedAt: "2026-07-01T00:00:00.000Z",
          })}\n`,
        );
      }
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "root-expired"),
        run: createRunner(rootExpiredCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "root-expired",
          recordLifecycle: (event) => {
            rootExpiredEvents.push(event);
          },
        },
      });

      const scenarioCount = (await generatedScenariosFor("focused")).length;
      expect(
        coldEvents.filter(
          (event) =>
            event.type === "issuance" &&
            event.outcome === "issued" &&
            event.gate === "generated-root-quality",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
      ).toHaveLength(scenarioCount);
      expect(focusedMisses.maximum()).toBe(2);
      expect(
        coldEvents.filter(
          (event) =>
            event.type === "issuance" &&
            event.outcome === "issued" &&
            event.gate === "focused-package-link",
        ),
      ).toHaveLength(scenarioCount);
      for (const command of coldCommands.filter(
        ({ command, args }) =>
          command === "node" && args.includes("--conditions=source"),
      )) {
        const projectDir = path.dirname(path.dirname(command.cwd));
        const scenarioCommands = coldCommands.filter(({ cwd }) =>
          cwd.startsWith(projectDir),
        );
        expect(
          scenarioCommands.findIndex(
            ({ command: name, args }) =>
              name === "pnpm" && args[0] === "run" && args[1] === "check",
          ),
        ).toBeLessThan(scenarioCommands.indexOf(command));
      }

      expect(warmCommands.filter(({ command }) => command !== "git")).toEqual(
        [],
      );
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ),
      ).toHaveLength(scenarioCount * 2);
      expect(warmEvents.filter((event) => event.type === "execution")).toEqual(
        [],
      );
      expect(
        rootChangedCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "check",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        rootChangedCommands.filter(({ command }) => command === "node"),
      ).toEqual([]);
      expect(
        rootChangedEvents.filter(
          (event) =>
            event.type === "execution" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "succeeded",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        rootChangedEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "hit",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        rootChangedEvents.filter(
          (event) =>
            event.type === "execution" && event.gate === "focused-package-link",
        ),
      ).toEqual([]);
      expect(
        rootExpiredCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "check",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        rootExpiredCommands.filter(({ command }) => command === "node"),
      ).toEqual([]);
      expect(
        rootExpiredEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "miss" &&
            event.reason === "stale",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        rootExpiredEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "hit",
        ),
      ).toHaveLength(scenarioCount);
    } finally {
      focusedMisses.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares dependencies when Root evidence hits and Focused evidence misses in a new workspace", async () => {
    const root = await temporaryRepository("fixture-focused-partial-warm-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    type Command = {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    };
    const createRunner =
      (commands: Command[]) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (command === "pnpm" && args[0] === "install") {
          await mkdir(path.join(options.cwd, "node_modules"), {
            recursive: true,
          });
          return {};
        }
        if (command === "pnpm" || command === "node") {
          const dependencyRoot =
            command === "node"
              ? path.dirname(path.dirname(options.cwd))
              : options.cwd;
          try {
            await access(path.join(dependencyRoot, "node_modules"));
          } catch {
            throw new Error(
              `node_modules missing before ${command} ${args.join(" ")}`,
            );
          }
        }
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        if (
          command === "pnpm" &&
          args.includes("build") &&
          args.includes("--force")
        ) {
          await materializeFocusedProviderBuild(options.cwd);
        }
        if (command === "node") {
          return {
            stdout: await focusedMarker(
              path.dirname(path.dirname(options.cwd)),
            ),
          };
        }
        return {};
      };
    const coldCommands: Command[] = [];
    const partialWarmCommands: Command[] = [];
    const completeWarmCommands: Command[] = [];
    const partialWarmEvents: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "cold"),
        run: createRunner(coldCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "cold",
        },
      });
      await rm(path.join(evidenceRoot, "focused-package-link"), {
        recursive: true,
        force: true,
      });

      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "partial-warm"),
        run: createRunner(partialWarmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "partial-warm",
          recordLifecycle: (event) => {
            partialWarmEvents.push(event);
          },
        },
      });
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "complete-warm"),
        run: createRunner(completeWarmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "complete-warm",
        },
      });

      const scenarioCount = (await generatedScenariosFor("focused")).length;
      expect(
        partialWarmEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "hit",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        partialWarmEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "miss",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        partialWarmCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        partialWarmCommands.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force"),
        ),
      ).toHaveLength(scenarioCount);
      expect(
        partialWarmCommands.filter(
          ({ command, args }) =>
            command === "node" && args.includes("--conditions=source"),
        ),
      ).toHaveLength(scenarioCount);
      expect(
        completeWarmCommands.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            (args[0] === "install" || args.includes("build")),
        ),
      ).toEqual([]);
      expect(
        completeWarmCommands.filter(({ command }) => command === "node"),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never looks up Focused evidence when the current Root prerequisite fails", async () => {
    const root = await temporaryRepository("fixture-focused-root-failure-");
    const fileStorage = new FileFixtureEvidenceStorage(
      path.join(root, "evidence"),
    );
    const reads: string[] = [];
    const events: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await expect(
        runGeneratedScenarioSet("focused", {
          workspace: path.join(root, "workspace"),
          run: async (command, args, options) => {
            if (command === "git") {
              return await execa(command, [...args], options);
            }
            if (args.includes("--dry-run=json")) {
              return {
                stdout: JSON.stringify({
                  tasks: (await generatedTaskIds(options.cwd)).map(
                    (taskId) => ({ taskId }),
                  ),
                }),
              };
            }
            if (
              command === "pnpm" &&
              args[0] === "run" &&
              args[1] === "check"
            ) {
              throw new Error("Root Quality failed");
            }
            return {};
          },
          evidence: {
            storage: {
              read: async (gate, identity) => {
                reads.push(gate);
                return await fileStorage.read(gate, identity);
              },
              writeAtomically: fileStorage.writeAtomically.bind(fileStorage),
            },
            writeEnabled: true,
            recordLifecycle: (event) => {
              events.push(event);
            },
          },
        }),
      ).rejects.toThrow("Root Quality failed");

      const scenarioCount = (await generatedScenariosFor("focused")).length;
      await vi.waitFor(
        () => {
          expect(
            events.filter(
              (event) =>
                event.type === "execution" &&
                event.gate === "generated-root-quality" &&
                event.outcome === "failed",
            ),
          ).toHaveLength(scenarioCount);
        },
        { timeout: 5_000 },
      );
      expect(reads).toHaveLength(scenarioCount);
      expect(new Set(reads)).toEqual(new Set(["generated-root-quality"]));
      expect(
        events.filter((event) => event.gate === "focused-package-link"),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles the complete Package Addition Matrix before warm Root Quality lookup", async () => {
    const root = await temporaryRepository("fixture-matrix-evidence-");
    const evidenceRoot = path.join(root, "evidence");
    const firstWorkspace = path.join(root, "cold");
    const secondWorkspace = path.join(root, "warm");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");

    const createRunner =
      (
        commands: Array<{
          command: string;
          args: readonly string[];
          cwd: string;
        }>,
      ) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (args[0] === "install") {
          await mkdir(path.join(options.cwd, "node_modules"), {
            recursive: true,
          });
          await writeFile(
            path.join(options.cwd, "pnpm-lock.yaml"),
            "fixture-created: true\n",
          );
        }
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        return {};
      };

    const coldCommands: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
    }> = [];
    const warmCommands: typeof coldCommands = [];
    const warmEvents: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await runGeneratedScenarioSet("package-addition-matrix", {
        workspace: firstWorkspace,
        run: createRunner(coldCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "cold-producer",
        },
      });
      const invalidRecordPath = path.join(
        evidenceRoot,
        "generated-root-quality",
        "invalid.json",
      );
      await writeFile(invalidRecordPath, '{"schema":');
      await runGeneratedScenarioSet("package-addition-matrix", {
        workspace: secondWorkspace,
        run: createRunner(warmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "warm-producer",
          recordLifecycle: (event) => {
            warmEvents.push(event);
          },
        },
      });

      const scenarioCount = (
        await generatedScenariosFor("package-addition-matrix")
      ).length;
      expect(
        coldCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        coldCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "add",
        ),
      ).toHaveLength(scenarioCount * 2);
      expect(
        coldCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "fix",
        ),
      ).toHaveLength(scenarioCount);
      const coldInstalls = coldCommands.filter(
        ({ command, args }) => command === "pnpm" && args[0] === "install",
      );
      expect(coldInstalls).toHaveLength(scenarioCount);
      expect(new Set(coldInstalls.map(({ cwd }) => cwd)).size).toBe(
        scenarioCount,
      );
      for (const install of coldInstalls) {
        expect(path.dirname(install.cwd)).toBe(firstWorkspace);
        expect(install.args).toEqual([
          "install",
          "--store-dir",
          path.join(firstWorkspace, ".pnpm-store"),
        ]);
        const scenarioCommands = coldCommands.filter(
          ({ cwd }) => cwd === install.cwd,
        );
        expect(
          scenarioCommands.findIndex(
            ({ command, args }) => command === "git" && args[0] === "init",
          ),
        ).toBeLessThan(
          scenarioCommands.findIndex(
            ({ command, args }) => command === "git" && args[0] === "add",
          ),
        );
      }
      expect(warmCommands.filter(({ command }) => command === "pnpm")).toEqual(
        [],
      );
      expect(new Set(warmCommands.map(({ command }) => command))).toEqual(
        new Set(["git"]),
      );
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "add",
        ),
      ).toHaveLength(scenarioCount * 2);
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ),
      ).toHaveLength(scenarioCount);
      expect(warmEvents.filter((event) => event.type === "execution")).toEqual(
        [],
      );
      await expect(readFile(invalidRecordPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      for (const scenario of await generatedScenariosFor(
        "package-addition-matrix",
      )) {
        const generation = JSON.parse(
          await readFile(
            path.join(
              secondWorkspace,
              scenario.id,
              ".template/generation.json",
            ),
            "utf8",
          ),
        ) as {
          readonly packages: readonly {
            readonly path: string;
            readonly definitionName: string;
          }[];
        };
        expect(
          generation.packages.map(({ definitionName }) => definitionName),
        ).toContain(
          scenario.addition?.metadata.name ?? scenario.base.metadata.name,
        );
        await expect(
          readFile(
            path.join(
              secondWorkspace,
              scenario.id,
              generation.packages.at(-1)!.path,
              "package.json",
            ),
            "utf8",
          ),
        ).resolves.toContain('"name"');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps stale and invalid records untouched in a read-only matrix run", async () => {
    const root = await temporaryRepository("fixture-read-only-matrix-");
    const evidenceRoot = path.join(root, "evidence");
    const workspace = path.join(root, "workspace");
    const fileStorage = new FileFixtureEvidenceStorage(evidenceRoot);
    try {
      const stale = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario: {
          id: "read-only-stale",
          label: "read-only stale",
          presetIdentities: [],
        },
        producerCommit: "seed",
        storage: fileStorage,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
        writeEnabled: true,
        execute: async () => undefined,
      });
      const gateRoot = path.join(evidenceRoot, "generated-root-quality");
      const stalePath = path.join(gateRoot, `${stale.identity}.json`);
      const invalidPath = path.join(gateRoot, "invalid.json");
      await writeFile(invalidPath, '{"schema":');
      const prune = vi.fn<typeof fileStorage.prune>(
        fileStorage.prune.bind(fileStorage),
      );
      const writeAtomically = vi.fn<typeof fileStorage.writeAtomically>(
        fileStorage.writeAtomically.bind(fileStorage),
      );

      await runGeneratedScenarioSet("package-addition-matrix", {
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          return {};
        },
        evidence: {
          storage: {
            read: fileStorage.read.bind(fileStorage),
            writeAtomically,
            prune,
          },
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
          writeEnabled: false,
          producerCommit: "read-only",
        },
      });

      expect(prune).not.toHaveBeenCalled();
      expect(writeAtomically).not.toHaveBeenCalled();
      await expect(readFile(stalePath, "utf8")).resolves.toContain(
        stale.identity,
      );
      await expect(readFile(invalidPath, "utf8")).resolves.toBe('{"schema":');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("schedules real matrix misses by final Check Environment Needs", async () => {
    const workspace = await temporaryRepository("fixture-matrix-scheduling-");
    const scheduledResources = new AsyncLocalStorage<
      readonly FixtureEvidenceExecutionResource[]
    >();
    const resourcesByScenario = new Map<
      string,
      readonly FixtureEvidenceExecutionResource[]
    >();
    const installedScenarios: string[] = [];
    const scheduledRuns: (readonly FixtureEvidenceExecutionResource[])[] = [];
    const needsByScenario = new Map<
      string,
      { readonly check: readonly { readonly kind?: string }[] }
    >();
    const ordinaryScenarios = new Set<string>();
    const browserScenarios = new Set<string>();
    const schedulerFactory = vi.fn<FixtureEvidenceSchedulerFactory>(
      (scheduling) => {
        const scheduler = createFixtureEvidenceScheduler(scheduling);
        return {
          run: async (resources, execute) => {
            scheduledRuns.push(resources);
            return await scheduler.run(
              resources,
              async () => await scheduledResources.run(resources, execute),
            );
          },
        };
      },
    );
    try {
      await runGeneratedScenarioSet("package-addition-matrix", {
        workspace,
        scheduling: { concurrency: 4 },
        schedulerFactory,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            const environmentNeeds = JSON.parse(
              await readFile(
                path.join(options.cwd, ".template/environment-needs.json"),
                "utf8",
              ),
            ) as {
              readonly check: readonly { readonly kind?: string }[];
            };
            const resources = scheduledResources.getStore();
            expect(resources).toBeDefined();
            const browser = environmentNeeds.check.some(
              (need) => need.kind === "playwright-browser-assets",
            );
            const scenarioId = path.basename(options.cwd);
            installedScenarios.push(scenarioId);
            needsByScenario.set(scenarioId, environmentNeeds);
            resourcesByScenario.set(scenarioId, resources!);
            if (browser) {
              browserScenarios.add(scenarioId);
            } else {
              ordinaryScenarios.add(scenarioId);
            }
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          return {};
        },
      });

      const scenarios = await generatedScenariosFor("package-addition-matrix");
      const scenarioIds = scenarios.map(({ id }) => id).sort();
      expect(schedulerFactory).toHaveBeenCalledOnce();
      expect(schedulerFactory).toHaveBeenCalledWith({ concurrency: 4 });
      expect(scheduledRuns).toHaveLength(scenarios.length);
      expect(installedScenarios.sort()).toEqual(scenarioIds);
      expect([...resourcesByScenario.keys()].sort()).toEqual(scenarioIds);
      expect(needsByScenario.size).toBe(scenarios.length);
      expect(ordinaryScenarios.size).toBeGreaterThanOrEqual(2);
      expect(browserScenarios.size).toBeGreaterThanOrEqual(2);
      for (const scenario of scenarios) {
        const finalNeeds = needsByScenario.get(scenario.id);
        expect(finalNeeds).toBeDefined();
        expect(resourcesByScenario.get(scenario.id)).toEqual(
          finalNeeds!.check.some(
            (need) => need.kind === "playwright-browser-assets",
          )
            ? ["browser"]
            : [],
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("invalidates only final matrix states changed by a Preset-local addition output", async () => {
    const root = await temporaryRepository("fixture-matrix-invalidation-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");

    try {
      const scenarios = await generatedScenariosFor("package-addition-matrix");
      const candidate = scenarios.find((scenario) => {
        const addition = scenario.addition;
        if (addition?.planPackageAddition === undefined) return false;
        const context = createGenerationContext({
          targetDir: path.join(root, "candidate"),
          scope: "fixture",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        });
        const packageLeafName = `fixture-${addition.metadata.name}`;
        const packagePath = addition.defaultPackagePath?.({
          context,
          packageLeafName,
        });
        if (packagePath === undefined) return false;
        const contribution = addition.planPackageAddition({
          context,
          packageLeafName,
          packagePath,
        });
        return contribution.operations.some(
          (operation) =>
            "source" in operation && operation.source === addition.source,
        );
      });
      expect(candidate?.addition).toBeDefined();
      const selectedAddition = candidate!.addition!;
      const sourceRoot = resolveBuiltInTemplateSource(
        selectedAddition.source,
        ".",
      );
      const changedSourceRoot = path.join(root, "changed-preset-source");
      await cp(sourceRoot, changedSourceRoot, { recursive: true });
      const sampleContext = createGenerationContext({
        targetDir: path.join(root, "sample"),
        scope: "fixture",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      });
      const sampleLeafName = `fixture-${selectedAddition.metadata.name}`;
      const samplePackagePath = selectedAddition.defaultPackagePath!({
        context: sampleContext,
        packageLeafName: sampleLeafName,
      });
      const sampleContribution = selectedAddition.planPackageAddition!({
        context: sampleContext,
        packageLeafName: sampleLeafName,
        packagePath: samplePackagePath,
      });
      const changedOperation = sampleContribution.operations.find(
        (operation) =>
          "source" in operation &&
          operation.source === selectedAddition.source &&
          "from" in operation &&
          typeof operation.from === "string",
      );
      expect(changedOperation).toBeDefined();
      if (
        changedOperation === undefined ||
        !("from" in changedOperation) ||
        typeof changedOperation.from !== "string"
      ) {
        throw new Error(
          "Expected a Preset-local source-backed Package Addition output",
        );
      }
      const changedSourceFile = path.join(
        changedSourceRoot,
        changedOperation.from,
      );
      const originalSource = await readFile(changedSourceFile);
      await writeFile(
        changedSourceFile,
        Buffer.concat([
          originalSource,
          Buffer.from("\n// Preset-local fixture evidence change\n"),
        ]),
      );
      const changedSource = createTemplateSourceHandle(changedSourceRoot);
      const changedAddition: BuiltInPresetDefinition = {
        ...selectedAddition,
        source: changedSource,
        planPackageAddition(options) {
          return replaceContributionTemplateSource({
            contribution: selectedAddition.planPackageAddition!(options),
            from: selectedAddition.source,
            to: changedSource,
          });
        },
      };

      const baseline = new Map<
        string,
        {
          readonly generatedContentIdentity: string;
          readonly contractIdentity: string;
        }
      >();
      for (const scenario of scenarios) {
        const rendered = await renderMatrixScenario({
          scenario,
          workspace: path.join(root, "cold"),
        });
        const contractIdentity =
          await deriveGeneratedRootQualityContractIdentity(rendered.plan, {
            includeFix: true,
          });
        baseline.set(scenario.id, {
          generatedContentIdentity: rendered.generatedContentIdentity,
          contractIdentity,
        });
        await runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: rendered.generatedContentIdentity,
          contractIdentity,
          scenario: {
            id: scenario.id,
            label: scenario.label,
            presetIdentities: [
              scenario.base.metadata.name,
              ...(scenario.addition === undefined
                ? []
                : [scenario.addition.metadata.name]),
            ],
          },
          producerCommit: "cold-producer",
          storage,
          clock,
          writeEnabled: true,
          execute: async () => undefined,
        });
      }

      await writeFile(
        path.join(root, "unrelated-documentation.md"),
        "does not belong to any Generated Repository\n",
      );
      for (const scenario of scenarios) {
        const rendered = await renderMatrixScenario({
          scenario,
          workspace: path.join(root, "documentation-change"),
        });
        const previous = baseline.get(scenario.id)!;
        expect(rendered.generatedContentIdentity).toBe(
          previous.generatedContentIdentity,
        );
        await expect(
          runFixtureEvidenceGate({
            gate: "generated-root-quality",
            generatedContentIdentity: rendered.generatedContentIdentity,
            contractIdentity: previous.contractIdentity,
            scenario: {
              id: scenario.id,
              label: scenario.label,
              presetIdentities: [],
            },
            producerCommit: "documentation-change",
            storage,
            clock,
            writeEnabled: false,
            execute: async () => {
              throw new Error("unrelated documentation must remain a hit");
            },
          }),
        ).resolves.toMatchObject({ status: "hit" });
      }

      const changedTrees: string[] = [];
      const executions: string[] = [];
      const hits: string[] = [];
      for (const scenario of scenarios) {
        const usesChangedAddition = scenario.addition === selectedAddition;
        const rendered = await renderMatrixScenario({
          scenario,
          workspace: path.join(root, "preset-local-change"),
          ...(usesChangedAddition ? { addition: changedAddition } : {}),
        });
        const previous = baseline.get(scenario.id)!;
        if (
          rendered.generatedContentIdentity !==
          previous.generatedContentIdentity
        ) {
          changedTrees.push(scenario.id);
        }
        const result = await runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: rendered.generatedContentIdentity,
          contractIdentity: await deriveGeneratedRootQualityContractIdentity(
            rendered.plan,
            {
              includeFix: true,
            },
          ),
          scenario: {
            id: scenario.id,
            label: scenario.label,
            presetIdentities: [],
          },
          producerCommit: "preset-local-change",
          storage,
          clock,
          writeEnabled: false,
          execute: async () => {
            executions.push(scenario.id);
          },
        });
        if (result.status === "hit") hits.push(scenario.id);
      }
      const affectedScenarioIds = scenarios
        .filter((scenario) => scenario.addition === selectedAddition)
        .map((scenario) => scenario.id);
      const unaffectedScenarioIds = scenarios
        .filter((scenario) => scenario.addition !== selectedAddition)
        .map((scenario) => scenario.id);
      expect(changedTrees).toEqual(affectedScenarioIds);
      expect(executions).toEqual(affectedScenarioIds);
      expect(hits).toEqual(unaffectedScenarioIds);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("runs all four source CLI scenario sets warm without an expensive command", async () => {
    const root = await temporaryRepository("fixture-evidence-cli-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const binRoot = path.join(root, "bin");
    const commandLog = path.join(root, "expensive-commands.jsonl");
    const pnpmPath = path.join(binRoot, "pnpm");
    const nodePath = path.join(binRoot, "node");
    const dockerPath = path.join(binRoot, "docker");
    const cliPath = path.join(
      process.cwd(),
      "packages/checks/src/check-generated-registry.ts",
    );
    const healthCliPath = path.join(
      process.cwd(),
      "packages/checks/src/check-fixture-evidence-health.ts",
    );
    try {
      await mkdir(binRoot, { recursive: true });
      await writeFile(
        pnpmPath,
        `#!${process.execPath}
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const commandArgs = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(["pnpm", ...commandArgs]) + "\\n");

const manifests = [];
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
    } else if (entry.name === "package.json") {
      manifests.push({
        root: path.dirname(entryPath),
        value: JSON.parse(readFileSync(entryPath, "utf8")),
      });
    }
  }
};
visit(process.cwd());

if (commandArgs.includes("--dry-run=json")) {
  const tasks = [];
  for (const { value: manifest } of manifests) {
        for (const taskName of Object.keys(manifest.scripts ?? {})) {
          tasks.push({
            taskId: (manifest.name.startsWith("@") ? manifest.name : "//") + "#" + taskName,
          });
        }
  }
  process.stdout.write(JSON.stringify({ tasks }));
}

if (commandArgs.includes("build") && commandArgs.includes("--force")) {
  for (const { root, value: manifest } of manifests) {
    const source = manifest.exports?.["."]?.source;
    const target = manifest.exports?.["."]?.default;
    if (typeof source !== "string" || typeof target !== "string") continue;
    const sourcePath = path.resolve(root, source);
    const targetPath = path.resolve(root, target);
    if (!existsSync(sourcePath)) continue;
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}
`,
      );
      await writeFile(
        nodePath,
        `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(["node", ...process.argv.slice(2)]) + "\\n");
let marker;
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
      continue;
    }
    try {
      marker ??= /focused-provider-marker:[0-9a-f]+/u.exec(readFileSync(entryPath, "utf8"))?.[0];
    } catch {}
  }
};
visit(path.resolve(process.cwd(), "../.."));
if (marker === undefined) throw new Error("focused marker was not materialized");
process.stdout.write(marker + "\\n");
`,
      );
      await writeFile(
        dockerPath,
        `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(["docker", ...process.argv.slice(2)]) + "\\n");
`,
      );
      await Promise.all([
        chmod(pnpmPath, 0o755),
        chmod(nodePath, 0o755),
        chmod(dockerPath, 0o755),
      ]);

      const baseEnv = isolatedFixtureEnvironment({
        FIXTURE_COMMAND_LOG: commandLog,
        PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        TEMPLATE_FIXTURE_EVIDENCE_DIR: evidenceRoot,
        TEMPLATE_FIXTURE_EVIDENCE_READ: "1",
        TEMPLATE_FIXTURE_EVIDENCE_WRITE: "1",
        TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR: activityRoot,
        TEMPLATE_FIXTURE_EVIDENCE_RUN_ID: "source-cli-run",
      });
      const sets = [
        "init",
        "package-addition-matrix",
        "focused",
        "deployment",
      ] as const;
      const invoke = async (runAttempt: string) => {
        const env = {
          ...baseEnv,
          TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: runAttempt,
        };
        for (const set of sets) {
          await execa(process.execPath, ["--conditions=source", cliPath, set], {
            cwd: process.cwd(),
            env,
          });
        }
      };

      await invoke("1");
      const coldCommands = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as readonly string[]);
      expect(
        coldCommands.filter(
          ([binary, command]) => binary === "pnpm" && command === "install",
        ),
      ).not.toHaveLength(0);
      expect(
        coldCommands.filter(
          ([binary, command, task]) =>
            binary === "pnpm" && command === "run" && task === "check",
        ),
      ).not.toHaveLength(0);
      expect(coldCommands.some(([binary]) => binary === "node")).toBe(true);
      expect(coldCommands.some(([binary]) => binary === "docker")).toBe(true);

      await invoke("2");
      const allCommands = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as readonly string[]);
      expect(allCommands).toEqual(coldCommands);
      const warmEnv = {
        ...baseEnv,
        TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: "2",
      };
      await expect(
        execa(process.execPath, ["--conditions=source", healthCliPath], {
          cwd: process.cwd(),
          env: warmEnv,
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(readdir(activityRoot)).resolves.toEqual(["activity.jsonl"]);
      await expect(
        execa(process.execPath, ["--conditions=source", healthCliPath], {
          cwd: process.cwd(),
          env: {
            ...baseEnv,
            TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: "3",
          },
        }),
      ).rejects.toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          "Enabled scenario set init has no current-run activity",
        ),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("structurally enforces gate, kernel, test-source, and orchestrator ownership", async () => {
    const root = await temporaryRepository("fixture-evidence-architecture-");
    try {
      await Promise.all([
        mkdir(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/gates/root-quality",
          ),
          { recursive: true },
        ),
        mkdir(
          path.join(root, "packages/checks/src/fixture-evidence/gates/focused"),
          { recursive: true },
        ),
        mkdir(path.join(root, "packages/checks/src/fixture-evidence/kernel"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/gates/root-quality/index.ts",
          ),
          'import "../focused/index.ts";\nimport "../../../outside.ts";\n',
        ),
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/gates/focused/index.ts",
          ),
          "export {};\n",
        ),
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/kernel/kernel.test.ts",
          ),
          "export {};\n",
        ),
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/kernel/index.ts",
          ),
          'import "../gates/root-quality/index.ts";\n',
        ),
        writeFile(
          path.join(root, "packages/checks/src/check-generated-registry.ts"),
          'async function scenario() { await run("pnpm", ["run", "check"], { cwd: "." }); await run("node", ["--conditions=source", "probe.mjs"], { cwd: "." }); await run("docker", ["version"], { cwd: "." }); await run("pnpm", ["run", "check:deployment"], { cwd: "." }); }\n',
        ),
      ]);

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "cross-gate-runtime-import" }),
          expect.objectContaining({
            rule: "gate-runtime-import-outside-contract",
          }),
          expect.objectContaining({
            rule: "kernel-runtime-import-outside-kernel",
          }),
          expect.objectContaining({ rule: "production-test-source" }),
          expect.objectContaining({ rule: "hidden-root-quality-command" }),
          expect.objectContaining({
            rule: "hidden-focused-package-link-command",
          }),
          expect.objectContaining({
            rule: "hidden-deployment-quality-command",
          }),
        ]),
      );
      await expect(
        findFixtureEvidenceArchitectureFindings(process.cwd()),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces gate and kernel ownership for dynamic imports and concatenated specifiers", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-import-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused",
    );
    const kernel = path.join(
      root,
      "packages/checks/src/fixture-evidence/kernel",
    );
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "cross-gate-runtime-import" }),
          expect.objectContaining({
            rule: "kernel-runtime-import-outside-kernel",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects createRequire property calls that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-create-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects direct CommonJS require calls that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-direct-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects callable createRequire results that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-callable-create-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects aliased createRequire loaders that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-aliased-create-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an aliased CommonJS loader target is dynamic", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "gate-runtime-import-outside-contract",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects hidden Root Quality commands regardless of orchestrator invocation form", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-orchestrator-boundary-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
    const bypasses = [
      'const invoke = run;\ninvoke("pnpm", ["run", "check"], { cwd: "." });\n',
      'options.run("pnpm", ["install"], { cwd: "." });\n',
      'execa("pnpm", ["run", "fix"], { cwd: "." });\n',
      'const invoke = (command, args) => processRunner(command, args);\ninvoke("pnpm", ["run", "check"]);\n',
      'const args = ["run", "check"];\nrun("pnpm", args, { cwd: "." });\n',
      'run("p" + "npm", ["r" + "un", `ch${"eck"}`], { cwd: "." });\n',
    ] as const;
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      for (const source of bypasses) {
        await writeFile(orchestrator, source);
        await expect(
          findFixtureEvidenceArchitectureFindings(root),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ rule: "hidden-root-quality-command" }),
          ]),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an orchestrator executor receives dynamic gate arguments", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "unassigned-orchestrator-command",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for dynamically computed gate arguments through a runner alias", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-aliased-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "unassigned-orchestrator-command",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an ordinary orchestrator function forwards dynamic commands", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-forwarded-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "unassigned-orchestrator-command",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dependency installation contracts owned by the scenario orchestrator", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-orchestrator-install-contract-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "orchestrator-dependency-install-contract",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows command-runner adapters and ignores unrelated command-like values", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-command-false-positive-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
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

      await expect(
        findFixtureEvidenceArchitectureFindings(root),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
