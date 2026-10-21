import { readFile } from "node:fs/promises";
import path from "node:path";

type PublicationConfiguration = {
  readonly packagePath?: unknown;
};

export async function publicationTarget(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  readonly packageRoot: string;
  readonly outputDirectory: string;
}> {
  const workspaceRoot = path.resolve(process.cwd());
  const configurationPath = path.join(
    workspaceRoot,
    "scripts/npm-publication/publication.config.json",
  );
  let packageRoot = workspaceRoot;
  try {
    const configuration = JSON.parse(
      await readFile(configurationPath, "utf8"),
    ) as PublicationConfiguration;
    if (
      typeof configuration.packagePath !== "string" ||
      configuration.packagePath.length === 0
    ) {
      throw new Error(`共享发布目标配置缺少 packagePath：${configurationPath}`);
    }
    packageRoot = path.resolve(workspaceRoot, configuration.packagePath);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const outputOverride =
    env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
    env.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
  let outputDirectory = path.resolve(
    outputOverride ??
      path.join(packageRoot, "node_modules/.cache/npm-publication"),
  );
  const targetCount = Number(env.PUBLICATION_BATCH_TARGET_COUNT ?? "1");
  if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
    throw new Error("PUBLICATION_BATCH_TARGET_COUNT 必须是正整数。");
  }
  if (outputOverride !== undefined && targetCount > 1) {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { readonly name?: unknown };
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`批次发布目标缺少包名：${packageRoot}/package.json`);
    }
    outputDirectory = path.join(
      outputDirectory,
      encodeURIComponent(manifest.name),
    );
  }
  return { packageRoot, outputDirectory };
}
