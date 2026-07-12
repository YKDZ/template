import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { builtInPresetRegistry } from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const publicCliPackageName = ["@ykdz", "template"].join("/");

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
        }
      }
      expect(completedAdditions.toSorted()).toEqual(expectedAddableDefinitions);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
