import { parseDocument, isScalar, visit } from "yaml";

import type { GeneratedScenarioReceipt } from "./generated-content.ts";

type WorkflowOracle = {
  readonly deployment: boolean;
  readonly checkWorkflowJob: {
    readonly name: string;
    readonly timeoutMinutes: number;
  };
  readonly diagnosticOwnerPaths: Readonly<
    Record<"playwright" | "vitest-browser", readonly string[]>
  >;
};

function ownerFacts(receipt: GeneratedScenarioReceipt) {
  return receipt.result.projection.ownerFacts;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value)
    .filter((key) => key !== "name" || !expectedKeys.includes("name"))
    .toSorted();
  const expected = [...expectedKeys]
    .filter((key) => key !== "name" || !expectedKeys.includes("name"))
    .toSorted();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function workflowOracle(receipt: GeneratedScenarioReceipt): WorkflowOracle {
  const packagePaths = new Set(
    receipt.result.blueprint.packages.map((definition) => definition.path),
  );
  const diagnosticOwnerPaths = {
    playwright: new Set<string>(),
    "vitest-browser": new Set<string>(),
  };
  for (const declaration of ownerFacts(receipt).diagnosticArtifacts) {
    if (
      typeof declaration !== "object" ||
      declaration === null ||
      Array.isArray(declaration) ||
      !hasExactKeys(declaration, ["kind", "owner"])
    ) {
      throw new Error(
        "CI Diagnostic Artifact declarations may contain only kind and owner",
      );
    }
    const owner = (declaration as { readonly owner?: unknown }).owner;
    if (
      (declaration.kind !== "playwright" &&
        declaration.kind !== "vitest-browser") ||
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
    const workspaceOwner =
      ownerPath.kind === "workspace-orchestration" && ownerPath.path === ".";
    const packageOwner =
      ownerPath.kind === "package-boundary" &&
      typeof ownerPath.path === "string" &&
      /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u.test(ownerPath.path) &&
      ![
        ".git",
        ".github",
        ".devcontainer",
        ".template",
        "node_modules",
        "dist",
        "target",
      ].includes(ownerPath.path.split("/", 1)[0]!);
    if (!workspaceOwner && !packageOwner) {
      throw new Error(
        "CI Diagnostic Artifact owner has an unsafe Package Boundary path",
      );
    }
    if (packageOwner && !packagePaths.has(ownerPath.path)) {
      throw new Error(
        `CI Diagnostic Artifact owner is not a declared Package Boundary: ${ownerPath.path}`,
      );
    }
    diagnosticOwnerPaths[declaration.kind].add(ownerPath.path);
  }

  const deployment = ownerFacts(receipt).environmentNeeds.deployment.some(
    (need) => need.kind === "docker-engine",
  );
  return {
    deployment,
    checkWorkflowJob: ownerFacts(receipt).checkWorkflowJob,
    diagnosticOwnerPaths: {
      playwright: [...diagnosticOwnerPaths.playwright].toSorted(),
      "vitest-browser": [...diagnosticOwnerPaths["vitest-browser"]].toSorted(),
    },
  };
}

export type ParsedWorkflow = {
  readonly name?: unknown;
  readonly on?: unknown;
  readonly permissions?: unknown;
  readonly concurrency?: unknown;
  readonly jobs?: unknown;
};

type ParsedObject = Record<string, unknown>;

type WorkflowActionContract = {
  readonly name: string;
  readonly action: string;
  readonly with?: Readonly<ParsedObject>;
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
      with: { "persist-credentials": false, "fetch-depth": 1 },
    },
    node: {
      name: "Set up Node.js",
      action: "actions/setup-node",
      with: { "node-version-file": "package.json" },
    },
    pnpm: {
      name: "Set up pnpm",
      action: "pnpm/action-setup",
      with: { cache: true },
    },
    buildx: {
      name: "Set up Docker Buildx",
      action: "docker/setup-buildx-action",
    },
    upload: {
      name: "Upload Root Check diagnostics",
      action: "actions/upload-artifact",
    },
  } as Readonly<Record<WorkflowActionKey, WorkflowActionContract>>,
  installStep: {
    name: "Install dependencies",
    command: "pnpm install --frozen-lockfile",
  },
  lightCheckStep: {
    name: "Run Light Check",
    command: "node --conditions=source scripts/task-gates.ts check",
  },
  heavyCheckStep: {
    id: "run-heavy-check",
    name: "Run Heavy Check",
    command: "node --conditions=source scripts/task-gates.ts check:heavy",
  },
} as const;

