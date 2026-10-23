import type { Composition } from "@ykdz/template-core/composition";
import {
  contentIdentityKey,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  PackageDefinition,
  PackageDefinitionId,
} from "@ykdz/template-core/project-blueprint";
import type { PackageBinding } from "@ykdz/template-core/reference-package";
import { createGenerator } from "@ykdz/template-generator";

export const guideIdentity: ContentIdentity = {
  namespace: "test-docs",
  packageName: "@fixture/docs-guide",
  exportPath: "./template",
};
export const glossaryIdentity: ContentIdentity = {
  namespace: "test-docs",
  packageName: "@fixture/docs-glossary",
  exportPath: "./template",
};
export const indexIdentity: ContentIdentity = {
  namespace: "test-docs",
  packageName: "@fixture/docs-index",
  exportPath: "./template",
};
export const guideIdentityKey = contentIdentityKey(guideIdentity);
export const glossaryIdentityKey = contentIdentityKey(glossaryIdentity);

export type DocumentationConventions = {
  readonly collection: string;
  readonly edition: string;
};
export type DocumentationCreationInput = {
  readonly leafName?: string;
  readonly packagePath?: string;
};
export type DocumentationContribution = PackageContribution<{
  readonly path: string;
}>;
export type DocumentationFacts = {
  readonly edition: string;
  readonly packageCount: number;
};
export type DocumentationComposition = Composition<
  DocumentationConventions,
  DocumentationConventions,
  unknown,
  DocumentationContribution["facts"],
  DocumentationFacts,
  DocumentationCreationInput
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCreationInput(value: unknown): DocumentationCreationInput {
  if (!isRecord(value)) throw new Error("包创建输入必须是对象");
  if (value.leafName !== undefined && typeof value.leafName !== "string") {
    throw new Error("包创建输入 leafName 必须是字符串");
  }
  if (
    value.packagePath !== undefined &&
    typeof value.packagePath !== "string"
  ) {
    throw new Error("包创建输入 packagePath 必须是字符串");
  }
  return {
    ...(value.leafName === undefined ? {} : { leafName: value.leafName }),
    ...(value.packagePath === undefined
      ? {}
      : { packagePath: value.packagePath }),
  };
}

function makeReference(options: {
  readonly identity: ContentIdentity;
  readonly alias: string;
  readonly instance: "shared" | "independent";
  readonly defaultPath: string;
  readonly author: string;
  readonly text: string;
  readonly dependencies?: readonly {
    key: string;
    contentIdentity: ContentIdentity;
  }[];
}): LoadedContentMember<unknown, "reference"> {
  return {
    identity: options.identity,
    kind: "reference",
    alias: options.alias,
    source: {
      specifier: `${options.identity.packageName}/template`,
      moduleURL: `file:///fixture/${options.alias}/template.js`,
      manifestURL: `file:///fixture/${options.alias}/package.json`,
    },
    definition: {
      alias: options.alias,
      instance: options.instance,
      prepare() {
        return {
          resources: [
            {
              path: "README.md",
              content: new TextEncoder().encode(options.text),
              mode: 0,
            },
          ],
          facts: {},
        };
      },
      ...(options.dependencies === undefined
        ? {}
        : { dependencies: options.dependencies }),
      parseCreationInput,
      createDefinition({
        conventions,
        creationInput,
      }: {
        readonly conventions: DocumentationConventions;
        readonly creationInput: DocumentationCreationInput | undefined;
      }): PackageDefinition {
        const leaf = creationInput?.leafName ?? options.alias;
        const packagePath = creationInput?.packagePath ?? options.defaultPath;
        return {
          name: `${conventions.collection}:${leaf}`,
          path: packagePath,
          role: "documentation",
        };
      },
      evaluate({
        packageDefinitionId,
        definition,
        prepared,
        bindings,
        stableCommon,
      }: {
        readonly packageDefinitionId: DocumentationContribution["packageDefinitionId"];
        readonly definition: PackageDefinition;
        readonly prepared: {
          readonly resources: readonly {
            readonly path: string;
            readonly content: Uint8Array;
          }[];
        };
        readonly bindings: ReadonlyMap<string, PackageBinding>;
        readonly stableCommon: DocumentationConventions;
      }): DocumentationContribution {
        const resource = prepared.resources.find(
          (item) => item.path === "README.md",
        );
        if (resource === undefined)
          throw new Error(`文档内容缺少 README 资源：${options.alias}`);
        const provider = bindings.get("glossary");
        const body =
          options.alias === "guide"
            ? `${stableCommon.collection}/${stableCommon.edition} by ${options.author}: ${definition.name} uses ${provider?.definition.path ?? "no glossary"}`
            : `${stableCommon.collection}/${stableCommon.edition} ${options.alias} by ${options.author}`;
        const files =
          options.alias === "index"
            ? []
            : [
                {
                  path: "README.md",
                  content: new TextEncoder().encode(
                    `${body}\n${new TextDecoder().decode(resource.content)}`,
                  ),
                  mode: 0,
                },
              ];
        return {
          packageDefinitionId,
          files,
          ...(files.length === 0
            ? {}
            : {
                reconciliation: files.map(({ path }) => ({
                  path,
                  driver: "text" as const,
                })),
              }),
          facts: { path: definition.path },
        };
      },
    },
  };
}

