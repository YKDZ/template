import {
  contentIdentityKey,
  isContentIdentity,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import type {
  GeneratorContent,
  PackageCreationInput,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";
import { createGenerator } from "@ykdz/template-generator";

type DocumentationContext = {
  readonly targetRoot: string;
  readonly policyId: string;
  readonly collection: string;
  readonly edition: string;
};

type DocumentationInput = {
  readonly collection: string;
  readonly edition: string;
};

type DocumentationState = {
  readonly policyId: string;
  readonly collection: string;
  readonly edition: string;
};

type DocumentationContribution = {
  readonly definition: PackageDefinition;
  readonly operations: readonly RenderOperation[];
};

type DocumentationContent = GeneratorContent<
  DocumentationContext,
  DocumentationContribution,
  PackageCreationInput
>;

export const guideIdentity = {
  namespace: "test-docs",
  packageName: "@fixture/docs-guide",
  exportPath: "./template",
} satisfies ContentIdentity;
export const glossaryIdentity = {
  namespace: "test-docs",
  packageName: "@fixture/docs-glossary",
  exportPath: "./template",
} satisfies ContentIdentity;
export const guideIdentityKey = contentIdentityKey(guideIdentity);
export const glossaryIdentityKey = contentIdentityKey(glossaryIdentity);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocumentationState(value: unknown): DocumentationState {
  if (
    !isRecord(value) ||
    typeof value.policyId !== "string" ||
    typeof value.collection !== "string" ||
    typeof value.edition !== "string"
  ) {
    throw new Error("文档策略记录缺少必要事实");
  }
  return {
    policyId: value.policyId,
    collection: value.collection,
    edition: value.edition,
  };
}

export function createDocumentationEngine(options: {
  readonly policyId: string;
  readonly author: string;
  readonly includeGlossary?: boolean;
  readonly configurableGlossary?: boolean;
  readonly glossaryUsesGuide?: boolean;
  readonly invalidProjection?: "duplicate" | "unallocated";
}) {
  const glossary: DocumentationContent = {
    identity: glossaryIdentity,
    kind: "reference",
    alias: "glossary",
    source: {
      specifier: "@fixture/docs-glossary/template",
      moduleURL: "file:///fixture/docs-glossary/template.js",
      manifestURL: "file:///fixture/docs-glossary/package.json",
    },
    definition: {
      alias: "glossary",
      instance: "shared",
      defaultLeafName: "glossary",
      defaultPath: "docs/glossary",
      role: "documentation",
      contribute({ context, definition }) {
        return {
          definition,
          operations: [
            {
              kind: "writeText",
              to: `${definition.path}/README.md`,
              text: `${context.collection}/${context.edition} glossary by ${options.author}\n`,
            },
          ],
        };
      },
    },
  };
  const guide: DocumentationContent = {
    identity: guideIdentity,
    kind: "reference",
    alias: "guide",
    source: {
      specifier: "@fixture/docs-guide/template",
      moduleURL: "file:///fixture/docs-guide/template.js",
      manifestURL: "file:///fixture/docs-guide/package.json",
    },
    definition: {
      alias: "guide",
      instance: "independent",
      defaultLeafName: "overview",
      defaultPath: "docs/overview",
      role: "documentation",
      normalizeConfiguration(input) {
        if (!options.configurableGlossary) return null;
        if (input === undefined) return { glossary: false };
        if (!isRecord(input) || typeof input.glossary !== "boolean")
          throw new Error("指南配置必须声明glossary布尔值");
        return { glossary: input.glossary };
      },
      contribute({ context, definition, bindings, configuration }) {
        const glossaryDefinition = bindings?.get(glossaryIdentityKey);
        if (
          glossaryDefinition === undefined &&
          !(
            options.configurableGlossary &&
            isRecord(configuration) &&
            configuration.glossary === false
          )
        ) {
          throw new Error("文档内容缺少术语表绑定");
        }
        return {
          definition,
          operations: [
            {
              kind: "writeText",
              to: `${definition.path}/README.md`,
              text: `${context.collection}/${context.edition} by ${options.author}: ${definition.name} uses ${glossaryDefinition?.path ?? "no glossary"}\n`,
            },
          ],
        };
      },
    },
  };
  const content =
    options.includeGlossary === false ? [guide] : [guide, glossary];

  const strategy: WorkspaceStrategy<
    DocumentationContext,
    DocumentationInput,
    DocumentationState,
    DocumentationContribution,
    PackageCreationInput,
    DocumentationContent
  > = {
    identity: options.policyId,
    initialize({ targetRoot, input, selection }) {
      if (
        selection.length !== 1 ||
        !isContentIdentity(selection[0]?.contentIdentity) ||
        contentIdentityKey(selection[0].contentIdentity) !== guideIdentityKey
      ) {
        throw new Error("文档策略只接受明确选择的指南内容");
      }
      const state = { policyId: options.policyId, ...input };
      return { context: { targetRoot, ...state }, state };
    },
    prepareUpdate({ targetRoot, state }) {
      return { targetRoot, ...state };
    },
    parseState: parseDocumentationState,
    dependencies({ content: selected, configuration }) {
      if (
        options.glossaryUsesGuide &&
        contentIdentityKey(selected.identity) === glossaryIdentityKey
      )
        return [guideIdentity];
      return contentIdentityKey(selected.identity) === guideIdentityKey &&
        !(
          options.configurableGlossary &&
          isRecord(configuration) &&
          configuration.glossary === false
        )
        ? [glossaryIdentity]
        : [];
    },
    bindings({ providers }) {
      return new Map(providers);
    },
    createDefinition({ context, content: selected, creationInput }) {
      const selectedDefinition = selected.definition;
      const leafName = creationInput?.leafName;
      const leaf = leafName ?? selectedDefinition.defaultLeafName;
      return {
        name: `${context.collection}:${leaf}`,
        path:
          creationInput?.packagePath ??
          (leafName === undefined
            ? selectedDefinition.defaultPath
            : `docs/${leafName}`),
        role: selectedDefinition.role,
      };
    },
    project({ context, state, blueprint, contributions }) {
      const index = [
        `${state.collection}/${state.edition} (${state.policyId})`,
        ...blueprint.packages
          .map(
            (definition) =>
              `${definition.role}\t${definition.name}\t${definition.path}`,
          )
          .toSorted(),
      ].join("\n");
      const strategyDocument = {
        policyId: context.policyId,
        collection: context.collection,
        edition: context.edition,
      };
      return {
        ownerFacts: {
          edition: state.edition,
          packageCount: blueprint.packages.length,
        },
        ...(options.invalidProjection === "duplicate"
          ? {
              blueprint: {
                ...blueprint,
                packages: [...blueprint.packages, ...blueprint.packages],
              },
            }
          : options.invalidProjection === "unallocated"
            ? {
                blueprint: {
                  ...blueprint,
                  packages: [
                    ...blueprint.packages,
                    {
                      ...blueprint.packages[0]!,
                      packageDefinitionId: `package-${"a".repeat(64)}`,
                      name: "north:unallocated",
                      path: "docs/unallocated",
                    },
                  ],
                },
              }
            : {}),
        operations: [
          ...contributions.flatMap((contribution) => contribution.operations),
          {
            kind: "writeJson",
            to: ".template/blueprint.json",
            value: blueprint,
          },
          { kind: "writeText", to: "INDEX.md", text: `${index}\n` },
          {
            kind: "writeJson",
            to: ".workspace/strategy.json",
            value: strategyDocument,
          },
        ],
        reconciliation: [
          { path: ".template/blueprint.json", driver: "canonical" },
          { path: "INDEX.md", driver: "text" },
          { path: ".workspace/strategy.json", driver: "canonical" },
        ],
      };
    },
  };

  return createGenerator({ content, strategy });
}
