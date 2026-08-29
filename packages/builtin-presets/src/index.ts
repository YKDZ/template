export {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  prepareGeneratedRepositoryInitialization,
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
  InitializationIdentityOverrides,
  PublicationSetupHandoff,
  ResolvedInitialization,
} from "./foundation.ts";
