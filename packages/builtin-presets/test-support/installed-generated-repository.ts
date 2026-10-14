import {
  copyFile,
  cp,
  link,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type InstalledGeneratedRepository = {
  readonly workspace: string;
  readonly targetDir: string;
};

export async function removeWithRetry(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (firstCause) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (retryCause) {
      throw new AggregateError(
        [firstCause, retryCause],
        `Could not remove temporary repository ${directory}`,
        { cause: firstCause },
      );
    }
  }
}

function describeFailure(cause: unknown, seen = new Set<unknown>()): unknown {
  if (!(cause instanceof Error)) return cause;
  if (seen.has(cause)) return { name: cause.name, message: cause.message };
  seen.add(cause);
  const details = cause as Error & {
    readonly command?: string;
    readonly escapedCommand?: string;
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly timedOut?: boolean;
    readonly isCanceled?: boolean;
  };
  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    ...(cause.cause === undefined
      ? {}
      : { cause: describeFailure(cause.cause, seen) }),
    ...(cause instanceof AggregateError
      ? { errors: cause.errors.map((error) => describeFailure(error, seen)) }
      : {}),
    ...(details.command === undefined ? {} : { command: details.command }),
    ...(details.escapedCommand === undefined
      ? {}
      : { escapedCommand: details.escapedCommand }),
    ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
    ...(details.signal === undefined ? {} : { signal: details.signal }),
    ...(details.stdout === undefined ? {} : { stdout: details.stdout }),
    ...(details.stderr === undefined ? {} : { stderr: details.stderr }),
    ...(details.timedOut === undefined ? {} : { timedOut: details.timedOut }),
    ...(details.isCanceled === undefined
      ? {}
      : { isCanceled: details.isCanceled }),
  };
}

function isDisposableRepositoryPath(source: string, root: string): boolean {
  const relative = path.relative(root, source);
  return !relative
    .split(path.sep)
    .some((part) =>
      ["node_modules", ".pnpm-store", ".npm", ".cache", ".turbo"].includes(
        part,
      ),
    );
}

export async function preserveInstalledGeneratedRepositoryFailure(options: {
  readonly label: string;
  readonly scenario: string;
  readonly repository: InstalledGeneratedRepository;
  readonly cause: unknown;
}): Promise<string | undefined> {
  const diagnosticsRoot = path.resolve(
    process.env.TEMPLATE_BUILTIN_PRESET_DIAGNOSTICS_DIR ??
      path.join(tmpdir(), "template-builtin-preset-diagnostics"),
  );
  await mkdir(diagnosticsRoot, { recursive: true });
  const directory = await mkdtemp(
    path.join(diagnosticsRoot, `${options.label}-`),
  );
  const retainedWorkspace = path.join(directory, "workspace");
  try {
    await cp(options.repository.workspace, retainedWorkspace, {
      recursive: true,
      filter: (source) =>
        isDisposableRepositoryPath(source, options.repository.workspace),
    });
    await writeFile(
      path.join(directory, "failure.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          scenario: options.scenario,
          originalWorkspace: options.repository.workspace,
          retainedWorkspace,
          generatedRepository: path.join(
            retainedWorkspace,
            path.relative(
              options.repository.workspace,
              options.repository.targetDir,
            ),
          ),
          command:
            "pnpm --filter @ykdz/template-builtin-presets run test:integration",
          argv: process.argv,
          cwd: process.cwd(),
          cause: describeFailure(options.cause),
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`${options.label} 测试失败材料已保留：${directory}\n`);
    return directory;
  } catch (preservationCause) {
    process.stderr.write(
      `${options.label} 测试失败现场未能复制，原目录保留在 ${options.repository.workspace}：${String(preservationCause)}\n`,
    );
    return undefined;
  }
}

async function copyDirectoryWithLinkedFiles(
  sourceDirectory: string,
  targetDirectory: string,
  relativeDirectory = "",
): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, entry.name);
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(source), target);
    } else if (entry.isDirectory()) {
      await copyDirectoryWithLinkedFiles(source, target, relative);
    } else if (entry.isFile() && relative === "lock.yaml") {
      await copyFile(source, target);
    } else if (entry.isFile()) {
      try {
        await link(source, target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
        await copyFile(source, target);
      }
    }
  }
}

async function copyNodeModulesDirectory(
  sourceDirectory: string,
  targetDirectory: string,
): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(source), target);
    } else if (entry.isDirectory() && entry.name === ".pnpm") {
      await copyDirectoryWithLinkedFiles(source, target);
    } else if (entry.isDirectory()) {
      await copyNodeModulesDirectory(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target);
    }
  }
}

async function findNodeModulesDirectories(
  directory: string,
  found: string[] = [],
): Promise<readonly string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    if (entry.name === "node_modules") found.push(child);
    else await findNodeModulesDirectories(child, found);
  }
  return found;
}

export async function cloneInstalledGeneratedRepository(
  source: InstalledGeneratedRepository,
  prefix: string,
  label: string,
): Promise<InstalledGeneratedRepository> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const targetDir = path.join(workspace, path.basename(source.targetDir));
  try {
    await cp(source.targetDir, targetDir, {
      recursive: true,
      filter: (sourcePath) =>
        isDisposableRepositoryPath(sourcePath, source.targetDir),
    });
    for (const sourceModules of await findNodeModulesDirectories(
      source.targetDir,
    )) {
      const targetModules = path.join(
        targetDir,
        path.relative(source.targetDir, sourceModules),
      );
      await copyNodeModulesDirectory(sourceModules, targetModules);
    }
    return { workspace, targetDir };
  } catch (cause) {
    const retained = await preserveInstalledGeneratedRepositoryFailure({
      label,
      scenario: prefix,
      repository: { workspace, targetDir },
      cause,
    });
    if (retained !== undefined) await removeWithRetry(workspace);
    throw cause;
  }
}
