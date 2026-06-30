#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";

import {
  builtInPresetProjections,
  findBuiltInPresetProjection,
} from "../templates/registry.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultTemplatesRoot = path.join(repoRoot, "templates");

type CheckTemplateGithubYamlOptions = {
  templatesRoot?: string;
  supportedPresetNames?: readonly string[];
};

async function listGithubYamlTemplates(
  templatesRoot: string,
): Promise<string[]> {
  const templateEntries = await readdir(templatesRoot, { withFileTypes: true });
  const templateFiles: string[] = [];

  for (const templateEntry of templateEntries) {
    if (!templateEntry.isDirectory()) {
      continue;
    }

    const githubRoot = path.join(templatesRoot, templateEntry.name, ".github");
    templateFiles.push(...(await listYamlFiles(githubRoot)));
  }

  return templateFiles.sort((left, right) => left.localeCompare(right));
}

async function listYamlFiles(directory: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listYamlFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && isYamlFile(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function isYamlFile(fileName: string): boolean {
  return fileName.endsWith(".yml") || fileName.endsWith(".yaml");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function relativeTemplateFilePath(
  templatesRoot: string,
  filePath: string,
): string {
  return `templates/${path.relative(templatesRoot, filePath).split(path.sep).join("/")}`;
}

async function checkYamlTemplate(
  templatesRoot: string,
  filePath: string,
): Promise<string[]> {
  const contents = await readFile(filePath, "utf8");
  const document = parseDocument(contents);
  const relativePath = relativeTemplateFilePath(templatesRoot, filePath);
  const problems = [...document.errors, ...document.warnings].map(
    (error) => `${relativePath}: ${error.message}`,
  );

  if (!isMap(document.contents)) {
    problems.push(`${relativePath}: expected a top-level YAML map`);
    return problems;
  }

  if (
    /^templates\/[^/]+\/\.github\/workflows\/[^/]+\.ya?ml$/.test(relativePath)
  ) {
    problems.push(...checkWorkflowTemplate(relativePath, document.contents));
    problems.push(
      ...checkProjectedTemplate(relativePath, contents, "workflow"),
    );
  } else if (
    /^templates\/[^/]+\/\.github\/dependabot\.ya?ml$/.test(relativePath)
  ) {
    problems.push(...checkDependabotTemplate(relativePath, document.contents));
    problems.push(
      ...checkProjectedTemplate(relativePath, contents, "dependabot"),
    );
  }

  return problems;
}

function checkProjectedTemplate(
  relativePath: string,
  contents: string,
  kind: "workflow" | "dependabot",
): string[] {
  const presetName = presetNameFromRelativePath(relativePath);

  if (!presetName || !findSupportedPresetProjection(presetName)) {
    return [];
  }

  const expected =
    kind === "workflow"
      ? projectGithubCheckWorkflow(presetName)
      : projectDependabotTemplate(presetName);

  if (contents.replace(/\r\n/g, "\n") === expected) {
    return [];
  }

  const projectionName =
    kind === "workflow"
      ? "GitHub check workflow projection"
      : "Dependabot projection";
  return [
    `${relativePath}: expected checked template source to match ${projectionName}`,
  ];
}

function presetNameFromRelativePath(relativePath: string): string | undefined {
  return relativePath.match(/^templates\/([^/]+)\//)?.[1];
}

function findSupportedPresetProjection(presetName: string) {
  const projection = findBuiltInPresetProjection(presetName);

  return projection?.metadata.generation === "supported"
    ? projection
    : undefined;
}

function projectGithubCheckWorkflow(presetName: string): string {
  const projectionPlan = projectThroughPresetProjection(presetName);
  const projectedWorkflow = projectionPlan?.operations.find(
    (operation) =>
      operation.kind === "writeText" &&
      operation.to === ".github/workflows/check.yml",
  );

  return projectedWorkflow?.kind === "writeText"
    ? projectedWorkflow.text
    : missingProjectedGithubTemplate(presetName, "workflow");
}

function projectDependabotTemplate(presetName: string): string {
  const projectionPlan = projectThroughPresetProjection(presetName);
  const projectedDependabot = projectionPlan?.operations.find(
    (operation) =>
      operation.kind === "writeText" &&
      operation.to === ".github/dependabot.yml",
  );

  return projectedDependabot?.kind === "writeText"
    ? projectedDependabot.text
    : missingProjectedGithubTemplate(presetName, "dependabot");
}

function missingProjectedGithubTemplate(
  presetName: string,
  kind: "workflow" | "dependabot",
): never {
  throw new Error(
    `Preset Projection ${presetName} did not project ${kind} template source`,
  );
}

function projectThroughPresetProjection(presetName: string) {
  const projection = findSupportedPresetProjection(presetName);

  if (!projection) {
    return undefined;
  }

  return projection.project({
    projectName: { kind: "ProjectName", value: "generated-repository" },
    preset: presetName,
    packageManager: { kind: "PackageManager", value: "pnpm" },
    blueprint: projection.blueprint({ targetDir: "generated-repository" }),
    toolchain: {
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "22" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.0.0" },
      source: "bundled-fallback",
      diagnostics: [],
    },
  });
}

function checkWorkflowTemplate(
  relativePath: string,
  document: YAMLMap,
): string[] {
  const problems: string[] = [];
  const jobs = getMapValue(document, "jobs");

  if (getMapValue(document, "name") === undefined) {
    problems.push(`${relativePath}: expected workflow name`);
  }

  if (getMapValue(document, "on") === undefined) {
    problems.push(`${relativePath}: expected workflow triggers`);
  }

  if (!isMap(jobs) || jobs.items.length === 0) {
    problems.push(`${relativePath}: expected at least one workflow job`);
    return problems;
  }

  for (const job of jobs.items) {
    if (!isMap(job.value)) {
      problems.push(
        `${relativePath}: expected workflow job ${String(job.key)} to be a map`,
      );
    }
  }

  const checkJob = getMapValue(jobs, "check");
  if (checkJob === undefined) {
    problems.push(`${relativePath}: expected check workflow job`);
  } else if (isMap(checkJob)) {
    if (typeof getMapValue(checkJob, "runs-on") !== "string") {
      problems.push(
        `${relativePath}: expected check workflow job to declare runs-on`,
      );
    }

    const steps = getMapValue(checkJob, "steps");
    if (!isSeq(steps) || steps.items.length === 0) {
      problems.push(
        `${relativePath}: expected check workflow job to declare steps`,
      );
    } else if (!steps.items.every(isMap)) {
      problems.push(
        `${relativePath}: expected every check workflow step to be a map`,
      );
    }
  }

  return problems;
}

function checkDependabotTemplate(
  relativePath: string,
  document: YAMLMap,
): string[] {
  const problems: string[] = [];
  const version = getMapValue(document, "version");
  const updates = getMapValue(document, "updates");

  if (version !== 2) {
    problems.push(`${relativePath}: expected Dependabot version 2`);
  }

  if (!isSeq(updates) || updates.items.length === 0) {
    problems.push(`${relativePath}: expected Dependabot updates`);
    return problems;
  }

  const updateMaps = updates.items.filter(isMap) as YAMLMap[];
  const ecosystems = updateMaps
    .map((update) => getMapValue(update, "package-ecosystem"))
    .filter((ecosystem): ecosystem is string => typeof ecosystem === "string");

  if (updateMaps.length !== updates.items.length) {
    problems.push(
      `${relativePath}: expected every Dependabot update to be a map`,
    );
  }

  if (!ecosystems.includes("github-actions")) {
    problems.push(
      `${relativePath}: expected github-actions Dependabot coverage`,
    );
  }

  if (!ecosystems.includes("npm") && !ecosystems.includes("cargo")) {
    problems.push(`${relativePath}: expected npm or cargo Dependabot coverage`);
  }

  for (const update of updateMaps) {
    if (typeof getMapValue(update, "directory") !== "string") {
      problems.push(
        `${relativePath}: expected every Dependabot update to declare directory`,
      );
    }

    const schedule = getMapValue(update, "schedule");
    if (
      !isMap(schedule) ||
      typeof getMapValue(schedule, "interval") !== "string"
    ) {
      problems.push(
        `${relativePath}: expected every Dependabot update to declare schedule.interval`,
      );
    }
  }

  return problems;
}

function getMapValue(document: YAMLMap, key: string): unknown {
  return document.get(key);
}

export async function checkTemplateGithubYaml(
  options: CheckTemplateGithubYamlOptions = {},
): Promise<number> {
  const templatesRoot = options.templatesRoot ?? defaultTemplatesRoot;
  const supportedPresetNames =
    options.supportedPresetNames ??
    builtInPresetProjections
      .filter((projection) => projection.metadata.generation === "supported")
      .map((projection) => projection.metadata.name);
  const templateFiles = await listGithubYamlTemplates(templatesRoot);

  if (templateFiles.length === 0) {
    throw new Error(
      "No checked GitHub YAML templates found in templates/*/.github",
    );
  }

  const seenFiles = new Set(
    templateFiles.map((filePath) =>
      relativeTemplateFilePath(templatesRoot, filePath),
    ),
  );
  const requiredFiles = supportedPresetNames.flatMap((presetName) => [
    {
      displayPath: `templates/${presetName}/.github/workflows/check.yml`,
      acceptedPaths: [
        `templates/${presetName}/.github/workflows/check.yml`,
        `templates/${presetName}/.github/workflows/check.yaml`,
      ],
    },
    {
      displayPath: `templates/${presetName}/.github/dependabot.yml`,
      acceptedPaths: [
        `templates/${presetName}/.github/dependabot.yml`,
        `templates/${presetName}/.github/dependabot.yaml`,
      ],
    },
  ]);
  const missingFiles = requiredFiles
    .filter((requiredFile) =>
      requiredFile.acceptedPaths.every(
        (acceptedPath) => !seenFiles.has(acceptedPath),
      ),
    )
    .map(
      (requiredFile) =>
        `${requiredFile.displayPath}: expected checked template source file`,
    );
  const failures = (
    await Promise.all(
      templateFiles.map((filePath) =>
        checkYamlTemplate(templatesRoot, filePath),
      ),
    )
  ).flat();
  failures.unshift(...missingFiles);

  if (failures.length > 0) {
    throw new Error(
      `Checked GitHub YAML templates are invalid:\n${failures.join("\n")}`,
    );
  }

  return templateFiles.length;
}

async function main(): Promise<void> {
  const templateFileCount = await checkTemplateGithubYaml();

  console.log(
    `Checked ${templateFileCount} GitHub workflow and Dependabot template files.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
