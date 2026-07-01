#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import { assembleGenerationContext } from "../src/generation-context.js";
import { planNextStepInstructions } from "../src/next-step-instructions.js";
import {
  builtInPresetProjections,
  findBuiltInPresetProjection,
} from "../templates/registry.js";

type SupportedFixturePreset =
  (typeof builtInPresetProjections)[number]["metadata"]["name"];

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "src/cli.ts");
const deterministicToolchainEnv = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};

function supportedFixturePresets(): SupportedFixturePreset[] {
  return builtInPresetProjections
    .filter((projection) => projection.metadata.generation === "supported")
    .map((projection) => projection.metadata.name);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  console.log(`$ ${[command, ...args].join(" ")}`);
  await execa(command, args, { cwd, env, stdio: "inherit" });
}

async function generatePreset(
  presetName: SupportedFixturePreset,
  workspace: string,
): Promise<string> {
  const projectDir = path.join(workspace, `fixture-${presetName}`);

  await run(
    "pnpm",
    [
      "exec",
      "tsx",
      cliPath,
      "init",
      projectDir,
      "--preset",
      presetName,
      "--yes",
    ],
    repoRoot,
    deterministicToolchainEnv,
  );

  return projectDir;
}

async function runMachineVerifiableNextSteps(
  presetName: SupportedFixturePreset,
  projectDir: string,
): Promise<void> {
  const projection = findBuiltInPresetProjection(presetName);

  if (!projection) {
    throw new Error(
      `Missing Preset Projection for fixture preset ${presetName}`,
    );
  }

  const blueprint = projection.blueprint({ targetDir: projectDir });
  const projectionPlan = projection.project(
    assembleGenerationContext({
      targetDir: projectDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.0.0" },
        source: "bundled-fallback",
        diagnostics: [],
      },
    }),
  );
  const plan = planNextStepInstructions({
    targetDir: projectDir,
    projectionPlan,
  });

  for (const step of plan.steps) {
    if (!step.machineVerifiable || step.kind !== "command") {
      continue;
    }

    const env = step.id === "run-root-check" ? { CI: "1" } : undefined;
    await run(step.command, [...step.args], step.cwd, env);
  }
}

async function checkPreset(
  presetName: SupportedFixturePreset,
  workspace: string,
): Promise<void> {
  console.log(`\n== ${presetName} ==`);
  const projectDir = await generatePreset(presetName, workspace);
  await runMachineVerifiableNextSteps(presetName, projectDir);
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-fixtures-"));
  let shouldRemoveWorkspace = false;

  try {
    for (const presetName of supportedFixturePresets()) {
      await checkPreset(presetName, workspace);
    }

    shouldRemoveWorkspace = true;
  } finally {
    if (shouldRemoveWorkspace) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      console.error(`Fixture workspace preserved for debugging: ${workspace}`);
    }
  }
}

await main();