const rootActionKeys: readonly WorkflowActionKey[] = [
  "checkout",
  "node",
  "pnpm",
];

function matchesAction(value: unknown, action: string): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(`${action}@`) &&
    /^[a-f0-9]{40}$/u.test(value.slice(action.length + 1))
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isParsedObject(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}

function assertActionReferences(source: string): void {
  const document = parseDocument(source);
  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "uses") return;
      const value = pair.value;
      if (
        !isScalar(value) ||
        typeof value.value !== "string" ||
        !/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/u.test(value.value) ||
        !/^\s*v?\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?\s*$/u.test(
          value.comment ?? "",
        )
      ) {
        throw new Error(
          "Action uses requires an immutable full SHA and attached recognizable release comment",
        );
      }
    },
  });
}

function diagnosticStepContracts(
  oracle: WorkflowOracle,
  deployment: boolean,
):
  | {
      readonly stage: ParsedObject;
      readonly upload: ParsedObject;
    }
  | undefined {
  if (
    oracle.diagnosticOwnerPaths.playwright.length === 0 &&
    oracle.diagnosticOwnerPaths["vitest-browser"].length === 0
  ) {
    return undefined;
  }
  const checkName = deployment ? "Check" : "Root Check";
  const condition = "failure()";
  const upload = workflowPolicy.actions.upload;
  return {
    stage: {
      id: "stage-diagnostics",
      name: `Stage ${checkName} diagnostics`,
      if: condition,
      env: {
        PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS:
          oracle.diagnosticOwnerPaths.playwright.join("\n"),
        VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS:
          oracle.diagnosticOwnerPaths["vitest-browser"].join("\n"),
      },
      run: [
        "rm -rf .template-ci-diagnostics",
        "mkdir -p .template-ci-diagnostics",
        "printf '%s\\n' \"$PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS\" | while IFS= read -r owner_path; do",
        '  [ -n "$owner_path" ] || continue',
        "  for diagnostic_directory in test-results playwright-report; do",
        '    source_path="$owner_path/$diagnostic_directory"',
        '    destination_path=".template-ci-diagnostics/$owner_path/$diagnostic_directory"',
        '    if [ -d "$source_path" ]; then',
        '      mkdir -p "$(dirname "$destination_path")"',
        '      cp -R "$source_path" "$destination_path"',
        "    fi",
        "  done",
        "done",
        "printf '%s\\n' \"$VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS\" | while IFS= read -r owner_path; do",
        '  [ -n "$owner_path" ] || continue',
        '  diagnostic_directory=".vitest/attachments/failure-screenshots"',
        '  source_path="$owner_path/$diagnostic_directory"',
        '  destination_path=".template-ci-diagnostics/$owner_path/$diagnostic_directory"',
        '  if [ -d "$source_path" ]; then',
        '    mkdir -p "$(dirname "$destination_path")"',
        '    cp -R "$source_path" "$destination_path"',
        "  fi",
        "done",
        "",
      ].join("\n"),
    },
    upload: {
      id: "upload-diagnostics",
      name: `Upload ${checkName} diagnostics`,
      if: condition,
      uses: upload.action,
      with: {
        name: deployment ? "check-diagnostics" : "root-check-diagnostics",
        path: ".template-ci-diagnostics",
        "include-hidden-files": true,
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    },
  };
}

function assertDiagnosticSteps(
  receipt: GeneratedScenarioReceipt,
  stageStep: unknown,
  uploadStep: unknown,
  oracle: WorkflowOracle,
  deployment: boolean,
): void {
  const contract = diagnosticStepContracts(oracle, deployment);
  if (contract === undefined) return;
  if (
    !isParsedObject(stageStep) ||
    !hasExactKeys(stageStep, ["id", "name", "if", "env", "run"]) ||
    stageStep.id !== contract.stage.id ||
    stageStep.if !== contract.stage.if ||
    stableJson(stageStep.env) !== stableJson(contract.stage.env) ||
    stageStep.run !== contract.stage.run
  ) {
    throw new Error(
      `${receipt.scenario.id}: Check diagnostics must stage only closed native evidence before upload`,
    );
  }
  const withValues = isParsedObject(uploadStep) ? uploadStep.with : undefined;
  if (
    !isParsedObject(uploadStep) ||
    !hasExactKeys(uploadStep, ["id", "name", "if", "uses", "with"]) ||
    uploadStep.id !== contract.upload.id ||
    uploadStep.if !== contract.upload.if ||
    !matchesAction(uploadStep.uses, String(contract.upload.uses)) ||
    !isParsedObject(withValues) ||
    !hasExactKeys(withValues, [
      "name",
      "path",
      "include-hidden-files",
      "if-no-files-found",
      "retention-days",
    ]) ||
    withValues.name !== (contract.upload.with as ParsedObject).name ||
    typeof withValues.path !== "string" ||
    withValues.path !== (contract.upload.with as ParsedObject).path ||
    withValues["include-hidden-files"] !== true ||
    withValues["if-no-files-found"] !== "ignore" ||
    withValues["retention-days"] !== 7
  ) {
    throw new Error(
      `${receipt.scenario.id}: Check diagnostic upload must retain only aggregate native evidence`,
    );
  }
}

function isParsedObject(value: unknown): value is ParsedObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkflowStepName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertGeneratedCheckWorkflowContract(
  receipt: GeneratedScenarioReceipt,
  workflow: ParsedWorkflow,
  oracle: WorkflowOracle,
): void {
  if (
    !isParsedObject(workflow.jobs) ||
    !hasExactKeys(workflow.jobs, ["check"])
  ) {
    throw new Error(
      `${receipt.scenario.id}: Root Check workflow has unexpected jobs`,
    );
  }
  const job = workflow.jobs.check;
  const deployment = oracle.deployment;
  if (
    !isParsedObject(job) ||
    !hasExactKeys(job, ["name", "runs-on", "timeout-minutes", "steps"])
  ) {
    throw new Error(`${receipt.scenario.id}: Check job has unexpected fields`);
  }
  const diagnostic = diagnosticStepContracts(oracle, deployment);
  const diagnosticStart = deployment ? 7 : 6;
  if (
    !Array.isArray(job.steps) ||
    job.steps.length !== diagnosticStart + (diagnostic === undefined ? 0 : 2)
  ) {
    throw new Error(
      `${receipt.scenario.id}: Check has an unexpected step count`,
    );
  }
  if (
    job.name !== oracle.checkWorkflowJob.name ||
    job["runs-on"] !== workflowPolicy.rootJob.runner ||
    job["timeout-minutes"] !== oracle.checkWorkflowJob.timeoutMinutes
  ) {
    throw new Error(`${receipt.scenario.id}: Check job identity is not stable`);
  }
  for (const [index, actionKey] of rootActionKeys.entries()) {
    const contract = workflowPolicy.actions[actionKey];
    const step = job.steps[index];
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, ["name", "uses", "with"]) ||
      !isWorkflowStepName(step.name) ||
      !matchesAction(step.uses, contract.action) ||
      stableJson(step.with) !== stableJson(contract.with)
    ) {
      throw new Error(
        `${receipt.scenario.id}: Check ${contract.name} step diverges from its capability contract`,
      );
    }
  }
  const runSteps = [
    [job.steps[3], workflowPolicy.installStep],
    [job.steps[4], workflowPolicy.lightCheckStep],
  ] as const;
  for (const [step, contract] of runSteps) {
    if (
      !isParsedObject(step) ||
      !hasExactKeys(step, ["name", "run"]) ||
      !isWorkflowStepName(step.name) ||
      step.run !== contract.command
    ) {
      throw new Error(
        `${receipt.scenario.id}: Check ${contract.name} step diverges from its capability contract`,
      );
    }
  }
  let heavyCheckIndex = 5;
  if (deployment) {
    const buildx = job.steps[heavyCheckIndex];
    const contract = workflowPolicy.actions.buildx;
    if (
      !isParsedObject(buildx) ||
      !hasExactKeys(buildx, ["id", "name", "uses"]) ||
      buildx.id !== "prepare-deployment" ||
      !isWorkflowStepName(buildx.name) ||
      !matchesAction(buildx.uses, contract.action)
    ) {
      throw new Error(
        `${receipt.scenario.id}: Check ${contract.name} step diverges from its capability contract`,
      );
    }
    heavyCheckIndex += 1;
  }
  const heavyCheck = job.steps[heavyCheckIndex];
  const heavyContract = workflowPolicy.heavyCheckStep;
  if (
    !isParsedObject(heavyCheck) ||
    !hasExactKeys(heavyCheck, ["id", "name", "run"]) ||
    heavyCheck.id !== heavyContract.id ||
    !isWorkflowStepName(heavyCheck.name) ||
    heavyCheck.run !== heavyContract.command
  ) {
    throw new Error(
      `${receipt.scenario.id}: Check ${heavyContract.name} step diverges from its capability contract`,
    );
  }
  assertDiagnosticSteps(
    receipt,
    job.steps[diagnosticStart],
    job.steps[diagnosticStart + 1],
    oracle,
    deployment,
  );
}

