#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseDocument } from "yaml";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  type GeneratedRepositoryPlan,
} from "#template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

import { deriveFixtureMatrix } from "./registry-checks.ts";

type WorkflowOracle = {
  readonly deployment: boolean;
  readonly diagnosticOwnerPaths: readonly string[];
};

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...expectedKeys].toSorted();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function workflowOracle(plan: GeneratedRepositoryPlan): WorkflowOracle {
  const packagePaths = new Set(
    plan.blueprint.packages.map((definition) => definition.path),
  );
  const diagnosticOwnerPaths = new Set<string>();
  for (const declaration of plan.ciDiagnosticArtifacts) {
    if (
      typeof declaration !== "object" ||
      declaration === null ||
      Array.isArray(declaration) ||
      !hasExactKeys(declaration as Record<string, unknown>, ["kind", "owner"])
    ) {
      throw new Error(
        "CI Diagnostic Artifact declarations may contain only kind and owner",
      );
    }
    const owner = (declaration as { readonly owner?: unknown }).owner;
    if (
      declaration.kind !== "playwright" ||
      typeof owner !== "object" ||
      owner === null ||
      Array.isArray(owner) ||
      !hasExactKeys(owner as Record<string, unknown>, ["kind", "path"])
    ) {
      throw new Error(
        "CI Diagnostic Artifact requires a Package Boundary owner",
      );
    }
    const ownerPath = owner as {
      readonly kind?: unknown;
      readonly path?: unknown;
    };
    if (
      ownerPath.kind !== "package-boundary" ||
      typeof ownerPath.path !== "string" ||
      !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u.test(ownerPath.path) ||
      [
        ".git",
        ".github",
        ".devcontainer",
        ".template",
        "node_modules",
        "dist",
        "target",
      ].includes(ownerPath.path.split("/", 1)[0]!)
    ) {
      throw new Error(
        "CI Diagnostic Artifact owner has an unsafe Package Boundary path",
      );
    }
    if (!packagePaths.has(ownerPath.path)) {
      throw new Error(
        `CI Diagnostic Artifact owner is not a declared Package Boundary: ${ownerPath.path}`,
      );
    }
    diagnosticOwnerPaths.add(ownerPath.path);
  }

  const deployment = plan.manifests.some((manifest) => {
    const scripts = manifest.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).deployment === "string"
    );
  });
  if (
    deployment &&
    !plan.deploymentEnvironmentNeeds.some(
      (need) => need.kind === "docker-engine",
    )
  ) {
    throw new Error("Deployment Check requires a Docker Environment Need");
  }
  return {
    deployment,
    diagnosticOwnerPaths: [...diagnosticOwnerPaths].toSorted(),
  };
}

type ParsedWorkflow = {
  readonly name?: unknown;
  readonly on?: unknown;
  readonly permissions?: unknown;
  readonly concurrency?: unknown;
  readonly jobs?: unknown;
};

type ParsedObject = Record<string, unknown>;

const publicationWorkflowPath = ".github/workflows/release.yml";

/** Publication is a ts-cli capability, not part of ProjectCheckWorkflowPlan. */
export function assertPublicationWorkflowContract(
  plan: GeneratedRepositoryPlan,
  source: string,
  workflow: ParsedWorkflow,
): void {
  void source;
  const candidate = plan.packageContributions.filter(
    (contribution) =>
      contribution.foundation.npmPublication?.kind === "public-cli-candidate",
  );
  if (candidate.length === 0) {
    failPublicationWorkflow(
      plan,
      "non-candidate preset projected a release workflow",
    );
  }
  if (
    !isParsedObject(workflow) ||
    !hasExactKeys(workflow, [
      "name",
      "on",
      "permissions",
      "concurrency",
      "jobs",
    ]) ||
    workflow.name !== "Publish verified npm artifact" ||
    !isParsedObject(workflow.on) ||
    !hasExactKeys(workflow.on, ["workflow_dispatch"]) ||
    workflow.on.workflow_dispatch !== null ||
    !isParsedObject(workflow.permissions) ||
    !hasExactKeys(workflow.permissions, []) ||
    !isParsedObject(workflow.concurrency) ||
    workflow.concurrency.group !== "npm-publication" ||
    workflow.concurrency["cancel-in-progress"] !== false ||
    workflow.concurrency.queue !== "max" ||
    !isParsedObject(workflow.jobs) ||
    !hasExactKeys(workflow.jobs, ["verify", "publish", "release"])
  ) {
    failPublicationWorkflow(
      plan,
      "manual dispatch, empty permissions, or fixed concurrency diverges",
    );
  }
  const verify = workflow.jobs.verify;
  const publish = workflow.jobs.publish;
  const release = workflow.jobs.release;
  if (
    !isParsedObject(verify) ||
    !isParsedObject(publish) ||
    !isParsedObject(release)
  ) {
    failPublicationWorkflow(
      plan,
      "verify, publish, and release jobs are required",
    );
  }
  assertPublicationJob(plan, verify, {
    keys: ["name", "runs-on", "permissions", "steps"],
    permissions: { contents: "read" },
    needs: undefined,
  });
  assertPublicationJob(plan, publish, {
    keys: ["name", "needs", "runs-on", "permissions", "steps"],
    permissions: { contents: "read", "id-token": "write" },
    needs: "verify",
  });
  assertPublicationJob(plan, release, {
    keys: ["name", "needs", "runs-on", "permissions", "steps"],
    permissions: { contents: "write" },
    needs: "publish",
  });
  assertPublicationVerifySteps(plan, verify.steps);
  assertPublicationPublishSteps(plan, publish.steps);
  assertPublicationReleaseSteps(plan, release.steps);
}

