import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import formatterConfig from "@ykdz/reference-typescript-config/oxfmt";
import {
  loadLocalTemplateMetadata,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import { inspectTaskGate } from "@ykdz/template-workspace/task-gates";
import { format } from "oxfmt";
import { parse as parseToml } from "smol-toml";

import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  validateGeneratedDevelopmentContainerProjection,
  validatePlanDependencyCatalog,
} from "../src/registry-checks.ts";
import {
  assertGeneratedManifestPublicationPolicy,
  materializeGeneratedScenario,
} from "./generated-scenario.ts";

async function outputFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    if ([".git", ".turbo", "node_modules"].includes(entry.name)) continue;
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await outputFiles(root, file)));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

/** 检查实际落盘结果；不安装生成工作区，也不执行其检查任务。 */
export async function validateGeneratedOutput(options: {
  readonly projectDir: string;
  readonly plan: GeneratedRepositoryPlan;
}): Promise<void> {
  const { projectDir, plan } = options;
  loadLocalTemplateMetadata(projectDir);
  await validatePlanDependencyCatalog(plan, projectDir);
  await assertGeneratedManifestPublicationPolicy(options);
  await validateGeneratedDevelopmentContainerProjection(options);
  for (const file of await outputFiles(projectDir)) {
    if (
      !/\.(?:[cm]?[jt]sx?|vue|jsonc?|ya?ml|toml|md|html|css)$/u.test(file) &&
      !file.endsWith("Cargo.lock")
    )
      continue;
    const source = await readFile(path.join(projectDir, file), "utf8");
    if (file.endsWith("Cargo.lock")) {
      parseToml(source);
      continue;
    }
    const formatted = await format(file, source, formatterConfig);
    if (formatted.errors.length > 0)
      throw new Error(
        `${file} 最终生成内容无法解析：${JSON.stringify(formatted.errors)}`,
      );
    if (formatted.code !== source)
      throw new Error(`${file} 最终生成格式不符合所属原生政策`);
  }
  const turboCommand = [
    process.execPath,
    fileURLToPath(import.meta.resolve("turbo")),
  ] as const;
  for (const gate of ["check:full", "fix"] as const) {
    const analysis = inspectTaskGate(gate, projectDir, undefined, turboCommand);
    if (analysis.diagnostics.length > 0)
      throw new Error(
        `${gate} 最终生成任务配置无效：\n${analysis.diagnostics.join("\n")}`,
      );
  }
}

export async function checkGeneratedOutputs(): Promise<void> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-generated-output-"),
  );
  try {
    for (const scenario of [
      ...deriveFixtureMatrix(),
      ...deriveFocusedProjectLinkScenarios(),
    ]) {
      const result = await materializeGeneratedScenario({
        workspace,
        scenario,
        initializationOverrides: {
          scope: "output-audit",
          ...(scenario.base.initialPrimaryPackage === undefined
            ? {}
            : { name: "custom-main", path: "products/custom-main" }),
        },
        ...(scenario.addition === undefined
          ? {}
          : {
              additionIdentity: {
                name: `custom-${scenario.addition.metadata.name}`,
                path: `modules/custom-${scenario.addition.metadata.name}`,
              },
            }),
      });
      try {
        await validateGeneratedOutput(result);
      } catch (error) {
        throw new Error(`${scenario.id} 最终生成检查失败`, { cause: error });
      }
      console.log(`${scenario.id} 最终生成检查通过`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  await checkGeneratedOutputs();
