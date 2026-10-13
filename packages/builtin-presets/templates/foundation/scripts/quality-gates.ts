import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type QualityGate = "check" | "check:heavy" | "check:full";

type ScriptRole =
  | "quality:light"
  | "quality:heavy"
  | "quality:conditional"
  | "quality:entry"
  | "work:development"
  | "work:repair"
  | "work:release"
  | "work:preparation"
  | "work:lifecycle";

type TurboTask = {
  readonly name: string;
  readonly fullName: string;
  readonly packageName: string;
  readonly tags: readonly string[];
  readonly executable: boolean;
  readonly role?: ScriptRole;
};

type GateLayer = {
  readonly role: "quality:light" | "quality:heavy";
  readonly label: string;
};

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
};

const turboTaskQuery =
  "{ packages { items { name tasks { items { name fullName tags script command } } } } }";

const validRoles = new Set<ScriptRole>([
  "quality:light",
  "quality:heavy",
  "quality:conditional",
  "quality:entry",
  "work:development",
  "work:repair",
  "work:release",
  "work:preparation",
  "work:lifecycle",
]);

const publicGateNames = new Set<QualityGate>([
  "check",
  "check:heavy",
  "check:full",
]);

const maxTurboOutputBytes = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function report(message: string): void {
  process.stderr.write(`${message}\n`);
}

function runCaptured(cwd: string, args: readonly string[]): CommandResult {
  const result = spawnSync("pnpm", ["exec", "turbo", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: maxTurboOutputBytes,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runVisible(cwd: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveStatus) => {
    const command =
      process.platform === "win32"
        ? "pnpm"
        : resolve(cwd, "node_modules/.bin/turbo");
    const commandArgs =
      process.platform === "win32" ? ["exec", "turbo", ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    let interruptedBy: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) {
        interruptedBy = signal;
        const turboSignal = signal === "SIGTERM" ? "SIGINT" : signal;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, turboSignal);
          } catch {
            child.kill(turboSignal);
          }
        } else {
          child.kill(turboSignal);
        }
      }
    };
    const forwardInterrupt = (): void => forward("SIGINT");
    const forwardTerminate = (): void => forward("SIGTERM");
    const removeSignalHandlers = (): void => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };

    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    child.once("error", (error) => {
      removeSignalHandlers();
      report(`无法启动 Turbo 执行 ${args.join(" ")}：${error.message}`);
      resolveStatus(1);
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      if (interruptedBy !== undefined) {
        resolveStatus(interruptedBy === "SIGINT" ? 130 : 143);
      } else if (code !== null) {
        resolveStatus(code);
      } else {
        resolveStatus(
          signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1,
        );
      }
    });
  });
}

function commandFailure(label: string, result: CommandResult): string {
  const details = result.stderr.trim();
  if (result.error !== undefined) {
    return `无法运行 Turbo ${label}：${result.error.message}`;
  }
  return `Turbo ${label} 失败（退出码 ${String(result.status)}）${details === "" ? "" : `：\n${details}`}`;
}

function roleTags(tags: readonly string[]): readonly string[] {
  return tags.filter(
    (tag) => tag.startsWith("quality:") || tag.startsWith("work:"),
  );
}

function publicGateTask(task: {
  readonly name: string;
  readonly packageName: string;
}): boolean {
  return (
    task.packageName === "//" && publicGateNames.has(task.name as QualityGate)
  );
}

function protectedVerificationTask(task: TurboTask): boolean {
  return (
    task.name === "check" ||
    task.name.startsWith("check:") ||
    task.name === "test" ||
    task.name.startsWith("test:") ||
    task.name === "lint" ||
    task.name === "typecheck" ||
    task.name === "format:check"
  );
}

