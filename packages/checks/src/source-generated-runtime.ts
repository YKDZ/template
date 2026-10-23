import { templateContent } from "@ykdz/template-content";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

import type { GeneratedScenarioRuntime } from "./generated-content.ts";

/** 源码作者门使用正式内容集合与默认 SDK。 */
export const sourceGeneratedScenarioRuntime: GeneratedScenarioRuntime = {
  content: templateContent,
  createDefaultGenerator,
};
