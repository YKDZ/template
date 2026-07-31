import {
  assertCiDiagnosticArtifactDeclaration,
  type CiDiagnosticArtifactDeclaration,
} from "./ci-diagnostic-artifact.ts";
import type { DevelopmentContainerToolLayer } from "./development-container-tool-layer.ts";
import type { EditorCustomizationCapability } from "./editor-customization.ts";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
} from "./module-graph.ts";
import type { PackageDefinition } from "./project-blueprint-v2.ts";
import type { DependencyMaintenancePolicy } from "./project-github.ts";
import type { RenderOperation, TemplateSourceHandle } from "./renderer.ts";

const operationPath = (operation: RenderOperation): string => {
  if ("to" in operation) return operation.to;
  if ("path" in operation) return operation.path;
  return "";
};

export type FoundationContribution = {
  /** Toolchains the Foundation must install and project into coordinated root files. */
  readonly toolchains: {
    readonly rust?: {
      readonly toolchain: string;
      readonly components: readonly ("rustfmt" | "clippy")[];
    };
  };
  /** Editor capabilities the Foundation must project into its coordinated editor files. */
  readonly editorCapabilities: readonly EditorCustomizationCapability[];
  /** Ecosystems and paths whose maintenance belongs in the coordinated root policy. */
  readonly dependencyMaintenance: DependencyMaintenancePolicy;
  /** Workspace membership patterns contributed by package boundaries. */
  readonly workspacePackageGlobs?: readonly string[];
  /** Dependency Catalog entries required by package-owned manifests. */
  readonly dependencyCatalog?: Readonly<Record<string, string>>;
  /** Source-backed Development Container capabilities coordinated by Foundation. */
  readonly developmentContainerToolLayers?:
    | readonly DevelopmentContainerToolLayer[]
    | undefined;
  /** Source-backed coordinated files projected by Foundation. */
  readonly templateFiles?:
    | readonly {
        readonly identity: string;
        readonly source: TemplateSourceHandle;
        readonly from: string;
        readonly to: string;
        readonly replacements?: Readonly<Record<string, string>> | undefined;
      }[]
    | undefined;
};

/** A preset-agnostic package-sized part of a Generated Repository Plan. */
export type PackageContribution = {
  readonly definition: PackageDefinition;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly exposure: {
    readonly exports: Readonly<Record<string, unknown>>;
    readonly imports: Readonly<Record<string, unknown>>;
  };
  readonly operations: readonly RenderOperation[];
  /** Typed requirements consumed by the Foundation for coordinated root outputs. */
  readonly foundation: FoundationContribution;
  readonly environmentNeeds: readonly CheckEnvironmentNeed[];
  /** Closed native CI evidence owned by this Package Boundary. */
  readonly ciDiagnosticArtifacts?: readonly CiDiagnosticArtifactDeclaration[];
  /** Requirements prepared only by a focused deployment entrypoint. */
  readonly deploymentEnvironmentNeeds?: readonly DeploymentEnvironmentNeed[];
};

export function assertPackageContribution(
  contribution: PackageContribution,
  provenance: {
    readonly definitionName?: string;
    readonly planner?: string;
  } = {},
): PackageContribution {
  if (contribution.definition.name !== contribution.manifest.name) {
    throw new Error(
      "Package Contribution manifest name must match its Package Definition",
    );
  }
  const outsideOperation = contribution.operations.find(
    (operation) =>
      !operationPath(operation).startsWith(`${contribution.definition.path}/`),
  );
  if (outsideOperation) {
    const target = operationPath(outsideOperation);
    const rule = target.includes("/")
      ? "Package Contribution may not write a sibling Package Boundary"
      : "Package Contribution may not write a coordinated root output";
    const owner =
      provenance.definitionName === undefined
        ? ""
        : `${provenance.definitionName}: ${provenance.planner ?? "Package Contribution"} `;
    throw new Error(
      `${owner}${rule}; ${contribution.definition.path} attempted ${target}`,
    );
  }
  for (const artifact of contribution.ciDiagnosticArtifacts ?? []) {
    const declaration = assertCiDiagnosticArtifactDeclaration(artifact);
    if (declaration.owner.path !== contribution.definition.path) {
      throw new Error(
        `CI Diagnostic Artifact owner must match its Package Contribution: ${contribution.definition.path}`,
      );
    }
  }
  return contribution;
}
