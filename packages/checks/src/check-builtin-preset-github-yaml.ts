#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  resolveBuiltInTemplateSource,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "@ykdz/template-core/project-github";
import { parseDocument } from "yaml";

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

function sourceForGithubTemplate(
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
  const operation = plan.operations.find((candidate) =>
    isGithubTemplateOperation(candidate, generatedPath),
  );

  if (operation === undefined) {
    throw new Error(
      `${plan.definitionName}: missing Foundation-composed ${generatedPath} Template Source`,
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

function renderTemplate(
  source: string,
  replacements: Record<string, string>,
): string {
  const used = new Set<string>();
  const rendered = source.replaceAll(
    /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (_placeholder, name: string) => {
      const replacement = replacements[name];
      if (replacement === undefined) {
        throw new Error(`Missing Template Source replacement: ${name}`);
      }
      used.add(name);
      return replacement;
    },
  );

  for (const name of Object.keys(replacements)) {
    if (!used.has(name)) {
      throw new Error(`Unused Template Source replacement: ${name}`);
    }
  }

  return rendered;
}

function expectedGithubTemplate(
  plan: GeneratedRepositoryPlan,
  kind: GithubTemplateKind,
): string {
  if (kind === "dependabot") {
    return projectDependabotConfig(plan.dependencyMaintenancePolicy);
  }

  return projectCheckWorkflow({
    checkPlan: {
      components: [...plan.checks],
      environmentNeeds: [...plan.environmentNeeds],
      deploymentChecks: [...plan.deploymentChecks],
    },
  });
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
      if (rendered !== expectedGithubTemplate(plan, kind)) {
        throw new Error(
          `${definition.metadata.name}: ${kind} Template Source diverges from its Foundation plan\nexpected:\n${expectedGithubTemplate(plan, kind)}\nactual:\n${rendered}`,
        );
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInPresetGithubYaml();
}
