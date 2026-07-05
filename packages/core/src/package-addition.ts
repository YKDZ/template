import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateProjectBlueprint,
  type ProjectBlueprint,
} from "@ykdz/template-shared";
import {
  PackageAdditionSupport,
  type PackageLinkIntent,
  type PackageRole,
  type PackageSourcePreset,
} from "@ykdz/template-shared";

import {
  collectGeneratedManifestCatalogReferences,
  pnpmWorkspaceYamlWithCatalogDependencies,
  type GeneratedPackageManifestDependencies,
} from "./dependency-catalog.js";
import {
  assertTypeScriptPackageBoundaryForLinkIntent,
  packageTurboTasks,
  planPackageLinks,
  type TurboTaskGraph,
} from "./package-linking.js";
import {
  findPresetSourceManifestPreset,
  type PresetSourceManifest,
} from "./preset-source.js";
import {
  defaultPackagePathForPresetSourcePackageAddition,
  planPresetSourcePackageAddition,
  type PresetProjectionSourceRoots,
} from "./projection-capabilities.js";
import { renderProject } from "./renderer.js";
import type { RenderOperation } from "./renderer.js";

export type AddPackageOptions = {
  cwd: string;
  preset: string;
  name: string;
  path?: string | undefined;
  linkFrom?: readonly string[] | undefined;
  presetSourceManifest: PresetSourceManifest;
  projectionSourceRoots: PresetProjectionSourceRoots;
};

type RootPackageJson = {
  scripts: Record<string, string>;
  devDependencies?: Record<string, string>;
  type?: string;
  [key: string]: unknown;
};

type GeneratedRepositoryPackageMetadata = {
  projectName: string;
  nodeVersion: string;
};

type RootUpdatePlan = {
  blueprint: ProjectBlueprint;
  rootPackageJson: RootPackageJson;
  turboConfig: { tasks: TurboTaskGraph };
  workspaceText: string;
  consumerManifestUpdates: readonly ConsumerManifestUpdate[];
};

type PackageManifestForTaskGraph = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: unknown;
};

type ConsumerManifestUpdate = {
  readonly packagePath: string;
  readonly manifest: PackageManifestForTaskGraph & Record<string, unknown>;
};

function projectNameFromBlueprint(
  blueprint: ProjectBlueprint,
  fallbackProjectName: string,
): string {
  const firstPackage = blueprint.packages?.[0];
  const match = firstPackage?.name.match(/^@([^/]+)\//);

  if (match?.[1]) {
    return match[1];
  }

  if (/^[a-z0-9][a-z0-9._-]*$/.test(fallbackProjectName)) {
    return fallbackProjectName;
  }

  throw new Error(
    "Cannot infer workspace package scope from the stored Project Blueprint or root package.json",
  );
}

function assertSafePackageLeaf(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      "--name must be a lowercase package leaf name using letters, numbers, and hyphens",
    );
  }
}

const reservedPackagePathCollections = new Set([
  ".devcontainer",
  ".git",
  ".github",
  ".template",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

function assertSafePackagePathSegment(
  packagePath: string,
  segment: string,
): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(segment)) {
    throw new Error(
      `Package Path ${packagePath} must use safe path segments with lowercase letters, numbers, and hyphens`,
    );
  }
}

function validateExplicitPackagePath(packagePath: string): string {
  if (path.isAbsolute(packagePath)) {
    throw new Error(`Package Path ${packagePath} must be relative`);
  }

  if (packagePath !== packagePath.trim()) {
    throw new Error(`Package Path ${packagePath} must not contain whitespace`);
  }

  if (
    packagePath === ".." ||
    packagePath.startsWith("../") ||
    packagePath.endsWith("/..") ||
    packagePath.includes("/../")
  ) {
    throw new Error(
      `Package Path ${packagePath} must not escape the workspace`,
    );
  }

  const normalized = path.posix.normalize(packagePath);
  if (normalized !== packagePath || packagePath.includes("\\")) {
    throw new Error(
      `Package Path ${packagePath} must be exactly two safe path segments`,
    );
  }

  const segments = packagePath.split("/");
  if (segments.length !== 2) {
    throw new Error(
      `Package Path ${packagePath} must be exactly two safe path segments`,
    );
  }

  const [collection, packageDirectory] = segments;
  if (!collection || !packageDirectory) {
    throw new Error(
      `Package Path ${packagePath} must be exactly two safe path segments`,
    );
  }

  if (reservedPackagePathCollections.has(collection)) {
    throw new Error(
      `Package Path ${packagePath} uses reserved collection ${collection}`,
    );
  }

  assertSafePackagePathSegment(packagePath, collection);
  assertSafePackagePathSegment(packagePath, packageDirectory);

  if (reservedPackagePathCollections.has(packageDirectory)) {
    throw new Error(
      `Package Path ${packagePath} uses reserved package directory ${packageDirectory}`,
    );
  }

  return packagePath;
}

