import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-core/dependency-catalog";
import type {
  PackageDefinition,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import type { ProjectProjectionReconciliation } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  createTemplateSourceHandle,
  type RenderOperation,
} from "@ykdz/template-core/renderer";
import type {
  GeneratorPackageRecord,
  WorkspaceProjection,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";
import { composeCiDiagnosticArtifacts } from "@ykdz/template-environment/ci-diagnostic-artifact";
import {
  builtInEditorCustomization,
  planBuiltInDevelopmentContainer,
  shellCheckDevelopmentContainerToolLayer,
} from "@ykdz/template-environment/development-environment";
import {
  normalizeEnvironmentNeeds,
  type CheckEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@ykdz/template-environment/module-graph";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/preset-definition";
import type { ReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

import { browserTestDevelopmentContainerToolLayer } from "./development-container.ts";
import {
  assertReusablePackageExposure,
  readPackageAdditionVersionFacts,
} from "./package-addition-facts.ts";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "./project-github.ts";
import {
  createWorkspaceRootManifest,
  packageConditionKeyOrder,
  packageManifestKeyOrder,
  projectToolchainMirrorManifest,
  projectPreparedWorkspaceRoot,
} from "./root-projection.ts";

export type DefaultWorkspaceInput = {
  readonly repositoryName?: string;
  readonly defaultPackageScope?: string;
};

export type DefaultWorkspaceState = {
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly toolchain: {
    readonly nodeLtsMajor: string;
    readonly nodeVersion?: string;
    readonly packageManagerPin: string;
  };
};

const workspaceSource = createTemplateSourceHandle(
  fileURLToPath(new URL("../", import.meta.url)),
);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspaceResource(from: string, to: string): RenderOperation {
  return {
    kind: "copyFile",
    source: workspaceSource,
    from: "assets/" + from,
    to,
  };
}

function workspaceFile(from: string, to: string): RenderOperation {
  return {
    kind: "copyFile",
    source: workspaceSource,
    from,
    to,
  };
}

function readWorkspaceJson(from: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../assets/" + from, import.meta.url)),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function defaultContext(
  targetRoot: string,
  state: DefaultWorkspaceState,
): GenerationContext {
  return {
    targetDir: path.resolve(targetRoot),
    repositoryName: state.repositoryName,
    defaultPackageScope: state.defaultPackageScope,
    foundationPackages: {
      typescriptConfiguration: {
        name: "@" + state.defaultPackageScope + "/typescript-config",
      },
    },
    toolchain: {
      nodeLtsMajor: state.toolchain.nodeLtsMajor,
      ...(state.toolchain.nodeVersion === undefined
        ? {}
        : { nodeVersion: state.toolchain.nodeVersion }),
      packageManagerPin: state.toolchain.packageManagerPin,
    },
  };
}

function nativeDependencyNames(reference: ReferencePackage): readonly string[] {
  const authoring = new Set(reference.authoringDependencies);
  return [
    ...new Set(
      [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ].flatMap((field) => {
        const dependencies = reference.manifest[field];
        if (!isRecord(dependencies)) return [];
        return Object.entries(dependencies)
          .filter(
            ([name, specifier]) =>
              !authoring.has(name) &&
              typeof specifier === "string" &&
              (specifier.startsWith("workspace:") ||
                specifier.startsWith("link:")),
          )
          .map(([name]) => name);
      }),
    ),
  ];
}

function nativeDependencyIdentities(
  content: ReferencePackage,
  contentByIdentity: ReadonlyMap<string, ReferencePackage>,
): readonly string[] {
  return nativeDependencyNames(content).map((nativeName) => {
    const provider = [...contentByIdentity.values()].find(
      (candidate) => candidate.manifest.name === nativeName,
    );
    if (provider === undefined) {
      throw new Error("显式内容缺少本地依赖：" + nativeName);
    }
    return provider.identity;
  });
}

function nativeBindings(
  contentByIdentity: ReadonlyMap<string, ReferencePackage>,
  providers: ReadonlyMap<string, PackageDefinition>,
): ReadonlyMap<string, PackageDefinition> {
  return new Map(
    [...providers].map(([identity, definition]) => {
      const provider = contentByIdentity.get(identity);
      if (provider === undefined) {
        throw new Error("工作区策略无法解释内容绑定：" + identity);
      }
      return [provider.manifest.name, definition];
    }),
  );
}

function siblingPackagePath(defaultPath: string, leafName: string): string {
  const parentPath = path.posix.dirname(defaultPath);
  return path.posix.join(
    parentPath === "." ? "packages" : parentPath,
    leafName,
  );
}

function maintenancePolicy(contributions: readonly PackageContribution[]) {
  const ecosystems = [
    ...new Set([
      "devcontainers" as const,
      ...contributions.flatMap(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.ecosystems,
      ),
    ]),
  ];
  const directories: Record<string, string> = {};
  const extraDirectories: Record<string, string[]> = {};
  for (const ecosystem of ecosystems) {
    const candidates = [
      ...new Set(
        contributions.flatMap((contribution) => {
          const policy = contribution.foundation.dependencyMaintenance;
          const primary = policy.directories?.[ecosystem];
          return [
            ...(primary === undefined ? [] : [primary]),
            ...(policy.extraDirectories?.[ecosystem] ?? []),
          ];
        }),
      ),
    ];
    const [primary, ...extra] = candidates;
    if (primary !== undefined) directories[ecosystem] = primary;
    if (extra.length > 0) extraDirectories[ecosystem] = extra;
  }
  return {
    ecosystems,
    ...(Object.keys(directories).length === 0 ? {} : { directories }),
    ...(Object.keys(extraDirectories).length === 0 ? {} : { extraDirectories }),
    interval: "weekly" as const,
  };
}

function boundaryTags(
  contributions: readonly PackageContribution[],
): readonly ("app" | "library")[] {
  const selected = new Set<"app" | "library">();
  for (const contribution of contributions) {
    if (
      contribution.definition.role === "cli-tool" ||
      contribution.definition.role === "runtime-service"
    )
      selected.add("app");
    else if (contribution.definition.role === "shared-library") {
      selected.add("library");
    }
  }
  return [...selected];
}

function projectOperations(options: {
  readonly context: GenerationContext;
  readonly state: DefaultWorkspaceState;
  readonly blueprint: ProjectBlueprint;
  readonly packages: readonly GeneratorPackageRecord[];
  readonly contributions: readonly PackageContribution[];
}): WorkspaceProjection {
  const { context, blueprint, contributions } = options;
  const configuration = contributions.find(
    (contribution) =>
      contribution.definition.name ===
      context.foundationPackages.typescriptConfiguration.name,
  );
  if (configuration === undefined) {
    throw new Error("默认策略缺少共享 TypeScript 配置内容");
  }
  const rootManifest = createWorkspaceRootManifest({
    name: context.repositoryName,
    typescriptConfigurationPackageName: configuration.definition.name,
    nodeDeclaration:
      context.toolchain.nodeVersion ?? context.toolchain.nodeLtsMajor,
    packageManagerPin: context.toolchain.packageManagerPin,
  });
  const dependencyCatalog = selectTemplateDependencyCatalogEntries(
    collectGeneratedManifestCatalogReferences([
      ...contributions.map((contribution) => contribution.manifest),
      rootManifest,
    ]),
  );
  const packages = ["apps/*", "packages/*"];
  for (const definition of blueprint.packages) {
    const glob = definition.path.split("/")[0] + "/*";
    if (!packages.includes(glob)) packages.push(glob);
  }
  const packagePaths = blueprint.packages.map((definition) => definition.path);
  const artifacts = composeCiDiagnosticArtifacts({
    packagePaths,
    declarations: contributions.flatMap(
      (contribution) => contribution.ciDiagnosticArtifacts ?? [],
    ),
  });
  const editor = builtInEditorCustomization(
    contributions.flatMap(
      (contribution) => contribution.foundation.editorCapabilities,
    ),
  );
  const deploymentEnvironmentNeeds = contributions.flatMap(
    (contribution) =>
      contribution.foundation.deploymentCheck?.environmentNeeds ?? [],
  );
  const hasDeployment = deploymentEnvironmentNeeds.length > 0;
  const hasJointE2e = contributions.some(
    (contribution) => contribution.foundation.vueHonoJointE2e !== undefined,
  );
  const checkEnvironmentNeeds = [
    ...contributions.flatMap((contribution) => contribution.environmentNeeds),
    ...(hasJointE2e
      ? [
          playwrightBrowserAssetsEnvironmentNeed({
            browser: "chromium",
            owner: { kind: "workspace-orchestration", path: "." },
          }),
        ]
      : []),
    ...(hasDeployment
      ? [
          shellCheckEnvironmentNeed({
            kind: "workspace-orchestration",
            path: ".",
          }),
        ]
      : []),
  ];
  const containerLayers = [
    ...(checkEnvironmentNeeds.some(
      (need) => need.kind === "playwright-browser-assets",
    )
      ? [browserTestDevelopmentContainerToolLayer()]
      : []),
    ...(hasDeployment ? [shellCheckDevelopmentContainerToolLayer()] : []),
    ...contributions.flatMap(
      (contribution) =>
        contribution.foundation.developmentContainerToolLayers ?? [],
    ),
  ];
  const container = planBuiltInDevelopmentContainer({
    nodeVersion:
      context.toolchain.nodeVersion ?? context.toolchain.nodeLtsMajor,
    layers: containerLayers,
  });
  const containerBase = JSON.parse(
    readFileSync(
      fileURLToPath(
        import.meta
          .resolve("@ykdz/template-environment/assets/.devcontainer/devcontainer.json"),
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const referenceNames = new Map(
    contributions.flatMap((contribution) =>
      contribution.referenceSource === undefined
        ? []
        : [
            [
              contribution.referenceSource,
              contribution.definition.name,
            ] as const,
          ],
    ),
  );
  const rootProjection = projectPreparedWorkspaceRoot({
    rootManifest,
    packageGlobs: packages,
    dependencyCatalog,
    dependencyOverrides: {},
    turboTemplate: readWorkspaceJson("turbo.json"),
    referenceNames,
    turboBoundaryTags: boundaryTags(contributions),
    rootTsconfigTemplate: readWorkspaceJson("tsconfig.json"),
    rootTsconfigCompilerOptions: {
      rewriteRelativeImportExtensions: false,
      allowImportingTsExtensions: true,
    },
    rootTsconfigInclude: ["*.config.ts", "scripts/**/*.ts"],
    tsconfigConfigTemplate: readWorkspaceJson("tsconfig.config.json"),
  });
  const editorExtensions = {
    kind: "writeJson" as const,
    to: ".vscode/extensions.json",
    value: { recommendations: editor.extensions },
    ...(editor.extensions.length > 2
      ? { multilineArrays: ["recommendations"] }
      : {}),
  };
  const environmentNeeds = normalizeEnvironmentNeeds({
    check: checkEnvironmentNeeds as CheckEnvironmentNeed[],
    deployment: deploymentEnvironmentNeeds,
  });
  const reconciliation: readonly ProjectProjectionReconciliation[] = [
    { path: "tsconfig.json", driver: "structured" },
    { path: "turbo.json", driver: "structured" },
    {
      path: ".devcontainer/devcontainer.json",
      driver: "structured",
      identitySets: [
        {
          location: "/mounts",
          identity: {
            kind: "projection",
            members: container.mounts.map(({ identity, target }) => ({
              identity,
              match: { target },
            })),
            fallback: { fields: ["target"] },
          },
        },
      ],
      mirrorSlots: [
        {
          id: "node-version-build-arg",
          location: {
            kind: "json-pointer",
            pointer: "/build/args/NODE_VERSION",
          },
        },
      ],
    },
    {
      path: ".vscode/extensions.json",
      driver: "structured",
      identitySets: [
        {
          location: "/recommendations",
          identity: { kind: "self" },
        },
      ],
    },
    { path: ".template/blueprint.json", driver: "canonical" },
    { path: ".template/environment-needs.json", driver: "canonical" },
    { path: ".template/generation.json", driver: "canonical" },
  ];
  const defaultOperations: RenderOperation[] = [
    rootProjection.manifest,
    rootProjection.workspace,
    workspaceResource("gitignore", ".gitignore"),
    workspaceResource("agent-instructions.md", "AGENTS.md"),
    rootProjection.turbo,
    workspaceFile(
      "scripts/check-toolchain-versions.ts",
      "scripts/check-toolchain-versions.ts",
    ),
    projectToolchainMirrorManifest(reconciliation),
    workspaceFile("scripts/task-gates.ts", "scripts/task-gates.ts"),
    workspaceFile(
      "scripts/run-turbo-boundaries.ts",
      "scripts/run-turbo-boundaries.ts",
    ),
    rootProjection.tsconfig,
    rootProjection.tsconfigConfig,
    {
      kind: "writeText",
      to: "oxlint.config.ts",
      text:
        "export { default } from " +
        JSON.stringify(configuration.definition.name + "/oxlint") +
        ";\n",
    },
    {
      kind: "writeText",
      to: "oxfmt.config.ts",
      text:
        "export { default } from " +
        JSON.stringify(configuration.definition.name + "/oxfmt") +
        ";\n",
    },
    editorExtensions,
    { kind: "writeJson", to: ".vscode/settings.json", value: editor.settings },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: { ...containerBase, name: context.repositoryName },
    },
    {
      kind: "mergeJson",
      to: ".devcontainer/devcontainer.json",
      value: {
        build: {
          args: Object.fromEntries(
            container.buildArguments.map((argument) => [
              argument.name,
              argument.value,
            ]),
          ),
        },
        ...(container.mounts.length === 0
          ? {}
          : {
              mounts: container.mounts.map(
                ({ identity: _identity, ...mount }) => mount,
              ),
            }),
      },
    },
    container.dockerfileOperation,
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectCheckWorkflow({
        packagePaths,
        diagnosticArtifacts: artifacts,
      }),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectDependabotConfig(maintenancePolicy(contributions)),
    },
    {
      kind: "writeJson",
      to: ".template/environment-needs.json",
      value: environmentNeeds,
    },
  ];
  const packageOperations = contributions.flatMap((contribution) =>
    contribution.operations.map((operation) =>
      operation.kind === "writeJson" &&
      operation.to === contribution.definition.path + "/package.json"
        ? {
            ...operation,
            value: contribution.manifest,
            multilineArrays: ["files"],
            keyOrder: packageManifestKeyOrder,
            nestedKeyOrder: packageConditionKeyOrder,
          }
        : operation,
    ),
  );
  return {
    operations: [
      ...packageOperations,
      ...defaultOperations,
      { kind: "writeJson", to: ".template/blueprint.json", value: blueprint },
    ],
    reconciliation,
  };
}

/** 创建拥有 Node、pnpm、catalog、Turbo 与根任务政策的默认工作区策略。 */
export function createDefaultWorkspaceStrategy(): WorkspaceStrategy<
  GenerationContext,
  DefaultWorkspaceInput,
  DefaultWorkspaceState,
  PackageContribution,
  ReferencePackage
> {
  return {
    identity: "default",
    initialize({ targetRoot, input }) {
      const repositoryName =
        input.repositoryName ?? path.basename(path.resolve(targetRoot));
      const defaultPackageScope = input.defaultPackageScope ?? repositoryName;
      const nodeVersion = releaseToolchainSnapshot.nodeVersion;
      const state: DefaultWorkspaceState = {
        repositoryName,
        defaultPackageScope,
        toolchain: {
          nodeLtsMajor: nodeVersion.slice(0, nodeVersion.indexOf(".")),
          nodeVersion,
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
        },
      };
      return { state, context: defaultContext(targetRoot, state) };
    },
    prepareAddition({
      targetRoot,
      state,
      content,
      contentByIdentity,
      packages,
    }) {
      const current = readPackageAdditionVersionFacts(targetRoot);
      const context = defaultContext(targetRoot, {
        ...state,
        toolchain: current.toolchain,
      });
      const definitionsById = new Map<string, PackageDefinition>(
        packages.map((item) => [
          item.definition.packageDefinitionId,
          item.definition,
        ]),
      );
      for (const identity of nativeDependencyIdentities(
        content,
        contentByIdentity,
      )) {
        const provider = contentByIdentity.get(identity);
        const existing = packages.filter(
          (item) => item.contentIdentity === identity,
        );
        if (provider === undefined || existing.length !== 1) continue;
        const providerRecord = existing[0]!;
        const providerDefinitions = new Map<string, PackageDefinition>();
        for (const [providerIdentity, packageDefinitionId] of Object.entries(
          providerRecord.bindings,
        )) {
          const definition = definitionsById.get(packageDefinitionId);
          if (definition === undefined) {
            throw new Error(
              "生成记录包绑定引用了不存在的包实例：" + packageDefinitionId,
            );
          }
          providerDefinitions.set(providerIdentity, definition);
        }
        const baseline = provider.contribute({
          context,
          definition: providerRecord.definition,
          bindings: nativeBindings(contentByIdentity, providerDefinitions),
        });
        assertReusablePackageExposure({
          repositoryRoot: targetRoot,
          packagePath: providerRecord.definition.path,
          expectedExports: baseline.exposure.exports,
        });
      }
      return context;
    },
    parseState(value) {
      if (!isRecord(value) || !isRecord(value.toolchain)) {
        throw new Error("默认工作区策略记录无效");
      }
      if (
        typeof value.repositoryName !== "string" ||
        typeof value.defaultPackageScope !== "string" ||
        typeof value.toolchain.nodeLtsMajor !== "string" ||
        typeof value.toolchain.nodeVersion !== "string" ||
        typeof value.toolchain.packageManagerPin !== "string"
      ) {
        throw new Error("默认工作区策略记录缺少必要事实");
      }
      return value as DefaultWorkspaceState;
    },
    dependencies({ content, contentByIdentity }) {
      return nativeDependencyIdentities(content, contentByIdentity);
    },
    bindings({ contentByIdentity, providers }) {
      return nativeBindings(contentByIdentity, providers);
    },
    createDefinition({
      context,
      content,
      leafName,
      packagePath: explicitPath,
    }) {
      const selectedLeaf = leafName ?? content.defaultLeafName;
      return {
        name: "@" + context.defaultPackageScope + "/" + selectedLeaf,
        path:
          explicitPath ??
          (leafName === undefined
            ? content.defaultPath
            : siblingPackagePath(content.defaultPath, selectedLeaf)),
        role: content.role,
      };
    },
    project(options) {
      return projectOperations(options);
    },
  };
}
