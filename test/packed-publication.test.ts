import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { builtInPresetRegistry } from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const publicCliPackageName = ["@ykdz", "template"].join("/");

async function generatedTextFiles(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly source: string }[]> {
  const files: { path: string; source: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!new Set([".git", "node_modules", ".turbo"]).has(entry.name)) {
        files.push(...(await generatedTextFiles(root, child)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      files.push({
        path: child,
        source: await readFile(path.join(root, child), "utf8"),
      });
    } catch {
      // Binary generated assets are outside the task-model text contract.
    }
  }
  return files;
}

async function expectNativeTaskModel(projectDir: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(projectDir, "package.json"), "utf8"),
  ) as { readonly scripts: Record<string, string> };
  const taskModel = JSON.stringify({
    scripts: manifest.scripts,
    turbo: JSON.parse(
      await readFile(path.join(projectDir, "turbo.json"), "utf8"),
    ),
  });

  expect(Object.keys(manifest.scripts)).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/:(?:run|root)$/u),
      "transit",
    ]),
  );
  for (const command of [
    manifest.scripts.check,
    manifest.scripts.fix,
    manifest.scripts["check:deployment"],
  ]) {
    if (command !== undefined) expect(command).not.toContain("--filter");
  }
  expect(taskModel).not.toMatch(/(?:Check|Fix) (?:Component|Plan)/u);
  expect(taskModel).not.toMatch(/Deployment Check Component/u);
  expect(taskModel).not.toMatch(/deployment[\s-]*(?:task[\s-]*)?owner/iu);

  const fullTree = await generatedTextFiles(projectDir);
  for (const file of fullTree) {
    expect(file.source).not.toMatch(/\b[\p{L}\p{N}_-]+:(?:run|root)\b/iu);
    expect(file.source).not.toMatch(/\btransit\b/iu);
    expect(file.source).not.toMatch(
      /(?:Check|Fix) (?:Component|Plan)|Deployment Check Component/iu,
    );
  }

  const retiredBuild = await execa("pnpm", ["run", "build:run"], {
    cwd: projectDir,
    reject: false,
  });
  expect(retiredBuild.exitCode).not.toBe(0);
}

describe("packed public CLI consumer", () => {
  it("runs the archive alone: import, help, every initialization, and package addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-packed-consumer-"),
    );
    try {
      const archiveDirectory = path.join(workspace, "archives");
      await execa(
        "pnpm",
        [
          "--config.node-linker=hoisted",
          "--filter",
          publicCliPackageName,
          "pack",
          "--pack-destination",
          archiveDirectory,
        ],
        { cwd: process.cwd() },
      );
      const archive = (await readdir(archiveDirectory)).find((file) =>
        file.endsWith(".tgz"),
      );
      expect(archive).toBeDefined();
      const consumer = path.join(workspace, "consumer");
      const archivePath = path.join(archiveDirectory, archive!);
      await mkdir(consumer, { recursive: true });
      await execa("npm", ["init", "--yes"], { cwd: consumer });
      await execa("pnpm", ["add", archivePath], { cwd: consumer });

      const cli = path.join(
        consumer,
        "node_modules",
        "@ykdz",
        "template",
        "dist/cli.js",
      );
      const bundledDefinitions = path.join(
        consumer,
        "node_modules",
        "@ykdz",
        "template",
        "node_modules",
        "@ykdz",
        "template-builtin-presets",
        "dist/src/index.js",
      );
      await expect(
        execa(
          "node",
          [
            "--input-type=module",
            "-e",
            "await import(process.argv[1])",
            bundledDefinitions,
          ],
          {
            cwd: consumer,
          },
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      const help = await execa("node", [cli, "--help"], { cwd: consumer });
      expect(help.stdout).toContain("template init <dir>");
      const presets = await execa("node", [cli, "presets"], {
        cwd: consumer,
      });
      const definitions = presets.stdout.split("\n").flatMap((line) => {
        const match = /^\s{2}([^:\s]+):/u.exec(line);
        return match === null ? [] : [{ name: match[1]! }];
      });
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions) {
        await execa(
          "node",
          [
            cli,
            "init",
            path.join(consumer, "generated", definition.name),
            "--preset",
            definition.name,
            "--yes",
          ],
          {
            cwd: consumer,
            env: {
              ...process.env,
              TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
            },
          },
        );
        await expectNativeTaskModel(
          path.join(consumer, "generated", definition.name),
        );
      }
      const expectedAddableDefinitions = builtInPresetRegistry
        .all()
        .filter((definition) => definition.planPackageAddition !== undefined)
        .map((definition) => definition.metadata.name)
        .toSorted();
      const completedAdditions: string[] = [];
      for (const candidate of definitions) {
        const result = await execa(
          "node",
          [
            cli,
            "add",
            "package",
            "--preset",
            candidate.name,
            "--name",
            "archive-addition",
            "--path",
            "packages/archive-addition",
          ],
          {
            cwd: path.join(consumer, "generated", candidate.name),
            env: {
              ...process.env,
              TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
            },
            reject: false,
          },
        );
        if (result.exitCode === 0) {
          completedAdditions.push(candidate.name);
          await expectNativeTaskModel(
            path.join(consumer, "generated", candidate.name),
          );
        }
      }
      expect(completedAdditions.toSorted()).toEqual(expectedAddableDefinitions);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