function supportedPackageAdditionPresetNames(
  manifest: PresetSourceManifest,
): string[] {
  return manifest.presets
    .filter(
      (preset) =>
        preset.packageAdditionSupport === PackageAdditionSupport.Supported,
    )
    .map((preset) => preset.name);
}

function formatUnsupportedPackageAdditionPresetError(
  preset: string,
  manifest: PresetSourceManifest,
): string {
  return [
    `Preset ${preset} cannot be used for Package Addition.`,
    "It can still initialize a Generated Repository, but it cannot be added to an existing one.",
    `Supported Package Addition presets: ${supportedPackageAdditionPresetNames(manifest).join(", ")}`,
  ].join("\n");
}

function assertNoPackageConflict(
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string,
): void {
  const existingByName = blueprint.packages?.find(
    (pkg) => pkg.name === packageName,
  );
  if (existingByName) {
    throw new Error(
      `Package Path ${packagePath} conflicts with existing package ${existingByName.name} at ${existingByName.path}`,
    );
  }

  const existingByPath = blueprint.packages?.find(
    (pkg) => pkg.path === packagePath,
  );
  if (existingByPath) {
    throw new Error(
      `Package Path ${packagePath} conflicts with existing package ${existingByPath.name} at ${existingByPath.path}`,
    );
  }
}

function formatAvailablePackagePaths(blueprint: ProjectBlueprint): string {
  return (blueprint.packages ?? [])
    .map((projectPackage) => projectPackage.path)
    .join(", ");
}

