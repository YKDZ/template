#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseDocument } from "yaml";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
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

function hasExactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
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
      !hasExactObjectKeys(declaration as Record<string, unknown>, [
        "kind",
        "owner",
      ])
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
      !hasExactObjectKeys(owner as Record<string, unknown>, ["kind", "path"])
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

const rootOnlyStepContracts = [
  {
    name: "Checkout source",
    uses: "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    version: "v5",
    with: { "persist-credentials": false, "fetch-depth": 1 },
  },
  {
    name: "Set up Node.js",
    uses: "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
    version: "v5",
    with: { "node-version-file": "package.json" },
  },
  {
    name: "Set up pnpm",
    uses: "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320",
    version: "v4.4.0",
    with: { cache: true },
  },
] as const;

const actionContracts: ReadonlyMap<
  string,
  { readonly reference: string; readonly version: string }
> = new Map([
  [
    "actions/checkout",
    {
      reference: "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
      version: "v5",
    },
  ],
  [
    "actions/setup-node",
    {
      reference: "a0853c24544627f65ddf259abe73b1d18a591444",
      version: "v5",
    },
  ],
  [
    "pnpm/action-setup",
    {
      reference: "fc06bc1257f339d1d5d8b3a19a8cae5388b55320",
      version: "v4.4.0",
    },
  ],
  [
    "docker/setup-buildx-action",
    {
      reference: "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
      version: "v4.2.0",
    },
  ],
  [
    "actions/upload-artifact",
    {
      reference: "65462800fd760344b1a7b4382951275a0abb4808",
      version: "v4",
    },
  ],
] as const);

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
      name: "Upload Root Check diagnostics",
      if: condition,
      uses: "actions/upload-artifact@65462800fd760344b1a7b4382951275a0abb4808",
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
    !hasPinnedActionReleaseLine(source, String(contract.upload.uses), "v4")
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check diagnostic upload must retain only aggregate native Playwright evidence`,
    );
  }
}

function isParsedObject(value: unknown): value is ParsedObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: ParsedObject,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).toSorted();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys.toSorted()[index])
  );
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
  const actionSteps = job.steps.slice(0, rootOnlyStepContracts.length);
  for (const [index, contract] of rootOnlyStepContracts.entries()) {
    const step = actionSteps[index];
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, ["name", "uses", "with"]) ||
      step.name !== contract.name ||
      step.uses !== contract.uses ||
      JSON.stringify(step.with) !== JSON.stringify(contract.with) ||
      !hasPinnedActionReleaseLine(source, contract.uses, contract.version)
    ) {
      throw new Error(
        `${plan.definitionName}: Root Check ${contract.name} step diverges from its capability contract`,
      );
    }
  }
  const runStepContracts = [
    { name: "Install dependencies", run: "pnpm install --frozen-lockfile" },
    { name: "Run Root Check", run: "pnpm run check" },
  ] as const;
  for (const [index, contract] of runStepContracts.entries()) {
    const step = job.steps[rootOnlyStepContracts.length + index];
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, ["name", "run"]) ||
      step.name !== contract.name ||
      step.run !== contract.run
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
    job["runs-on"] !== "ubuntu-latest" ||
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
  const expectedInclude = [
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
  ];
  if (
    JSON.stringify(job.strategy.matrix.include) !==
    JSON.stringify(expectedInclude)
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
  const actionContracts = [
    ...rootOnlyStepContracts,
    {
      name: "Set up Docker Buildx",
      uses: "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
      version: "v4.2.0",
      if: "matrix.requires_docker",
    },
  ] as const;
  for (const [index, contract] of actionContracts.entries()) {
    const step = steps[index];
    const expectedKeys =
      "if" in contract ? ["name", "uses", "if"] : ["name", "uses", "with"];
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, expectedKeys) ||
      step.name !== contract.name ||
      step.uses !== contract.uses ||
      ("if" in contract
        ? step.if !== contract.if
        : JSON.stringify(step.with) !== JSON.stringify(contract.with)) ||
      !hasPinnedActionReleaseLine(source, contract.uses, contract.version)
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
    install.name !== "Install dependencies" ||
    install.run !== "pnpm install --frozen-lockfile" ||
    !isParsedObject(selectedCheck) ||
    !hasExactKeys(selectedCheck, ["name", "run"]) ||
    selectedCheck.name !== "Run selected Check" ||
    selectedCheck.run !== "${{ matrix.task_entrypoint }}"
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
  if (generatedPath !== ".github/workflows/check.yml") {
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
  const job = isParsedObject(workflow.jobs) ? workflow.jobs.check : undefined;
  if (!isParsedObject(job)) {
    throw new Error(`${plan.definitionName}: Root Check job is missing`);
  }
  const steps = job?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${plan.definitionName}: Root Check has no steps`);
  }
  if (
    workflow.name !== "Check" ||
    JSON.stringify(workflow.on) !==
      JSON.stringify({
        pull_request: null,
        push: { branches: ["main"] },
      })
  ) {
    throw new Error(
      `${plan.definitionName}: unexpected Check workflow triggers`,
    );
  }
  if (
    JSON.stringify(workflow.permissions) !==
    JSON.stringify({ contents: "read" })
  ) {
    throw new Error(
      `${plan.definitionName}: Check permissions are not contents-read`,
    );
  }
  if (
    JSON.stringify(workflow.concurrency) !==
    JSON.stringify({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": true,
    })
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
    job?.name !== "Root Check" ||
    job["runs-on"] !== "ubuntu-latest" ||
    job["timeout-minutes"] !== 30
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check identity is not stable`,
    );
  }

  assertRootOnlyWorkflowContract(plan, source, workflow, oracle);

  const parsedSteps = (steps as unknown[]).map((step) => {
    if (!isParsedObject(step)) {
      throw new Error(
        `${plan.definitionName}: Check workflow step is not a mapping`,
      );
    }
    return step;
  });
  const namedSteps = new Map(parsedSteps.map((step) => [step.name, step]));
  if (
    namedSteps.size !== steps.length ||
    parsedSteps.some(
      (step) => typeof step.name !== "string" || step.name.length === 0,
    )
  ) {
    throw new Error(
      `${plan.definitionName}: every Check workflow step must have a stable display name`,
    );
  }
  const checkout = namedSteps.get("Checkout source");
  const node = namedSteps.get("Set up Node.js");
  const pnpm = namedSteps.get("Set up pnpm");
  const install = namedSteps.get("Install dependencies");
  const rootCheck = namedSteps.get("Run Root Check");
  const actionSteps = parsedSteps.filter(
    (step): step is ParsedObject & { readonly uses: string } =>
      typeof step.uses === "string",
  );
  for (const step of actionSteps) {
    const [action, reference] = step.uses.split("@");
    const contract =
      action === undefined ? undefined : actionContracts.get(action);
    if (
      action === undefined ||
      reference === undefined ||
      contract === undefined ||
      reference !== contract.reference
    ) {
      throw new Error(
        `${plan.definitionName}: Check contains an unsupported or incorrectly pinned external action`,
      );
    }
    if (!hasPinnedActionReleaseLine(source, step.uses, contract.version)) {
      throw new Error(
        `${plan.definitionName}: ${action} must retain its release comment`,
      );
    }
  }
  const rootActionSteps = [checkout, node, pnpm];
  const expectedActions = [
    "actions/checkout",
    "actions/setup-node",
    "pnpm/action-setup",
  ];

  for (const [index, step] of rootActionSteps.entries()) {
    const action = expectedActions[index]!;
    if (
      typeof step?.uses !== "string" ||
      !new RegExp(`^${action}@[0-9a-f]{40}$`, "u").test(step.uses)
    ) {
      throw new Error(`${plan.definitionName}: ${action} must use a full SHA`);
    }
  }

  if (
    JSON.stringify(checkout?.with) !==
      JSON.stringify({ "persist-credentials": false, "fetch-depth": 1 }) ||
    JSON.stringify(node?.with) !==
      JSON.stringify({ "node-version-file": "package.json" }) ||
    JSON.stringify(pnpm?.with) !== JSON.stringify({ cache: true }) ||
    install?.run !== "pnpm install --frozen-lockfile" ||
    rootCheck?.run !== "pnpm run check"
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check environment preparation diverges from its capability plan`,
    );
  }
  const commands = parsedSteps
    .map((step) => step.run)
    .filter((command): command is string => typeof command === "string");
  if (
    commands.some(
      (command) =>
        command !== "pnpm install --frozen-lockfile" &&
        command !== "pnpm run check" &&
        command !== "pnpm run check:deployment" &&
        command !== diagnosticStepContracts(oracle, false)?.stage.run,
    )
  ) {
    throw new Error(
      `${plan.definitionName}: Check workflow duplicates a Task Leaf Command or custom CI protocol`,
    );
  }
  if (!plan.dependencyMaintenancePolicy.ecosystems.includes("github-actions")) {
    throw new Error(
      `${plan.definitionName}: Check action SHAs are outside the Dependency Maintenance Policy`,
    );
  }
}