function failPublicationWorkflow(
  plan: GeneratedRepositoryPlan,
  message: string,
): never {
  throw new Error(`${plan.definitionName}: publication workflow ${message}`);
}

function assertPublicationJob(
  plan: GeneratedRepositoryPlan,
  job: ParsedObject,
  expected: {
    readonly keys: readonly string[];
    readonly permissions: Readonly<ParsedObject>;
    readonly needs: string | undefined;
  },
): void {
  if (
    !hasExactKeys(job, expected.keys) ||
    job["runs-on"] !== "ubuntu-latest" ||
    JSON.stringify(job.permissions) !== JSON.stringify(expected.permissions) ||
    job.needs !== expected.needs ||
    !Array.isArray(job.steps)
  ) {
    failPublicationWorkflow(
      plan,
      "job permissions, ordering, or runner diverges",
    );
  }
}

function step(
  plan: GeneratedRepositoryPlan,
  value: unknown,
  name: string,
): ParsedObject {
  if (!isParsedObject(value) || value.name !== name) {
    failPublicationWorkflow(plan, `missing ${name} step`);
  }
  return value;
}

function assertNodeSetup(plan: GeneratedRepositoryPlan, value: unknown): void {
  const value_ = step(plan, value, "Set up Node.js");
  if (
    !hasExactKeys(value_, ["name", "uses", "with"]) ||
    value_.uses !==
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" ||
    !isParsedObject(value_.with) ||
    !hasExactKeys(value_.with, ["node-version-file"]) ||
    value_.with["node-version-file"] !== "package.json"
  )
    failPublicationWorkflow(plan, "Node setup must use package.json only");
}

function assertCheckout(plan: GeneratedRepositoryPlan, value: unknown): void {
  const value_ = step(plan, value, "Checkout source");
  if (
    !hasExactKeys(value_, ["name", "uses", "with"]) ||
    value_.uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !isParsedObject(value_.with) ||
    !hasExactKeys(value_.with, ["ref", "persist-credentials", "fetch-depth"]) ||
    value_.with.ref !== "${{ github.sha }}" ||
    value_.with["persist-credentials"] !== false ||
    value_.with["fetch-depth"] !== 1
  )
    failPublicationWorkflow(
      plan,
      "checkout must be immutable, exact SHA, and credential-free",
    );
}

