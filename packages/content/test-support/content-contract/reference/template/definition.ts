import { fileURLToPath } from "node:url";

import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type { ReferencePackageDefinition } from "@ykdz/template-core/reference-package";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import { defineNativeReferenceContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import manifest from "../package.json" with { type: "json" };
import { referenceRevision } from "./revision.ts";

type Conventions = { readonly policy: "neutral" };
type CreationInput = { readonly projectName: string };
type PreparedFacts = {
  readonly revision: typeof referenceRevision.prepared;
  readonly resourceCount: number;
};
type StableCommon = {
  readonly edition: string;
  readonly providerVersion: string;
};
type PackageInput = { readonly providerVersion: string };
type ContributionFacts = {
  readonly kind: "contract-contribution";
  readonly projectName: string;
  readonly providerVersion: string;
  readonly ownerRevision: typeof referenceRevision.prepared;
};

const referenceDefinition = {
  ...({
    alias: "contract-reference",
    instance: "independent",
    parseCreationInput(value: unknown): CreationInput {
      if (
        typeof value !== "object" ||
        value === null ||
        !("projectName" in value) ||
        typeof value.projectName !== "string"
      ) {
        throw new Error("包创建输入必须包含项目名");
      }
      return { projectName: value.projectName };
    },
    createDefinition({
      creationInput,
    }: {
      readonly conventions: Conventions;
      readonly creationInput: CreationInput | undefined;
      readonly layout?: unknown;
    }) {
      const projectName = creationInput?.projectName ?? "contract-starter";
      return {
        name: projectName,
        path: `packages/${projectName}`,
        role: "library",
      };
    },
    evaluate({
      packageDefinitionId,
      definition,
      prepared,
      stableCommon,
      packageInput,
      creationInput,
    }: Parameters<
      ReferencePackageDefinition<
        Conventions,
        CreationInput,
        PreparedFacts,
        StableCommon,
        PackageInput,
        ContributionFacts
      >["evaluate"]
    >[0]): PackageContribution<ContributionFacts> {
      const resource = prepared.resources.find(
        (candidate) => candidate.path === "resources/README.md",
      );
      if (resource === undefined) throw new Error("参考资源缺失");
      return {
        packageDefinitionId,
        files: [
          {
            path: "README.md",
            content: new TextEncoder().encode(
              [
                new TextDecoder().decode(resource.content),
                stableCommon.edition,
                packageInput?.providerVersion ?? stableCommon.providerVersion,
                creationInput?.projectName ?? definition.name,
                definition.path,
              ].join("\n"),
            ),
            mode: 0,
          },
        ],
        reconciliation: [{ path: "README.md", driver: "text" }],
        facts: {
          kind: "contract-contribution",
          projectName: creationInput?.projectName ?? definition.name,
          providerVersion:
            packageInput?.providerVersion ?? stableCommon.providerVersion,
          ownerRevision: prepared.facts.revision,
        },
      };
    },
  } satisfies Omit<
    ReferencePackageDefinition<
      Conventions,
      CreationInput,
      PreparedFacts,
      StableCommon,
      PackageInput,
      ContributionFacts
    >,
    "prepare"
  >),
  revision: referenceRevision.extension,
  authorExtension: {
    marker: referenceRevision.extension,
    describe() {
      return {
        format: referenceRevision.format,
        revision: referenceRevision.extension.endsWith("v1") ? 1 : 2,
      } as const;
    },
  },
};

export const referencePackage = defineNativeReferenceContentArtifact(
  referenceDefinition,
  {
    manifest,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    resources: [
      {
        path: "resources/README.md",
        source: createTemplateSourceHandle(
          fileURLToPath(new URL("../resources/README.md", import.meta.url)),
        ),
        mode: 0o644,
      },
      {
        path: "resources/latent.txt",
        source: createTemplateSourceHandle(
          fileURLToPath(new URL("../resources/latent.txt", import.meta.url)),
        ),
        mode: 0o644,
      },
    ],
    executionDependencies: ["@ykdz/template-workspace-authoring"],
    prepareFacts(resources) {
      return {
        revision: referenceRevision.prepared,
        resourceCount: resources.length,
      };
    },
  },
);