function expectedDependabotUpdate(
  ecosystem: string,
  directory: string,
): ParsedObject {
  const update: ParsedObject = {
    "package-ecosystem": ecosystem,
    directory,
    schedule: { interval: "weekly" },
  };
  if (ecosystem === "npm") {
    update.groups = {
      drizzle: { patterns: ["drizzle-*", "drizzle-orm"] },
    };
    update.ignore = [
      {
        "dependency-name": "@types/node",
        "update-types": ["version-update:semver-major"],
      },
      {
        "dependency-name": "pnpm",
        "update-types": [
          "version-update:semver-major",
          "version-update:semver-minor",
          "version-update:semver-patch",
        ],
      },
    ];
  }
  if (ecosystem === "docker" && directory === "/.devcontainer") {
    update.ignore = [
      {
        "dependency-name": "mcr.microsoft.com/devcontainers/typescript-node",
        "update-types": ["version-update:semver-major"],
      },
    ];
  }
  return update;
}

function dependabotOracle(
  plan: GeneratedRepositoryPlan,
): readonly ParsedObject[] {
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
    expectedDependabotUpdate("npm", "/"),
    expectedDependabotUpdate("github-actions", "/"),
    expectedDependabotUpdate("docker", "/.devcontainer"),
    ...deploymentDirectories.map((directory) =>
      expectedDependabotUpdate("docker", directory),
    ),
    ...cargoDirectories.map((directory) =>
      expectedDependabotUpdate("cargo", directory),
    ),
    ...(cargoDirectories.length === 0
      ? []
      : [expectedDependabotUpdate("rust-toolchain", "/")]),
  ];
}

export function assertDependabotContract(
  plan: GeneratedRepositoryPlan,
  generatedPath: string,
  parsed: unknown,
): void {
  if (generatedPath !== ".github/dependabot.yml") {
    throw new Error(
      `${plan.definitionName}: Dependabot has unexpected generated path ${generatedPath}`,
    );
  }
  if (
    !isParsedObject(parsed) ||
    !hasExactKeys(parsed, ["version", "updates"]) ||
    parsed.version !== 2 ||
    !Array.isArray(parsed.updates) ||
    JSON.stringify(parsed.updates) !== JSON.stringify(dependabotOracle(plan))
  ) {
    throw new Error(
      `${plan.definitionName}: generated Dependabot configuration diverges from the independent repository policy oracle`,
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
        scope: "github-policy",
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
          context,
          blueprint: initialization.blueprint,
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
            ? ".github/workflows/check.yml"
            : ".github/dependabot.yml";
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
          ".github/workflows/check.yml",
          input.content,
          document.toJS() as ParsedWorkflow,
        );
      } else {
        assertDependabotContract(
          input.plan,
          ".github/dependabot.yml",
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
