export {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  validateProjectBlueprint,
} from "./foundation.ts";
export { templateSources } from "./template-sources.ts";
export type {
  BuiltInPresetDefinition,
  GeneratedRepositoryPlan,
  PackageContribution,
  ProjectBlueprint,
  BuiltInGenerationContext,
  LocalTemplateMetadata,
} from "./foundation.ts";
