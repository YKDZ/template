#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import { builtInPresets, type BuiltInPreset } from "../src/declarations.js";

type SupportedFixturePreset = Extract<
  BuiltInPreset["name"],
  "ts-lib" | "hono-api" | "vue-app" | "vue-hono-app" | "rust-bin"
>;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "src/cli.ts");
const deterministicToolchainEnv = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};

function supportedFixturePresets(): SupportedFixturePreset[] {
  return builtInPresets
    .filter((preset) => preset.generation === "supported")
    .map((preset) => preset.name as SupportedFixturePreset);
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

async function checkNodePreset(
  presetName: Exclude<SupportedFixturePreset, "rust-bin">,
  projectDir: string,
): Promise<void> {
  // Fixture Checks follow generated CI setup so browser dependencies stay covered
  // without making local checks run full ready-mode browser installs differently.
  await run("corepack", ["enable"], projectDir);
  await run("pnpm", ["install"], projectDir);

  if (presetName === "vue-app") {
    await run(
      "pnpm",
      ["exec", "playwright", "install", "--with-deps", "chromium"],
      projectDir,
    );
  }

  if (presetName === "vue-hono-app") {
    await run(
      "pnpm",
      [
        "--filter",
        "./apps/web",
        "exec",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
      ],
      projectDir,
    );
  }

  await run("pnpm", ["run", "check"], projectDir, { CI: "1" });
}

async function checkRustPreset(projectDir: string): Promise<void> {
  await run("./scripts/check", [], projectDir);
}

async function checkPreset(
  presetName: SupportedFixturePreset,
  workspace: string,
): Promise<void> {
  console.log(`\n== ${presetName} ==`);
  const projectDir = await generatePreset(presetName, workspace);

  if (presetName === "rust-bin") {
    await checkRustPreset(projectDir);
    return;
  }

  await checkNodePreset(presetName, projectDir);
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
