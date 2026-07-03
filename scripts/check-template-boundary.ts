import path from "node:path";
import { fileURLToPath } from "node:url";

import { assembleGenerationContext } from "../src/generation-context.js";
import {
  loadBuiltInPresetSourceManifest,
  manifestReferencedSourceFiles,
} from "../src/preset-source.js";
import {
  checkTemplateSourceBoundary,
  templateBoundaryDebtAllowlist,
  type TemplateBoundaryCheckProjection,
  type TemplateBoundaryDebt,
  type TemplateBoundaryViolation,
} from "../src/template-boundary-check.js";
import { builtInPresetProjections } from "../templates/registry.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const projectionSourceFiles: Record<string, string> = {
  "hono-api": "templates/hono-api/projection.ts",
  "rust-bin": "templates/rust-bin/projection.ts",
  "ts-lib": "templates/ts-lib/projection.ts",
  "vue-app": "templates/vue-app/projection.ts",
  "vue-hono-app": "templates/vue-hono-app/projection.ts",
};

function projectionTargetDir(presetName: string): string {
  return path.join(repoRoot, ".template-boundary-check", `demo-${presetName}`);
}

function projectionPlanForPreset(
  presetName: string,
): TemplateBoundaryCheckProjection {
  const projection = builtInPresetProjections.find(
    (candidate) => candidate.metadata.name === presetName,
  );
  const sourceFile = projectionSourceFiles[presetName];

  if (!projection || !sourceFile) {
    throw new Error(
      `Missing Template Boundary Check projection: ${presetName}`,
    );
  }

  const targetDir = projectionTargetDir(presetName);
  const blueprint = projection.blueprint({ targetDir });
  const plan = projection.project(
    assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: {
          kind: "PackageManagerPin",
          value: "pnpm@11.2.3",
        },
        source: "bundled-fallback",
        diagnostics: [],
      },
    }),
  );

  return {
    name: presetName,
    sourceFilePath: path.join(repoRoot, sourceFile),
    plan,
  };
}

function formatDiagnostic(diagnostic: TemplateBoundaryViolation): string {
  return [
    `${diagnostic.preset}: ${diagnostic.generatedPath}`,
    `  owner: ${diagnostic.owningFunction}`,
    `  operation: ${diagnostic.operationKind}`,
    `  source: ${path.relative(repoRoot, diagnostic.sourceFilePath)}`,
    ...(diagnostic.allowlistReason
      ? [`  allowlist: ${diagnostic.allowlistReason}`]
      : []),
  ].join("\n");
}

function formatAllowlistEntry(entry: TemplateBoundaryDebt): string {
  return [
    `${entry.preset}: ${entry.generatedPath}`,
    `  owner: ${entry.owningFunction}`,
    `  allowlist: ${entry.reason}`,
  ].join("\n");
}

export async function checkBuiltInTemplateBoundaries(): Promise<void> {
  const templatesRoot = path.join(repoRoot, "templates");
  const manifest = loadBuiltInPresetSourceManifest();
  const result = await checkTemplateSourceBoundary({
    projections: builtInPresetProjections.map((projection) =>
      projectionPlanForPreset(projection.metadata.name),
    ),
    manifestReferencedSourceFiles: manifestReferencedSourceFiles(
      manifest,
      templatesRoot,
    ),
    allowlist: templateBoundaryDebtAllowlist,
  });

  if (result.allowlistedDebt.length > 0) {
    console.log(
      [
        "Template Boundary Check allowlisted debt:",
        ...result.allowlistedDebt.map(formatDiagnostic),
      ].join("\n"),
    );
  }

  if (!result.ok) {
    throw new Error(
      [
        "Template Boundary Check failed:",
        ...result.violations.map(formatDiagnostic),
        ...result.unusedAllowlistEntries.map(
          (entry) => `Unused allowlist entry:\n${formatAllowlistEntry(entry)}`,
        ),
      ].join("\n"),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInTemplateBoundaries();
}
