import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  builtInPresetProjections,
  findBuiltInPresetProjection,
} from "../templates/registry.js";
import {
  validateProjectBlueprint,
  type ProjectBlueprint,
} from "./declarations.js";
import {
  collectGeneratedManifestCatalogReferences,
  pnpmWorkspaceYamlWithCatalogDependencies,
  type GeneratedPackageManifestDependencies,
} from "./dependency-catalog.js";
import { PackageAdditionSupport } from "./package-addition-support.js";
import { renderProject } from "./renderer.js";
import type { RenderOperation } from "./renderer.js";

export type AddPackageOptions = {
  cwd: string;
  preset: string;
  name: string;
  path?: string;
};

type RootTsconfig = {
  references?: Array<{ path: string }>;
  [key: string]: unknown;
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
  rootTsconfig: RootTsconfig;
  workspaceText: string;
};

function projectNameFromBlueprint(
  blueprint: ProjectBlueprint,
  fallbackProjectName: string,
): string {
  const firstPackage = blueprint.packages?.[0];
  const match = firstPackage?.name.match(/^@([^/]+)\//);

  if (match) {
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

function defaultPackagePathForPreset(
  preset: string,
  packageLeafName: string,
): string {
  return preset === "ts-lib"
    ? `packages/${packageLeafName}`
    : `apps/${packageLeafName}`;
}

function supportedPackageAdditionPresetNames(): string[] {
  return builtInPresetProjections
    .filter(
      (projection) =>
        projection.metadata.packageAdditionSupport ===
        PackageAdditionSupport.Supported,
    )
    .map((projection) => projection.metadata.name);
}

function formatUnsupportedPackageAdditionPresetError(preset: string): string {
  return [
    `Preset ${preset} cannot be used for Package Addition.`,
    "It can still initialize a Generated Repository, but it cannot be added to an existing one.",
    `Supported Package Addition presets: ${supportedPackageAdditionPresetNames().join(", ")}`,
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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonOrDefault<T>(
  filePath: string,
  defaultValue: T,
): Promise<T> {
  try {
    return await readJson<T>(filePath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return defaultValue;
    }

    throw error;
  }
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
    blueprintJson = await readJson<unknown>(blueprintPath);
  } catch (error: unknown) {
    if (
      error instanceof SyntaxError ||
      (isNodeError(error) && error.code === "ENOENT")
    ) {
      throw new Error(
        "Package Addition requires a valid .template/blueprint.json",
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
  const packageJson = await readJson<unknown>(path.join(root, "package.json"));

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

function assertRootTsconfig(input: unknown): asserts input is RootTsconfig {
  if (!isRecord(input)) {
    throw new Error(
      "Cannot update root TypeScript project references: tsconfig.json must be an object",
    );
  }

  const references = input.references;
  if (references === undefined) {
    return;
  }

  if (!Array.isArray(references)) {
    throw new Error(
      "Cannot update root TypeScript project references: references must be an array",
    );
  }

  for (const reference of references) {
    if (!isRecord(reference) || typeof reference.path !== "string") {
      throw new Error(
        "Cannot update root TypeScript project references: each reference must have a string path",
      );
    }
  }
}

function rootTsconfigWithReferences(
  input: unknown,
  referencePaths: readonly string[],
): RootTsconfig {
  assertRootTsconfig(input);

  if (referencePaths.length === 0) {
    return input;
  }

  const tsconfig = input;
  const references = tsconfig.references ?? [];

  for (const referencePath of referencePaths) {
    if (!references.some((reference) => reference.path === referencePath)) {
      references.push({ path: referencePath });
    }
  }

  return { ...tsconfig, references };
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

function blueprintWithPackage(
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string,
): ProjectBlueprint {
  const nextBlueprint = {
    ...blueprint,
    packages: [
      ...(blueprint.packages ?? []),
      { name: packageName, path: packagePath },
    ],
  };
  const result = validateProjectBlueprint(nextBlueprint);

  if (!result.ok) {
    throw new Error(
      "Package Addition would write an invalid .template/blueprint.json",
    );
  }

  return result.value;
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
  task: "check" | "fix",
  workspacePackageGlobs: readonly string[],
): string {
  const filters = workspacePackageGlobs.map((glob) => `--filter './${glob}'`);

  return [`turbo run ${task}`, ...filters].join(" ");
}

function rootScriptWithTurboPackageTask(
  script: string,
  task: "check" | "fix",
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

function rootPackageJsonWithPackageTaskFilters(
  input: unknown,
  blueprint: ProjectBlueprint,
): RootPackageJson {
  assertRootPackageJson(input);

  const workspacePackageGlobs = workspacePackageGlobsFromBlueprint(blueprint);

  return {
    ...input,
    scripts: {
      ...input.scripts,
      check: rootScriptWithTurboPackageTask(
        input.scripts.check,
        "check",
        workspacePackageGlobs,
      ),
      fix: rootScriptWithTurboPackageTask(
        input.scripts.fix,
        "fix",
        workspacePackageGlobs,
      ),
    },
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

  for (const dependency of ["oxfmt", "oxlint"]) {
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
  workspacePackageGlob: string,
  rootTsconfigReferences: readonly string[],
  catalogDependencies: readonly string[],
  requiresSharedOxcConfiguration: boolean,
): Promise<RootUpdatePlan> {
  const nextBlueprint = blueprintWithPackage(
    blueprint,
    packageName,
    packagePath,
  );
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
  const rootTsconfig = rootTsconfigWithReferences(
    await readJsonOrDefault<unknown>(path.join(root, "tsconfig.json"), {
      files: [],
    }),
    rootTsconfigReferences,
  );
  const rootPackageJson = rootPackageJsonWithPackageTaskFilters(
    await readJson<unknown>(path.join(root, "package.json")),
    nextBlueprint,
  );

  return {
    blueprint: nextBlueprint,
    rootPackageJson: rootPackageJsonWithSharedOxcRuntimeDependencies(
      rootPackageJson,
      requiresSharedOxcConfiguration,
    ),
    rootTsconfig,
    workspaceText,
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
  sharedOxcRoot?: string;
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
  const packagePath = options.path
    ? validateExplicitPackagePath(options.path)
    : defaultPackagePathForPreset(options.preset, options.name);
  const projection = findBuiltInPresetProjection(options.preset);

  if (!projection) {
    throw new Error(`Unknown preset for Package Addition: ${options.preset}`);
  }

  if (
    projection.metadata.packageAdditionSupport !==
    PackageAdditionSupport.Supported
  ) {
    throw new Error(
      formatUnsupportedPackageAdditionPresetError(options.preset),
    );
  }

  const packageAddition = projection.capabilities?.packageAddition;

  if (!packageAddition) {
    throw new Error(
      `Preset ${options.preset} declares Package Addition support but has no Package Addition implementation`,
    );
  }

  const additionPlan = await packageAddition.planPackageAddition({
    root,
    blueprint,
    packageLeafName: options.name,
    packageName,
    packagePath,
    nodeVersion: repositoryMetadata.nodeVersion,
  });
  const requiresSharedOxcConfiguration =
    additionPlan.sourceRoots?.sharedOxc !== undefined;

  assertNoPackageConflict(blueprint, packageName, additionPlan.packagePath);

  await assertMissingPackagePath(
    additionPlan.packagePath,
    path.join(root, additionPlan.packagePath),
  );
  const rootUpdatePlan = await planRootUpdates(
    root,
    blueprint,
    packageName,
    additionPlan.packagePath,
    additionPlan.workspacePackageGlob,
    additionPlan.rootTsconfigReferences,
    packageAdditionCatalogDependencies(additionPlan.operations),
    requiresSharedOxcConfiguration,
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
  await writeJson(
    path.join(root, "tsconfig.json"),
    rootUpdatePlan.rootTsconfig,
  );
  await writeJson(
    path.join(root, ".template/blueprint.json"),
    rootUpdatePlan.blueprint,
  );
}
