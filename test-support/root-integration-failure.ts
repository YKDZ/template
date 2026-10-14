import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

export async function preserveRootIntegrationFailure(
  workspace: string,
  scenario: string,
  error: unknown,
): Promise<void> {
  const failure = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: describeCause(error),
    command: error instanceof Error ? property(error, "command") : undefined,
    exitCode: error instanceof Error ? property(error, "exitCode") : undefined,
    signal: error instanceof Error ? property(error, "signal") : undefined,
    isCanceled:
      error instanceof Error ? property(error, "isCanceled") : undefined,
    timedOut: error instanceof Error ? property(error, "timedOut") : undefined,
    stdout: error instanceof Error ? property(error, "stdout") : undefined,
    stderr: error instanceof Error ? property(error, "stderr") : undefined,
  };
  const record = {
    schemaVersion: 1,
    scenario,
    originalWorkspace: workspace,
    argv: process.argv,
    cwd: process.cwd(),
    failure,
  };
  try {
    await writeFile(
      path.join(workspace, "root-integration-failure.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  } catch (writeError) {
    process.stderr.write(
      `无法写入根安装型失败记录；保留生成工作区 ${workspace}：${writeError instanceof Error ? writeError.message : String(writeError)}\n`,
    );
    return;
  }

  const configuredDiagnostics =
    process.env.TEMPLATE_BUILTIN_PRESET_DIAGNOSTICS_DIR;
  if (configuredDiagnostics !== undefined) {
    const diagnosticsRoot = path.resolve(configuredDiagnostics);
    await mkdir(diagnosticsRoot, { recursive: true });
    const diagnosticsDirectory = await mkdtemp(
      path.join(diagnosticsRoot, "root-installed-integration-"),
    );
    const retainedWorkspace = path.join(diagnosticsDirectory, "workspace");
    try {
      await cp(workspace, retainedWorkspace, {
        recursive: true,
        filter: (source) => isRetainableWorkspacePath(source, workspace),
      });
      await writeFile(
        path.join(diagnosticsDirectory, "failure.json"),
        `${JSON.stringify(
          {
            ...record,
            diagnosticsDirectory,
            retainedWorkspace,
          },
          null,
          2,
        )}\n`,
      );
      process.stderr.write(
        `根安装型失败材料已保存至 ${diagnosticsDirectory}\n`,
      );
    } catch (copyError) {
      process.stderr.write(
        `无法复制根安装型失败材料；原工作区仍保留在 ${workspace}：${copyError instanceof Error ? copyError.message : String(copyError)}\n`,
      );
    }
  }
  process.stderr.write(`保留根安装型失败工作区：${workspace}\n`);
}

function property(error: Error, key: string): unknown {
  return key in error
    ? (error as unknown as Record<string, unknown>)[key]
    : undefined;
}

function describeCause(cause: unknown, seen = new Set<unknown>()): unknown {
  if (!(cause instanceof Error)) return cause;
  if (seen.has(cause)) return { name: cause.name, message: cause.message };
  seen.add(cause);
  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    ...(cause.cause === undefined
      ? {}
      : { cause: describeCause(cause.cause, seen) }),
    ...(cause instanceof AggregateError
      ? { errors: cause.errors.map((item) => describeCause(item, seen)) }
      : {}),
  };
}

function isRetainableWorkspacePath(source: string, workspace: string): boolean {
  const relative = path.relative(workspace, source);
  const parts = relative.split(path.sep);
  return (
    !parts.some((part) =>
      [
        "node_modules",
        ".pnpm-store",
        ".npm",
        ".cache",
        ".turbo",
        "target",
      ].includes(part),
    ) &&
    !parts.some(
      (part, index) =>
        part === ".cargo" &&
        ["registry", "git"].includes(parts[index + 1] ?? ""),
    )
  );
}
