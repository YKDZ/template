#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  resolveBuiltInTemplateSource,
  type GeneratedRepositoryPlan,
} from "#template-builtin-presets";
import {
  projectCheckWorkflowPlan,
  projectCheckWorkflowTemplateReplacements,
  projectDependabotConfig,
} from "#template-core/project-github";

type GithubTemplateKind = "workflow" | "dependabot";
type SourceBackedOperation = Extract<
  GeneratedRepositoryPlan["operations"][number],
  { kind: "copyFile" | "writeTextTemplate" }
>;

function isGithubTemplateOperation(
  operation: GeneratedRepositoryPlan["operations"][number],
  generatedPath: string,
): operation is SourceBackedOperation {
  return (
    (operation.kind === "copyFile" || operation.kind === "writeTextTemplate") &&
    operation.to === generatedPath
  );
}

export function sourceForGithubTemplate(
  plan: GeneratedRepositoryPlan,
  kind: GithubTemplateKind,
): {
  readonly filePath: string;
  readonly replacements: Record<string, string>;
} {
  const generatedPath =
    kind === "workflow"
      ? ".github/workflows/check.yml"
      : ".github/dependabot.yml";
  const operations = plan.operations.filter(
    (candidate) => "to" in candidate && candidate.to === generatedPath,
  );

  if (operations.length !== 1) {
    throw new Error(
      `${plan.definitionName}: expected exactly one Foundation-composed ${generatedPath} Template Source, found ${operations.length}`,
    );
  }
  const operation = operations[0]!;
  if (!isGithubTemplateOperation(operation, generatedPath)) {
    throw new Error(
      `${plan.definitionName}: Foundation ${generatedPath} must use a source-backed Template Source operation`,
    );
  }

  return {
    filePath:
      operation.source === undefined
        ? (() => {
            throw new Error(
              `${plan.definitionName}: Foundation ${generatedPath} is missing its owned Template Source handle`,
            );
          })()
        : resolveBuiltInTemplateSource(operation.source, operation.from),
    replacements:
      operation.kind === "writeTextTemplate" ? operation.replacements : {},
  };
}

export function renderTemplate(
  source: string,
  replacements: Record<string, string>,
): string {
  const occurrences = new Map<string, number>();
  const rendered = source.replaceAll(
    /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (_placeholder, name: string) => {
      const count = occurrences.get(name) ?? 0;
      occurrences.set(name, count + 1);
      const replacement = replacements[name];
      if (replacement === undefined) return _placeholder;
      return replacement;
    },
  );

  for (const name of Object.keys(replacements)) {
    const count = occurrences.get(name) ?? 0;
    if (count === 0) {
      throw new Error(`Missing Template Source placeholder: ${name}`);
    }
    if (count !== 1) {
      throw new Error(
        `Template Source placeholder ${name} must occur exactly once`,
      );
    }
  }

  for (const name of occurrences.keys()) {
    if (!Object.hasOwn(replacements, name)) {
      throw new Error(`Unexpected Template Source placeholder: ${name}`);
    }
  }

  return rendered;
}

