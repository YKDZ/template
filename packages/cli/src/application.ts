import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  builtInPresetRegistry,
  loadLocalTemplateMetadata,
  prepareGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  templateSources,
} from "#template-builtin-presets";
import { validateProjectBlueprint } from "#template-core/project-blueprint";
import {
  reconcileAndApplyProjectProjections,
  materializeProjectProjection,
  type ProjectProjectionAction,
  type ProjectProjectionConflict,
} from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";
import {
  resolveToolchainVersions,
  type ResolvedToolchainVersions,
  type ToolchainResolutionSource,
} from "#template-core/toolchain-resolution";

export type ConfirmationRequest = {
  readonly message: string;
  readonly prompt: string;
};

export type ApplicationRuntime = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tty: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
  };
  readonly confirmation: {
    confirm(request: ConfirmationRequest): Promise<boolean>;
  };
};

export type InitCommandOptions = {
  readonly dir: string;
  readonly preset: string;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly todo: boolean;
  readonly name?: string;
  readonly path?: string;
  readonly scope?: string;
};

export type AddPackageCommandOptions = {
  readonly preset: string;
  readonly name: string;
  readonly path?: string;
  readonly linkFrom: readonly string[];
  readonly dryRun: boolean;
  readonly json: boolean;
};

export type ApplicationCommandResult = {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

type PackageAdditionCliConflict = Omit<
  ProjectProjectionConflict,
  "before" | "current" | "after"
> & {
  readonly context: {
    readonly before: string;
    readonly current: string;
    readonly after: string;
  };
};

type PackageAdditionCliResult =
  | {
      readonly schemaVersion: 1;
      readonly command: "add package";
      readonly status: "success";
      readonly dryRun: boolean;
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "add package";
      readonly status: "conflict";
      readonly dryRun: boolean;
      readonly actions: readonly [];
      readonly conflicts: readonly PackageAdditionCliConflict[];
    };

export function formatPresetCatalog(): string {
  return [
    "Built-in presets",
    "",
    ...formatRows(
      builtInPresetRegistry
        .all()
        .map((definition) => [
          definition.metadata.name,
          `${definition.metadata.title} - ${definition.metadata.description}`,
        ]),
    ),
  ].join("\n");
}

function toolchainSourceFromEnv(
  env: ApplicationRuntime["env"],
): ToolchainResolutionSource | undefined {
  const source = env.TEMPLATE_TOOLCHAIN_RESOLUTION;
  return source === "online" || source === "bundled-fallback"
    ? source
    : undefined;
}

async function resolveToolchain(
  env: ApplicationRuntime["env"],
): Promise<ResolvedToolchainVersions> {
  return await resolveToolchainVersions({
    source: toolchainSourceFromEnv(env),
    nodeReleaseIndexUrl: env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL,
    pnpmRegistryUrl: env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL,
  });
}

function toolchainReport(toolchain: ResolvedToolchainVersions) {
  return {
    nodeLtsMajor: toolchain.nodeLtsMajor.value,
    packageManagerPin: toolchain.packageManagerPin.value,
    source: toolchain.source,
    diagnostics: toolchain.diagnostics,
  };
}

function formatRows(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => `${label}:`.length));
  return rows.map(
    ([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`,
  );
}

function formatLineSpan(span: {
  readonly startLine: number;
  readonly lineCount: number;
}): string {
  return `line ${span.startLine} (${span.lineCount} line${span.lineCount === 1 ? "" : "s"})`;
}

function packageAdditionConflict(
  conflict: ProjectProjectionConflict,
): PackageAdditionCliConflict {
  const { before, current, after, ...details } = conflict;
  return {
    ...details,
    context: { before, current, after },
  };
}

export function renderPackageAdditionResult(
  result: PackageAdditionCliResult,
  options: AddPackageCommandOptions,
  preset: string,
): string {
  if (result.status === "conflict") {
    return [
      "Package Addition conflict",
      "",
      ...result.conflicts.flatMap((conflict) => [
        `  ${conflict.path} (${conflict.driver})`,
        ...(conflict.location === undefined
          ? []
          : [`    Location: ${conflict.location || "<document root>"}`]),
        ...(conflict.region === undefined
          ? []
          : [
              `    Region: Before ${formatLineSpan(conflict.region.before)}; Current ${formatLineSpan(conflict.region.current)}; After ${formatLineSpan(conflict.region.after)}`,
            ]),
        ...(conflict.attribute === undefined
          ? []
          : [`    Attribute: ${conflict.attribute}`]),
        `    Reason: ${conflict.reason}`,
        `    Before: ${conflict.context.before}`,
        `    Current: ${conflict.context.current}`,
        `    After: ${conflict.context.after}`,
      ]),
    ].join("\n");
  }
  return [
    result.dryRun ? "Package Addition preview" : "Added package",
    "",
    ...formatRows([
      ["Preset", preset],
      ["Name", options.name],
    ]),
    "",
    ...(result.actions.length === 0
      ? ["No changes"]
      : result.actions.map(
          (action) => `  ${action.action} ${action.path} (${action.driver})`,
        )),
  ].join("\n");
}

export async function validateBlueprintFile(
  filePath: string,
  runtime: ApplicationRuntime,
): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(path.resolve(runtime.cwd, filePath), "utf8"),
  );
  const result = validateProjectBlueprint(value);
  if (!result.ok) {
    throw new Error(
      result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n"),
    );
  }
  return "Blueprint is valid";
}

export async function runInit(
  options: InitCommandOptions,
  runtime: ApplicationRuntime,
): Promise<string> {
  const definition = builtInPresetRegistry.require(options.preset);
  const toolchain = await resolveToolchain(runtime.env);
  const preparation = prepareGeneratedRepositoryInitialization({
    definition,
    targetDir: path.resolve(runtime.cwd, options.dir),
    toolchain: {
      nodeLtsMajor: toolchain.nodeLtsMajor.value,
      packageManagerPin: toolchain.packageManagerPin.value,
    },
    ...((options.name ?? options.path ?? options.scope) === undefined
      ? {}
      : {
          overrides: {
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.path === undefined ? {} : { path: options.path }),
            ...(options.scope === undefined ? {} : { scope: options.scope }),
          },
        }),
  });
  const { plan, resolved, publicationSetup } = preparation;
  const resolvedPackageRows: readonly (readonly [string, string])[] = [
    ["Name", resolved.packages.map(({ name }) => name).join(", ")],
    [
      "Path",
      resolved.packages.map(({ path: packagePath }) => packagePath).join(", "),
    ],
  ];
  const operations = [
    ...plan.operations,
    ...(options.todo
      ? [
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.foundation,
            from: "TODO.md.template",
            to: "TODO.md",
            replacements: {
              NEXT_STEPS: plan.nextStepInstructions
                .map(
                  (instruction, index) =>
                    `${index + 1}. \`${instruction.display}\``,
                )
                .join("\n"),
            },
          },
        ]
      : []),
  ];
  await materializeProjectProjection({
    operations,
    reconciliation: plan.reconciliation,
  });
  const output = {
    command: "init",
    dryRun: options.dryRun,
    targetDir: options.dir,
    resolved,
    blueprint: plan.blueprint,
    generationRecord: plan.generationRecord,
    toolchain: toolchainReport(toolchain),
    nextSteps: plan.nextStepInstructions,
    publicationSetup,
    followUpDocument: {
      enabled: options.todo,
      path: options.todo ? "TODO.md" : undefined,
    },
  };
  if (options.dryRun) return JSON.stringify(output, null, 2);

  if (
    !options.yes &&
    (options.json || !runtime.tty.stdin || !runtime.tty.stdout)
  ) {
    throw new Error("Non-interactive init requires --yes");
  }
  if (
    !options.yes &&
    !(await runtime.confirmation.confirm({
      message: [
        "Planned project",
        "",
        ...formatRows([
          ["Preset", resolved.preset],
          ...resolvedPackageRows,
          ["Scope", resolved.scope],
          ["Target", options.dir],
          ["Packages", String(plan.blueprint.packages.length)],
        ]),
      ].join("\n"),
      prompt: "Generate this project? [y/N] ",
    }))
  ) {
    throw new Error("Init cancelled");
  }

  await renderNewProject({
    targetRoot: path.resolve(runtime.cwd, options.dir),
    operations,
  });
  if (options.json) return JSON.stringify(output, null, 2);
  return [
    "Initialized project",
    "",
    ...formatRows([
      ["Preset", resolved.preset],
      ...resolvedPackageRows,
      ["Scope", resolved.scope],
      ["Target", options.dir],
    ]),
    "",
    "Next steps",
    "",
    ...plan.nextStepInstructions.map(
      (instruction, index) => `  ${index + 1}. ${instruction.display}`,
    ),
    ...(publicationSetup === null
      ? []
      : [
          "",
          "One-time npm publication setup",
          "",
          `  ${publicationSetup.command}`,
        ]),
  ].join("\n");
}

