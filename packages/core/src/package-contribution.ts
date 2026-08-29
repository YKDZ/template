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
import type { PackageDefinition } from "./project-blueprint.ts";
import type { DependencyMaintenancePolicy } from "./project-github.ts";
import type { RenderOperation, TemplateSourceHandle } from "./renderer.ts";

const operationPath = (operation: RenderOperation): string => {
  if ("to" in operation) return operation.to;
  if ("path" in operation) return operation.path;
  return "";
};

const reservedSystemToolNames = new Set([
  "aux",
  "bash",
  "bun",
  "cmd",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "con",
  "corepack",
  "deno",
  "git",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
  "node",
  "nul",
  "npm",
  "npx",
  "pnpm",
  "powershell",
  "prn",
  "pwsh",
  "sh",
  "yarn",
  "zsh",
]);

export type FoundationContribution = {
  /** Closed publication capability consumed only by coordinated root policy. */
  readonly npmPublication?: {
    readonly kind: "public-cli-candidate";
  };
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
  /** Explicit dependency on the Foundation-owned TypeScript policy Package. */
  readonly typescriptConfigurationPackage?: {
    readonly dependency: "required";
  };
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

/** Validates the portable executable name promised by a CLI Package Boundary. */
export function validateCliCommandName(
  commandName: string,
  occupiedCommandNames: readonly string[] = [],
): string {
  if (/[/\\]/u.test(commandName)) {
    throw new Error(
      `CLI command name must not be a path; received ${JSON.stringify(commandName)}`,
    );
  }
  if (/\p{White_Space}/u.test(commandName)) {
    throw new Error(
      `CLI command name must not contain whitespace; received ${JSON.stringify(commandName)}`,
    );
  }
  if (/\p{Control}/u.test(commandName)) {
    throw new Error(
      `CLI command name must not contain a control character; received ${JSON.stringify(commandName)}`,
    );
  }
  if (commandName.startsWith("-")) {
    throw new Error(
      `CLI command name must not have a leading hyphen; received ${JSON.stringify(commandName)}`,
    );
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(commandName)) {
    throw new Error(
      `CLI command name must use lowercase ASCII letters, digits, and single hyphens; received ${JSON.stringify(commandName)}`,
    );
  }
  if (reservedSystemToolNames.has(commandName)) {
    throw new Error(
      `CLI command name is a reserved system tool; received ${JSON.stringify(commandName)}`,
    );
  }
  if (occupiedCommandNames.includes(commandName)) {
    throw new Error(
      `CLI command name is already used by another workspace package; received ${JSON.stringify(commandName)}`,
    );
  }
  return commandName;
}

function manifestBinEntries(
  contribution: PackageContribution,
): readonly [string, unknown][] {
  const bin = contribution.manifest.bin;
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) {
    return [];
  }
  return Object.entries(bin);
}

/** Validates command portability and uniqueness across one complete plan. */
export function assertPackageContributionCommandNames(
  contributions: readonly PackageContribution[],
): readonly PackageContribution[] {
  const commandOwner = new Map<string, string>();
  for (const contribution of contributions) {
    const entries = manifestBinEntries(contribution);
    for (const [commandName] of entries) {
      const existingOwner = commandOwner.get(commandName);
      try {
        validateCliCommandName(commandName, [...commandOwner.keys()]);
      } catch (error) {
        if (existingOwner !== undefined) {
          throw new Error(
            `CLI command name ${JSON.stringify(commandName)} from ${contribution.definition.name} is already used by ${existingOwner}`,
          );
        }
        throw error;
      }
      commandOwner.set(commandName, contribution.definition.name);
    }
  }
  return contributions;
}

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