function assertPublicationVerifySteps(
  plan: GeneratedRepositoryPlan,
  steps: unknown,
): void {
  if (!Array.isArray(steps) || steps.length !== 8) {
    failPublicationWorkflow(
      plan,
      "verify must have the closed eight-step sequence",
    );
  }
  const gate = step(plan, steps[0], "Require the default branch dispatch");
  if (
    !hasExactKeys(gate, ["name", "run", "env"]) ||
    typeof gate.run !== "string" ||
    gate.run !==
      'test "$GITHUB_EVENT_NAME" = workflow_dispatch\ntest "$GITHUB_REF" = "refs/heads/$GITHUB_DEFAULT_BRANCH"\ntest -n "$GITHUB_SHA"\n' ||
    !isParsedObject(gate.env) ||
    !hasExactKeys(gate.env, ["GITHUB_DEFAULT_BRANCH"]) ||
    gate.env.GITHUB_DEFAULT_BRANCH !==
      "${{ github.event.repository.default_branch }}"
  ) {
    failPublicationWorkflow(
      plan,
      "verify must reject a non-default ref before checkout",
    );
  }
  assertCheckout(plan, steps[1]);
  assertNodeSetup(plan, steps[2]);
  const pnpm = step(plan, steps[3], "Set up pnpm");
  const install = step(plan, steps[4], "Install dependencies");
  const staging = step(plan, steps[5], "Create publication staging directory");
  const check = step(plan, steps[6], "Run Root Check once");
  const upload = step(plan, steps[7], "Upload verified npm artifact");
  if (
    !hasExactKeys(pnpm, ["name", "uses", "with"]) ||
    pnpm.uses !==
      "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320" ||
    !isParsedObject(pnpm.with) ||
    !hasExactKeys(pnpm.with, ["cache"]) ||
    pnpm.with.cache !== true ||
    !hasExactKeys(install, ["name", "run"]) ||
    install.run !== "pnpm install --frozen-lockfile" ||
    !hasExactKeys(staging, ["name", "run"]) ||
    staging.run !==
      'mkdir -p "$RUNNER_TEMP/npm-publication-artifact"\ntest -z "$(find "$RUNNER_TEMP/npm-publication-artifact" -mindepth 1 -print -quit)"\n' ||
    !hasExactKeys(check, ["name", "run", "env"]) ||
    check.run !== "pnpm run check" ||
    !isParsedObject(check.env) ||
    !hasExactKeys(check.env, ["PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY"]) ||
    check.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY !==
      "${{ runner.temp }}/npm-publication-artifact" ||
    !hasExactKeys(upload, ["name", "uses", "with"]) ||
    upload.uses !==
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
    !isParsedObject(upload.with) ||
    !hasExactKeys(upload.with, ["name", "path", "if-no-files-found"]) ||
    upload.with.name !== "npm-publication-${{ github.run_id }}" ||
    upload.with.path !==
      "${{ runner.temp }}/npm-publication-artifact/*.tgz\n${{ runner.temp }}/npm-publication-artifact/SHA512SUMS\n${{ runner.temp }}/npm-publication-artifact/verified-publication-artifact.json\n" ||
    upload.with["if-no-files-found"] !== "error"
  )
    failPublicationWorkflow(
      plan,
      "verify must persist and upload the one Root Check artifact",
    );
}

function assertPublicationPublishSteps(
  plan: GeneratedRepositoryPlan,
  steps: unknown,
): void {
  if (!Array.isArray(steps) || steps.length !== 4) {
    failPublicationWorkflow(
      plan,
      "publish must have the closed four-step sequence",
    );
  }
  const checkout = step(plan, steps[0], "Checkout source");
  const download = step(plan, steps[2], "Download verified npm artifact");
  const caller = step(plan, steps[3], "Publish the verified tgz with OIDC");
  if (
    !hasExactKeys(checkout, ["name", "uses", "with"]) ||
    checkout.uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !isParsedObject(checkout.with) ||
    !hasExactKeys(checkout.with, [
      "ref",
      "persist-credentials",
      "fetch-depth",
    ]) ||
    checkout.with.ref !== "${{ github.sha }}" ||
    checkout.with["persist-credentials"] !== false ||
    checkout.with["fetch-depth"] !== 1 ||
    !hasExactKeys(download, ["name", "uses", "with"]) ||
    download.uses !==
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" ||
    !isParsedObject(download.with) ||
    !hasExactKeys(download.with, ["name", "path"]) ||
    download.with.name !== "npm-publication-${{ github.run_id }}" ||
    download.with.path !== "${{ runner.temp }}/npm-publication-download" ||
    !hasExactKeys(caller, ["name", "run", "env"]) ||
    caller.run !==
      "node --conditions=source scripts/npm-publication/publish.ts" ||
    !isParsedObject(caller.env) ||
    !hasExactKeys(caller.env, ["PUBLICATION_ARTIFACT_DIRECTORY"]) ||
    caller.env.PUBLICATION_ARTIFACT_DIRECTORY !==
      "${{ runner.temp }}/npm-publication-download"
  )
    failPublicationWorkflow(
      plan,
      "publish must download the same artifact then invoke the direct caller",
    );
  assertNodeSetup(plan, steps[1]);
}

