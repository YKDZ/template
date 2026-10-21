import { readFileSync } from "node:fs";

const configuration = JSON.parse(
  readFileSync(new URL("./publication.config.json", import.meta.url), "utf8"),
) as { readonly packagePath: string };

/** 发布目标由生成时的结构化配置拥有，入口不再分别维护包路径。 */
export const publicationPackagePath = configuration.packagePath;