function projectWorkflowPlan(plan: GeneratedRepositoryPlan) {
  return projectCheckWorkflowPlan({
    packagePaths: plan.blueprint.packages.map((definition) => definition.path),
    deploymentEnvironmentNeeds: [...plan.deploymentEnvironmentNeeds],
    diagnosticArtifacts: [...plan.ciDiagnosticArtifacts],
    hasDeploymentTask: plan.manifests.some((manifest) => {
      const scripts = manifest.scripts;
      return (
        typeof scripts === "object" &&
        scripts !== null &&
        typeof (scripts as Record<string, unknown>).deployment === "string"
      );
    }),
  });
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
      reference: "8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      version: "v3",
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
  expected: ReturnType<typeof projectWorkflowPlan>,
  deploymentMatrix: boolean,
):
  | {
      readonly stage: ParsedObject;
      readonly upload: ParsedObject;
    }
  | undefined {
  if (expected.diagnosticArtifacts.length === 0) return undefined;
  const condition = deploymentMatrix
    ? "failure() && matrix.capability == 'root'"
    : "failure()";
  const replacements = projectCheckWorkflowTemplateReplacements({
    packagePaths: expected.packagePaths,
    diagnosticArtifacts: expected.diagnosticArtifacts,
  });
  const ownerPaths = replacements.DIAGNOSTIC_OWNER_PATHS;
  if (ownerPaths === undefined) {
    throw new Error(
      "Diagnostic workflow is missing its validated native owner facts",
    );
  }
  return {
    stage: {
      name: "Stage Root Check diagnostics",
      if: condition,
      env: {
        DIAGNOSTIC_OWNER_PATHS: ownerPaths.replaceAll(/^ {12}/gmu, ""),
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
  expected: ReturnType<typeof projectWorkflowPlan>,
  deploymentMatrix: boolean,
): void {
  const contract = diagnosticStepContracts(expected, deploymentMatrix);
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
  expected: ReturnType<typeof projectWorkflowPlan>,
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
  const diagnostic = diagnosticStepContracts(expected, false);
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
    { name: "Install dependencies", run: expected.taskLayer.installCommand },
    { name: "Run Root Check", run: expected.taskLayer.checkCommand },
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
    expected,
    false,
  );
}

function assertDeploymentWorkflowContract(
  plan: GeneratedRepositoryPlan,
  source: string,
  workflow: ParsedWorkflow,
  expected: ReturnType<typeof projectWorkflowPlan>,
): void {
  if (
    expected.matrix === undefined ||
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
    job["runs-on"] !== expected.rootCheck.runner ||
    job["timeout-minutes"] !== "${{ matrix.timeout_minutes }}"
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix job must retain independent names, timeouts, and no dependencies`,
    );
  }
  if (
    !isParsedObject(job.strategy) ||
    !hasExactKeys(job.strategy, ["fail-fast", "matrix"]) ||
    job.strategy["fail-fast"] !== expected.matrix.failFast ||
    !isParsedObject(job.strategy.matrix) ||
    !hasExactKeys(job.strategy.matrix, ["include"]) ||
    !Array.isArray(job.strategy.matrix.include)
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix must use explicit non-fail-fast include entries`,
    );
  }
  const expectedInclude = expected.matrix.include.map((entry) => ({
    capability: entry.capability,
    job_name: entry.jobDisplayName,
    task_entrypoint: entry.taskEntrypoint,
    timeout_minutes: entry.timeoutMinutes,
    requires_docker: entry.requiresDocker,
  }));
  if (
    JSON.stringify(job.strategy.matrix.include) !==
    JSON.stringify(expectedInclude)
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix include entries diverge from its capability plan`,
    );
  }
  const diagnostic = diagnosticStepContracts(expected, true);
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
      uses: "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      version: "v3",
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
    install.run !== expected.taskLayer.installCommand ||
    !isParsedObject(selectedCheck) ||
    !hasExactKeys(selectedCheck, ["name", "run"]) ||
    selectedCheck.name !== "Run selected Check" ||
    selectedCheck.run !== "${{ matrix.task_entrypoint }}"
  ) {
    throw new Error(
      `${plan.definitionName}: Deployment matrix must install and invoke its selected task in each leg`,
    );
  }
  assertDiagnosticSteps(plan, source, steps[6], steps[7], expected, true);
}

export function assertWorkflowContract(
  plan: GeneratedRepositoryPlan,
  sourcePath: string,
  source: string,
  workflow: ParsedWorkflow,
): void {
  const expected = projectWorkflowPlan(plan);
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
    workflow.name !== expected.workflowName ||
    JSON.stringify(workflow.on) !==
      JSON.stringify({
        pull_request: null,
        push: { branches: expected.triggers.pushBranches },
      })
  ) {
    throw new Error(
      `${plan.definitionName}: unexpected Check workflow triggers`,
    );
  }
  if (
    JSON.stringify(workflow.permissions) !==
    JSON.stringify(expected.permissions)
  ) {
    throw new Error(
      `${plan.definitionName}: Check permissions are not contents-read`,
    );
  }
  if (
    JSON.stringify(workflow.concurrency) !==
    JSON.stringify({
      group: expected.concurrency.group,
      "cancel-in-progress": expected.concurrency.cancelInProgress,
    })
  ) {
    throw new Error(
      `${plan.definitionName}: Check concurrency is not same-ref cancellation`,
    );
  }
  if (expected.matrix !== undefined) {
    assertDeploymentWorkflowContract(plan, source, workflow, expected);
    if (
      !plan.dependencyMaintenancePolicy.ecosystems.includes("github-actions")
    ) {
      throw new Error(
        `${plan.definitionName}: Check action SHAs are outside the Dependency Maintenance Policy`,
      );
    }
    if (!sourcePath.includes("/templates/foundation/.github/workflows/")) {
      throw new Error(
        `${plan.definitionName}: Check workflow is not Foundation Template Source`,
      );
    }
    return;
  }
  if (
    job?.name !== expected.rootCheck.jobDisplayName ||
    job["runs-on"] !== expected.rootCheck.runner ||
    job["timeout-minutes"] !== expected.rootCheck.timeoutMinutes
  ) {
    throw new Error(
      `${plan.definitionName}: Root Check identity is not stable`,
    );
  }

  const hasDeploymentTask = plan.manifests.some((manifest) => {
    const scripts = manifest.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).deployment === "string"
    );
  });
  if (!hasDeploymentTask) {
    assertRootOnlyWorkflowContract(plan, source, workflow, expected);
  }

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
    install?.run !== expected.taskLayer.installCommand ||
    rootCheck?.run !== expected.taskLayer.checkCommand
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
        command !== expected.taskLayer.installCommand &&
        command !== expected.taskLayer.checkCommand &&
        command !== "pnpm run check:deployment" &&
        command !== diagnosticStepContracts(expected, false)?.stage.run,
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
  if (!sourcePath.includes("/templates/foundation/.github/workflows/")) {
    throw new Error(
      `${plan.definitionName}: Check workflow is not Foundation Template Source`,
    );
  }
}

export async function checkBuiltInPresetGithubYaml(): Promise<void> {
  for (const definition of builtInPresetRegistry.all()) {
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", definition.metadata.name),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });

    for (const kind of ["workflow", "dependabot"] as const) {
      const source = sourceForGithubTemplate(plan, kind);
      const rendered = renderTemplate(
        await readFile(source.filePath, "utf8"),
        source.replacements,
      );
      const document = parseDocument(rendered);
      if (document.errors.length > 0 || document.warnings.length > 0) {
        throw new Error(
          `${definition.metadata.name}: invalid ${kind} Template Source ${source.filePath}: ${[...document.errors, ...document.warnings].map((error) => error.message).join("; ")}`,
        );
      }
      if (kind === "workflow") {
        assertWorkflowContract(
          plan,
          source.filePath,
          rendered,
          document.toJS() as ParsedWorkflow,
        );
      } else if (
        rendered !== projectDependabotConfig(plan.dependencyMaintenancePolicy)
      ) {
        throw new Error(
          `${definition.metadata.name}: Dependabot Template Source diverges from its Foundation plan`,
        );
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInPresetGithubYaml();
}
