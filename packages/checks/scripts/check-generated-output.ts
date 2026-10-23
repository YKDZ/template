import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { inspectTaskGate } from "@ykdz/reference-workspace-root/task-gates";
import { generatorMetadataPaths } from "@ykdz/template-generator";
import formatterConfig from "@ykdz/tooling-config/oxfmt";
import { format } from "oxfmt";
import { parse as parseToml } from "smol-toml";

import { validateGeneratedScenarioReceipt } from "../src/registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";
import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  materializeGeneratedScenario,
  type GeneratedScenarioReceipt,
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

/** 检查生成器实际写入的文件与有限owner事实。 */
export async function validateGeneratedOutput(
  receipt: GeneratedScenarioReceipt,
): Promise<void> {
  const { projectDir } = receipt;
  await validateGeneratedScenarioReceipt({
    receipt,
    runtime: sourceGeneratedScenarioRuntime,
  });
  const expectedMetadata = new Map<string, unknown>([
    [generatorMetadataPaths.blueprint, receipt.result.blueprint],
    [generatorMetadataPaths.generationRecord, receipt.result.generationRecord],
  ]);
  for (const [metadataPath, expectedValue] of expectedMetadata) {
    const expectedEntry = receipt.result.projection.entries.find(
      (entry) => entry.path === metadataPath,
    );
    if (expectedEntry?.kind !== "file")
      throw new Error(`${metadataPath} 不在正式投影文件中`);
    const actualBytes = await readFile(path.join(projectDir, metadataPath));
    if (!Buffer.from(expectedEntry.content).equals(actualBytes))
      throw new Error(`${metadataPath} 与正式 SDK 投影字节不一致`);
    let actualValue: unknown;
    try {
      actualValue = JSON.parse(actualBytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error(`${metadataPath} 不是有效 JSON`, { cause: error });
    }
    if (!isDeepStrictEqual(actualValue, expectedValue))
      throw new Error(`${metadataPath} 与正式 SDK 结果不一致`);
  }
  for (const file of await outputFiles(projectDir)) {
    if (expectedMetadata.has(file)) continue;
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
      ...deriveFixtureMatrix(sourceGeneratedScenarioRuntime),
      ...deriveFocusedProjectLinkScenarios(sourceGeneratedScenarioRuntime),
    ]) {
      const receipt = await materializeGeneratedScenario({
        runtime: sourceGeneratedScenarioRuntime,
        workspace,
        scenario,
        conventions: { defaultPackageScope: "output-audit" },
        ...(Object.keys(scenario.base.definition.nodes).length === 1
          ? {
              initializationCreationInput: {
                leafName: "custom-main",
                packagePath: "products/custom-main",
              },
            }
          : {}),
        ...(scenario.addition === undefined
          ? {}
          : {
              additionIdentity: {
                name: `custom-${scenario.addition.definition.metadata.alias}`,
                path: `modules/custom-${scenario.addition.definition.metadata.alias}`,
              },
            }),
      });
      if (receipt.status === "not-applicable") continue;
      try {
        await validateGeneratedOutput(receipt);
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