function assignRole(
  task: Omit<TurboTask, "role">,
  diagnostics: string[],
): ScriptRole | undefined {
  const roles = roleTags(task.tags);
  const isPublicGate = publicGateTask(task);
  if (roles.length === 0) {
    diagnostics.push(
      `${task.fullName} 缺少唯一职责标签；请在 Turbo 任务标签中声明质量范围或工作用途`,
    );
    return undefined;
  }
  if (roles.length > 1) {
    diagnostics.push(
      `${task.fullName} 有多个职责标签：${roles.join("、")}；每个可执行任务只能声明一个职责`,
    );
    return undefined;
  }

  const role = roles[0]!;
  if (!validRoles.has(role as ScriptRole)) {
    diagnostics.push(`${task.fullName} 使用未知职责标签 ${role}`);
    return undefined;
  }
  const scriptRole = role as ScriptRole;
  if (isPublicGate && scriptRole !== "quality:entry") {
    diagnostics.push(
      `${task.fullName} 是公共验收入口，职责必须为 quality:entry，当前为 ${scriptRole}`,
    );
    return undefined;
  }
  if (!isPublicGate && scriptRole === "quality:entry") {
    diagnostics.push(
      `${task.fullName} 不能使用 quality:entry；该职责只允许根 check、check:heavy、check:full`,
    );
    return undefined;
  }
  if (protectedVerificationTask(task) && !scriptRole.startsWith("quality:")) {
    diagnostics.push(
      `${task.fullName} 是保留验收任务，不能归入非验收职责 ${scriptRole}`,
    );
    return undefined;
  }

  return scriptRole;
}

function readTaskDirectory(cwd: string): {
  readonly tasks: readonly TurboTask[];
  readonly diagnostics: readonly string[];
} {
  const result = runCaptured(cwd, ["query", turboTaskQuery]);
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("原生任务目录查询", result)],
      tasks: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Turbo 原生任务目录不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      ],
      tasks: [],
    };
  }

  const packages =
    isRecord(response) && isRecord(response.data)
      ? response.data.packages
      : undefined;
  const packageItems = isRecord(packages) ? packages.items : undefined;
  if (!Array.isArray(packageItems)) {
    return {
      diagnostics: ["Turbo 原生任务目录缺少 packages.items"],
      tasks: [],
    };
  }

  const diagnostics: string[] = [];
  const tasks: TurboTask[] = [];
  for (const packageItem of packageItems) {
    if (!isRecord(packageItem) || !isNonEmptyString(packageItem.name)) {
      diagnostics.push("Turbo 原生任务目录包含无法识别的工作区包");
      continue;
    }
    const taskConnection = packageItem.tasks;
    const taskItems = isRecord(taskConnection)
      ? taskConnection.items
      : undefined;
    if (!Array.isArray(taskItems)) {
      diagnostics.push(`${packageItem.name} 的 Turbo 任务目录缺少 tasks.items`);
      continue;
    }

    for (const taskItem of taskItems) {
      if (!isRecord(taskItem)) {
        diagnostics.push(`${packageItem.name} 的 Turbo 任务目录包含无效任务`);
        continue;
      }
      const { name, fullName, tags, script, command } = taskItem;
      if (
        !isNonEmptyString(name) ||
        !isNonEmptyString(fullName) ||
        !Array.isArray(tags) ||
        !tags.every((tag) => typeof tag === "string")
      ) {
        diagnostics.push(`${packageItem.name} 的 Turbo 任务条目缺少名称或标签`);
        continue;
      }

      const executable = isNonEmptyString(script) || isNonEmptyString(command);
      const taskWithoutRole = {
        name,
        fullName,
        packageName: packageItem.name,
        tags,
        executable,
      };
      if (!executable) {
        tasks.push(taskWithoutRole);
        continue;
      }

      const role = assignRole(taskWithoutRole, diagnostics);
      tasks.push(
        role === undefined ? taskWithoutRole : { ...taskWithoutRole, role },
      );
    }
  }

  return { diagnostics, tasks };
}

function parseDryRun(
  cwd: string,
  tasks: readonly TurboTask[],
): {
  readonly taskIds: readonly string[];
  readonly diagnostics: readonly string[];
} {
  if (tasks.length === 0) {
    return { diagnostics: [], taskIds: [] };
  }
  const result = runCaptured(cwd, [
    "run",
    ...tasks.map((task) => task.fullName),
    "--dry=json",
  ]);
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("执行图预览", result)],
      taskIds: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Turbo 执行图预览不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      ],
      taskIds: [],
    };
  }
  if (!isRecord(response) || !Array.isArray(response.tasks)) {
    return {
      diagnostics: ["Turbo 执行图预览缺少 tasks"],
      taskIds: [],
    };
  }

  const taskIds: string[] = [];
  const diagnostics: string[] = [];
  for (const task of response.tasks) {
    if (!isRecord(task) || !isNonEmptyString(task.taskId)) {
      diagnostics.push("Turbo 执行图预览包含无法识别的任务标识");
      continue;
    }
    taskIds.push(task.taskId);
  }

  return { diagnostics, taskIds };
}

