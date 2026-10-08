import { generationRecordSchema } from "@ykdz/template-builtin-presets";
import { projectBlueprintSchema } from "@ykdz/template-core/project-blueprint";
import * as v from "valibot";

import { standardSchema } from "./standard-schema.ts";

/** 持久数据结构沿用所属模块的声明，CLI 只声明命令额外提供的事实。 */
export const initializationSchema = standardSchema(
  v.object({
    dryRun: v.boolean(),
    targetDir: v.string(),
    resolved: v.object({
      preset: v.string(),
      topology: v.picklist(["configurable-primary-package", "fixed"]),
      packages: v.array(v.object({ name: v.string(), path: v.string() })),
      scope: v.string(),
    }),
    blueprint: projectBlueprintSchema,
    generationRecord: generationRecordSchema,
    toolchain: v.object({
      nodeVersion: v.string(),
      packageManagerPin: v.string(),
    }),
    nextSteps: v.array(v.object({ display: v.string() })),
    publicationSetup: v.nullable(v.object({ command: v.string() })),
    followUpDocument: v.object({
      enabled: v.boolean(),
      path: v.optional(v.string()),
    }),
  }),
);

export const packageAdditionSchema = standardSchema(
  v.object({
    dryRun: v.boolean(),
    actions: v.array(
      v.object({
        path: v.string(),
        driver: v.picklist(["structured", "text", "canonical"]),
        action: v.picklist(["create", "update"]),
      }),
    ),
  }),
);

const packageIdentity = v.object({
  name: v.string(),
  path: v.string(),
  role: v.string(),
});
const region = v.object({ startLine: v.number(), lineCount: v.number() });
export const packageConflictSchema = standardSchema(
  v.object({
    dryRun: v.boolean(),
    actions: v.tuple([]),
    conflicts: v.array(
      v.union([
        v.object({
          kind: v.picklist(["identity", "missing-link"]),
          existing: packageIdentity,
          requested: packageIdentity,
          missingLink: v.optional(
            v.object({
              consumerPackagePath: v.string(),
              providerPackagePath: v.string(),
            }),
          ),
        }),
        v.object({
          path: v.string(),
          driver: v.picklist([
            "structured",
            "text",
            "canonical",
            "precondition",
          ]),
          location: v.optional(v.string()),
          attribute: v.optional(
            v.picklist(["file-kind", "binary-content", "executable-mode"]),
          ),
          region: v.optional(
            v.object({ before: region, current: region, after: region }),
          ),
          reason: v.string(),
          context: v.object({
            before: v.string(),
            current: v.string(),
            after: v.string(),
          }),
        }),
      ]),
    ),
  }),
);
