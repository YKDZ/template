#!/usr/bin/env node
import path from "node:path";

import {
  checkFixtureEvidenceHealth,
  FileFixtureEvidenceActivityLedger,
  formatFixtureEvidenceHealthReport,
} from "./fixture-evidence/kernel/index.ts";

const environmentNames = {
  evidenceDirectory: "TEMPLATE_FIXTURE_EVIDENCE_DIR",
  activityDirectory: "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
  runId: "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
  runAttempt: "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
} as const;

const fixtureEvidenceScenarioSets = [
  "init",
  "package-addition-matrix",
  "focused",
  "deployment",
] as const;

type FixtureEvidenceScenarioSet = (typeof fixtureEvidenceScenarioSets)[number];

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for Fixture Evidence Health Check`);
  }
  return value;
}

function enabledScenarioSets(
  arguments_: readonly string[],
): readonly FixtureEvidenceScenarioSet[] {
  const configured =
    arguments_.length === 0 ? fixtureEvidenceScenarioSets : arguments_;
  for (const scenarioSet of configured) {
    if (
      !fixtureEvidenceScenarioSets.some(
        (candidate) => candidate === scenarioSet,
      )
    ) {
      throw new Error(
        "Expected enabled scenario set: init, package-addition-matrix, focused, or deployment",
      );
    }
  }
  return [...new Set(configured)] as readonly FixtureEvidenceScenarioSet[];
}

export async function checkConfiguredFixtureEvidenceHealth(
  arguments_: readonly string[],
): Promise<void> {
  const report = await checkFixtureEvidenceHealth({
    ledger: new FileFixtureEvidenceActivityLedger({
      root: path.resolve(
        requiredEnvironment(environmentNames.activityDirectory),
      ),
      evidenceRoot: path.resolve(
        requiredEnvironment(environmentNames.evidenceDirectory),
      ),
    }),
    runId: requiredEnvironment(environmentNames.runId),
    runAttempt: requiredEnvironment(environmentNames.runAttempt),
    enabledScenarioSets: enabledScenarioSets(arguments_),
  });
  for (const line of formatFixtureEvidenceHealthReport(report)) {
    console.info(line);
  }
  if (!report.healthy) {
    throw new Error(
      `Fixture Evidence Health Check failed:\n${report.failures
        .map((failure) => `[${failure.code}] ${failure.detail}`)
        .join("\n")}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkConfiguredFixtureEvidenceHealth(process.argv.slice(2));
}
