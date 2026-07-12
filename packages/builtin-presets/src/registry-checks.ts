import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-core/dependency-catalog";
import type { BuiltInPresetDefinition } from "@ykdz/template-core/preset-definition";
import { projectDependabotConfig } from "@ykdz/template-core/project-github";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  type GeneratedRepositoryPlan,
} from "./foundation.ts";

/** A real registry Definition and optional Package Addition planner scenario. */
export type GeneratedScenario = {
  readonly id: string;
  readonly label: string;
  readonly base: BuiltInPresetDefinition;
  readonly addition?: BuiltInPresetDefinition;
  readonly linkFrom?: readonly string[];
};

function scenarioId(...parts: readonly string[]): string {
  return parts.join("--");
}

/** One production-equivalent initialization per complete registered Definition. */
export function deriveInitializationScenarios(): readonly GeneratedScenario[] {
  return builtInPresetRegistry.all().map((base) => ({
    id: scenarioId("init", base.metadata.name),
    label: `initialize ${base.metadata.name}`,
    base,
  }));
}

/**
 * Every initialization plus every registered Package Addition planner applied
 * to every base Definition. No Preset identity list is maintained here.
 */
export function deriveFixtureMatrix(): readonly GeneratedScenario[] {
  const definitions = builtInPresetRegistry.all();
  const addable = definitions.filter(
    (definition) => definition.planPackageAddition !== undefined,
  );

  return definitions.flatMap((base) => [
    {
      id: scenarioId("fixture", base.metadata.name, "init"),
      label: `initialize ${base.metadata.name}`,
      base,
    },
    ...addable.map((addition) => ({
      id: scenarioId(
        "fixture",
        base.metadata.name,
        "add",
        addition.metadata.name,
      ),
      label: `initialize ${base.metadata.name}, then add ${addition.metadata.name}`,
      base,
      addition,
    })),
  ]);
}

/**
 * Focused link cases use the first real owned Package Boundary from each base
 * Definition; the provider remains an optional Package Addition Definition.
 * There is deliberately no hand-maintained Preset compatibility table.
 */
export function deriveFocusedProjectLinkScenarios(): readonly GeneratedScenario[] {
  const definitions = builtInPresetRegistry.all();
  const addable = definitions.filter(
    (definition) => definition.planPackageAddition !== undefined,
  );
  return definitions.flatMap((base) => {
    // Some Definitions derive their package path from the project name. Plan
    // the consumer using the exact target-directory basename that the focused
    // runner will use, rather than a discovery-only placeholder.
    const scenarioContext = (addition: BuiltInPresetDefinition) => {
      const id = scenarioId(
        "focused-link",
        base.metadata.name,
        addition.metadata.name,
      );
      return {
        id,
        context: createGenerationContext({
          targetDir: path.join("generated-repository", id),
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        }),
      };
    };
    return addable.flatMap((addition) => {
      const { id, context } = scenarioContext(addition);
      const contribution =
        base.planInitializationContributions?.(context)[0] ??
        base.planInitialization(context);
      if (contribution === undefined) return [];
      const packageLeafName = `focused-${addition.metadata.name}`;
      const packagePath = addition.defaultPackagePath?.({
        context,
        packageLeafName,
      });
      if (packagePath === undefined) return [];
      const provider = addition.planPackageAddition?.({
        context,
        packageLeafName,
        packagePath,
      });
      // Boundary policies permit generated packages to import a shared
      // library, not another runtime service. Derive the focused link from
      // the actual addition Contribution instead of Preset identity.
      if (provider?.definition.role !== "shared-library") return [];
      return [
        {
          id,
          label: `link ${contribution.definition.path} to added ${addition.metadata.name}`,
          base,
          addition,
          linkFrom: [contribution.definition.path],
        },
      ];
    });
  });
}

/** Convention-owned location for a Definition's observable behavior contract. */
export function presetLocalBehaviorTestPath(
  definition: BuiltInPresetDefinition,
): string {
  // Template Source is owned at templates/<definition>; its sibling source
  // directory is the convention-bearing Behavior Test location. This remains
  // stable when planners are executed from compiled dist/ output.
  const templateRoot = resolveBuiltInTemplateSource(definition.source, ".");
  return path.resolve(
    templateRoot,
    "..",
    "..",
    "src",
    path.basename(templateRoot),
    "behavior.test.ts",
  );
}

export type PresetLocalBehaviorTest = {
  readonly definition: BuiltInPresetDefinition;
  readonly filePath: string;
};

/** Discovers the behavior contract colocated with every registry Definition. */
export async function discoverPresetLocalBehaviorTests(): Promise<
  readonly PresetLocalBehaviorTest[]