function assertPublicationReleaseSteps(
  plan: GeneratedRepositoryPlan,
  steps: unknown,
): void {
  if (!Array.isArray(steps) || steps.length !== 4) {
    failPublicationWorkflow(
      plan,
      "release must have the closed four-step sequence",
    );
  }
  const checkout = step(plan, steps[0], "Checkout source");
  const download = step(plan, steps[2], "Download verified npm artifact");
  const caller = step(plan, steps[3], "Create immutable GitHub Release");
  if (
    !hasExactKeys(checkout, ["name", "uses", "with"]) ||
    checkout.uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !isParsedObject(checkout.with) ||
    !hasExactKeys(checkout.with, [
      "ref",
      "persist-credentials",
      "fetch-depth",
    ]) ||
    checkout.with.ref !== "${{ github.sha }}" ||
    checkout.with["persist-credentials"] !== false ||
    checkout.with["fetch-depth"] !== 1 ||
    !hasExactKeys(download, ["name", "uses", "with"]) ||
    download.uses !==
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" ||
    !isParsedObject(download.with) ||
    !hasExactKeys(download.with, ["name", "path"]) ||
    download.with.name !== "npm-publication-${{ github.run_id }}" ||
    download.with.path !== "${{ runner.temp }}/npm-publication-release" ||
    !hasExactKeys(caller, ["name", "run", "env"]) ||
    caller.run !==
      "node --conditions=source scripts/npm-publication/release.ts" ||
    !isParsedObject(caller.env) ||
    !hasExactKeys(caller.env, [
      "PUBLICATION_ARTIFACT_DIRECTORY",
      "GITHUB_DEFAULT_BRANCH",
      "GH_TOKEN",
    ]) ||
    caller.env.PUBLICATION_ARTIFACT_DIRECTORY !==
      "${{ runner.temp }}/npm-publication-release" ||
    caller.env.GITHUB_DEFAULT_BRANCH !==
      "${{ github.event.repository.default_branch }}" ||
    caller.env.GH_TOKEN !== "${{ github.token }}"
  ) {
    failPublicationWorkflow(
      plan,
      "release must consume the same artifact with only its GitHub credential",
    );
  }
  assertNodeSetup(plan, steps[1]);
}

type WorkflowActionContract = {
  readonly name: string;
  readonly action: string;
  readonly reference: string;
  readonly release: string;
  readonly with?: Readonly<ParsedObject>;
  readonly condition?: string;
};

type WorkflowActionKey = "checkout" | "node" | "pnpm" | "buildx" | "upload";

const workflowPolicy = {
  generatedPath: ".github/workflows/check.yml",
  name: "Check",
  triggers: { pull_request: null, push: { branches: ["main"] } },
  permissions: { contents: "read" },
  concurrency: {
    group: "${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true,
  },
  rootJob: {
    id: "check",
    name: "Root Check",
    runner: "ubuntu-latest",
    timeoutMinutes: 30,
  },
  actions: {
    checkout: {
      name: "Checkout source",
      action: "actions/checkout",
      reference: "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
      release: "v5",
      with: { "persist-credentials": false, "fetch-depth": 1 },
    },
    node: {
      name: "Set up Node.js",
      action: "actions/setup-node",
      reference: "a0853c24544627f65ddf259abe73b1d18a591444",
      release: "v5",
      with: { "node-version-file": "package.json" },
    },
    pnpm: {
      name: "Set up pnpm",
      action: "pnpm/action-setup",
      reference: "fc06bc1257f339d1d5d8b3a19a8cae5388b55320",
      release: "v4.4.0",
      with: { cache: true },
    },
    buildx: {
      name: "Set up Docker Buildx",
      action: "docker/setup-buildx-action",
      reference: "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
      release: "v4.2.0",
      condition: "matrix.requires_docker",
    },
    upload: {
      name: "Upload Root Check diagnostics",
      action: "actions/upload-artifact",
      reference: "65462800fd760344b1a7b4382951275a0abb4808",
      release: "v4",
    },
  } as Readonly<Record<WorkflowActionKey, WorkflowActionContract>>,
  installStep: {
    name: "Install dependencies",
    command: "pnpm install --frozen-lockfile",
  },
  rootCheckStep: { name: "Run Root Check", command: "pnpm run check" },
  selectedCheckStep: {
    name: "Run selected Check",
    command: "${{ matrix.task_entrypoint }}",
  },
  deploymentMatrix: [
    {
      capability: "root",
      job_name: "Root Check",
      task_entrypoint: "pnpm run check",
      timeout_minutes: 30,
      requires_docker: false,
    },
    {
      capability: "deployment",
      job_name: "Deployment Check",
      task_entrypoint: "pnpm run check:deployment",
      timeout_minutes: 45,
      requires_docker: true,
    },
  ],
} as const;

const rootActionKeys: readonly WorkflowActionKey[] = [
  "checkout",
  "node",
  "pnpm",
];

function pinnedAction(contract: WorkflowActionContract): string {
  return `${contract.action}@${contract.reference}`;
}

