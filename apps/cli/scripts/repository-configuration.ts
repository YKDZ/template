import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type RepositoryConfigurationTarget = {
  readonly label: string;
  readonly before: string;
  readonly write: (contents: string) => Promise<void>;
};

async function replaceFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.repository-config-${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 准备应用 CLI 自有的工具链声明，并绑定其本地写入位置。 */
export async function prepareRepositoryConfigurationTarget(): Promise<RepositoryConfigurationTarget> {
  const file = fileURLToPath(new URL("../package.json", import.meta.url));
  return {
    label: "应用 CLI 包清单",
    before: await readFile(file, "utf8"),
    write: (contents) => replaceFile(file, contents),
  };
}
