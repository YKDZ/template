import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  contentIdentityKey,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { JsonValue } from "@ykdz/template-core/json";
import type { PresetSelectionDefinition } from "@ykdz/template-core/reference-package";
import type { DefaultWorkspaceConventions } from "@ykdz/template-workspace/reference-package";

export type ChecksPreset = LoadedContentMember<
  PresetSelectionDefinition<JsonValue> & {
    readonly metadata: {
      readonly alias: string;
      readonly title: string;
      readonly description: string;
    };
  },
  "preset"
>;
export type GeneratedScenario = {
  readonly id: string;
  readonly label: string;
  readonly base: ChecksPreset;
  readonly addition?: ChecksPreset;
  readonly focusedLink?: boolean;
};

export type GeneratedScenarioRuntime = {
  readonly content: readonly (
    | ChecksPreset
    | LoadedContentMember<unknown, "reference">
  )[];
  readonly createDefaultGenerator: typeof import("@ykdz/template-workspace/default-generation").createDefaultGenerator;
};

type DefaultGenerator = ReturnType<
  typeof import("@ykdz/template-workspace/default-generation").createDefaultGenerator<
    typeof import("@ykdz/template-content").templateContent
  >
>;
type DefaultGeneratorResult = Awaited<ReturnType<DefaultGenerator["init"]>>;

export type SuccessfulScenarioResult = Extract<
  DefaultGeneratorResult,
  { readonly status: "success" }
>;

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
  result: DefaultGeneratorResult,
  phase: "initialization" | "addition",
  scenario: GeneratedScenario,
): SuccessfulScenarioResult {
  if (result.status !== "success") {
    throw new Error(
      `${scenario.id}: ${phase} did not succeed: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function focusedConsumerPath(options: {
  readonly generator: ReturnType<
    GeneratedScenarioRuntime["createDefaultGenerator"]
  >;
  readonly projectDir: string;
  readonly blueprint: SuccessfulScenarioResult["blueprint"];
  readonly generationRecord: SuccessfulScenarioResult["generationRecord"];
  readonly repositoryRoot: string;
  readonly additionPreset: ChecksPreset;
  readonly creationInput: Record<string, string | string[]>;
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
    const manifest = JSON.parse(
      await readFile(
        path.join(options.projectDir, consumer.path, "package.json"),
        "utf8",
      ),
    ) as Readonly<Record<string, unknown>>;
    if (manifest.type !== "module") continue;
    const planned = await options.generator.planAdd({
      repositoryRoot: options.repositoryRoot,
      preset: options.additionPreset.identity,
      creationInput: {
        ...options.creationInput,
        linkFrom: [consumer.path],
      },
    });
    if (planned.status === "planned") return consumer.path;
    if (
      planned.status === "operation-failure" &&
      planned.phase === "calculation" &&
      /包连接|Node包名导入|Package Role/u.test(planned.error.message)
    ) {
      continue;
    }
    throw new Error(
      `${options.additionPreset.identity.packageName}: focused link planning failed for ${consumer.path}: ${JSON.stringify(planned)}`,
    );
  }
  return undefined;
}

/** 运行唯一内容集合的真实 init/add，并返回同次正式处理产生的收据。 */
export async function materializeGeneratedScenario(options: {
  readonly runtime: GeneratedScenarioRuntime;
  readonly scenario: GeneratedScenario;
  readonly workspace: string;
  readonly conventions?: Partial<DefaultWorkspaceConventions>;
  readonly initializationCreationInput?: JsonValue;
  readonly additionIdentity?: { readonly name: string; readonly path?: string };
  readonly afterInitialization?: (
    result: SuccessfulScenarioResult,
    projectDir: string,
  ) => Promise<void>;
  readonly cancelSignal?: AbortSignal;
}): Promise<GeneratedScenarioReceipt | { readonly status: "not-applicable" }> {
  const projectDir = path.join(options.workspace, options.scenario.id);
  options.cancelSignal?.throwIfAborted();
  const generator = options.runtime.createDefaultGenerator({
    content: options.runtime.content,
  });
  const initialization = requireSuccess(
    await generator.init({
      targetRoot: projectDir,
      selection: {
        presets: [
          {
            contentIdentity: options.scenario.base.identity,
            ...(options.initializationCreationInput === undefined
              ? {}
              : { creationInput: options.initializationCreationInput }),
          },
        ],
      },
      conventions: {
        repositoryName: `fixture-${options.scenario.id
          .toLowerCase()
          .replace(/[^a-z0-9-]/gu, "-")}`,
        defaultPackageScope: "fixture",
        ...options.conventions,
      },
    }),
    "initialization",
    options.scenario,
  );
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
    const consumer = await focusedConsumerPath({
      generator,
      projectDir,
      blueprint: initialization.blueprint,
      generationRecord: initialization.generationRecord,
      repositoryRoot: projectDir,
      additionPreset: options.scenario.addition,
      creationInput: {
        leafName:
          options.additionIdentity?.name ??
          `fixture-${options.scenario.addition.definition.metadata.alias}`,
        ...(options.additionIdentity?.path === undefined
          ? {}
          : { packagePath: options.additionIdentity.path }),
      },
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
    additionResult.status === "operation-failure" &&
    additionResult.phase === "calculation" &&
    /包连接|Node包名导入|Package Role/u.test(additionResult.error.message)
  ) {
    return { status: "not-applicable" };
  }
  const result = requireSuccess(additionResult, "addition", options.scenario);
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
