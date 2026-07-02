import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { findBuiltInPresetProjection } from "../templates/registry.js";
import {
  validateProjectBlueprint,
  type ProjectBlueprint,
} from "./declarations.js";
import {
  collectGeneratedManifestCatalogReferences,
  pnpmWorkspaceYamlWithCatalogDependencies,
  type GeneratedPackageManifestDependencies,
} from "./dependency-catalog.js";
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
  [key: string]: unknown;
};

type RootUpdatePlan = {
  blueprint: ProjectBlueprint;
  rootPackageJson: RootPackageJson;
  rootTsconfig: RootTsconfig;
  workspaceText: string;
};

function projectNameFromBlueprint(blueprint: ProjectBlueprint): string {
  const firstPackage = blueprint.packages?.[0];
  const match = firstPackage?.name.match(/^@([^/]+)\//);

  if (!match) {
    throw new Error(
      "Cannot infer workspace package scope from the stored Project Blueprint",
    );
  }

  return match[1];
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

async function readGeneratedRepositoryNodeVersion(
  root: string,
): Promise<string> {
  const packageJson = await readJson<unknown>(path.join(root, "package.json"));

  if (!isRecord(packageJson) || !isRecord(packageJson.engines)) {
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

  return nodeVersion;
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

async function planRootUpdates(
  root: string,
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string,
  workspacePackageGlob: string,
  rootTsconfigReferences: readonly string[],
  catalogDependencies: readonly string[],
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
    catalogDependencies,
  );
  const rootTsconfig = rootTsconfigWithReferences(
    await readJson<unknown>(path.join(root, "tsconfig.json")),
    rootTsconfigReferences,
  );
  const rootPackageJson = rootPackageJsonWithPackageTaskFilters(
    await readJson<unknown>(path.join(root, "package.json")),
    nextBlueprint,
  );

  return {
    blueprint: nextBlueprint,
    rootPackageJson,
    rootTsconfig,
    workspaceText,
  };
}

export async function addPackage(options: AddPackageOptions): Promise<void> {
  assertSafePackageLeaf(options.name);

  const root = path.resolve(options.cwd);
  const blueprint = await readGeneratedWorkspaceBlueprint(root);
  const nodeVersion = await readGeneratedRepositoryNodeVersion(root);
  const projectName = projectNameFromBlueprint(blueprint);
  const packageName = `@${projectName}/${options.name}`;
  const packagePath = options.path
    ? validateExplicitPackagePath(options.path)
    : defaultPackagePathForPreset(options.preset, options.name);
  const projection = findBuiltInPresetProjection(options.preset);
  const packageAddition = projection?.capabilities?.packageAddition;

  if (!projection) {
    throw new Error(`Unknown preset for Package Addition: ${options.preset}`);
  }

  if (!packageAddition) {
    throw new Error(
      `Package Addition is not supported by preset: ${options.preset}`,
    );
  }

  const additionPlan = await packageAddition.planPackageAddition({
    root,
    blueprint,
    packageLeafName: options.name,
    packageName,
    packagePath,
    nodeVersion,
  });

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
  );

  await mkdir(path.join(root, additionPlan.packagePath), { recursive: true });
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
