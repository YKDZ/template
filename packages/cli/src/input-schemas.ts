import path from "node:path";

import * as v from "valibot";

import {
  validateInitializationInput,
  validatePackageAdditionInput,
  type InitializationInputIssue,
  type PackageAdditionInputIssue,
} from "./input-validation.ts";
import { cliPresets } from "./preset-catalog.ts";
import { standardSchema } from "./standard-schema.ts";

const initializationPresetChoices = cliPresets
  .filter((preset) => preset.definition.operations.includes("init"))
  .map((preset) => preset.alias);
const additionPresetChoices = cliPresets
  .filter((preset) => preset.definition.operations.includes("add"))
  .map((preset) => preset.alias);

const initializationMessages: Record<InitializationInputIssue["code"], string> =
  {
    PRESET_UNKNOWN: "请选择有效的预设。",
    FIXED_TOPOLOGY_OVERRIDE: "固定拓扑预设不支持覆盖初始包名称或路径。",
    INVALID_PACKAGE_NAME: "--name 必须是有效的无 scope 包叶名称。",
    INVALID_PACKAGE_PATH: "--path 必须恰好包含两个安全路径段。",
    RESERVED_PACKAGE_PATH: "--path 不能使用保留的工作区目录。",
    INVALID_PACKAGE_SCOPE: "--scope 必须是不含空白字符的有效 npm scope。",
    INVALID_REPOSITORY_SCOPE: "目标目录名无法作为默认 scope，请指定 --scope。",
    CONFLICTING_PACKAGE_IDENTITY: "初始包身份与基础配置包冲突。",
  };

export function initializationInputSchema(cwd: string) {
  return standardSchema(
    v.pipe(
      v.object({
        dir: v.pipe(v.string(), v.nonEmpty()),
        preset: v.picklist(initializationPresetChoices),
        name: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "无 scope 的 npm 包叶名称；仅可配置主包的预设允许覆盖。",
            ),
          ),
        ),
        path: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "两个安全路径段；不能使用保留目录；仅可配置主包的预设允许覆盖。",
            ),
          ),
        ),
        scope: v.optional(
          v.pipe(
            v.string(),
            v.description("有效 npm scope；省略时使用目标目录名。"),
          ),
        ),
        dryRun: v.optional(v.boolean(), false),
        todo: v.optional(v.boolean(), true),
        publication: v.optional(v.boolean(), false),
      }),
      v.rawCheck(({ dataset, addIssue }) => {
        if (!dataset.typed) return;
        const { dir, preset, name, path: packagePath, scope } = dataset.value;
        const result = validateInitializationInput({
          preset,
          targetDir: path.resolve(cwd, dir),
          overrides: {
            ...(name === undefined ? {} : { name }),
            ...(packagePath === undefined ? {} : { path: packagePath }),
            ...(scope === undefined ? {} : { scope }),
          },
        });
        if (result.status === "input-invalid") {
          for (const issue of result.issues) {
            addIssue({ message: initializationMessages[issue.code] });
          }
        }
      }),
    ),
    ["raw_check"],
  );
}

const additionMessages: Record<PackageAdditionInputIssue["code"], string> = {
  PRESET_UNKNOWN: "请选择有效的预设。",
  PRESET_NOT_ADDABLE: "该预设不支持新增包。",
  INVALID_PACKAGE_NAME: "--name 必须是有效的无 scope 包叶名称。",
  INVALID_PACKAGE_PATH: "--path 必须恰好包含两个安全路径段。",
  RESERVED_PACKAGE_PATH: "--path 不能使用保留工作区目录。",
  INVALID_LINK_FROM: "--link-from 必须恰好包含两个安全路径段。",
  RESERVED_LINK_FROM: "--link-from 不能使用保留工作区目录。",
  UNKNOWN_LINK_FROM: "指定的消费包不存在。",
  UNSUPPORTED_LINK: "指定的包角色不支持此链接。",
};

export const packageAdditionInputSchema = standardSchema(
  v.pipe(
    v.object({
      preset: v.picklist(additionPresetChoices),
      name: v.pipe(v.string(), v.description("无 scope 的 npm 包叶名称。")),
      path: v.optional(
        v.pipe(
          v.string(),
          v.description("两个安全路径段，不能使用保留工作区目录。"),
        ),
      ),
      linkFrom: v.optional(
        v.array(
          v.pipe(
            v.string(),
            v.description(
              "消费包路径：两个安全路径段，不能使用保留工作区目录。",
            ),
          ),
        ),
        [],
      ),
      publication: v.optional(v.boolean(), false),
      dryRun: v.optional(v.boolean(), false),
    }),
    v.rawCheck(({ dataset, addIssue }) => {
      if (!dataset.typed) return;
      const input = dataset.value;
      const result = validatePackageAdditionInput({
        preset: input.preset,
        packageLeafName: input.name,
        linkFrom: input.linkFrom,
        ...(input.path === undefined ? {} : { packagePath: input.path }),
      });
      if (result.status === "input-invalid") {
        for (const issue of result.issues) {
          addIssue({ message: additionMessages[issue.code] });
        }
      }
    }),
  ),
  ["raw_check"],
);

/** 本轮配置入口只显式开启发布，不扩展卸载或其他配置操作。 */
export const packageConfigurationInputSchema = standardSchema(
  v.pipe(
    v.object({
      path: v.pipe(
        v.string(),
        v.nonEmpty(),
        v.description("蓝图中已登记的包路径。"),
      ),
      publication: v.optional(v.boolean(), false),
      dryRun: v.optional(v.boolean(), false),
    }),
    v.rawCheck(({ dataset, addIssue }) => {
      if (dataset.typed && !dataset.value.publication)
        addIssue({ message: "请通过 --publication 明确开启发布。" });
    }),
  ),
  ["raw_check"],
);