export function createDocumentationEngine(options: {
  readonly author: string;
  readonly includeGlossary?: boolean;
}) {
  const glossary = makeReference({
    identity: glossaryIdentity,
    alias: "glossary",
    instance: "shared",
    defaultPath: "docs/glossary",
    author: options.author,
    text: "Glossary resource\n",
  });
  const guide = makeReference({
    identity: guideIdentity,
    alias: "guide",
    instance: "independent",
    defaultPath: "docs/overview",
    author: options.author,
    text: "Guide resource\n",
    dependencies: [{ key: "glossary", contentIdentity: glossaryIdentity }],
  });
  const index = makeReference({
    identity: indexIdentity,
    alias: "index",
    instance: "independent",
    defaultPath: ".",
    author: options.author,
    text: "Index resource\n",
  });
  const content = [
    index,
    guide,
    ...(options.includeGlossary === false ? [] : [glossary]),
  ];
  const composition: DocumentationComposition = {
    identity: {
      namespace: "test-docs",
      packageName: "@fixture/docs-index",
      exportPath: "./composition",
    },
    parseConventions(value): DocumentationConventions {
      if (
        !isRecord(value) ||
        typeof value.collection !== "string" ||
        typeof value.edition !== "string"
      ) {
        throw new Error("文档组合缺少 collection 或 edition 约定");
      }
      return { collection: value.collection, edition: value.edition };
    },
    resolve({ conventions, packages }) {
      return {
        stableCommon: conventions,
        packageInputs: new Map<PackageDefinitionId, unknown>(),
        packageLinkIntents: packages.flatMap((item) =>
          Object.values(item.dependencyBindings).map((providerId) => ({
            consumerId: item.packageDefinitionId,
            providerId,
          })),
        ),
      };
    },
    combine({ blueprint, conventions }) {
      const root = blueprint.packages.find(
        (definition) => definition.path === ".",
      );
      if (root === undefined) throw new Error("文档组合需要根目录索引包");
      const indexText = [
        `${blueprint.packages.length} packages`,
        ...blueprint.packages
          .map(
            (definition) =>
              `${definition.role}\t${definition.name}\t${definition.path}`,
          )
          .toSorted(),
      ].join("\n");
      return {
        files: [
          {
            packageDefinitionId: root.packageDefinitionId,
            file: {
              path: "INDEX.md",
              content: new TextEncoder().encode(`${indexText}\n`),
              mode: 0,
            },
          },
        ],
        reconciliation: [
          {
            packageDefinitionId: root.packageDefinitionId,
            reconciliation: { path: "INDEX.md", driver: "text" },
          },
        ],
        facts: {
          edition: conventions.edition,
          packageCount: blueprint.packages.length,
        },
      };
    },
  };
  return createGenerator({ content, composition });
}
