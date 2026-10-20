import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveTemplateMembers, templateContent } from "@ykdz/template-content";
import {
  renderProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";

const output = fileURLToPath(
  new URL("../dist/reference-packages/", import.meta.url),
);
const { referencePackages } = deriveTemplateMembers(templateContent);
await rm(output, { recursive: true, force: true });

for (const reference of referencePackages) {
  const targetRoot = path.join(output, reference.manifest.name);
  const templateExport = reference.manifest.exports?.["./template"];
  const entry =
    typeof templateExport === "object" && templateExport !== null
      ? (templateExport as Record<string, unknown>).default
      : undefined;
  if (typeof entry !== "string" || !entry.startsWith("./"))
    throw new Error(`参考包缺少默认生成描述入口：${reference.manifest.name}`);

  await renderProject({
    targetRoot,
    operations: reference.payloadOperations(""),
  });
  await mkdir(targetRoot, { recursive: true });
  await cp(
    resolveTemplateSource(reference.source("package.json"), "."),
    path.join(targetRoot, "package.json"),
  );

  // 编译产物有独立发布职责，不受源资源的 Git 忽略规则排除。
  const compiledDirectory = path.posix.dirname(entry).replace(/^\.\//u, "");
  await cp(
    resolveTemplateSource(reference.source(compiledDirectory), "."),
    path.join(targetRoot, compiledDirectory),
    { recursive: true },
  );
  const loaderDirectory = path.join(targetRoot, "template-dist");
  await mkdir(loaderDirectory, { recursive: true });
  await writeFile(
    path.join(loaderDirectory, "entry.js"),
    `export * from ${JSON.stringify(`../${entry.slice(2)}`)};\n`,
  );
}