function diagnosticStepContracts(
  oracle: WorkflowOracle,
  deploymentMatrix: boolean,
):
  | {
      readonly stage: ParsedObject;
      readonly upload: ParsedObject;
    }
  | undefined {
  if (oracle.diagnosticOwnerPaths.length === 0) return undefined;
  const condition = deploymentMatrix
    ? "failure() && matrix.capability == 'root'"
    : "failure()";
  const upload = workflowPolicy.actions.upload;
  return {
    stage: {
      name: "Stage Root Check diagnostics",
      if: condition,
      env: {
        DIAGNOSTIC_OWNER_PATHS: oracle.diagnosticOwnerPaths.join("\n"),
      },
      run: [
        "rm -rf .template-ci-diagnostics",
        "mkdir -p .template-ci-diagnostics",
        "printf '%s\\n' \"$DIAGNOSTIC_OWNER_PATHS\" | while IFS= read -r owner_path; do",
        "  for diagnostic_directory in test-results playwright-report; do",
        '    source_path="$owner_path/$diagnostic_directory"',
        '    destination_path=".template-ci-diagnostics/$owner_path/$diagnostic_directory"',
        '    if [ -d "$source_path" ]; then',
        '      mkdir -p "$(dirname "$destination_path")"',
        '      cp -R "$source_path" "$destination_path"',
        "    fi",
        "  done",
        "done",
        "",
      ].join("\n"),
    },
    upload: {
      name: upload.name,
      if: condition,
      uses: pinnedAction(upload),
      with: {
        name: "root-check-diagnostics",
        path: ".template-ci-diagnostics",
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    },
  };
}

function assertDiagnosticSteps(
  plan: GeneratedRepositoryPlan,
  source: string,
  stageStep: unknown,
  uploadStep: unknown,
  oracle: WorkflowOracle,
  deploymentMatrix: boolean,
): void {
  const contract = diagnosticStepContracts(oracle, deploymentMatrix);
  if (contract === undefined) return;
  if (
    !isParsedObject(stageStep) ||
    !hasExactKeys(stageStep, ["name", "if", "env", "run"]) ||
    stageStep.name !== contract.stage.name ||
    stageStep.if !== contract.stage.if ||
    JSON.stringify(stageStep.env) !== JSON.stringify(contract.stage.env) ||
    stageStep.run !== contract.stage.run
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check diagnostics must stage only closed native Playwright evidence before upload`,
    );
  }
  const withValues = isParsedObject(uploadStep) ? uploadStep.with : undefined;
  if (
    !isParsedObject(uploadStep) ||
    !hasExactKeys(uploadStep, ["name", "if", "uses", "with"]) ||
    uploadStep.name !== contract.upload.name ||
    uploadStep.if !== contract.upload.if ||
    uploadStep.uses !== contract.upload.uses ||
    !isParsedObject(withValues) ||
    !hasExactKeys(withValues, [
      "name",
      "path",
      "if-no-files-found",
      "retention-days",
    ]) ||
    withValues.name !== (contract.upload.with as ParsedObject).name ||
    typeof withValues.path !== "string" ||
    withValues.path !== (contract.upload.with as ParsedObject).path ||
    withValues["if-no-files-found"] !== "ignore" ||
    withValues["retention-days"] !== 7 ||
    !hasPinnedActionReleaseLine(
      source,
      String(contract.upload.uses),
      workflowPolicy.actions.upload.release,
    )
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check diagnostic upload must retain only aggregate native Playwright evidence`,
    );
  }
}

function isParsedObject(value: unknown): value is ParsedObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPinnedActionReleaseLine(
  source: string,
  actionReference: string,
  version: string,
): boolean {
  const escapedReference = actionReference.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  return source
    .split("\n")
    .some((line) =>
      new RegExp(
        `^\\s*uses: ${escapedReference} # ${version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`,
        "u",
      ).test(line),
    );
}