function validateLayerClosure(
  layer: GateLayer,
  taskIds: readonly string[],
  tasksByName: ReadonlyMap<string, TurboTask>,
): readonly string[] {
  const diagnostics: string[] = [];
  for (const taskId of taskIds) {
    const dependency = tasksByName.get(taskId);
    if (dependency === undefined) {
      diagnostics.push(
        `${layer.label} 执行图包含任务目录中不存在的任务 ${taskId}`,
      );
      continue;
    }
    if (!dependency.executable) {
      continue;
    }
    if (
      dependency.role === "quality:entry" ||
      dependency.role === "quality:conditional" ||
      (layer.role === "quality:light" && dependency.role === "quality:heavy")
    ) {
      const scope =
        layer.role === "quality:light" && dependency.role === "quality:heavy"
          ? "轻检查不能间接启动重验收"
          : dependency.role === "quality:conditional"
            ? "常规验收不能间接启动条件验收"
            : "验收叶任务不能依赖公共聚合入口";
      diagnostics.push(
        `${layer.label} 执行图包含 ${dependency.fullName}：${scope}`,
      );
    }
  }

  return diagnostics;
}

function layerFor(role: GateLayer["role"]): GateLayer {
  return {
    role,
    label: role === "quality:light" ? "轻检查" : "重验收",
  };
}

function layersFor(gate: QualityGate): readonly GateLayer[] {
  if (gate === "check") {
    return [layerFor("quality:light")];
  }
  if (gate === "check:heavy") {
    return [layerFor("quality:heavy")];
  }

  return [layerFor("quality:light"), layerFor("quality:heavy")];
}

export async function runQualityGate(
  gate: QualityGate,
  cwd = process.cwd(),
): Promise<number> {
  if (!publicGateNames.has(gate)) {
    report(`未知公共验收入口：${String(gate)}`);
    return 1;
  }

  const directory = readTaskDirectory(cwd);
  if (directory.diagnostics.length > 0) {
    report(directory.diagnostics.join("\n"));
    return 1;
  }
  const tasksByName = new Map(
    directory.tasks.map((task) => [task.fullName, task]),
  );
  const layers = layersFor(gate);
  const plans: {
    readonly layer: GateLayer;
    readonly tasks: readonly TurboTask[];
  }[] = [];
  const diagnostics: string[] = [];

  for (const layer of layers) {
    const selected = directory.tasks.filter((task) => task.role === layer.role);
    const dryRun = parseDryRun(cwd, selected);
    diagnostics.push(...dryRun.diagnostics);
    diagnostics.push(
      ...validateLayerClosure(layer, dryRun.taskIds, tasksByName),
    );
    plans.push({ layer, tasks: selected });
  }

  if (diagnostics.length > 0) {
    report(diagnostics.join("\n"));
    return 1;
  }

  const conditionalTasks = directory.tasks.filter(
    (task) => task.role === "quality:conditional",
  );
  if (conditionalTasks.length > 0) {
    report(
      `条件验收未执行：${conditionalTasks.map((task) => task.fullName).join("、")}`,
    );
  }

  for (const plan of plans) {
    if (plan.tasks.length === 0) {
      continue;
    }
    const status = await runVisible(cwd, [
      "run",
      ...plan.tasks.map((task) => task.fullName),
      "--continue=dependencies-successful",
      "--output-logs=errors-only",
      "--log-order=grouped",
    ]);
    if (status !== 0) {
      return status;
    }
  }

  return 0;
}

const mainFile = process.argv[1];
if (
  mainFile !== undefined &&
  pathToFileURL(resolve(mainFile)).href === import.meta.url
) {
  const gate = process.argv[2];
  if (gate !== "check" && gate !== "check:heavy" && gate !== "check:full") {
    report("用法：node quality-gates.ts <check|check:heavy|check:full>");
    process.exitCode = 2;
  } else {
    void runQualityGate(gate)
      .then((status) => {
        process.exitCode = status;
      })
      .catch((error: unknown) => {
        report(
          `公共验收入口失败：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
  }
}
