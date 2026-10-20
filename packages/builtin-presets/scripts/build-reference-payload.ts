import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { templateReferencePackages } from "@ykdz/template-content";
import {
  renderProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { mapTypeScriptModuleSpecifiers } from "@ykdz/template-workspace-authoring/typescript-module-specifiers";

const output = fileURLToPath(
  new URL("../dist/reference-packages/", import.meta.url),
);
await rm(output, { recursive: true, force: true });

for (const reference of templateReferencePackages) {
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

// 作者使用公开依赖入口，分发制品使用同一描述的编译副本。
// 复用正式渲染器的模块映射，不携带完整参考包的运行依赖。
const distributionRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const compiledSource = path.join(distributionRoot, "src");
for (const file of await readdir(compiledSource, { recursive: true })) {
  if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
  const target = path.join(compiledSource, file);
  const moduleSpecifiers = new Map(
    templateReferencePackages.map((reference) => {
      const relative = path
        .relative(
          path.dirname(target),
          path.join(output, reference.manifest.name, "template-dist/entry.js"),
        )
        .split(path.sep)
        .join("/");
      return [
        reference.manifest.name + "/template",
        relative.startsWith(".") ? relative : "./" + relative,
      ];
    }),
  );
  const original = await readFile(target, "utf8");
  const text = mapTypeScriptModuleSpecifiers(
    original,
    moduleSpecifiers,
    target,
  );
  if (text === original) continue;
  await renderProject({
    targetRoot: distributionRoot,
    operations: [
      {
        kind: "writeText",
        to: path.posix.join("src", file),
        text,
        mode: (await stat(target)).mode & 0o777,
        overwrite: true,
      },
    ],
  });
}
