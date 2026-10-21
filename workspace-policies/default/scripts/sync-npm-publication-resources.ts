import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publicationResources } from "@ykdz/reference-npm-publication/resources";

const resourceRoot = fileURLToPath(new URL("../assets/", import.meta.url));
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const [relativePath, contents] of await publicationResources()) {
  const destination = path.join(resourceRoot, relativePath);
  const current = await readFile(destination, "utf8").catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
  if (current === contents) continue;
  stale.push(path.relative(resourceRoot, destination));
  if (!check) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}

if (check && stale.length > 0) {
  throw new Error(
    `npm 发布资源与共享参考包不一致：${stale.join("、")}。请执行 pnpm sync。`,
  );
}
