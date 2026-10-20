export {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  prepareGeneratedRepositoryPackageAddition,
  validateGeneratedRepositoryInitializationInput,
  validateGeneratedRepositoryPackageAdditionInput,
  prepareGeneratedRepositoryInitialization,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  validateProjectBlueprint,
} from "./foundation.ts";
export { referencePackagePublicationContexts } from "./shared/reference-packages.ts";
export {
  createVueHonoProjectContent,
  type VueHonoProjectContent,
} from "./vue-hono-app/project-content.ts";
export {
  createVikeProjectContents,
  type VikeProjectContents,
  type VikeProjectNodeIdentities,
} from "./vike-app/project-content.ts";
export { generationRecordSchema } from "./generation-record.ts";
export type {
  BuiltInPresetDefinition,
  GeneratedRepositoryPlan,
  PackageContribution,
  ProjectBlueprint,
  BuiltInGenerationContext,
  LocalTemplateMetadata,
  InitializationIdentityOverrides,
  InitializationInputIssue,
  InitializationInputValidation,
  InitializationPreparation,
  PackageAdditionBusinessConflict,
  PackageAdditionInputIssue,
  PackageAdditionPreparation,
  NextStepInstruction,
  PublicationSetupHandoff,
  ResolvedInitialization,
} from "./foundation.ts";