> {
  return await Promise.all(
    builtInPresetRegistry.all().map(async (definition) => {
      const filePath = presetLocalBehaviorTestPath(definition);
      try {
        const details = await stat(filePath);
        if (!details.isFile()) {
          throw new Error("path is not a file");
        }
      } catch (error) {
        throw new Error(
          `${definition.metadata.name}: missing Preset-Local Behavior Test at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { definition, filePath };
    }),
  );
}

type SourceBackedOperation = Extract<
  RenderOperation,
  { kind: "copyFile" | "writeTextTemplate" | "writeTextFromFragments" }
>;

export type PlanSourceReference = {
  readonly definitionName: string;
  readonly plannerSourceFile: string;
  readonly generatedPath: string;
  readonly sourceFile: string;
};

function operationReferences(
  operation: SourceBackedOperation,
): readonly { readonly generatedPath: string; readonly sourceFile: string }[] {
  if (operation.kind === "writeTextFromFragments") {
    return operation.fragments.map((fragment) => ({
      generatedPath: operation.to,
      sourceFile: resolveBuiltInTemplateSource(fragment.source!, fragment.from),
    }));
  }
  return [
    {
      generatedPath: operation.to,
      sourceFile: resolveBuiltInTemplateSource(
        operation.source!,
        operation.from,
      ),
    },
  ];
}

/** Extracts referenced Template Source exclusively from the rendered plan. */
export function planSourceReferences(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
}): readonly PlanSourceReference[] {
  return options.plan.operations.flatMap((operation) => {
    if (
      operation.kind !== "copyFile" &&
      operation.kind !== "writeTextTemplate" &&
      operation.kind !== "writeTextFromFragments"
    ) {
      return [];
    }
    try {
      return operationReferences(operation).map((reference) => ({
        definitionName: options.definition.metadata.name,
        plannerSourceFile: options.definition.plannerSourceFile,
        ...reference,
      }));
    } catch (error) {
      throw new Error(
        `generated ${operation.to}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

/**
 * Fails before rendering when a real plan references missing or escaping
 * Template Source. Diagnostics retain Definition, planner, and generated path.
 */
export async function validatePlanSources(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
}): Promise<readonly PlanSourceReference[]> {
  let references: readonly PlanSourceReference[];
  try {
    references = planSourceReferences(options);
  } catch (error) {
    throw new Error(
      `${options.definition.metadata.name}: ${options.definition.plannerSourceFile} references undeclared or escaping Template Source for a generated output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const reference of references) {
    try {
      await access(reference.sourceFile);
    } catch {
      throw new Error(
        `${reference.definitionName}: ${reference.plannerSourceFile} references missing Template Source ${reference.sourceFile} for generated ${reference.generatedPath}`,
      );
    }
  }
  return references;
}

/** Verifies the generated catalog is derived solely from structured manifests. */
export function validatePlanDependencyCatalog(
  plan: GeneratedRepositoryPlan,
): void {
  const expected = selectTemplateDependencyCatalogEntries(
    collectGeneratedManifestCatalogReferences(plan.manifests),
  );
  if (JSON.stringify(expected) !== JSON.stringify(plan.dependencyCatalog)) {
    throw new Error(
      `${plan.definitionName}: ${plan.plannerSourceFile} ${plan.planningContribution} violates Dependency Catalog ownership; generated manifests reference an undeclared dependency`,
    );
  }
}

export type VerificationPlan = {
  readonly definition: BuiltInPresetDefinition;
  readonly plan: GeneratedRepositoryPlan;
};

/**
 * The plan set consumed by source, dependency, boundary, and publication
 * checks. Addition plans retain real base Contributions for link planning but
 * render only their own operations.
 */
export function deriveVerificationPlans(): readonly VerificationPlan[] {
  return deriveFixtureMatrix().flatMap((scenario) => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "template-verification-plan-"),
    );
    try {
      const context = createGenerationContext({
        targetDir: path.join(workspace, scenario.id),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: scenario.base,
        context,
      });
      const plans: VerificationPlan[] = [
        { definition: scenario.base, plan: initialization },
      ];
      if (scenario.addition) {
        const initialContributions =
          scenario.base.planInitializationContributions?.(context) ?? [
            scenario.base.planInitialization(context),
          ];
        for (const contribution of initialContributions) {
          const manifestPath = path.join(
            context.targetDir,
            contribution.definition.path,
            "package.json",
          );
          mkdirSync(path.dirname(manifestPath), { recursive: true });
          writeFileSync(manifestPath, JSON.stringify(contribution.manifest));
        }
        const dependabotPath = path.join(
          context.targetDir,
          ".github/dependabot.yml",
        );
        mkdirSync(path.dirname(dependabotPath), { recursive: true });
        writeFileSync(
          dependabotPath,
          projectDependabotConfig(initialization.dependencyMaintenancePolicy),
        );
        plans.push({
          definition: scenario.addition,
          plan: planGeneratedRepositoryPackageAddition({
            definition: scenario.addition,
            context,
            blueprint: initialization.blueprint,
            packageLeafName: `verification-${scenario.addition.metadata.name}`,
          }),
        });
      }
      return plans;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

/**
 * Verifies a packed artifact contains every Template Source file referenced by
 * the complete registry plan set, rather than a parallel source inventory.
 */
export function validatePlanPublicationSources(options: {
  readonly packageRoot: string;
  readonly packedPaths: readonly string[];
  readonly verificationPlans?: readonly VerificationPlan[];
}): void {
  const packageRoot = path.resolve(options.packageRoot);
  const packedPaths = new Set(options.packedPaths);
  for (const packedPath of packedPaths) {
    if (
      packedPath.startsWith("package/templates/.template-") ||
      /^package\/dist\/src\/.*\.test\.(?:[cm]?js|d\.ts)$/u.test(packedPath) ||
      /(?:^|\/)\.turbo(?:\/|$)/u.test(packedPath) ||
      /(?:^|\/)node_modules(?:\/|$)/u.test(packedPath)
    ) {
      throw new Error(
        `packed Built-in Presets artifact contains generated or test artifact ${packedPath}`,
      );
    }
  }
  const plans = options.verificationPlans ?? deriveVerificationPlans();
  for (const { definition, plan } of plans) {
    for (const reference of planSourceReferences({ definition, plan })) {
      const relativePath = path.relative(packageRoot, reference.sourceFile);
      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error(
          `${reference.definitionName}: ${reference.plannerSourceFile} references Template Source outside the Built-in Presets package for generated ${reference.generatedPath}`,
        );
      }
      const packedPath = `package/${relativePath.split(path.sep).join("/")}`;
      if (!packedPaths.has(packedPath)) {
        throw new Error(
          `${reference.definitionName}: packed Built-in Presets artifact omits ${packedPath}, referenced for generated ${reference.generatedPath}`,
        );
      }
    }
  }
}
