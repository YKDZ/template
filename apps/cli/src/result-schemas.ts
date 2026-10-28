import { generationRecordSchema } from "@ykdz/template-core/generation-record";
import { projectBlueprintSchema } from "@ykdz/template-core/project-blueprint";
import { z } from "zod";

/** 持久数据结构沿用所属模块的声明，CLI 只声明命令额外提供的事实。 */
export const initializationSchema = z.object({
  dryRun: z.boolean(),
  targetDir: z.string(),
  resolved: z.object({
    preset: z.string(),
    topology: z.enum(["configurable-primary-package", "fixed"]),
    packages: z.array(z.object({ name: z.string(), path: z.string() })),
    scope: z.string(),
  }),
  blueprint: projectBlueprintSchema,
  generationRecord: generationRecordSchema,
  toolchain: z.object({
    nodeVersion: z.string(),
    packageManagerPin: z.string(),
  }),
  nextSteps: z.array(z.object({ display: z.string() })),
  followUpDocument: z.object({
    enabled: z.boolean(),
    path: z.string().optional(),
  }),
});

const packageUpdateSchema = z.object({
  dryRun: z.boolean(),
  actions: z.array(
    z.object({
      path: z.string(),
      driver: z.enum(["structured", "text", "canonical"]),
      action: z.enum(["create", "update"]),
    }),
  ),
});

export const packageAdditionSchema = packageUpdateSchema;

const projectProjectionSource = z.object({
  identity: z.string(),
  label: z.string(),
});
const region = z.object({ startLine: z.number(), lineCount: z.number() });
const packageIdentity = z.object({
  name: z.string(),
  path: z.string(),
  role: z.string(),
});
export const packageConflictSchema = z.object({
  dryRun: z.boolean(),
  actions: z.tuple([]),
  conflicts: z.array(
    z.union([
      z.object({
        kind: z.literal("identity"),
        existing: packageIdentity,
        requested: packageIdentity,
      }),
      z.object({
        path: z.string(),
        driver: z.enum(["structured", "text", "canonical", "precondition"]),
        location: z.string().optional(),
        attribute: z
          .enum(["file-kind", "binary-content", "executable-mode"])
          .optional(),
        region: z
          .object({ before: region, current: region, after: region })
          .optional(),
        sources: z.array(projectProjectionSource).optional(),
        reason: z.string(),
        context: z.object({
          before: z.string(),
          current: z.string(),
          after: z.string(),
        }),
      }),
    ]),
  ),
});
