import { readFile } from "node:fs/promises";

/** 返回可由生成仓库原样派生的发布运行时与公开命令资源。 */
export async function publicationResources(): Promise<
  ReadonlyMap<string, string>
> {
  const files = [
    "publication.ts",
    "generated/diagnose.ts",
    "generated/prepare.ts",
    "generated/accept.ts",
  ] as const;
  return new Map(
    await Promise.all(
      files.map(
        async (file) =>
          [
            `npm-publication/${file}`,
            await readFile(new URL(file, import.meta.url), "utf8"),
          ] as const,
      ),
    ),
  );
}
