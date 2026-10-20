import type {
  GeneratorContentDefinition,
  PackageCreationInput,
} from "@ykdz/template-core/workspace-strategy";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/preset-definition";
import type { ReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

type GeneratorContributionOptions<CreationInput extends PackageCreationInput> =
  Parameters<
    GeneratorContentDefinition<
      GenerationContext,
      PackageContribution,
      CreationInput
    >["contribute"]
  >[0];

export type VueHonoProjectContent<CreationInput extends PackageCreationInput> =
  Omit<ReferencePackage, "contribute"> &
    Pick<
      GeneratorContentDefinition<
        GenerationContext,
        PackageContribution,
        CreationInput
      >,
      "contribute"
    >;

/** 将 Hono API 实例与 Vue-Hono web 内容组合为封闭的联合验收需求。 */
export function createVueHonoProjectContent<
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(options: {
  readonly web: ReferencePackage;
  readonly apiNodeIdentity: string;
}): VueHonoProjectContent<CreationInput> {
  return {
    ...options.web,
    contribute(input: GeneratorContributionOptions<CreationInput>) {
      const contribution = options.web.contribute(input);
      if (input.createdBy !== "initialization") return contribution;

      const api = input.nodeInstances.get(options.apiNodeIdentity);
      if (api === undefined) {
        throw new Error(
          `缺少 Vue-Hono 联合验收所需的 ${options.apiNodeIdentity} 实例`,
        );
      }
      return {
        ...contribution,
        projectRequirements: [
          ...(contribution.projectRequirements ?? []),
          {
            kind: "vue-hono-joint-e2e",
            web: input.definition,
            api,
          },
        ],
      };
    },
  };
}
