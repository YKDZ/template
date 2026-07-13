#!/usr/bin/env node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderNewProject } from "@ykdz/template-core/renderer";
import type { TemplateSourceHandle } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import {
  builtInPresetTemplateSourceCheckContexts,
  resolveBuiltInTemplateSource,
  type BuiltInPresetTemplateSourceCheckContext,
} from "./foundation.ts";

const formattedTemplateSourceFile = /\.(?:[cm]?[jt]sx?|vue|json|html|css)$/u;
const lintedTemplateSourceFile = /\.(?:[cm]?[jt]sx?|vue)$/u;

function planTemplateSourceFiles(
  context: BuiltInPresetTemplateSourceCheckContext,
): readonly string[] {
  return context.plan.operations.flatMap((operation) => {
    if (
      operation.kind !== "copyFile" &&
      operation.kind !== "writeTextTemplate" &&
      operation.kind !== "writeTextFromFragments"
    ) {
      return [];
    }
    const sourceFile = (source: TemplateSourceHandle, from: string): string =>
      resolveBuiltInTemplateSource(source, from);
    if (operation.kind === "writeTextFromFragments") {
      return operation.fragments.map((fragment) =>
        sourceFile(fragment.source!, fragment.from),
      );
    }
    return [sourceFile(operation.source!, operation.from)];
  });
}

async function checkContributionTemplateSource(
  context: BuiltInPresetTemplateSourceCheckContext,
): Promise<void> {
  const sourceFiles = [...new Set(planTemplateSourceFiles(context))];
  for (const sourceFile of sourceFiles) {
    if (!(await stat(sourceFile)).isFile()) {
      throw new Error(
        `${context.definition.metadata.name}: referenced Template Source is not a file: ${sourceFile}`,
      );
    }
  }
  const formattedFiles = sourceFiles.filter((sourceFile) =>
    formattedTemplateSourceFile.test(sourceFile),
  );
  const lintedFiles = sourceFiles.filter(
    (sourceFile) =>
      lintedTemplateSourceFile.test(sourceFile) &&
      !sourceFile.endsWith("/foundation/scripts/check-boundaries.ts") &&
      !sourceFile.endsWith("/foundation/scripts/run-root-owned-task.ts"),
  );
  const rustSourceFiles = sourceFiles.filter((sourceFile) =>
    sourceFile.endsWith(".rs"),
  );
  const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
  const oxcConfigRoot = path.resolve(packageDirectory, "..", "..", "..");

  if (formattedFiles.length > 0) {
    await execa(
      "pnpm",
      [
        "exec",
        "oxfmt",
        "--list-different",
        "--config",
        path.join(oxcConfigRoot, "oxfmt.config.ts"),
        ...formattedFiles,
      ],
      { cwd: packageDirectory },
    );
  }
  if (lintedFiles.length > 0) {
    await execa(
      "pnpm",
      [
        "exec",
        "oxlint",
        "--quiet",
        "--format=unix",
        "--config",
        path.join(oxcConfigRoot, "oxlint.config.ts"),
        ...lintedFiles,
      ],
      { cwd: packageDirectory },
    );
  }
  if (rustSourceFiles.length > 0) {
    await execa("rustfmt", ["--check", ...rustSourceFiles]);
  }

  const checkRoot = await mkdtemp(
    path.join(
      tmpdir(),
      `.template-${context.contribution.definition.path.replaceAll("/", "-")}-`,
    ),
  );
  try {
    await renderNewProject({
      targetRoot: checkRoot,
      operations: [...context.plan.operations],
    });
    await execa("pnpm", ["install", "--ignore-scripts"], { cwd: checkRoot });
    await execa("pnpm", ["run", "typecheck"], { cwd: checkRoot });
    await execa("pnpm", ["run", "lint"], { cwd: checkRoot });
    for (const definition of context.plan.blueprint.packages) {
      const manifest = JSON.parse(
        await readFile(
          path.join(checkRoot, definition.path, "package.json"),
          "utf8",
        ),
      ) as { scripts?: Record<string, unknown> };
      if (typeof manifest.scripts?.typecheck !== "string") continue;
      await execa(
        "pnpm",
        ["--filter", `./${definition.path}`, "run", "typecheck"],
        { cwd: checkRoot },
      );
    }
  } finally {
    await rm(checkRoot, { recursive: true, force: true });
  }
}

/** Checks every initial Package Contribution's directly owned Template Source. */
export async function checkBuiltInPresetTemplateSource(): Promise<void> {
  const contexts = builtInPresetTemplateSourceCheckContexts();
  const checkedDefinitions = new Set<string>();
  for (const context of contexts) {
    if (checkedDefinitions.has(context.definition.metadata.name)) continue;
    checkedDefinitions.add(context.definition.metadata.name);
    await checkContributionTemplateSource(context);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInPresetTemplateSource();
}
