import { readFileSync } from "node:fs";

import type {
  CiDiagnosticArtifactDeclaration,
  DependencyMaintenancePolicy,
} from "@ykdz/default-content-authoring/contracts";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

export type ProjectCheckWorkflowDiagnosticOptions = {
  readonly diagnostics: readonly CiDiagnosticArtifactDeclaration[];
  readonly job?: ProjectCheckWorkflowJobOptions;
};

export type ProjectCheckWorkflowJobOptions = {
  readonly name?: string;
  readonly timeoutMinutes?: number;
};

export type ProjectCheckWorkflowJob = {
  readonly name: string;
  readonly timeoutMinutes: number;
};

export type PreparedProjectGithubTemplates = {
  readonly checkWorkflow: string;
  readonly dependabot: string;
  readonly nextSteps: string;
};

/** 根检查作业的默认值与显式声明共用同一规范化规则。 */
export function normalizeProjectCheckWorkflowJob(
  options?: ProjectCheckWorkflowJobOptions,
): ProjectCheckWorkflowJob {
  return {
    name: options?.name ?? "Root Check",
    timeoutMinutes: options?.timeoutMinutes ?? 30,
  };
}

/** GitHub 与后续步骤模板由根参考包在准备阶段从自有资源读取。 */
export function prepareProjectGithubTemplates(): PreparedProjectGithubTemplates {
  const read = (file: string): string => {
    try {
      return readFileSync(
        new URL(`../resources/${file}`, import.meta.url),
        "utf8",
      );
    } catch (cause) {
      throw new Error(
        `根资源 @ykdz/reference-workspace-root#./project-github prepare 阶段无法读取 ${file}`,
        { cause },
      );
    }
  };
  return {
    checkWorkflow: read("github/check.yml"),
    dependabot: read("github/dependabot.yml"),
    nextSteps: read("next-steps.md"),
  };
}

/** 完整原生工作流拥有任务和工具设置；投影只选择已声明的能力。 */
export function projectCheckWorkflow(
  options: ProjectCheckWorkflowDiagnosticOptions,
  template: string,
): string {
  const diagnostics = options.diagnostics;
  const workflow = parseDocument(template);
  const job = normalizeProjectCheckWorkflowJob(options.job);
  workflow.setIn(["jobs", "check", "name"], job.name);
  workflow.setIn(["jobs", "check", "timeout-minutes"], job.timeoutMinutes);
  const steps = workflow.getIn(["jobs", "check", "steps"]) as YAMLSeq<
    YAMLMap<string>
  >;
  steps.items = steps.items.filter((step) => {
    const identity = step.get("id");
    if (identity === "stage-diagnostics" || identity === "upload-diagnostics")
      return diagnostics.length > 0;
    return true;
  });
  if (options.job === undefined) {
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
        .toSorted((left, right) => left.localeCompare(right))
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
  template: string,
): string {
  const document = parseDocument(template);
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
  template: string,
): string {
  const introduction = template.trimEnd();
  const steps = instructions.map(
    (instruction, index) => `${index + 1}. \`${instruction.display}\``,
  );
  return `${introduction}\n\n${steps.join("\n")}\n`;
}