export async function runAddPackage(
  options: AddPackageCommandOptions,
  runtime: ApplicationRuntime,
): Promise<ApplicationCommandResult> {
  const localTemplateMetadata = loadLocalTemplateMetadata(runtime.cwd);
  const definition = builtInPresetRegistry.require(options.preset);
  const plan = planGeneratedRepositoryPackageAddition({
    definition,
    localTemplateMetadata,
    packageLeafName: options.name,
    ...(options.path ? { packagePath: options.path } : {}),
    ...(options.linkFrom.length > 0 ? { linkFrom: options.linkFrom } : {}),
  });
  const reconciliation = await reconcileAndApplyProjectProjections({
    targetRoot: runtime.cwd,
    ...plan.projectProjections,
    dryRun: options.dryRun,
  });
  if (!reconciliation.ok) {
    const output: PackageAdditionCliResult = {
      schemaVersion: 1,
      command: "add package",
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: reconciliation.conflicts.map(packageAdditionConflict),
    };
    return options.json
      ? { exitCode: 1, stdout: JSON.stringify(output, null, 2) }
      : {
          exitCode: 1,
          stderr: renderPackageAdditionResult(output, options, options.preset),
        };
  }
  const output: PackageAdditionCliResult = {
    schemaVersion: 1,
    command: "add package",
    status: "success",
    dryRun: options.dryRun,
    actions: reconciliation.actions,
  };
  return {
    exitCode: 0,
    stdout: options.json
      ? JSON.stringify(output, null, 2)
      : renderPackageAdditionResult(output, options, definition.metadata.name),
  };
}
