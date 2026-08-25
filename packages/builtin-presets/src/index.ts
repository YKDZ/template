export {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  validateProjectBlueprintV2,
} from "./foundation.ts";
export { templateSources } from "./template-sources.ts";
export type {
  BuiltInPresetDefinition,
  GeneratedRepositoryPlan,
  PackageContribution,
  ProjectBlueprintV2,
  BuiltInGenerationContext,
} from "./foundation.ts";
