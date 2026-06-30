import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { findBuiltInPresetProjection } from "../templates/registry.js";
import {
  validateProjectBlueprint,
  type ProjectBlueprint,
} from "./declarations.js";
import { renderProject } from "./renderer.js";

export type AddPackageOptions = {
  cwd: string;
  preset: string;
  name: string;
};

type RootTsconfig = {
  references?: Array<{ path: string }>;
  [key: string]: unknown;
};

type RootUpdatePlan = {
  blueprint: ProjectBlueprint;
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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertMissing(targetPath: string): Promise<void> {
  try {
    await stat(targetPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(
    `Package Addition would overwrite an existing path: ${targetPath}`,
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

async function readGeneratedWorkspaceBlueprint(
  root: string,
): Promise<ProjectBlueprint> {
  const blueprintPath = path.join(root, ".project-kit/blueprint.json");
  const result = validateProjectBlueprint(
    await readJson<unknown>(blueprintPath),
  );

  if (!result.ok) {
    throw new Error(
      "Package Addition requires a valid .project-kit/blueprint.json",
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
      "Package Addition would write an invalid .project-kit/blueprint.json",
    );
  }

  return result.value;
}

async function planRootUpdates(
  root: string,
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string,
  workspacePackageGlob: string,
  rootTsconfigReferences: readonly string[],
): Promise<RootUpdatePlan> {
  const workspaceText = workspaceTextWithPackageGlob(
    await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"),
    workspacePackageGlob,
  );
  const rootTsconfig = rootTsconfigWithReferences(
    await readJson<unknown>(path.join(root, "tsconfig.json")),
    rootTsconfigReferences,
  );

  return {
    blueprint: blueprintWithPackage(blueprint, packageName, packagePath),
    rootTsconfig,
    workspaceText,
  };
}

export async function addPackage(options: AddPackageOptions): Promise<void> {
  assertSafePackageLeaf(options.name);

  const root = path.resolve(options.cwd);
  const blueprint = await readGeneratedWorkspaceBlueprint(root);
  const projectName = projectNameFromBlueprint(blueprint);
  const packageName = `@${projectName}/${options.name}`;
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
  });

  if (
    blueprint.packages?.some(
      (pkg) =>
        pkg.name === packageName || pkg.path === additionPlan.packagePath,
    )
  ) {
    throw new Error(
      `Package Addition conflicts with an existing package definition: ${packageName}`,
    );
  }

  await assertMissing(path.join(root, additionPlan.packagePath));
  const rootUpdatePlan = await planRootUpdates(
    root,
    blueprint,
    packageName,
    additionPlan.packagePath,
    additionPlan.workspacePackageGlob,
    additionPlan.rootTsconfigReferences,
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
    path.join(root, "tsconfig.json"),
    rootUpdatePlan.rootTsconfig,
  );
  await writeJson(
    path.join(root, ".project-kit/blueprint.json"),
    rootUpdatePlan.blueprint,
  );
}
