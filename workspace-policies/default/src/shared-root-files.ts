import { isDeepStrictEqual } from "node:util";

import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

import type { CiDiagnosticArtifactDeclaration } from "./ci-diagnostic-artifact.ts";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
} from "./environment-needs.ts";
import type { DependencyMaintenancePolicy } from "./project-requirements.ts";

type SharedRootCiStep =
  | (Readonly<Record<string, unknown>> & { readonly id: string })
  | YAMLMap<unknown>;

function isYamlMapStep(value: unknown): value is YAMLMap<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly items?: unknown;
    readonly get?: unknown;
    readonly clone?: unknown;
  };
  return (
    Array.isArray(candidate.items) &&
    typeof candidate.get === "function" &&
    typeof candidate.clone === "function"
  );
}

/** 外层拥有者声明共享文件中的领域条目；不向参考包授予根写入权限。 */
export type SharedRootContribution = {
  readonly kind: "shared-root-files";
  readonly source: string;
  readonly manifest?: {
    readonly scripts?: Readonly<Record<string, string>>;
    readonly imports?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  /** 同名任务作为完整声明比较，不递归合并任务内部的规则。 */
  readonly turboTasks?: Readonly<Record<string, unknown>>;
  readonly typescript?: {
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    readonly include?: readonly string[];
  };
  /** 每个步骤必须有独占的 id；before 引用已存在的步骤。 */
  readonly ciSteps?: readonly {
    readonly before?: string;
    readonly steps: readonly SharedRootCiStep[];
  }[];
  /** 声明根检查作业的名称和超时；同一字段只允许等价来源。 */
  readonly ciJob?: {
    readonly name?: string;
    readonly timeoutMinutes?: number;
  };
  /** 外层拥有者声明共享环境及依赖维护需求。 */
  readonly environmentNeeds?: {
    readonly check?: readonly CheckEnvironmentNeed[];
    readonly deployment?: readonly DeploymentEnvironmentNeed[];
  };
  readonly dependencyMaintenance?: DependencyMaintenancePolicy;
  /** 由所属内容声明的 CI 失败诊断制品。 */
  readonly ciDiagnosticArtifacts?: readonly CiDiagnosticArtifactDeclaration[];
};

function pointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function conflict(location: string, left: string, right: string): never {
  throw new Error(`共享根文件声明冲突：${location}；来源 ${left} 与 ${right}`);
}

/** 每个字典拥有自己的等价规则；只比较完整条目，不提供覆盖优先级。 */
function composeEntries<T>(
  location: string,
  declarations: readonly {
    readonly source: string;
    readonly values: Readonly<Record<string, T>>;
  }[],
): Record<string, T> {
  const values: Record<string, T> = {};
  const owners = new Map<string, string>();
  for (const declaration of declarations) {
    for (const [key, value] of Object.entries(declaration.values)) {
      const owner = owners.get(key);
      if (owner !== undefined && !isDeepStrictEqual(values[key], value)) {
        conflict(`${location}/${pointer(key)}`, owner, declaration.source);
      }
      if (owner === undefined) {
        owners.set(key, declaration.source);
        values[key] = value;
      }
    }
  }
  return values;
}

export function composeSharedRootFiles(options: {
  readonly source: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly turboTasks: Readonly<Record<string, unknown>>;
  readonly typescript: {
    readonly compilerOptions: Readonly<Record<string, unknown>>;
    readonly include: readonly string[];
  };
  readonly declarations: readonly SharedRootContribution[];
}) {
  const declarations = options.declarations;
  const manifest = { ...options.manifest };
  for (const field of ["scripts", "imports", "devDependencies"] as const) {
    const values = composeEntries(`package.json#/${field}`, [
      {
        source: options.source,
        values: (manifest[field] ?? {}) as Readonly<Record<string, string>>,
      },
      ...declarations.map((declaration) => ({
        source: declaration.source,
        values: declaration.manifest?.[field] ?? {},
      })),
    ]);
    if (Object.keys(values).length > 0) manifest[field] = values;
  }
  const turboTasks = composeEntries("turbo.json#/tasks", [
    { source: options.source, values: options.turboTasks },
    ...declarations.map((declaration) => ({
      source: declaration.source,
      values: declaration.turboTasks ?? {},
    })),
  ]);
  const compilerOptions = composeEntries("tsconfig.json#/compilerOptions", [
    { source: options.source, values: options.typescript.compilerOptions },
    ...declarations.map((declaration) => ({
      source: declaration.source,
      values: declaration.typescript?.compilerOptions ?? {},
    })),
  ]);
  const include = [
    ...new Set([
      ...options.typescript.include,
      ...declarations.flatMap(
        (declaration) => declaration.typescript?.include ?? [],
      ),
    ]),
  ];
  const ciJob = composeEntries(
    ".github/workflows/check.yml#/jobs/check",
    declarations.map((declaration) => ({
      source: declaration.source,
      values: declaration.ciJob ?? {},
    })),
  ) as NonNullable<SharedRootContribution["ciJob"]>;
  return {
    manifest,
    turboTasks,
    typescript: { compilerOptions, include },
    ciSteps: declarations.flatMap((declaration) =>
      (declaration.ciSteps ?? []).map((insertion) => ({
        ...insertion,
        source: declaration.source,
      })),
    ),
    ciJob,
    environmentNeeds: {
      check: declarations.flatMap(
        (declaration) => declaration.environmentNeeds?.check ?? [],
      ),
      deployment: declarations.flatMap(
        (declaration) => declaration.environmentNeeds?.deployment ?? [],
      ),
    },
    dependencyMaintenance: declarations.flatMap((declaration) =>
      declaration.dependencyMaintenance === undefined
        ? []
        : [declaration.dependencyMaintenance],
    ),
  };
}

/** CI 步骤按锚点和来源顺序插入；步骤身份独占，不按内容去重或排序。 */
export function composeCheckWorkflow(
  template: string,
  source: string,
  insertions: ReturnType<typeof composeSharedRootFiles>["ciSteps"],
): string {
  if (insertions.length === 0) return template;
  const workflow = parseDocument(template);
  const steps = workflow.getIn(["jobs", "check", "steps"]) as YAMLSeq<
    YAMLMap<unknown>
  >;
  const owners = new Map<string, string>();
  for (const step of steps.items) {
    const id = step.get("id");
    if (typeof id === "string") owners.set(id, source);
  }
  for (const insertion of insertions) {
    const index =
      insertion.before === undefined
        ? steps.items.length
        : steps.items.findIndex((step) => step.get("id") === insertion.before);
    if (index === -1)
      throw new Error(
        `${insertion.source} 的 CI 步骤锚点不存在：${insertion.before}`,
      );
    for (const step of insertion.steps) {
      const id = isYamlMapStep(step) ? step.get("id") : step.id;
      if (typeof id !== "string") {
        throw new Error(`${insertion.source} 的 CI 步骤必须声明字符串 id`);
      }
      const owner = owners.get(id);
      if (owner !== undefined)
        conflict(
          `.github/workflows/check.yml#/jobs/check/steps/${pointer(id)}`,
          owner,
          insertion.source,
        );
      owners.set(id, insertion.source);
    }
    steps.items.splice(
      index,
      0,
      ...insertion.steps.map((step) =>
        isYamlMapStep(step)
          ? (step.clone() as YAMLMap<unknown>)
          : (workflow.createNode(step) as unknown as YAMLMap<unknown>),
      ),
    );
  }
  return workflow.toString();
}
