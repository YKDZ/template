#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, parseDocument } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesRoot = path.join(repoRoot, "templates");

async function listGithubYamlTemplates(): Promise<string[]> {
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

    if (entry.isFile() && entry.name.endsWith(".yml")) {
      files.push(entryPath);
    }
  }

  return files;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function relativeFilePath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function checkYamlTemplate(filePath: string): Promise<string[]> {
  const contents = await readFile(filePath, "utf8");
  const document = parseDocument(contents);
  const problems = [...document.errors, ...document.warnings].map(
    (error) => `${relativeFilePath(filePath)}: ${error.message}`
  );

  if (!isMap(document.contents)) {
    problems.push(`${relativeFilePath(filePath)}: expected a top-level YAML map`);
  }

  return problems;
}

async function main(): Promise<void> {
  const templateFiles = await listGithubYamlTemplates();

  if (templateFiles.length === 0) {
    throw new Error("No checked GitHub YAML templates found in templates/*/.github");
  }

  const failures = (
    await Promise.all(templateFiles.map((filePath) => checkYamlTemplate(filePath)))
  ).flat();

  if (failures.length > 0) {
    throw new Error(
      `Checked GitHub YAML templates are invalid:\n${failures.join("\n")}`
    );
  }

  console.log(`Checked ${templateFiles.length} GitHub YAML template files.`);
}

await main();
