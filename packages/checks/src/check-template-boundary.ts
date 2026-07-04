import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findPresetSourceManifestPreset,
  manifestReferencedSourceFiles,
  type PresetSourceManifest,
} from "@ykdz/template-builtin-source";
import {
  builtInPresetProjectionSourceRoots,
  builtInPresetSourceRoot,
  loadBuiltInPresetSourceManifest,
  projectBuiltInPresetSourcePreset,
} from "@ykdz/template-builtin-source";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import { PackageAdditionSupport } from "@ykdz/template-core/package-addition-support";
import {
  blueprintForPresetSourcePreset,
  defaultPackagePathForPresetSourcePackageAddition,
  planPresetSourcePackageAddition,
} from "@ykdz/template-core/projection-capabilities";
import {
  checkTemplateSourceBoundary,
  templateBoundaryDebtAllowlist,
  type TemplateBoundaryCheckProjection,
  type TemplateBoundaryDebt,
  type TemplateBoundaryViolation,
} from "@ykdz/template-core/template-boundary-check";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const projectionSourceFiles: Record<string, string> = {
  "hono-api": "packages/core/src/projection-capabilities.ts",
  "rust-bin": "packages/core/src/projection-capabilities.ts",
  "ts-lib": "packages/core/src/projection-capabilities.ts",
  "vue-app": "packages/core/src/projection-capabilities.ts",
  "vue-hono-app": "packages/core/src/projection-capabilities.ts",
};

function projectionTargetDir(presetName: string): string {
  return path.join(repoRoot, ".template-boundary-check", `demo-${presetName}`);
}

function projectionPlanForPreset(
  manifest: PresetSourceManifest,
  presetName: string,
): TemplateBoundaryCheckProjection {
  const preset = findPresetSourceManifestPreset(manifest, presetName);
  const sourceFile = projectionSourceFiles[presetName];

  if (!preset?.projection || !sourceFile) {
    throw new Error(
      `Missing Template Boundary Check projection: ${presetName}`,
    );
  }

  const targetDir = projectionTargetDir(presetName);
  const blueprint = blueprintForPresetSourcePreset(preset, { targetDir });
  const plan = projectBuiltInPresetSourcePreset({
    preset,
    context: assembleGenerationContext({
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
  });

  return {
    name: presetName,
    sourceFilePath: path.join(repoRoot, sourceFile),
    plan,
  };
}

async function packageAdditionPlanForPreset(
  manifest: PresetSourceManifest,
  presetName: string,
): Promise<TemplateBoundaryCheckProjection> {
  const preset = findPresetSourceManifestPreset(manifest, presetName);
  const sourceFile = projectionSourceFiles[presetName];

  if (!preset?.projection || !sourceFile) {
    throw new Error(
      `Missing Template Boundary Check Package Addition projection: ${presetName}`,
    );
  }

  const root = path.join(
    repoRoot,
    ".template-boundary-check",
    "package-addition-root",
  );
  const packageLeafName = "template-boundary-check";
  const packagePath = defaultPackagePathForPresetSourcePackageAddition(
    preset,
    packageLeafName,
    builtInPresetProjectionSourceRoots(),
  );
  const plan = await planPresetSourcePackageAddition({
    preset,
    sourceRoots: builtInPresetProjectionSourceRoots(),
    addition: {
      root,
      blueprint: {
        schemaVersion: 1,
        preset: "vue-hono-app",
        packageManager: "pnpm",
        projectKind: "multi-package",
        features: [],
        packages: [{ name: "@demo/web", path: "apps/web" }],
      },
      packageLeafName,
      packageName: `@demo/${packageLeafName}`,
      packagePath,
      nodeVersion: "24",
    },
  });

  return {
    name: `${presetName} package addition`,
    sourceFilePath: path.join(repoRoot, sourceFile),
    plan,
  };
}

export async function builtInTemplateBoundaryProjections(
  manifest: PresetSourceManifest,
): Promise<TemplateBoundaryCheckProjection[]> {
  const initProjections = manifest.presets
    .filter((preset) => preset.generation === "supported")
    .map((preset) => projectionPlanForPreset(manifest, preset.name));
  const packageAdditionProjections = await Promise.all(
    manifest.presets
      .filter(
        (preset) =>
          preset.generation === "supported" &&
          preset.packageAdditionSupport === PackageAdditionSupport.Supported,
      )
      .map((preset) => packageAdditionPlanForPreset(manifest, preset.name)),
  );

  return [...initProjections, ...packageAdditionProjections];
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
  const templatesRoot = builtInPresetSourceRoot();
  const manifest = loadBuiltInPresetSourceManifest();
  const result = await checkTemplateSourceBoundary({
    projections: await builtInTemplateBoundaryProjections(manifest),
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
