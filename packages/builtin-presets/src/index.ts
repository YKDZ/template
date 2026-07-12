export {
  builtInPresetRegistry,
  builtInPresetTemplateSourceCheckContexts,
  builtInPresetTemplateSourceContexts,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  validateProjectBlueprintV2,
} from "./foundation.ts";
export { templateSources } from "./template-sources.ts";
export type {
  BuiltInPresetDefinition,
  BuiltInPresetTemplateSourceCheckContext,
  GeneratedRepositoryPlan,
  PackageContribution,
  ProjectBlueprintV2,
  BuiltInGenerationContext,
} from "./foundation.ts";
