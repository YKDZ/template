import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { builtInPresetRegistry } from "#template-builtin-presets";

import type { CliJourney } from "../journey.ts";

const fallbackEnvironment = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};

function requireAddablePresetName(): string {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.planPackageAddition !== undefined);
  if (definition === undefined) {
    throw new Error("add package journey requires an addable Preset");
  }
  return definition.metadata.name;
}

const addablePresetName = requireAddablePresetName();

async function snapshot(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await snapshot(root, child)));
    } else if (entry.isFile()) {
      files.push({
        path: child.split(path.sep).join("/"),
        content: (await readFile(path.join(root, child))).toString("base64"),
      });
    }
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

const journey: CliJourney = {
  name: "add-package",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    return [
      {
        name: "initialize base",
        args: [
          "init",
          "project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
          "--yes",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "dry-run addition",
        cwd: project,
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          "packages/project",
          "--dry-run",
          "--json",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "apply addition",
        cwd: project,
        async prepare() {
          await assert.rejects(stat(path.join(project, "packages/utility")), {
            code: "ENOENT",
          });
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          "packages/project",
          "--json",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "repeat addition",
        cwd: project,
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          "packages/project",
          "--json",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "missing required options",
        cwd: project,
        args: ["add", "package"],
        env: fallbackEnvironment,
      },
      {
        name: "canonical metadata conflict",
        cwd: project,
        async prepare() {
          const generationPath = path.join(
            project,
            ".template/generation.json",
          );
          const generation = JSON.parse(
            await readFile(generationPath, "utf8"),
          ) as unknown;
          await writeFile(generationPath, JSON.stringify(generation));
          await writeFile(
            path.join(context.workDir, "conflict-before.json"),
            JSON.stringify(await snapshot(project)),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "second",
          "--path",
          "packages/second",
          "--json",
        ],
        env: fallbackEnvironment,
      },
    ];
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0);

    const preview = JSON.parse(results[1]?.stdout ?? "");
    assert.equal(results[1]?.exitCode, 0);
    assert.equal(preview.status, "success");
    assert.equal(preview.dryRun, true);
    assert.ok(
      preview.actions.some(
        (action: { path: string }) =>
          action.path === "packages/utility/package.json",
      ),
    );

    assert.equal(results[2]?.exitCode, 0);
    assert.equal(JSON.parse(results[2]?.stdout ?? "").status, "success");
    assert.match(
      await readFile(
        path.join(context.workDir, "project/packages/utility/package.json"),
        "utf8",
      ),
      /"name": "@acme\/utility"/u,
    );

    assert.deepEqual(JSON.parse(results[3]?.stdout ?? "").actions, []);
    assert.equal(results[4]?.exitCode, 1);
    assert.match(
      results[4]?.stderr ?? "",
      /required option '--preset <name>' not specified/u,
    );

    const conflict = JSON.parse(results[5]?.stdout ?? "");
    assert.equal(results[5]?.exitCode, 1);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.actions, []);
    assert.ok(
      conflict.conflicts.some(
        (entry: { path: string; driver: string }) =>
          entry.path === ".template/generation.json" &&
          entry.driver === "canonical",
      ),
    );
    assert.deepEqual(
      await snapshot(path.join(context.workDir, "project")),
      JSON.parse(
        await readFile(
          path.join(context.workDir, "conflict-before.json"),
          "utf8",
        ),
      ),
    );
  },
};

export default journey;
