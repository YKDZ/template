#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtInPresetSourceRoot,
  findBuiltInPresetSourceManifestPreset,
  loadBuiltInPresetSourceManifest,
  projectBuiltInPresetSourcePreset,
} from "@ykdz/template-builtin-source";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "@ykdz/template-core/project-github";
import { blueprintForPresetSourcePreset } from "@ykdz/template-core/projection-capabilities";
import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";

const defaultTemplatesRoot = builtInPresetSourceRoot();

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

  return templateFiles.toSorted((left, right) => left.localeCompare(right));
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
  const relativePath = relativeTemplateFilePath(templatesRoot, filePath);
  const templateKind = githubYamlTemplateKind(relativePath);
  const renderedContents = templateKind
    ? renderCheckedTemplateForProjection(
        presetNameFromRelativePath(relativePath) ?? "",
        contents.replace(/\r\n/g, "\n"),
        templateKind,
      )
    : contents;
  const document = parseDocument(renderedContents);
  const problems = [...document.errors, ...document.warnings].map(
    (error) => `${relativePath}: ${error.message}`,
  );

  if (!isMap(document.contents)) {
    problems.push(`${relativePath}: expected a top-level YAML map`);
    return problems;
  }

  if (templateKind === "workflow") {
    problems.push(...checkWorkflowTemplate(relativePath, document.contents));
    problems.push(
      ...checkProjectedTemplate(relativePath, contents, "workflow"),
    );
  } else if (templateKind === "dependabot") {
    problems.push(...checkDependabotTemplate(relativePath, document.contents));
    problems.push(
      ...checkProjectedTemplate(relativePath, contents, "dependabot"),
    );
  }

  return problems;
}

function githubYamlTemplateKind(
  relativePath: string,
): "workflow" | "dependabot" | undefined {
  if (
    /^templates\/[^/]+\/\.github\/workflows\/[^/]+\.ya?ml$/.test(relativePath)
  ) {
    return "workflow";
  }

  if (/^templates\/[^/]+\/\.github\/dependabot\.ya?ml$/.test(relativePath)) {
    return "dependabot";
  }

  return undefined;
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

  const renderedContents = renderCheckedTemplateForProjection(
    presetName,
    contents.replace(/\r\n/g, "\n"),
    kind,
  );
  const expected =
    kind === "workflow"
      ? projectGithubCheckWorkflow(presetName)
      : projectDependabotTemplate(presetName);

  if (renderedContents === expected) {
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

function renderCheckedTemplateForProjection(
  presetName: string,
  contents: string,
  kind: "workflow" | "dependabot",
): string {
  const projectionPlan = projectThroughPresetProjection(presetName);
  const generatedPath =
    kind === "workflow"
      ? ".github/workflows/check.yml"
      : ".github/dependabot.yml";
  const operation = projectionPlan?.operations.find(
    (candidate) =>
      (candidate.kind === "copyFile" ||
        candidate.kind === "writeTextTemplate") &&
      candidate.to === generatedPath,
  );

  if (!operation || operation.kind !== "writeTextTemplate") {
    return contents;
  }

  return renderCheckedTextTemplate(contents, operation.replacements);
}

function renderCheckedTextTemplate(
  contents: string,
  replacements: Record<string, string>,
): string {
  const used = new Set<string>();
  const rendered = contents.replaceAll(
    /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (_placeholder, name: string) => {
      const replacement = replacements[name];

      if (replacement === undefined) {
        throw new Error(`Missing text template variable: ${name}`);
      }

      used.add(name);
      return replacement;
    },
  );

  for (const name of Object.keys(replacements)) {
    if (!used.has(name)) {
      throw new Error(`Unused text template variable: ${name}`);
    }
  }

  return rendered;
}

function presetNameFromRelativePath(relativePath: string): string | undefined {
  return relativePath.match(/^templates\/([^/]+)\//)?.[1];
}

function findSupportedPresetProjection(presetName: string) {
  const preset = findBuiltInPresetSourceManifestPreset(presetName);

  return preset?.generation === "supported" && preset.projection
    ? preset
    : undefined;
}

function projectGithubCheckWorkflow(presetName: string): string {
  const projectionPlan = projectThroughPresetProjection(presetName);

  return projectionPlan
    ? projectCheckWorkflow({
        checkPlan: projectionPlan.checkPlan,
        environmentPreparation:
          presetName === "rust-bin" ? { rustToolchain: true } : undefined,
      })
    : missingProjectedGithubTemplate(presetName, "workflow");
}

function projectDependabotTemplate(presetName: string): string {
  const projectionPlan = projectThroughPresetProjection(presetName);

  return projectionPlan
    ? projectDependabotConfig(projectionPlan.dependencyMaintenancePolicy)
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
  const preset = findSupportedPresetProjection(presetName);

  if (!preset) {
    return undefined;
  }

  const targetDir = "generated-repository";
  const blueprint = blueprintForPresetSourcePreset(preset, { targetDir });

  return projectBuiltInPresetSourcePreset({
    preset,
    context: assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.34.4" },
        source: "bundled-fallback",
        diagnostics: [],
      },
    }),
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

  const updateMaps = updates.items.filter(isMap);
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
    loadBuiltInPresetSourceManifest()
      .presets.filter((preset) => preset.generation === "supported")
      .map((preset) => preset.name);
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
