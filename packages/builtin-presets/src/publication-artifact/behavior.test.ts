import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { create } from "tar";
import { afterEach, describe, expect, it } from "vitest";

import type { NpmPublicationReadiness } from "../../templates/ts-cli/publication/readiness.ts";

type ArtifactModule =
  typeof import("../../templates/ts-cli/publication/artifact.ts");

const templateRoot = path.resolve(
  import.meta.dirname,
  "../../templates/ts-cli",
);

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

async function loadArtifactModule(workspace: string): Promise<ArtifactModule> {
  const moduleRoot = path.join(workspace, "module");
  await mkdir(moduleRoot);
  await Promise.all([
    cp(
      path.join(templateRoot, "publication/artifact.ts"),
      path.join(moduleRoot, "artifact.ts"),
    ),
    cp(
      path.join(templateRoot, "publication/readiness.ts"),
      path.join(moduleRoot, "readiness.ts"),
    ),
    cp(
      path.join(templateRoot, "publication/changelog.ts"),
      path.join(moduleRoot, "changelog.ts"),
    ),
    cp(
      path.join(templateRoot, "src/cli-command-identity.ts"),
      path.join(moduleRoot, "cli-command-identity.ts"),
    ),
  ]);
  await writeFile(
    path.join(workspace, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(workspace, "node_modules"),
    "dir",
  );
  return (await import(
    `${pathToFileURL(path.join(moduleRoot, "artifact.ts")).href}?test=${crypto.randomUUID()}`
  )) as ArtifactModule;
}

describe("verified publication artifact contracts", () => {
  it("rejects traversal, symbolic-link, and duplicate tar entries", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-archive-contract-"),
    );
    workspaces.push(workspace);
    const { inspectPublicationArchive } = await loadArtifactModule(workspace);
    const sourceRoot = path.join(workspace, "source");
    await mkdir(sourceRoot);
    await writeFile(path.join(sourceRoot, "entry"), "content\n");
    await symlink("entry", path.join(sourceRoot, "link"));

    const cases = [
      {
        name: "traversal",
        paths: ["entry"],
        options: { prefix: "../" },
      },
      { name: "symbolic-link", paths: ["link"], options: {} },
      { name: "duplicate", paths: ["entry", "entry"], options: {} },
    ] as const;
    for (const item of cases) {
      const archivePath = path.join(workspace, `${item.name}.tgz`);
      await create(
        {
          cwd: sourceRoot,
          file: archivePath,
          gzip: true,
          ...item.options,
        },
        [...item.paths],
      );
      await expect(
        inspectPublicationArchive(archivePath),
      ).resolves.toMatchObject({ code: "artifact-archive-unsafe" });
    }
  });

  it("rejects scripts and unreviewed top-level packed manifest fields", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-manifest-contract-"),
    );
    workspaces.push(workspace);
    const { inspectPackedManifestContract } =
      await loadArtifactModule(workspace);
    const repository = {
      type: "git",
      url: "git+https://github.com/publisher/tool.git",
      directory: "packages/cli",
    };
    const sourceManifest = {
      description: "A focused command-line release tool.",
      license: "MIT",
      repository,
      homepage: "https://github.com/publisher/tool#readme",
      bugs: { url: "https://github.com/publisher/tool/issues" },
      engines: { node: ">=24" },
    };
    const packedManifest = {
      name: "@publisher/tool",
      version: "1.0.0",
      ...sourceManifest,
      type: "module",
      files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
      bin: { ship: "./dist/cli.js" },
      dependencies: { commander: "^15.0.0" },
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
      scripts: {},
    };
    const readiness: Extract<
      NpmPublicationReadiness,
      { readonly kind: "ready" }
    > = {
      kind: "ready",
      target: { packagePath: "packages/cli" },
      blockers: [],
      publication: {
        packagePath: "packages/cli",
        packageName: "@publisher/tool",
        commandName: "ship",
        version: "1.0.0",
        repository: repository.url,
        releaseDate: "2026-08-26",
        releaseNotes: "Publish the first stable CLI.",
      },
    };

    expect(
      inspectPackedManifestContract({
        manifest: packedManifest,
        sourceManifest,
        readiness,
      }),
    ).toMatchObject({ code: "artifact-manifest-contract" });
    const { scripts: _scripts, ...withoutScripts } = packedManifest;
    expect(
      inspectPackedManifestContract({
        manifest: { ...withoutScripts, author: "Ada Lovelace" },
        sourceManifest,
        readiness,
      }),
    ).toMatchObject({ code: "artifact-manifest-contract" });
  });

  it("uses explicit platform command plans for cmd bins and pnpm pack", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-consumer-command-"),
    );
    workspaces.push(workspace);
    const { planInstalledBinCommand, planPnpmPackCommand } =
      await loadArtifactModule(workspace);
    const environment = { ComSpec: String.raw`C:\Windows\System32\cmd.exe` };
    const binPath = String.raw`C:\consumer\node_modules\.bin\ship.cmd`;

    expect(
      planInstalledBinCommand({
        platform: "win32",
        binPath,
        args: ["--help"],
        environment,
      }),
    ).toEqual({
      executable: environment.ComSpec,
      args: [
        "/d",
        "/s",
        "/c",
        '""%TEMPLATE_VERIFIED_PUBLICATION_BIN%" "--help""',
      ],
      environment: {
        ...environment,
        TEMPLATE_VERIFIED_PUBLICATION_BIN: binPath,
      },
    });
    expect(
      planInstalledBinCommand({
        platform: "linux",
        binPath: "/consumer/node_modules/.bin/ship",
        args: ["--help"],
        environment: {},
      }),
    ).toEqual({
      executable: "/consumer/node_modules/.bin/ship",
      args: ["--help"],
      environment: {},
    });

    expect(
      planPnpmPackCommand({
        platform: "win32",
        packDirectory: String.raw`C:\temp\publication output`,
        environment,
      }),
    ).toEqual({
      executable: environment.ComSpec,
      args: [
        "/d",
        "/s",
        "/c",
        '""pnpm.cmd" "pack" "--pack-destination" "C:\\temp\\publication output""',
      ],
      environment,
    });
    expect(
      planPnpmPackCommand({
        platform: "linux",
        packDirectory: "/tmp/publication-output",
        environment: { PATH: "/usr/bin" },
      }),
    ).toEqual({
      executable: "pnpm",
      args: ["pack", "--pack-destination", "/tmp/publication-output"],
      environment: { PATH: "/usr/bin" },
    });
  });
});
