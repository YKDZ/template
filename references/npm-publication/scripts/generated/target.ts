import { readFile } from "node:fs/promises";
import path from "node:path";

type PublicationConfiguration = {
  readonly packagePath?: unknown;
};

export async function publicationTarget(): Promise<{
  readonly packageRoot: string;
  readonly outputDirectory: string;
}> {
  const workspaceRoot = path.resolve(process.cwd());
  const configurationPath = path.join(
    workspaceRoot,
    "scripts/npm-publication/publication.config.json",
  );
  const configuration = JSON.parse(
    await readFile(configurationPath, "utf8"),
  ) as PublicationConfiguration;
  if (
    typeof configuration.packagePath !== "string" ||
    configuration.packagePath.length === 0
  ) {
    throw new Error(`共享发布目标配置缺少 packagePath：${configurationPath}`);
  }

  const packageRoot = path.resolve(workspaceRoot, configuration.packagePath);
  const outputDirectory = path.resolve(
    process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
      path.join(packageRoot, "node_modules/.cache/npm-publication"),
  );
  return { packageRoot, outputDirectory };
}
