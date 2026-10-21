import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const publicationSetupDirectory = "scripts/npm-publication-setup";

export type AcquirePublicationSetupResult = {
  readonly kind: "created" | "restored-missing" | "already-present";
  readonly directory: string;
};

const sourceDirectory = fileURLToPath(
  new URL("../../resources/setup/files/", import.meta.url),
);
const setupScript = fileURLToPath(
  new URL("./first-release.ts", import.meta.url),
);

/** 仅由显式公开命令调用；保留现有编辑，只补回已删除的向导文件。 */
export async function acquirePublicationSetup(
  options: {
    readonly repositoryRoot?: string;
  } = {},
): Promise<AcquirePublicationSetupResult> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const directory = path.join(repositoryRoot, publicationSetupDirectory);
  let alreadyPresent = false;
  try {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`一次性发布目录不是普通目录：${directory}`);
    }
    alreadyPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(directory), { recursive: true });
  if (!alreadyPresent) {
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await lstat(directory);
      if (!current.isDirectory() || current.isSymbolicLink()) {
        throw new Error(`一次性发布目录不是普通目录：${directory}`);
      }
      alreadyPresent = true;
    }
  }
  let restoredMissing = false;
  try {
    const copyMissing = async (
      source: string,
      target: string,
    ): Promise<void> => {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isDirectory()) {
          try {
            await lstat(targetPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await mkdir(targetPath);
            restoredMissing = true;
          }
          await copyMissing(sourcePath, targetPath);
          continue;
        }
        try {
          await lstat(targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            await cp(sourcePath, targetPath, {
              force: false,
              errorOnExist: true,
            });
            restoredMissing = true;
          } catch (copyError) {
            if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") {
              throw copyError;
            }
          }
        }
      }
    };
    await copyMissing(sourceDirectory, directory);
    const setupPath = path.join(directory, "setup.ts");
    try {
      await lstat(setupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await cp(setupScript, setupPath, {
          force: false,
          errorOnExist: true,
        });
        restoredMissing = true;
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw copyError;
        }
      }
    }
    return {
      kind: alreadyPresent
        ? restoredMissing
          ? "restored-missing"
          : "already-present"
        : "created",
      directory,
    };
  } catch (error) {
    if (!alreadyPresent) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
