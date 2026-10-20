#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

import {
  deriveFixtureMatrix,
  forEachGeneratedScenario,
} from "../src/generated-content.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";
import {
  assertPublicationWorkflowContract,
  assertWorkflowContract,
  assertDependabotContract,
  policyOracleIdentity,
  type ParsedWorkflow,
} from "../src/workflow-contract.ts";

export { assertPublicationWorkflowContract } from "../src/workflow-contract.ts";

const publicationWorkflowPath = ".github/workflows/release.yml";
const dependabotGeneratedPath = ".github/dependabot.yml";
const workflowGeneratedPath = ".github/workflows/check.yml";

type PolicyOrigin = {
  readonly scenario: string;
  readonly generationPath: "initialization" | "package-addition";
  readonly generatedPath: string;
};

type PolicySummary = {
  readonly kind: "workflow" | "dependabot";
  readonly content: string;
  readonly oracleIdentity: string;
  readonly origins: readonly PolicyOrigin[];
};

async function checkedPolicySummaries(): Promise<readonly PolicySummary[]> {
  const byIdentity = new Map<string, PolicySummary>();
  const summaries = await forEachGeneratedScenario({
    runtime: sourceGeneratedScenarioRuntime,
    scenarios: deriveFixtureMatrix(sourceGeneratedScenarioRuntime),
    inspect: async (receipt) => {
      const generationPath =
        receipt.scenario.addition === undefined
          ? ("initialization" as const)
          : ("package-addition" as const);
      const current: PolicySummary[] = [];
      for (const kind of ["workflow", "dependabot"] as const) {
        const generatedPath =
          kind === "workflow" ? workflowGeneratedPath : dependabotGeneratedPath;
        const content = await readFile(
          `${receipt.projectDir}/${generatedPath}`,
          "utf8",
        );
        const document = parseDocument(content);
        if (document.errors.length > 0 || document.warnings.length > 0) {
          throw new Error(
            `${receipt.scenario.id}: invalid generated ${kind} YAML: ${[...document.errors, ...document.warnings].map((error) => error.message).join("; ")}`,
          );
        }
        if (kind === "workflow") {
          assertWorkflowContract(
            receipt,
            workflowGeneratedPath,
            content,
            document.toJS() as ParsedWorkflow,
          );
        } else {
          assertDependabotContract(
            receipt,
            dependabotGeneratedPath,
            document.toJS(),
          );
        }
        const hasPublicationCandidate =
          receipt.result.projection.ownerFacts.publication.candidate !== null;
        const releasePath = `${receipt.projectDir}/${publicationWorkflowPath}`;
        const releaseExists = existsSync(releasePath);
        if (releaseExists !== hasPublicationCandidate) {
          throw new Error(
            `${receipt.scenario.id}: publication workflow projection does not match the public CLI candidate capability`,
          );
        }
        if (releaseExists) {
          const releaseContent = await readFile(releasePath, "utf8");
          const release = parseDocument(releaseContent);
          if (release.errors.length > 0 || release.warnings.length > 0) {
            throw new Error(
              `${receipt.scenario.id}: invalid publication YAML: ${[...release.errors, ...release.warnings].map((error) => error.message).join("; ")}`,
            );
          }
          assertPublicationWorkflowContract(
            receipt,
            releaseContent,
            release.toJS() as ParsedWorkflow,
          );
        }

        const oracleIdentity = policyOracleIdentity(kind, receipt);
        const origin: PolicyOrigin = {
          scenario: receipt.scenario.id,
          generationPath,
          generatedPath,
        };
        const identity = `${kind}\u0000${content}`;
        const existing = byIdentity.get(identity);
        if (existing === undefined) {
          const summary = {
            kind,
            content,
            oracleIdentity,
            origins: [origin],
          } satisfies PolicySummary;
          byIdentity.set(identity, summary);
          current.push(summary);
        } else {
          if (existing.oracleIdentity !== oracleIdentity) {
            throw new Error(
              `Identical ${kind} final content was reached from incompatible owner facts: ${JSON.stringify([...existing.origins, origin])}`,
            );
          }
          const summary = {
            ...existing,
            origins: [...existing.origins, origin],
          };
          byIdentity.set(identity, summary);
        }
      }
      return current;
    },
    workspacePrefix: "template-github-policy-",
  });
  void summaries;
  return [...byIdentity.values()];
}

export async function checkBuiltInPresetGithubYaml(): Promise<void> {
  await checkedPolicySummaries();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInPresetGithubYaml();
}
