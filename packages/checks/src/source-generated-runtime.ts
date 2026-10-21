import { projectPublicationWorkspace } from "@ykdz/reference-npm-publication/template";
import { templateContent } from "@ykdz/template-content";
import { resolveTemplateSource } from "@ykdz/template-core/renderer";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import {
  canConsumeNodePackageNameImportForRole,
  canProvideSourceConditionPackageNameImportForRole,
} from "@ykdz/template-workspace/project-linking";

import type { GeneratedScenarioRuntime } from "./generated-content.ts";

/** 源码作者门使用的正式公开模块集合；安装门必须显式注入已安装模块。 */
export const sourceGeneratedScenarioRuntime: GeneratedScenarioRuntime = {
  content: templateContent,
  createGenerator,
  createDefaultWorkspaceStrategy,
  projectPublicationWorkspace,
  resolveTemplateSource,
  canConsumeNodePackageNameImportForRole,
  canProvideSourceConditionPackageNameImportForRole,
};
