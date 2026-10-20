import {
  type GeneratorContent,
  type GeneratorNodeInstances,
  type PackageCreationInput,
} from "@ykdz/template-core/workspace-strategy";
import { dockerEngineEnvironmentNeed } from "@ykdz/template-environment/module-graph";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/preset-definition";
import type { ReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

type GeneratorContributionOptions<CreationInput extends PackageCreationInput> =
  Parameters<
    GeneratorContent<
      GenerationContext,
      PackageContribution,
      CreationInput
    >["contribute"]
  >[0];

type StrategyReferencePackage<CreationInput extends PackageCreationInput> =
  Omit<ReferencePackage, "contribute"> &
    Pick<
      GeneratorContent<GenerationContext, PackageContribution, CreationInput>,
      "contribute"
    >;

export type VikeProjectNodeIdentities = {
  readonly web: string;
  readonly database: string;
  readonly migrations: string;
};

export type VikeProjectContents<CreationInput extends PackageCreationInput> = {
  readonly web: StrategyReferencePackage<CreationInput>;
  readonly database: StrategyReferencePackage<CreationInput>;
};

/** 将 Vike 应用、数据库和迁移实例组合成策略可解释的封闭项目要求。 */
export function createVikeProjectContents<
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(options: {
  readonly web: ReferencePackage;
  readonly database: ReferencePackage;
  readonly nodeIdentities: VikeProjectNodeIdentities;
}): VikeProjectContents<CreationInput> {
  const requireProjectInstances = (instances: GeneratorNodeInstances) => {
    const web = instances.get(options.nodeIdentities.web);
    const database = instances.get(options.nodeIdentities.database);
    const migrations = instances.get(options.nodeIdentities.migrations);
    if (
      web === undefined ||
      database === undefined ||
      migrations === undefined
    ) {
      throw new Error("缺少 Vike 项目所需的 web、数据库或迁移实例");
    }
    return { web, database, migrations };
  };

  return {
    web: {
      ...options.web,
      contribute(input: GeneratorContributionOptions<CreationInput>) {
        const contribution = options.web.contribute(input);
        if (input.createdBy !== "initialization") return contribution;
        const instances = requireProjectInstances(input.nodeInstances);
        return {
          ...contribution,
          projectRequirements: [
            ...(contribution.projectRequirements ?? []),
            {
              kind: "application-container-with-database-migrations",
              application: instances.web,
              database: instances.database,
              migrations: instances.migrations,
              environmentNeeds: [dockerEngineEnvironmentNeed()],
            },
          ],
        };
      },
    },
    database: {
      ...options.database,
      contribute(input: GeneratorContributionOptions<CreationInput>) {
        const contribution = options.database.contribute(input);
        if (input.createdBy !== "initialization") return contribution;
        const instances = requireProjectInstances(input.nodeInstances);
        return {
          ...contribution,
          projectRequirements: [
            ...(contribution.projectRequirements ?? []),
            {
              kind: "sqlite-database-preparation",
              web: instances.web,
              database: instances.database,
              migrations: instances.migrations,
            },
          ],
        };
      },
    },
  };
}
