import { readFileSync } from "node:fs";

import { composeCiDiagnosticArtifacts } from "@ykdz/template-environment/ci-diagnostic-artifact";
import type { DeploymentEnvironmentNeed } from "@ykdz/template-environment/module-graph";
import type { DependencyMaintenancePolicy } from "@ykdz/template-workspace-authoring/project-requirements";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

export type ProjectCheckWorkflowDiagnosticOptions = {
  readonly packagePaths: readonly string[];
  readonly diagnosticArtifacts?: readonly unknown[] | undefined;
};

/** 完整原生工作流拥有任务和工具设置；投影只选择已声明的能力。 */
export function projectCheckWorkflow(
  options: ProjectCheckWorkflowDiagnosticOptions & {
    readonly deploymentCheck?:
      | { readonly environmentNeeds: readonly DeploymentEnvironmentNeed[] }
      | undefined;
  },
): string {
  const hasDeployment = options.deploymentCheck !== undefined;
  if (
    hasDeployment &&
    !options.deploymentCheck?.environmentNeeds.some(
      (need) => need.kind === "docker-engine",
    )
  ) {
    throw new Error("Deployment Check requires a Docker environment need");
  }
  const diagnostics = composeCiDiagnosticArtifacts({
    packagePaths: options.packagePaths,
    declarations: options.diagnosticArtifacts ?? [],
  });
  const workflow = parseDocument(
    readFileSync(
      new URL("../assets/github/check.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = workflow.getIn(["jobs", "check", "steps"]) as YAMLSeq<
    YAMLMap<string>
  >;
  steps.items = steps.items.filter((step) => {
    const identity = step.get("id");
    if (identity === "prepare-deployment") return hasDeployment;
    if (identity === "stage-diagnostics" || identity === "upload-diagnostics")
      return diagnostics.length > 0;
    return true;
  });
  if (!hasDeployment) {
    workflow.setIn(["jobs", "check", "name"], "Root Check");
    workflow.setIn(["jobs", "check", "timeout-minutes"], 30);
    for (const step of steps.items) {
      if (step.get("id") === "stage-diagnostics")
        step.set("name", "Stage Root Check diagnostics");
      if (step.get("id") === "upload-diagnostics") {
        step.set("name", "Upload Root Check diagnostics");
        step.setIn(["with", "name"], "root-check-diagnostics");
      }
    }
  }
  const staging = steps.items.find(
    (step) => step.get("id") === "stage-diagnostics",
  );
  if (staging !== undefined) {
    const owners = (kind: "playwright" | "vitest-browser"): string =>
      diagnostics
        .filter((declaration) => declaration.kind === kind)
        .map((declaration) => declaration.owner.path)
        .toSorted()
        .join("\n");
    staging.setIn(
      ["env", "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS"],
      owners("playwright"),
    );
    staging.setIn(
      ["env", "VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS"],
      owners("vitest-browser"),
    );
  }
  return workflow.toString({ lineWidth: 0 });
}

type DependabotUpdate = Readonly<Record<string, unknown>> & {
  readonly "package-ecosystem": DependencyMaintenancePolicy["ecosystems"][number];
  readonly directory: `/${string}`;
  readonly schedule: Readonly<Record<string, unknown>>;
};

/** 版本维护政策保留在原生 YAML，描述只提供生态、目录与频率。 */
export function projectDependabotConfig(
  policy: DependencyMaintenancePolicy,
): string {
  const document = parseDocument(
    readFileSync(
      new URL("../assets/github/dependabot.yml", import.meta.url),
      "utf8",
    ),
  );
  const declarations = (document.toJS() as { updates: DependabotUpdate[] })
    .updates;
  const updates = policy.ecosystems.flatMap((ecosystem) => {
    const candidates = declarations.filter(
      (update) => update["package-ecosystem"] === ecosystem,
    );
    const defaultUpdate = candidates[0];
    if (defaultUpdate === undefined)
      throw new Error(`原生 Dependabot 配置未声明生态：${ecosystem}`);
    return [
      policy.directories?.[ecosystem] ?? defaultUpdate.directory,
      ...(policy.extraDirectories?.[ecosystem] ?? []),
    ].map((directory) => {
      const declaration =
        candidates.find((candidate) => candidate.directory === directory) ??
        candidates.find((candidate) => candidate.directory === "/") ??
        defaultUpdate;
      return {
        ...declaration,
        directory,
        schedule: { ...declaration.schedule, interval: policy.interval },
      };
    });
  });
  document.set("updates", updates);
  return document.toString({ lineWidth: 0 });
}

/** 文档正文是自然 Markdown，动态命令由已有正式计划提供。 */
export function projectNextStepsDocument(
  instructions: readonly { readonly display: string }[],
): string {
  const introduction = readFileSync(
    new URL("../assets/next-steps.md", import.meta.url),
    "utf8",
  ).trimEnd();
  const steps = instructions.map(
    (instruction, index) => `${index + 1}. \`${instruction.display}\``,
  );
  return `${introduction}\n\n${steps.join("\n")}\n`;
}