function assertRootOnlyWorkflowContract(
  plan: GeneratedRepositoryPlan,
  source: string,
  workflow: ParsedWorkflow,
  oracle: WorkflowOracle,
): void {
  if (
    !isParsedObject(workflow.jobs) ||
    !hasExactKeys(workflow.jobs, ["check"])
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check workflow has unexpected jobs`,
    );
  }
  const job = workflow.jobs.check;
  if (
    !isParsedObject(job) ||
    !hasExactKeys(job, ["name", "runs-on", "timeout-minutes", "steps"])
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check job has unexpected fields or permissions`,
    );
  }
  const diagnostic = diagnosticStepContracts(oracle, false);
  if (
    !Array.isArray(job.steps) ||
    job.steps.length !== 5 + (diagnostic === undefined ? 0 : 2)
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check must have exactly five steps`,
    );
  }
  const actionSteps = job.steps.slice(0, rootActionKeys.length);
  for (const [index, actionKey] of rootActionKeys.entries()) {
    const contract = workflowPolicy.actions[actionKey];
    const step = actionSteps[index];
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, ["name", "uses", "with"]) ||
      step.name !== contract.name ||
      step.uses !== pinnedAction(contract) ||
      JSON.stringify(step.with) !== JSON.stringify(contract.with) ||
      !hasPinnedActionReleaseLine(
        source,
        pinnedAction(contract),
        contract.release,
      )
    ) {
      throw new Error(
        `${plan.definitionName}: Root Check ${contract.name} step diverges from its capability contract`,
      );
    }
  }
  const runStepContracts = [
    workflowPolicy.installStep,
    workflowPolicy.rootCheckStep,
  ] as const;
  for (const [index, contract] of runStepContracts.entries()) {
    const step = job.steps[rootActionKeys.length + index];
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, ["name", "run"]) ||
      step.name !== contract.name ||
      step.run !== contract.command
    ) {
      throw new Error(
        `${plan.definitionName}: Root Check ${contract.name} step diverges from its capability contract`,
      );
    }
  }
  assertDiagnosticSteps(
    plan,
    source,
    job.steps[5],
    job.steps[6],
    oracle,
    false,
  );
}

function assertDeploymentWorkflowContract(
  plan: GeneratedRepositoryPlan,
  source: string,
  workflow: ParsedWorkflow,
  oracle: WorkflowOracle,
): void {
  if (
    !oracle.deployment ||
    !isParsedObject(workflow.jobs) ||
    !hasExactKeys(workflow.jobs, ["check"])
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment Check jobs are invalid`,
    );
  }
  const job = workflow.jobs.check;
  if (
    !isParsedObject(job) ||
    !hasExactKeys(job, [
      "name",
      "runs-on",
      "timeout-minutes",
      "strategy",
      "steps",
    ]) ||
    job.name !== "${{ matrix.job_name }}" ||
    job["runs-on"] !== workflowPolicy.rootJob.runner ||
    job["timeout-minutes"] !== "${{ matrix.timeout_minutes }}"
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix job must retain independent names, timeouts, and no dependencies`,
    );
  }
  if (
    !isParsedObject(job.strategy) ||
    !hasExactKeys(job.strategy, ["fail-fast", "matrix"]) ||
    job.strategy["fail-fast"] !== false ||
    !isParsedObject(job.strategy.matrix) ||
    !hasExactKeys(job.strategy.matrix, ["include"]) ||
    !Array.isArray(job.strategy.matrix.include)
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix must use explicit non-fail-fast include entries`,
    );
  }
  if (
    JSON.stringify(job.strategy.matrix.include) !==
    JSON.stringify(workflowPolicy.deploymentMatrix)
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix include entries diverge from its capability plan`,
    );
  }
  const diagnostic = diagnosticStepContracts(oracle, true);
  if (
    !Array.isArray(job.steps) ||
    job.steps.length !== 6 + (diagnostic === undefined ? 0 : 2)
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix legs must be self-contained`,
    );
  }
  const steps = job.steps;
  const actionKeys: readonly WorkflowActionKey[] = [
    ...rootActionKeys,
    "buildx",
  ];
  for (const [index, actionKey] of actionKeys.entries()) {
    const contract = workflowPolicy.actions[actionKey];
    const step = steps[index];
    const expectedKeys = contract.condition
      ? ["name", "uses", "if"]
      : ["name", "uses", "with"];
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, expectedKeys) ||
      step.name !== contract.name ||
      step.uses !== pinnedAction(contract) ||
      (contract.condition
        ? step.if !== contract.condition
        : JSON.stringify(step.with) !== JSON.stringify(contract.with)) ||
      !hasPinnedActionReleaseLine(
        source,
        pinnedAction(contract),
        contract.release,
      )
    ) {
      throw new Error(
        `${plan.definitionName}: Deployment matrix ${contract.name} step diverges from its capability contract`,
      );
    }
  }
  const install = steps[4];
  const selectedCheck = steps[5];
  if (
    !isParsedObject(install) ||
    !hasExactKeys(install, ["name", "run"]) ||
    install.name !== workflowPolicy.installStep.name ||
    install.run !== workflowPolicy.installStep.command ||
    !isParsedObject(selectedCheck) ||
    !hasExactKeys(selectedCheck, ["name", "run"]) ||
    selectedCheck.name !== workflowPolicy.selectedCheckStep.name ||
    selectedCheck.run !== workflowPolicy.selectedCheckStep.command
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix must install and invoke its selected task in each leg`,
    );
  }
  assertDiagnosticSteps(plan, source, steps[6], steps[7], oracle, true);
}

export function assertWorkflowContract(
  plan: GeneratedRepositoryPlan,
  generatedPath: string,
  source: string,
  workflow: ParsedWorkflow,
): void {
  const oracle = workflowOracle(plan);
  if (generatedPath !== workflowPolicy.generatedPath) {
    throw new Error(
      `${plan.definitionName}: Check workflow has unexpected generated path ${generatedPath}`,
    );
  }
  if (
    !isParsedObject(workflow) ||
    !hasExactKeys(workflow, [
      "name",
      "on",
      "permissions",
      "concurrency",
      "jobs",
    ])
  ) {
    throw new Error(
      `${plan.definitionName}: Check workflow has unexpected top-level execution configuration`,
    );
  }
  const job = isParsedObject(workflow.jobs)
    ? workflow.jobs[workflowPolicy.rootJob.id]
    : undefined;
  if (!isParsedObject(job)) {
    throw new Error(`${plan.definitionName}: Root Check job is missing`);
  }
  const steps = job?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${plan.definitionName}: Root Check has no steps`);
  }
  if (
    workflow.name !== workflowPolicy.name ||
    JSON.stringify(workflow.on) !== JSON.stringify(workflowPolicy.triggers)
  ) {
    throw new Error(
      `${plan.definitionName}: unexpected Check workflow triggers`,
    );
  }
  if (
    JSON.stringify(workflow.permissions) !==
    JSON.stringify(workflowPolicy.permissions)
  ) {
    throw new Error(
      `${plan.definitionName}: Check permissions are not contents-read`,
    );
  }
  if (
    JSON.stringify(workflow.concurrency) !==
    JSON.stringify(workflowPolicy.concurrency)
  ) {
    throw new Error(
      `${plan.definitionName}: Check concurrency is not same-ref cancellation`,
    );
  }
  if (oracle.deployment) {
    assertDeploymentWorkflowContract(plan, source, workflow, oracle);
    if (
      !plan.dependencyMaintenancePolicy.ecosystems.includes("github-actions")
    ) {
      throw new Error(
        `${plan.definitionName}: Check action SHAs are outside the Dependency Maintenance Policy`,
      );
    }
    return;
  }
  if (
    job?.name !== workflowPolicy.rootJob.name ||
    job["runs-on"] !== workflowPolicy.rootJob.runner ||
    job["timeout-minutes"] !== workflowPolicy.rootJob.timeoutMinutes
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check identity is not stable`,
    );
  }

  assertRootOnlyWorkflowContract(plan, source, workflow, oracle);
  if (!plan.dependencyMaintenancePolicy.ecosystems.includes("github-actions")) {
    throw new Error(
      `${plan.definitionName}: Check action SHAs are outside the Dependency Maintenance Policy`,
    );
  }
}

type DependencyEcosystem =
  | "npm"
  | "cargo"
  | "github-actions"
  | "docker"
  | "rust-toolchain";

type DependabotUpdateOracle = {
  readonly ecosystem: DependencyEcosystem;
  readonly directory: `/${string}`;
};

const dependabotGeneratedPath = ".github/dependabot.yml";
const dependabotInterval = "weekly";
const packageManagerDependency = "pnpm";
const devcontainerImage = "mcr.microsoft.com/devcontainers/typescript-node";
const majorUpdateType = "version-update:semver-major";
const allSemverUpdateTypes = [
  majorUpdateType,
  "version-update:semver-minor",
  "version-update:semver-patch",
] as const;

function dependabotUpdateKey(update: DependabotUpdateOracle): string {
  return `${update.ecosystem}\u0000${update.directory}`;
}

function dependabotOracle(
  plan: GeneratedRepositoryPlan,
): readonly DependabotUpdateOracle[] {
  const manifestByName = new Map(
    plan.manifests.flatMap((manifest) =>
      typeof manifest.name === "string" ? [[manifest.name, manifest]] : [],
    ),
  );
  const deploymentDirectories = plan.blueprint.packages.flatMap(
    (definition) => {
      const scripts = manifestByName.get(definition.name)?.scripts;
      return typeof scripts === "object" &&
        scripts !== null &&
        typeof (scripts as Record<string, unknown>).deployment === "string"
        ? [`/${definition.path}`]
        : [];
    },
  );
  const cargoDirectories = plan.blueprint.packages.flatMap((definition) =>
    definition.role === "native-package" ? [`/${definition.path}`] : [],
  );
  return [
    { ecosystem: "npm", directory: "/" },
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "docker", directory: "/.devcontainer" },
    ...deploymentDirectories.map(
      (directory): DependabotUpdateOracle => ({
        ecosystem: "docker",
        directory: directory as `/${string}`,
      }),
    ),
    ...cargoDirectories.map(
      (directory): DependabotUpdateOracle => ({
        ecosystem: "cargo",
        directory: directory as `/${string}`,
      }),
    ),
    ...(cargoDirectories.length === 0
      ? []
      : [{ ecosystem: "rust-toolchain" as const, directory: "/" as const }]),
  ];
}

function assertExactStringMembers(
  actual: unknown,
  expected: readonly string[],
  diagnostic: string,
): void {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== "string") ||
    actual.length !== expected.length ||
    !expected.every((value) => actual.includes(value))
  ) {
    throw new Error(diagnostic);
  }
}

function assertWeeklySchedule(
  plan: GeneratedRepositoryPlan,
  update: ParsedObject,
  oracle: DependabotUpdateOracle,
): void {
  if (
    !isParsedObject(update.schedule) ||
    update.schedule.interval !== dependabotInterval
  ) {
    throw new Error(
      `${plan.definitionName}: ${oracle.ecosystem} ${oracle.directory} must retain a weekly update schedule`,
    );
  }
}

function dependabotIgnoreUpdateTypes(
  update: ParsedObject,
  dependencyName: string,
): unknown {
  if (!Array.isArray(update.ignore)) return undefined;
  const rule = update.ignore.find(
    (candidate) =>
      isParsedObject(candidate) &&
      candidate["dependency-name"] === dependencyName,
  );
  return isParsedObject(rule) ? rule["update-types"] : undefined;
}

function assertDependabotUpdateSemantics(
  plan: GeneratedRepositoryPlan,
  update: ParsedObject,
  oracle: DependabotUpdateOracle,
): void {
  assertWeeklySchedule(plan, update, oracle);
  if (oracle.ecosystem === "npm") {
    assertExactStringMembers(
      dependabotIgnoreUpdateTypes(update, packageManagerDependency),
      allSemverUpdateTypes,
      `${plan.definitionName}: ${packageManagerDependency} ignore update types diverge from policy`,
    );
    return;
  }
  if (oracle.ecosystem === "docker" && oracle.directory === "/.devcontainer") {
    assertExactStringMembers(
      dependabotIgnoreUpdateTypes(update, devcontainerImage),
      [majorUpdateType],
      `${plan.definitionName}: ${devcontainerImage} ignore update types diverge from policy`,
    );
  }
}

export function assertDependabotContract(
  plan: GeneratedRepositoryPlan,
  generatedPath: string,
  parsed: unknown,
): void {
  if (generatedPath !== dependabotGeneratedPath) {
    throw new Error(
      `${plan.definitionName}: Dependabot has unexpected generated path ${generatedPath}`,
    );
  }
  if (
    !isParsedObject(parsed) ||
    !hasExactKeys(parsed, ["version", "updates"])
  ) {
    throw new Error(
      `${plan.definitionName}: Dependabot must contain only version and updates`,
    );
  }
  if (parsed.version !== 2 || !Array.isArray(parsed.updates)) {
    throw new Error(
      `${plan.definitionName}: Dependabot version 2 updates are required`,
    );
  }

  const expectedUpdates = dependabotOracle(plan);
  const expectedByKey = new Map(
    expectedUpdates.map((update) => [dependabotUpdateKey(update), update]),
  );
  const seen = new Set<string>();
  for (const [index, update] of parsed.updates.entries()) {
    if (
      !isParsedObject(update) ||
      typeof update["package-ecosystem"] !== "string" ||
      typeof update.directory !== "string" ||
      !update.directory.startsWith("/")
    ) {
      throw new Error(
        `${plan.definitionName}: Dependabot update ${index + 1} has no valid ecosystem and absolute directory`,
      );
    }
    const actual = {
      ecosystem: update["package-ecosystem"] as DependencyEcosystem,
      directory: update.directory as `/${string}`,
    };
    const key = dependabotUpdateKey(actual);
    const oracle = expectedByKey.get(key);
    if (oracle === undefined) {
      const expectedSameEcosystem = expectedUpdates.find(
        (candidate) => candidate.ecosystem === actual.ecosystem,
      );
      throw new Error(
        `${plan.definitionName}: unexpected ${actual.ecosystem} ${actual.directory} update${expectedSameEcosystem === undefined ? "" : `; expected ${expectedSameEcosystem.ecosystem} ${expectedSameEcosystem.directory} update`}`,
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `${plan.definitionName}: duplicate ${oracle.ecosystem} ${oracle.directory} update`,
      );
    }
    seen.add(key);
    assertDependabotUpdateSemantics(plan, update, oracle);
  }
  const missing = expectedUpdates.find(
    (update) => !seen.has(dependabotUpdateKey(update)),
  );
  if (missing !== undefined) {
    throw new Error(
      `${plan.definitionName}: missing ${missing.ecosystem} ${missing.directory} update`,
    );
  }
}

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

function policyOracleIdentity(
  kind: PolicyInput["kind"],
  plan: GeneratedRepositoryPlan,
): string {
  return JSON.stringify(
    kind === "workflow" ? workflowOracle(plan) : dependabotOracle(plan),
  );
}

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
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
          kind === "workflow"
            ? workflowPolicy.generatedPath
            : dependabotGeneratedPath;
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
          workflowPolicy.generatedPath,
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
