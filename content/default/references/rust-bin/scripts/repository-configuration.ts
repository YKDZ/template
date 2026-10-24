import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type RepositoryConfigurationTarget = {
  readonly label: string;
  readonly before: string;
  write(contents: string): Promise<void>;
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

/** 准备 Rust 参考包自有的工具链模板，并绑定其本地写入位置。 */
export async function prepareRepositoryConfigurationTarget(): Promise<RepositoryConfigurationTarget> {
  const file = fileURLToPath(
    new URL("../template/rust-toolchain.toml", import.meta.url),
  );
  return {
    label: "Rust 工具链模板",
    before: await readFile(file, "utf8"),
    write: (contents) => replaceFile(file, contents),
  };
}