function packageLinkIntentForSingleConsumer(options: {
  readonly blueprint: ProjectBlueprint;
  readonly consumerPackagePath: string;
  readonly providerPackagePath: string;
}): PackageLinkIntent {
  if (options.consumerPackagePath === options.providerPackagePath) {
    throw new Error(
      `Package Link Intent cannot link ${options.providerPackagePath} from itself`,
    );
  }

  const consumer = options.blueprint.packages?.find(
    (projectPackage) => projectPackage.path === options.consumerPackagePath,
  );

  if (!consumer) {
    const availablePackagePaths = formatAvailablePackagePaths(
      options.blueprint,
    );
    throw new Error(
      [
        `Unknown Package Path for --link-from: ${options.consumerPackagePath}`,
        availablePackagePaths
          ? `Available Package Paths: ${availablePackagePaths}`
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    );
  }

  return {
    consumerPackagePath: options.consumerPackagePath,
    providerPackagePath: options.providerPackagePath,
  };
}

function packageLinkIntentsForConsumers(options: {
  readonly blueprint: ProjectBlueprint;
  readonly consumerPackagePaths: readonly string[];
  readonly providerPackagePath: string;
}): PackageLinkIntent[] {
  const packageLinkIntents: PackageLinkIntent[] = [];
  const seenConsumerPackagePaths = new Set<string>();

  for (const consumerPackagePath of options.consumerPackagePaths) {
    if (seenConsumerPackagePaths.has(consumerPackagePath)) {
      continue;
    }

    seenConsumerPackagePaths.add(consumerPackagePath);
    packageLinkIntents.push(
      packageLinkIntentForSingleConsumer({
        blueprint: options.blueprint,
        consumerPackagePath,
        providerPackagePath: options.providerPackagePath,
      }),
    );
  }

  return packageLinkIntents;
}

async function assertPackageLinkIntentConsumersAreTypeScriptBoundaries(options: {
  readonly root: string;
  readonly blueprint: ProjectBlueprint;
  readonly packageLinkIntents: readonly PackageLinkIntent[];
}): Promise<void> {
  for (const intent of options.packageLinkIntents) {
    const consumer = options.blueprint.packages?.find(
      (projectPackage) => projectPackage.path === intent.consumerPackagePath,
    );

    if (!consumer) {
      continue;
    }

    if (consumer.role !== undefined && consumer.sourcePreset !== undefined) {
      assertTypeScriptPackageBoundaryForLinkIntent(consumer, "consumer");
      continue;
    }

    try {
      const manifest = await readJson(
        path.join(options.root, consumer.path, "package.json"),
      );
      const scripts = isRecord(manifest) ? manifest.scripts : undefined;
      const hasTypeScriptPackageShape =
        isRecord(manifest) &&
        manifest.type === "module" &&
        isRecord(scripts) &&
        typeof scripts.typecheck === "string";

      if (hasTypeScriptPackageShape) {
        continue;
      }

      assertTypeScriptPackageBoundaryForLinkIntent(consumer, "consumer");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        assertTypeScriptPackageBoundaryForLinkIntent(consumer, "consumer");
      }

      throw error;
    }
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertMissingPackagePath(
  packagePath: string,
  targetPath: string,
): Promise<void> {
  try {
    await stat(targetPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(
    `Package Path ${packagePath} conflicts with existing filesystem path ${targetPath}`,
  );
}

function resolveGeneratedPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Package Addition paths must be relative: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const insideRoot =
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);

  if (!insideRoot) {
    throw new Error(
      `Package Addition path escapes the Generated Repository: ${relativePath}`,
    );
  }

  return resolvedPath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRootPackageJson(
  input: unknown,
): asserts input is RootPackageJson {
  if (!isRecord(input)) {
    throw new Error(
      "Cannot update root Package Addition scripts: package.json must be an object",
    );
  }

  if (!isRecord(input.scripts)) {
    throw new Error(
      "Cannot update root Package Addition scripts: scripts must be an object",
    );
  }

  for (const scriptName of ["check", "fix"] as const) {
    if (typeof input.scripts[scriptName] !== "string") {
      throw new Error(
        `Cannot update root Package Addition scripts: scripts.${scriptName} must be a string`,
      );
    }
  }
}

async function readGeneratedWorkspaceBlueprint(
  root: string,
): Promise<ProjectBlueprint> {
  const blueprintPath = path.join(root, ".template/blueprint.json");
  let blueprintJson: unknown;

  try {
    blueprintJson = await readJson(blueprintPath);
  } catch (error: unknown) {
    if (
      error instanceof SyntaxError ||
      (isNodeError(error) && error.code === "ENOENT")
    ) {
      throw new Error(
        "Package Addition requires a valid .template/blueprint.json",
        { cause: error },
      );
    }

    throw error;
  }

  const result = validateProjectBlueprint(blueprintJson);

  if (!result.ok) {
    if (
      isRecord(blueprintJson) &&
      blueprintJson.projectKind === "single-package"
    ) {
      throw new Error(
        "Package Addition only supports existing workspace Generated Repositories",
      );
    }

    throw new Error(
      "Package Addition requires a valid .template/blueprint.json",
    );
  }

  const blueprint = result.value;

  if (blueprint.projectKind !== "multi-package") {
    throw new Error(
      "Package Addition only supports existing workspace Generated Repositories",
    );
  }

  if (blueprint.packageManager !== "pnpm") {
    throw new Error(
      "Package Addition only supports pnpm workspace Generated Repositories",
    );
  }

  if (!blueprint.packages || blueprint.packages.length === 0) {
    throw new Error(
      "Package Addition requires package definitions in the stored Project Blueprint",
    );
  }

  await stat(path.join(root, "turbo.json"));
  await stat(path.join(root, "pnpm-workspace.yaml"));

  return blueprint;
}

async function readGeneratedRepositoryPackageMetadata(
  root: string,
): Promise<GeneratedRepositoryPackageMetadata> {
  const packageJson = await readJson(path.join(root, "package.json"));

  if (!isRecord(packageJson)) {
    throw new Error(
      "Package Addition requires root package.json to be an object",
    );
  }

  const projectName = packageJson.name;
  if (typeof projectName !== "string" || projectName.length === 0) {
    throw new Error(
      "Package Addition requires root package.json to declare name",
    );
  }

  if (!isRecord(packageJson.engines)) {
    throw new Error(
      "Package Addition requires root package.json to declare engines.node",
    );
  }

  const nodeVersion = packageJson.engines.node;
  if (typeof nodeVersion !== "string" || nodeVersion.length === 0) {
    throw new Error(
      "Package Addition requires root package.json to declare engines.node",
    );
  }

  return { projectName, nodeVersion };
}

function workspaceTextWithPackageGlob(text: string, glob: string): string {
  if (text.includes(`  - ${glob}`)) {
    return text;
  }

  const nextText = text.replace(/^packages:\n/m, `packages:\n  - ${glob}\n`);
  if (nextText === text) {
    throw new Error(
      "Cannot update pnpm workspace membership: missing packages section",
    );
  }

  return nextText;
}

function packageAdditionCatalogDependencies(
  operations: readonly RenderOperation[],
): string[] {
  const manifests: GeneratedPackageManifestDependencies[] = [];

  for (const operation of operations) {
    if (
      operation.kind !== "writeJson" ||
      path.basename(operation.to) !== "package.json"
    ) {
      continue;
    }

    if (!isRecord(operation.value)) {
      throw new Error(
        `Package Addition package manifest must be an object: ${operation.to}`,
      );
    }

    manifests.push(operation.value);
  }

  return collectGeneratedManifestCatalogReferences(manifests);
}

function generatedPackageManifestFromOperations(
  operations: readonly RenderOperation[],
  packagePath: string,
): PackageManifestForTaskGraph | undefined {
  for (const operation of operations) {
    if (
      operation.kind !== "writeJson" ||
      operation.to !== `${packagePath}/package.json`
    ) {
      continue;
    }

    if (!isRecord(operation.value)) {
      throw new Error(
        `Package Addition package manifest must be an object: ${operation.to}`,
      );
    }

    return operation.value;
  }

  return undefined;
}

async function packageManifestsForTaskGraph(options: {
  readonly root: string;
  readonly blueprint: ProjectBlueprint;
  readonly operations: readonly RenderOperation[];
  readonly manifestOverrides?: ReadonlyMap<string, PackageManifestForTaskGraph>;
}): Promise<PackageManifestForTaskGraph[]> {
  const manifests: PackageManifestForTaskGraph[] = [];

  for (const packageDefinition of options.blueprint.packages ?? []) {
    const manifestOverride = options.manifestOverrides?.get(
      packageDefinition.path,
    );
    const manifestFromOperations = generatedPackageManifestFromOperations(
      options.operations,
      packageDefinition.path,
    );

    if (manifestOverride !== undefined) {
      manifests.push(manifestOverride);
      continue;
    }

    if (manifestFromOperations !== undefined) {
      manifests.push(manifestFromOperations);
      continue;
    }

    const manifest = await readJson(
      path.join(options.root, packageDefinition.path, "package.json"),
    );
    assertObjectManifest(manifest, packageDefinition.path);
    manifests.push(manifest);
  }

  return manifests;
}

function blueprintWithPackage(
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string,
  packageRole: PackageRole,
  packageSourcePreset: PackageSourcePreset,
  packageLinkIntents: readonly PackageLinkIntent[],
): ProjectBlueprint {
  const nextBlueprint = {
    ...blueprint,
    packages: [
      ...(blueprint.packages ?? []),
      {
        name: packageName,
        path: packagePath,
        role: packageRole,
        sourcePreset: packageSourcePreset,
      },
    ],
    packageLinkIntents:
      packageLinkIntents.length > 0
        ? [...(blueprint.packageLinkIntents ?? []), ...packageLinkIntents]
        : blueprint.packageLinkIntents,
  };
  const result = validateProjectBlueprint(nextBlueprint);

  if (!result.ok) {
    throw new Error(
      "Package Addition would write an invalid .template/blueprint.json",
    );
  }

  return result.value;
}

function assertObjectManifest(
  input: unknown,
  packagePath: string,
): asserts input is PackageManifestForTaskGraph & Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(
      `Cannot update Package Link Intent manifest for ${packagePath}: package.json must be an object`,
    );
  }
}

function recordSortedByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

async function consumerManifestUpdatesForPackageLinkIntents(options: {
  readonly root: string;
  readonly manifestDependenciesByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, "workspace:*">>
  >;
}): Promise<ConsumerManifestUpdate[]> {
  const updates: ConsumerManifestUpdate[] = [];

  for (const [
    packagePath,
    packageLinkDependencies,
  ] of options.manifestDependenciesByPackagePath) {
    const manifest = await readJson(
      path.join(options.root, packagePath, "package.json"),
    );
    assertObjectManifest(manifest, packagePath);
    if (
      manifest.dependencies !== undefined &&
      !isRecord(manifest.dependencies)
    ) {
      throw new Error(
        `Cannot update Package Link Intent manifest for ${packagePath}: dependencies must be an object`,
      );
    }

    updates.push({
      packagePath,
      manifest: {
        ...manifest,
        dependencies: recordSortedByKey({
          ...manifest.dependencies,
          ...packageLinkDependencies,
        }),
      },
    });
  }

  return updates;
}

function workspacePackageGlobsFromBlueprint(
  blueprint: ProjectBlueprint,
): string[] {
  const globs: string[] = [];

  for (const packageDefinition of blueprint.packages ?? []) {
    const [workspaceDir] = packageDefinition.path.split("/");

    if (!workspaceDir) {
      throw new Error(
        `Cannot update root Package Addition scripts: invalid package path ${packageDefinition.path}`,
      );
    }

    const glob = `${workspaceDir}/*`;
    if (!globs.includes(glob)) {
      globs.push(glob);
    }
  }

  return globs;
}

function turboPackageTaskCommand(
  task: "typecheck" | "build" | "test" | "test:e2e" | "check" | "fix",
  workspacePackageGlobs: readonly string[],
): string {
  const filters = workspacePackageGlobs.map((glob) => `--filter './${glob}'`);

  return [`turbo run ${task}`, ...filters].join(" ");
}

function rootScriptWithTurboPackageTask(
  script: string,
  task: "typecheck" | "build" | "test" | "test:e2e" | "check" | "fix",
  workspacePackageGlobs: readonly string[],
): string {
  const commands = script.split(" && ");
  const turboCommandIndex = commands.findIndex((command) =>
    command.startsWith(`turbo run ${task}`),
  );

  if (turboCommandIndex === -1) {
    throw new Error(
      `Cannot update root Package Addition scripts: scripts.${task} must run Turbo package tasks`,
    );
  }

  commands[turboCommandIndex] = turboPackageTaskCommand(
    task,
    workspacePackageGlobs,
  );

  return commands.join(" && ");
}

function turboTaskNamesForPackageManifests(
  manifests: readonly PackageManifestForTaskGraph[],
): Array<"typecheck" | "build" | "test" | "test:e2e" | "check"> {
  const taskNames: Array<
    "typecheck" | "build" | "test" | "test:e2e" | "check"
  > = [];

  for (const taskName of [
    "typecheck",
    "build",
    "test",
    "test:e2e",
    "check",
  ] as const) {
    if (
      manifests.some(
        (manifest) => typeof manifest.scripts?.[taskName] === "string",
      )
    ) {
      taskNames.push(taskName);
    }
  }

  return taskNames;
}

function rootScriptWithTurboPackageTasks(options: {
  readonly script: string;
  readonly taskNames: readonly (
    | "typecheck"
    | "build"
    | "test"
    | "test:e2e"
    | "check"
  )[];
  readonly workspacePackageGlobs: readonly string[];
}): string {
  const rootCommands = options.script
    .split(" && ")
    .filter((command) => !command.startsWith("turbo run "));
  const turboCommands = options.taskNames.map((taskName) =>
    turboPackageTaskCommand(taskName, options.workspacePackageGlobs),
  );

  return [...rootCommands, ...turboCommands].join(" && ");
}

function rootPackageJsonWithPackageTaskFilters(
  input: unknown,
  blueprint: ProjectBlueprint,
  packageManifests: readonly PackageManifestForTaskGraph[],
): RootPackageJson {
  assertRootPackageJson(input);

  const workspacePackageGlobs = workspacePackageGlobsFromBlueprint(blueprint);
  const taskNames = turboTaskNamesForPackageManifests(packageManifests);
  const rootCheckTaskNames = taskNames.filter(
    (taskName) => taskName !== "test:e2e",
  );
  const checkScript = input.scripts.check;
  const fixScript = input.scripts.fix;
  if (checkScript === undefined || fixScript === undefined) {
    throw new Error(
      "Cannot update root Package Addition scripts: check and fix scripts are required",
    );
  }

  return {
    ...input,
    scripts: {
      ...input.scripts,
      check: rootScriptWithTurboPackageTasks({
        script: checkScript,
        taskNames: rootCheckTaskNames,
        workspacePackageGlobs,
      }),
      fix: rootScriptWithTurboPackageTask(
        fixScript,
        "fix",
        workspacePackageGlobs,
      ),
    },
  };
}

function manifestExportUsesCompiledRuntime(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const rootExport = value["."];
  if (!isRecord(rootExport)) {
    return false;
  }

  return (
    typeof rootExport.default === "string" &&
    rootExport.default.startsWith("./dist/")
  );
}

function packageManifestsNeedDependencyBuilds(
  manifests: readonly PackageManifestForTaskGraph[],
): boolean {
  const compiledPackageNames = new Set(
    manifests
      .filter((manifest) => manifestExportUsesCompiledRuntime(manifest.exports))
      .map((manifest) => manifest.name)
      .filter((name): name is string => typeof name === "string"),
  );

  if (compiledPackageNames.size === 0) {
    return false;
  }

  return manifests.some((manifest) =>
    Object.entries(manifest.dependencies ?? {}).some(
      ([dependencyName, specifier]) =>
        specifier === "workspace:*" && compiledPackageNames.has(dependencyName),
    ),
  );
}

function turboConfigForPackageManifests(
  manifests: readonly PackageManifestForTaskGraph[],
): { tasks: TurboTaskGraph } {
  return {
    tasks: packageTurboTasks({
      dependencyBuildsRequired: packageManifestsNeedDependencyBuilds(manifests),
    }),
  };
}

function rootPackageJsonWithSharedOxcRuntimeDependencies(
  input: RootPackageJson,
  requiresSharedOxcConfiguration: boolean,
): RootPackageJson {
  if (!requiresSharedOxcConfiguration) {
    return input;
  }

  if (input.type !== undefined && input.type !== "module") {
    throw new Error(
      'Cannot update root OXC configuration: package.json type must be "module" or omitted',
    );
  }

  if (input.devDependencies !== undefined && !isRecord(input.devDependencies)) {
    throw new Error(
      "Cannot update root OXC configuration dependencies: devDependencies must be an object",
    );
  }

  return {
    ...input,
    type: "module",
    devDependencies: {
      ...input.devDependencies,
      oxfmt: input.devDependencies?.oxfmt ?? "catalog:",
      oxlint: input.devDependencies?.oxlint ?? "catalog:",
      "oxlint-tsgolint":
        input.devDependencies?.["oxlint-tsgolint"] ?? "catalog:",
    },
  };
}

function catalogDependenciesWithSharedOxcRuntimeDependencies(
  catalogDependencies: readonly string[],
  requiresSharedOxcConfiguration: boolean,
): string[] {
  const dependencies = [...catalogDependencies];

  if (!requiresSharedOxcConfiguration) {
    return dependencies;
  }

  for (const dependency of ["oxfmt", "oxlint", "oxlint-tsgolint"]) {
    if (!dependencies.includes(dependency)) {
      dependencies.push(dependency);
    }
  }

  return dependencies;
}

async function planRootUpdates(
  root: string,
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string,
  packageRole: PackageRole,
  packageSourcePreset: PackageSourcePreset,
  packageLinkIntents: readonly PackageLinkIntent[],
  workspacePackageGlob: string,
  catalogDependencies: readonly string[],
  requiresSharedOxcConfiguration: boolean,
  operations: readonly RenderOperation[],
): Promise<RootUpdatePlan> {
  const nextBlueprint = blueprintWithPackage(
    blueprint,
    packageName,
    packagePath,
    packageRole,
    packageSourcePreset,
    packageLinkIntents,
  );
  const consumerManifestUpdates =
    packageLinkIntents.length > 0
      ? await consumerManifestUpdatesForPackageLinkIntents({
          root,
          manifestDependenciesByPackagePath: planPackageLinks(
            [
              {
                name: packageName,
                path: packagePath,
                role: packageRole,
                sourcePreset: packageSourcePreset,
              },
            ],
            packageLinkIntents,
          ).manifestDependenciesByPackagePath,
        })
      : [];
  const manifestOverrides = new Map(
    consumerManifestUpdates.map((update) => [
      update.packagePath,
      update.manifest,
    ]),
  );
  const packageManifests = await packageManifestsForTaskGraph({
    root,
    blueprint: nextBlueprint,
    operations,
    manifestOverrides,
  });
  const workspaceText = pnpmWorkspaceYamlWithCatalogDependencies(
    workspaceTextWithPackageGlob(
      await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"),
      workspacePackageGlob,
    ),
    catalogDependenciesWithSharedOxcRuntimeDependencies(
      catalogDependencies,
      requiresSharedOxcConfiguration,
    ),
  );
  const rootPackageJson = rootPackageJsonWithPackageTaskFilters(
    await readJson(path.join(root, "package.json")),
    nextBlueprint,
    packageManifests,
  );

  return {
    blueprint: nextBlueprint,
    rootPackageJson: rootPackageJsonWithSharedOxcRuntimeDependencies(
      rootPackageJson,
      requiresSharedOxcConfiguration,
    ),
    turboConfig: turboConfigForPackageManifests(packageManifests),
    workspaceText,
    consumerManifestUpdates,
  };
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function writeIfMissing(filePath: string, text: string): Promise<void> {
  if ((await readTextIfExists(filePath)) !== undefined) {
    return;
  }

  await writeFile(filePath, text, "utf8");
}

async function ensureRootOxfmtConfig(
  root: string,
  sharedOxcRoot: string,
): Promise<void> {
  await writeIfMissing(
    path.join(root, "oxfmt.config.ts"),
    await readFile(path.join(sharedOxcRoot, "oxfmt.config.ts"), "utf8"),
  );
}

async function ensureRootOxlintConfig(options: {
  root: string;
  sharedOxcRoot: string;
  addedPreset: string;
}): Promise<void> {
  const nodeConfig = await readFile(
    path.join(options.sharedOxcRoot, "node", "oxlint.config.ts"),
    "utf8",
  );
  const vueConfig = await readFile(
    path.join(options.sharedOxcRoot, "vue", "oxlint.config.ts"),
    "utf8",
  );
  const targetPath = path.join(options.root, "oxlint.config.ts");
  const currentConfig = await readTextIfExists(targetPath);

  if (currentConfig === undefined) {
    await writeFile(
      targetPath,
      options.addedPreset === "vue-app" ? vueConfig : nodeConfig,
      "utf8",
    );
    return;
  }

  if (options.addedPreset !== "vue-app" || currentConfig === vueConfig) {
    return;
  }

  if (currentConfig === nodeConfig) {
    await writeFile(targetPath, vueConfig, "utf8");
    return;
  }

  throw new Error(
    "Cannot update root OXC lint configuration for Vue Package Addition: oxlint.config.ts has local changes",
  );
}

async function ensureRootOxcConfiguration(options: {
  root: string;
  sharedOxcRoot?: string | undefined;
  addedPreset: string;
}): Promise<void> {
  if (!options.sharedOxcRoot) {
    return;
  }

  await ensureRootOxfmtConfig(options.root, options.sharedOxcRoot);
  await ensureRootOxlintConfig({
    root: options.root,
    sharedOxcRoot: options.sharedOxcRoot,
    addedPreset: options.addedPreset,
  });
}

function gitignoreContainsEntry(text: string, entry: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => line.trim() === entry || line.trim() === `${entry}/`);
}

function gitignoreTextWithEntries(
  text: string,
  entries: readonly string[],
): string {
  const missingEntries = entries.filter(
    (entry) => !gitignoreContainsEntry(text, entry),
  );

  if (missingEntries.length === 0) {
    return text;
  }

  const prefix = text.trimEnd();
  return `${prefix}${prefix.length > 0 ? "\n" : ""}${missingEntries.join("\n")}\n`;
}

function rootGitignoreEntriesForPackageAddition(
  preset: string,
  requiresSharedOxcConfiguration: boolean,
): string[] {
  const entries = requiresSharedOxcConfiguration
    ? ["node_modules", "dist"]
    : [];

  if (preset === "vue-app") {
    entries.push("playwright-report", "test-results");
  }

  return entries;
}

async function ensureRootGitignoreEntries(
  root: string,
  entries: readonly string[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const gitignorePath = path.join(root, ".gitignore");
  const currentText = (await readTextIfExists(gitignorePath)) ?? "";
  const nextText = gitignoreTextWithEntries(currentText, entries);

  if (nextText !== currentText) {
    await writeFile(gitignorePath, nextText, "utf8");
  }
}

export async function addPackage(options: AddPackageOptions): Promise<void> {
  assertSafePackageLeaf(options.name);

  const root = path.resolve(options.cwd);
  const blueprint = await readGeneratedWorkspaceBlueprint(root);
  const repositoryMetadata = await readGeneratedRepositoryPackageMetadata(root);
  const projectName = projectNameFromBlueprint(
    blueprint,
    repositoryMetadata.projectName,
  );
  const packageName = `@${projectName}/${options.name}`;
  const preset = findPresetSourceManifestPreset(
    options.presetSourceManifest,
    options.preset,
  );

  if (!preset) {
    throw new Error(`Unknown preset for Package Addition: ${options.preset}`);
  }

  if (preset.packageAdditionSupport !== PackageAdditionSupport.Supported) {
    throw new Error(
      formatUnsupportedPackageAdditionPresetError(
        options.preset,
        options.presetSourceManifest,
      ),
    );
  }

  const packagePath = options.path
    ? validateExplicitPackagePath(options.path)
    : defaultPackagePathForPresetSourcePackageAddition(
        preset,
        options.name,
        options.projectionSourceRoots,
      );

  const additionPlan = await planPresetSourcePackageAddition({
    preset,
    sourceRoots: options.projectionSourceRoots,
    addition: {
      root,
      blueprint,
      packageLeafName: options.name,
      packageName,
      packagePath,
      nodeVersion: repositoryMetadata.nodeVersion,
    },
  });
  const requiresSharedOxcConfiguration =
    additionPlan.sourceRoots?.sharedOxc !== undefined;

  assertNoPackageConflict(blueprint, packageName, additionPlan.packagePath);
  const packageLinkIntents = packageLinkIntentsForConsumers({
    blueprint,
    consumerPackagePaths: options.linkFrom ?? [],
    providerPackagePath: additionPlan.packagePath,
  });

  await assertPackageLinkIntentConsumersAreTypeScriptBoundaries({
    root,
    blueprint,
    packageLinkIntents,
  });
  await assertMissingPackagePath(
    additionPlan.packagePath,
    path.join(root, additionPlan.packagePath),
  );
  const rootUpdatePlan = await planRootUpdates(
    root,
    blueprint,
    packageName,
    additionPlan.packagePath,
    additionPlan.packageRole,
    additionPlan.packageSourcePreset,
    packageLinkIntents,
    additionPlan.workspaceMembershipGlob ?? additionPlan.workspacePackageGlob,
    packageAdditionCatalogDependencies(additionPlan.operations),
    requiresSharedOxcConfiguration,
    additionPlan.operations,
  );

  await mkdir(path.join(root, additionPlan.packagePath), { recursive: true });
  await ensureRootOxcConfiguration({
    root,
    sharedOxcRoot: additionPlan.sourceRoots?.sharedOxc,
    addedPreset: options.preset,
  });
  await ensureRootGitignoreEntries(
    root,
    rootGitignoreEntriesForPackageAddition(
      options.preset,
      requiresSharedOxcConfiguration,
    ),
  );
  await renderProject({
    sourceRoot: additionPlan.sourceRoot,
    sourceRoots: additionPlan.sourceRoots,
    targetRoot: root,
    operations: [...additionPlan.operations],
  });

  for (const textFile of additionPlan.textFiles ?? []) {
    await writeFile(
      resolveGeneratedPath(root, textFile.path),
      textFile.text,
      "utf8",
    );
  }

  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    rootUpdatePlan.workspaceText,
    "utf8",
  );
  await writeJson(
    path.join(root, "package.json"),
    rootUpdatePlan.rootPackageJson,
  );
  await writeJson(path.join(root, "turbo.json"), rootUpdatePlan.turboConfig);
  for (const update of rootUpdatePlan.consumerManifestUpdates) {
    await writeJson(
      path.join(root, update.packagePath, "package.json"),
      update.manifest,
    );
  }
  await writeJson(
    path.join(root, ".template/blueprint.json"),
    rootUpdatePlan.blueprint,
  );
}
