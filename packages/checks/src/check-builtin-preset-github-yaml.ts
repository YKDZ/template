#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { parseDocument } from "yaml";

import { deriveFixtureMatrix } from "./registry-checks.ts";
import {
  assertPublicationWorkflowContract,
  assertWorkflowContract,
  assertDependabotContract,
  policyOracleIdentity,
  type ParsedWorkflow,
} from "./workflow-contract.ts";

export { assertPublicationWorkflowContract } from "./workflow-contract.ts";

const publicationWorkflowPath = ".github/workflows/release.yml";
const dependabotGeneratedPath = ".github/dependabot.yml";
const workflowGeneratedPath = ".github/workflows/check.yml";

type PolicyOrigin = {
  readonly presets: readonly string[];
  readonly generationPath: "initialization" | "package-addition";
  readonly generatedPath: string;
};

type PolicyInput = {
  readonly kind: "workflow" | "dependabot";
  readonly content: string;
  readonly plan: GeneratedRepositoryPlan;
  readonly oracleIdentity: string;
  readonly origins: PolicyOrigin[];
};

async function finalPolicyInputs(): Promise<readonly PolicyInput[]> {
  const byIdentity = new Map<string, PolicyInput>();
  for (const scenario of deriveFixtureMatrix()) {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-github-policy-"),
    );
    const projectDir = path.join(workspace, scenario.id);
    try {
      const context = createGenerationContext({
        targetDir: projectDir,
        defaultPackageScope: "github-policy",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: scenario.base,
        context,
      });
      await renderNewProject({
        targetRoot: projectDir,
        operations: [...initialization.operations],
      });
      let plan: GeneratedRepositoryPlan = initialization;
      if (scenario.addition !== undefined) {
        const addition = planGeneratedRepositoryPackageAddition({
          definition: scenario.addition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: `policy-${scenario.addition.metadata.name}`,
        });
        const result = await reconcileAndApplyProjectProjections({
          targetRoot: projectDir,
          ...addition.projectProjections,
        });
        if (!result.ok) {
          throw new Error(
            `${scenario.id}: GitHub policy projection conflicted: ${JSON.stringify(result.conflicts)}`,
          );
        }
        plan = addition;
      }
      const generationPath =
        scenario.addition === undefined
          ? ("initialization" as const)
          : ("package-addition" as const);
      const presets = [
        scenario.base.metadata.name,
        ...(scenario.addition === undefined
          ? []
          : [scenario.addition.metadata.name]),
      ];
      for (const kind of ["workflow", "dependabot"] as const) {
        const generatedPath =
          kind === "workflow" ? workflowGeneratedPath : dependabotGeneratedPath;
        const content = await readFile(
          path.join(projectDir, generatedPath),
          "utf8",
        );
        const identity = `${kind}\u0000${content}`;
        const oracleIdentity = policyOracleIdentity(kind, plan);
        const origin = { presets, generationPath, generatedPath };
        const existing = byIdentity.get(identity);
        if (existing === undefined) {
          byIdentity.set(identity, {
            kind,
            content,
            plan,
            oracleIdentity,
            origins: [origin],
          });
        } else {
          if (existing.oracleIdentity !== oracleIdentity) {
            throw new Error(
              `Identical ${kind} final content was reached from incompatible policy facts: ${JSON.stringify([...existing.origins, origin])}`,
            );
          }
          existing.origins.push(origin);
        }
      }
      const releasePath = path.join(projectDir, publicationWorkflowPath);
      const releaseExists = existsSync(releasePath);
      const hasPublicationCandidate = plan.packageContributions.some(
        (contribution) =>
          contribution.foundation.npmPublication?.kind ===
          "public-cli-candidate",
      );
      if (releaseExists !== hasPublicationCandidate) {
        throw new Error(
          `${scenario.id}: publication workflow projection does not match the public CLI candidate capability`,
        );
      }
      if (releaseExists) {
        const content = await readFile(releasePath, "utf8");
        const document = parseDocument(content);
        if (document.errors.length > 0 || document.warnings.length > 0) {
          throw new Error(
            `${scenario.id}: invalid publication YAML: ${[...document.errors, ...document.warnings].map((error) => error.message).join("; ")}`,
          );
        }
        assertPublicationWorkflowContract(
          plan,
          content,
          document.toJS() as ParsedWorkflow,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  return [...byIdentity.values()];
}

export async function checkBuiltInPresetGithubYaml(): Promise<void> {
  for (const input of await finalPolicyInputs()) {
    try {
      const document = parseDocument(input.content);
      if (document.errors.length > 0 || document.warnings.length > 0) {
        throw new Error(
          `invalid generated ${input.kind} YAML: ${[...document.errors, ...document.warnings].map((error) => error.message).join("; ")}`,
        );
      }
      if (input.kind === "workflow") {
        assertWorkflowContract(
          input.plan,
          workflowGeneratedPath,
          input.content,
          document.toJS() as ParsedWorkflow,
        );
      } else {
        assertDependabotContract(
          input.plan,
          dependabotGeneratedPath,
          document.toJS(),
        );
      }
    } catch (error) {
      throw new Error(
        `${input.kind} policy failed for ${input.origins.map((origin) => `${origin.presets.join("+")}:${origin.generationPath}:${origin.generatedPath}`).join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInPresetGithubYaml();
}
