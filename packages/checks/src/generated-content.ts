import { readFile } from "node:fs/promises";
import path from "node:path";

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import {
  contentIdentityKey,
  createContentIndex,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import type { ProjectBlueprint } from "@ykdz/template-core/project-blueprint";
import type { GeneratorResult } from "@ykdz/template-generator";
import type {
  DefaultWorkspaceCreationInput,
  DefaultWorkspaceOwnerFacts,
  DefaultWorkspaceInput,
} from "@ykdz/template-workspace/default-workspace-strategy";
import { canLinkNodePackageRoles } from "@ykdz/template-workspace/project-linking";

export type ChecksCreationInput =
  DefaultWorkspaceCreationInput<TsCliCreationInput>;
export type ChecksPreset = Extract<
  (typeof import("@ykdz/template-content").templateContent)[number],
  { readonly kind: "preset" }
>;
export type GeneratedScenario = {
  readonly id: string;
  readonly label: string;
  readonly base: ChecksPreset;
  readonly addition?: ChecksPreset;
  readonly focusedLink?: boolean;
};

export type GeneratedScenarioRuntime = {
  readonly content: typeof import("@ykdz/template-content").templateContent;
  readonly createGenerator: typeof import("@ykdz/template-generator").createGenerator;
  readonly projectPublicationWorkspace?: typeof import("@ykdz/reference-npm-publication/template").projectPublicationWorkspace;
  readonly createDefaultWorkspaceStrategy: typeof import("@ykdz/template-workspace/default-workspace-strategy").createDefaultWorkspaceStrategy;
  readonly resolveTemplateSource: typeof import("@ykdz/template-core/renderer").resolveTemplateSource;
  readonly canConsumeNodePackageNameImportForRole: typeof import("@ykdz/template-workspace/project-linking").canConsumeNodePackageNameImportForRole;
  readonly canProvideSourceConditionPackageNameImportForRole: typeof import("@ykdz/template-workspace/project-linking").canProvideSourceConditionPackageNameImportForRole;
};

type GeneratorSuccess = Extract<
  GeneratorResult<ChecksCreationInput, DefaultWorkspaceOwnerFacts>,
  { readonly status: "success" }
>;

export type SuccessfulScenarioResult = Omit<GeneratorSuccess, "projection"> & {
  readonly projection: NonNullable<GeneratorSuccess["projection"]> & {
    readonly blueprint: ProjectBlueprint;
    readonly ownerFacts: DefaultWorkspaceOwnerFacts;
  };
};

export type GeneratedScenarioReceipt = {
  readonly status: "generated";
  readonly scenario: GeneratedScenario;
  readonly projectDir: string;
  readonly initialization: SuccessfulScenarioResult;
  readonly result: SuccessfulScenarioResult;
  readonly linkFrom: readonly string[];
};

function scenarioId(
  kind: string,
  ...identities: readonly ContentIdentity[]
): string {
  return [
    kind,
    ...identities.map((identity) =>
      Buffer.from(contentIdentityKey(identity)).toString("base64url"),
    ),
  ].join("--");
}

function presetsIn(runtime: GeneratedScenarioRuntime): readonly ChecksPreset[] {
  return runtime.content.filter(
    (member): member is ChecksPreset =>
      typeof member === "object" &&
      member !== null &&
      "kind" in member &&
      member.kind === "preset",
  );
}

function initializationScenario(base: ChecksPreset): GeneratedScenario {
  const definition = base.definition;
  return {
    id: scenarioId("init", base.identity),
    label: `initialize ${definition.metadata.alias}`,
    base,
  };
}

export function deriveInitializationScenarios(
  runtime: GeneratedScenarioRuntime,
): readonly GeneratedScenario[] {
  return presetsIn(runtime)
    .filter((preset) => preset.definition.operations.includes("init"))
    .map(initializationScenario);
}

export function deriveFixtureMatrix(
  runtime: GeneratedScenarioRuntime,
): readonly GeneratedScenario[] {
  const presets = presetsIn(runtime);
  const initializers = presets.filter((preset) =>
    preset.definition.operations.includes("init"),
  );
  const additions = presets.filter((preset) =>
    preset.definition.operations.includes("add"),
  );
  const multiNodeAddition = additions.find(
    (preset) => Object.keys(preset.definition.nodes).length !== 1,
  );
  if (multiNodeAddition !== undefined) {
    throw new Error(
      `Add operation ${multiNodeAddition.definition.metadata.alias} must declare exactly one node`,
    );
  }
  return initializers.flatMap((base) => [
    initializationScenario(base),
    ...additions.map((addition) => ({
      id: scenarioId("fixture", base.identity, addition.identity),
      label: `initialize ${base.definition.metadata.alias}, then add ${addition.definition.metadata.alias}`,
      base,
      addition,
    })),
  ]);
}

export function deriveFocusedProjectLinkScenarios(
  runtime: GeneratedScenarioRuntime,
): readonly GeneratedScenario[] {
  return deriveFixtureMatrix(runtime).flatMap((scenario) => {
    const addition = scenario.addition;
    if (addition === undefined) return [];
    return [
      {
        ...scenario,
        id: scenarioId(
          "focused-link",
          scenario.base.identity,
          addition.identity,
        ),
        label: `initialize ${scenario.base.definition.metadata.alias}, then add ${addition.definition.metadata.alias} with a focused package link`,
        focusedLink: true,
      },
    ];
  });
}

function requireSuccess(
  result: GeneratorResult<ChecksCreationInput, DefaultWorkspaceOwnerFacts>,
  phase: "initialization" | "addition",
  scenario: GeneratedScenario,
): SuccessfulScenarioResult {
  if (result.status !== "success") {
    throw new Error(
      `${scenario.id}: ${phase} did not succeed: ${JSON.stringify(result)}`,
    );
  }
  if (
    result.projection === null ||
    result.projection.blueprint === undefined ||
    result.projection.ownerFacts === undefined
  ) {
    throw new Error(
      `${scenario.id}: ${phase} omitted default workspace projection facts`,
    );
  }
  return result as SuccessfulScenarioResult;
}

async function focusedConsumerPath(options: {
  readonly projectDir: string;
  readonly blueprint: SuccessfulScenarioResult["blueprint"];
  readonly generationRecord: SuccessfulScenarioResult["generationRecord"];
  readonly providerRole: string;
  readonly canConsumePackageNameImport: GeneratedScenarioRuntime["canConsumeNodePackageNameImportForRole"];
}): Promise<string | undefined> {
  const initializedPaths = new Set(
    options.blueprint.packages.flatMap((definition) => {
      const record = options.generationRecord.packages.find(
        (candidate) =>
          candidate.packageDefinitionId === definition.packageDefinitionId,
      );
      return record?.createdBy === "initialization" ? [definition.path] : [];
    }),
  );
  for (const consumer of options.blueprint.packages) {
    if (!initializedPaths.has(consumer.path)) continue;
    if (!canLinkNodePackageRoles(consumer.role, options.providerRole)) {
      continue;
    }
    const manifest = JSON.parse(
      await readFile(
        path.join(options.projectDir, consumer.path, "package.json"),
        "utf8",
      ),
    ) as Readonly<Record<string, unknown>>;
    if (options.canConsumePackageNameImport(consumer.role, manifest)) {
      return consumer.path;
    }
  }
  return undefined;
}

/** 运行唯一内容集合的真实 init/add，并返回同次正式处理产生的收据。 */
export async function materializeGeneratedScenario(options: {
  readonly runtime: GeneratedScenarioRuntime;
  readonly scenario: GeneratedScenario;
  readonly workspace: string;
  readonly strategyInput?: DefaultWorkspaceInput;
  readonly initializationCreationInput?: ChecksCreationInput;
  readonly additionIdentity?: { readonly name: string; readonly path?: string };
  readonly afterInitialization?: (
    result: SuccessfulScenarioResult,
    projectDir: string,
  ) => Promise<void>;
  readonly cancelSignal?: AbortSignal;
}): Promise<GeneratedScenarioReceipt | { readonly status: "not-applicable" }> {
  const projectDir = path.join(options.workspace, options.scenario.id);
  options.cancelSignal?.throwIfAborted();
  const generator = options.runtime.createGenerator({
    content: options.runtime.content,
    strategy:
      options.runtime.createDefaultWorkspaceStrategy<ChecksCreationInput>(
        options.runtime.projectPublicationWorkspace === undefined
          ? {}
          : { project: options.runtime.projectPublicationWorkspace },
      ),
  });
  const initialization = requireSuccess(
    await generator.init({
      targetRoot: projectDir,
      selection: {
        roots: [
          {
            preset: options.scenario.base.identity,
            ...(options.initializationCreationInput === undefined
              ? {}
              : { creationInput: options.initializationCreationInput }),
          },
        ],
      },
      strategyInput: {
        repositoryName: options.scenario.id,
        defaultPackageScope: "fixture",
        ...options.strategyInput,
      },
    }),
    "initialization",
    options.scenario,
  );
  if (initialization.projection === null) {
    throw new Error(
      `${options.scenario.id}: initialization omitted its projection`,
    );
  }
  await options.afterInitialization?.(initialization, projectDir);
  options.cancelSignal?.throwIfAborted();

  if (options.scenario.addition === undefined) {
    return {
      status: "generated",
      scenario: options.scenario,
      projectDir,
      initialization,
      result: initialization,
      linkFrom: [],
    };
  }

  let linkFrom: readonly string[] = [];
  if (options.scenario.focusedLink === true) {
    const providerNode = Object.values(
      options.scenario.addition.definition.nodes,
    )[0];
    if (providerNode === undefined) {
      throw new Error(
        `${options.scenario.id}: focused provider node is missing`,
      );
    }
    const provider = createContentIndex(options.runtime.content).fromDefinition(
      providerNode.reference,
      "reference",
      { namespace: options.scenario.addition.identity.namespace },
    );
    const consumer = await focusedConsumerPath({
      projectDir,
      blueprint: initialization.blueprint,
      generationRecord: initialization.generationRecord,
      providerRole: provider.definition.role,
      canConsumePackageNameImport:
        options.runtime.canConsumeNodePackageNameImportForRole,
    });
    if (consumer === undefined) return { status: "not-applicable" };
    linkFrom = [consumer];
  }
  const additionResult = await generator.add({
    repositoryRoot: projectDir,
    preset: options.scenario.addition.identity,
    creationInput: {
      leafName:
        options.additionIdentity?.name ??
        `fixture-${options.scenario.addition.definition.metadata.alias}`,
      ...(options.additionIdentity?.path === undefined
        ? {}
        : { packagePath: options.additionIdentity.path }),
      ...(linkFrom.length === 0 ? {} : { linkFrom }),
    },
  });
  if (
    options.scenario.focusedLink === true &&
    additionResult.status === "input-invalid" &&
    additionResult.issues.some((issue) => issue.code === "UNSUPPORTED_LINK")
  ) {
    return { status: "not-applicable" };
  }
  const result = requireSuccess(additionResult, "addition", options.scenario);
  if (result.projection === null) {
    throw new Error(`${options.scenario.id}: addition omitted its projection`);
  }
  return {
    status: "generated",
    scenario: options.scenario,
    projectDir,
    initialization,
    result,
    linkFrom,
  };
}

export async function forEachGeneratedScenario<T>(options: {
  readonly runtime: GeneratedScenarioRuntime;
  readonly scenarios: readonly GeneratedScenario[];
  readonly inspect: (receipt: GeneratedScenarioReceipt) => Promise<T>;
  readonly workspacePrefix?: string;
}): Promise<readonly T[]> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const results: T[] = [];
  for (const scenario of options.scenarios) {
    const workspace = await mkdtemp(
      path.join(
        tmpdir(),
        options.workspacePrefix ?? "template-check-scenario-",
      ),
    );
    try {
      const receipt = await materializeGeneratedScenario({
        runtime: options.runtime,
        scenario,
        workspace,
      });
      if (receipt.status === "not-applicable") continue;
      results.push(await options.inspect(receipt));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  return results;
}