export function assertWorkflowContract(
  receipt: GeneratedScenarioReceipt,
  generatedPath: string,
  source: string,
  workflow: ParsedWorkflow,
): void {
  assertActionReferences(source);
  const oracle = workflowOracle(receipt);
  if (generatedPath !== workflowPolicy.generatedPath) {
    throw new Error(
      `${receipt.scenario.id}: Check workflow has unexpected generated path ${generatedPath}`,
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
      `${receipt.scenario.id}: Check workflow has unexpected top-level execution configuration`,
    );
  }
  const job = isParsedObject(workflow.jobs)
    ? workflow.jobs[workflowPolicy.rootJob.id]
    : undefined;
  if (!isParsedObject(job)) {
    throw new Error(`${receipt.scenario.id}: Root Check job is missing`);
  }
  const steps = job?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${receipt.scenario.id}: Root Check has no steps`);
  }
  if (stableJson(workflow.on) !== stableJson(workflowPolicy.triggers)) {
    throw new Error(
      `${receipt.scenario.id}: unexpected Check workflow triggers`,
    );
  }
  if (
    stableJson(workflow.permissions) !== stableJson(workflowPolicy.permissions)
  ) {
    throw new Error(
      `${receipt.scenario.id}: Check permissions are not contents-read`,
    );
  }
  if (
    stableJson(workflow.concurrency) !== stableJson(workflowPolicy.concurrency)
  ) {
    throw new Error(
      `${receipt.scenario.id}: Check concurrency is not same-ref cancellation`,
    );
  }
  assertGeneratedCheckWorkflowContract(receipt, workflow, oracle);
  if (
    !ownerFacts(receipt).dependencyMaintenance.ecosystems.includes(
      "github-actions",
    )
  ) {
    throw new Error(
      `${receipt.scenario.id}: Check action SHAs are outside the Dependency Maintenance Policy`,
    );
  }
}

type DependencyEcosystem =
  | "npm"
  | "cargo"
  | "github-actions"
  | "docker"
  | "devcontainers"
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
  receipt: GeneratedScenarioReceipt,
): readonly DependabotUpdateOracle[] {
  const policy = ownerFacts(receipt).dependencyMaintenance;
  const ecosystems = [
    ...new Set(["devcontainers" as const, ...policy.ecosystems]),
  ];
  return ecosystems.flatMap((ecosystem) => {
    const declaredDirectories = [
      ...new Set([
        ...(ecosystem === "docker" ? (["/.devcontainer"] as const) : []),
        ...(policy.directories?.[ecosystem] === undefined
          ? []
          : [policy.directories[ecosystem]!]),
        ...(policy.extraDirectories?.[ecosystem] ?? []),
      ]),
    ];
    const directories: readonly `/${string}`[] =
      declaredDirectories.length === 0
        ? [ecosystem === "docker" ? "/.devcontainer" : "/"]
        : declaredDirectories;
    return directories.map((directory): DependabotUpdateOracle => ({
      ecosystem,
      directory,
    }));
  });
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
  receipt: GeneratedScenarioReceipt,
  update: ParsedObject,
  oracle: DependabotUpdateOracle,
): void {
  if (
    !isParsedObject(update.schedule) ||
    update.schedule.interval !== dependabotInterval
  ) {
    throw new Error(
      `${receipt.scenario.id}: ${oracle.ecosystem} ${oracle.directory} must retain a weekly update schedule`,
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
  receipt: GeneratedScenarioReceipt,
  update: ParsedObject,
  oracle: DependabotUpdateOracle,
): void {
  assertWeeklySchedule(receipt, update, oracle);
  if (oracle.ecosystem === "npm") {
    assertExactStringMembers(
      dependabotIgnoreUpdateTypes(update, packageManagerDependency),
      allSemverUpdateTypes,
      `${receipt.scenario.id}: ${packageManagerDependency} ignore update types diverge from policy`,
    );
    return;
  }
  if (oracle.ecosystem === "docker" && oracle.directory === "/.devcontainer") {
    assertExactStringMembers(
      dependabotIgnoreUpdateTypes(update, devcontainerImage),
      [majorUpdateType],
      `${receipt.scenario.id}: ${devcontainerImage} ignore update types diverge from policy`,
    );
  }
}

export function assertDependabotContract(
  receipt: GeneratedScenarioReceipt,
  generatedPath: string,
  parsed: unknown,
): void {
  if (generatedPath !== dependabotGeneratedPath) {
    throw new Error(
      `${receipt.scenario.id}: Dependabot has unexpected generated path ${generatedPath}`,
    );
  }
  if (
    !isParsedObject(parsed) ||
    !hasExactKeys(parsed, ["version", "updates"])
  ) {
    throw new Error(
      `${receipt.scenario.id}: Dependabot must contain only version and updates`,
    );
  }
  if (parsed.version !== 2 || !Array.isArray(parsed.updates)) {
    throw new Error(
      `${receipt.scenario.id}: Dependabot version 2 updates are required`,
    );
  }

  const expectedUpdates = dependabotOracle(receipt);
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
        `${receipt.scenario.id}: Dependabot update ${index + 1} has no valid ecosystem and absolute directory`,
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
        `${receipt.scenario.id}: unexpected ${actual.ecosystem} ${actual.directory} update${expectedSameEcosystem === undefined ? "" : `; expected ${expectedSameEcosystem.ecosystem} ${expectedSameEcosystem.directory} update`}`,
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `${receipt.scenario.id}: duplicate ${oracle.ecosystem} ${oracle.directory} update`,
      );
    }
    seen.add(key);
    assertDependabotUpdateSemantics(receipt, update, oracle);
  }
  const missing = expectedUpdates.find(
    (update) => !seen.has(dependabotUpdateKey(update)),
  );
  if (missing !== undefined) {
    throw new Error(
      `${receipt.scenario.id}: missing ${missing.ecosystem} ${missing.directory} update`,
    );
  }
}

export function policyOracleIdentity(
  kind: "workflow" | "dependabot",
  receipt: GeneratedScenarioReceipt,
): string {
  return stableJson(
    kind === "workflow" ? workflowOracle(receipt) : dependabotOracle(receipt),
  );
}
