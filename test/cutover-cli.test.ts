import {
  mkdtemp,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { builtInPresetRegistry } from "#template-builtin-presets";
import type { PackageRole } from "#template-core/project-blueprint-v2";

function requireAddableDefinitionForRole(targetDir: string, role: PackageRole) {
  const context = {
    targetDir,
    projectName: path.basename(targetDir),
    scope: "acme",
    toolchain: {
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.11.0",
    },
  } as const;
  const packageLeafName = "role-probe";
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const packagePath = candidate.defaultPackagePath?.({
      context,
      packageLeafName,
    });
    return (
      packagePath !== undefined &&
      candidate.planPackageAddition?.({
        context,
        packageLeafName,
        packagePath,
      }).definition.role === role
    );
  });
  if (definition === undefined) {
    throw new Error(`Expected an addable Definition for Package Role ${role}`);
  }
  return definition;
}

describe("cut-over CLI", () => {
  const preset = builtInPresetRegistry.all()[0]!;
  const addablePreset = builtInPresetRegistry
    .all()
    .find((definition) => definition.planPackageAddition !== undefined)!;

  it("prints add-specific help without requiring Local Template Metadata", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-help-source-"),
    );
    const cli = path.resolve("packages/cli/src/cli.ts");

    const help = await execa(
      "node",
      ["--conditions=source", cli, "add", "package", "--help"],
      { cwd: workspace, reject: false },
    );

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("template add package");
    expect(help.stdout).toContain("--link-from <path>");
    expect(help.stdout).not.toContain("template init <dir>");
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it("adds a package without replacing the caller's working-directory inode", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-cwd-"));
    const target = path.join(workspace, "@acme", "project");
    const cli = path.resolve("packages/cli/src/cli.ts");

    await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "init",
        target,
        "--preset",
        addablePreset.metadata.name,
        "--scope",
        "acme",
        "--yes",
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );

    const result = await execa(
      "bash",
      [
        "-lc",
        `cd ${JSON.stringify(target)} && node --conditions=source ${JSON.stringify(cli)} add package --preset ${addablePreset.metadata.name} --name second --path packages/second && pwd && test -f packages/second/package.json`,
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );

    expect(result.stdout).toContain(target);
    await expect(
      readFile(path.join(target, "packages/second/package.json"), "utf8"),
    ).resolves.toContain('"name": "@acme/second"');
  });

  it("previews only Addition Delta actions as JSON without writing the workspace", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-preview-"),
    );
    const target = path.join(workspace, "project");
    const cli = path.resolve("packages/cli/src/cli.ts");
    const env = { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" };

    await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "init",
        target,
        "--preset",
        addablePreset.metadata.name,
        "--scope",
        "acme",
        "--yes",
      ],
      { env },
    );
    const before = await workspaceSnapshot(target);
    const preview = await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "add",
        "package",
        "--preset",
        addablePreset.metadata.name,
        "--name",
        "previewed",
        "--path",
        "services/previewed",
        "--dry-run",
        "--json",
      ],
      { cwd: target, env },
    );

    expect(JSON.parse(preview.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "add package",
      status: "success",
      dryRun: true,
      actions: expect.arrayContaining([
        {
          path: "services/previewed/package.json",
          driver: "structured",
          action: "create",
        },
      ]),
    });
    expect(await workspaceSnapshot(target)).toEqual(before);

    const command = [
      "--conditions=source",
      cli,
      "add",
      "package",
      "--preset",
      addablePreset.metadata.name,
      "--name",
      "previewed",
      "--path",
      "services/previewed",
      "--json",
    ];
    await execa("node", command, { cwd: target, env });
    const afterAddition = await workspaceSnapshot(target);
    const repeated = await execa("node", command, { cwd: target, env });
    expect(JSON.parse(repeated.stdout)).toEqual({
      schemaVersion: 1,
      command: "add package",
      status: "success",
      dryRun: false,
      actions: [],
    });
    expect(await workspaceSnapshot(target)).toEqual(afterAddition);
  });

  it("reports a structured conflict as JSON with actionable context and zero mutation", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-json-conflict-"),
    );
    const target = path.join(workspace, "project");
    const cli = path.resolve("packages/cli/src/cli.ts");
    const env = { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" };
    const runtimeServicePreset = requireAddableDefinitionForRole(
      target,
      "runtime-service",
    );
    const sharedLibraryPreset = requireAddableDefinitionForRole(
      target,
      "shared-library",
    );

    await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "init",
        target,
        "--preset",
        sharedLibraryPreset.metadata.name,
        "--scope",
        "acme",
        "--yes",
      ],
      { env },
    );
    const turboPath = path.join(target, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      boundaries: { tags: Record<string, unknown> };
    };
    turbo.boundaries.tags.app = { dependencies: { allow: ["app"] } };
    await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);
    const before = await workspaceSnapshot(target);

    const conflict = await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "add",
        "package",
        "--preset",
        runtimeServicePreset.metadata.name,
        "--name",
        "dashboard",
        "--dry-run",
        "--json",
      ],
      { cwd: target, env, reject: false },
    );

    expect(conflict.exitCode).not.toBe(0);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "add package",
      status: "conflict",
      dryRun: true,
      actions: [],
      conflicts: [
        {
          path: "turbo.json",
          driver: "structured",
          location: "/boundaries/tags/app/dependencies/allow",
          reason: expect.any(String),
          context: {
            before: "<missing>",
            current: '["app"]',
            after: '["app","library"]',
          },
        },
      ],
    });
    expect(await workspaceSnapshot(target)).toEqual(before);
  });

  it("reports stale tool-owned metadata as a conflict with zero workspace writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-stale-metadata-"),
    );
    const target = path.join(workspace, "project");
    const cli = path.resolve("packages/cli/src/cli.ts");
    const env = { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" };

    await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "init",
        target,
        "--preset",
        addablePreset.metadata.name,
        "--scope",
        "acme",
        "--yes",
      ],
      { env },
    );
    const generationPath = path.join(target, ".template/generation.json");
    const generation = JSON.parse(
      await readFile(generationPath, "utf8"),
    ) as unknown;
    await writeFile(generationPath, JSON.stringify(generation));
    const before = await workspaceSnapshot(target);

    const conflict = await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "add",
        "package",
        "--preset",
        addablePreset.metadata.name,
        "--name",
        "stale",
        "--path",
        "packages/stale",
        "--json",
      ],
      { cwd: target, env, reject: false },
    );

    expect(conflict.exitCode).not.toBe(0);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      status: "conflict",
      actions: [],
      conflicts: [
        {
          path: ".template/generation.json",
          driver: "canonical",
          reason: "Current tool-owned state is stale",
        },
      ],
    });
    expect(await workspaceSnapshot(target)).toEqual(before);
  });

  it("renders text conflict context and succeeds when the same stateless command is rerun", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-text-conflict-"),
    );
    const target = path.join(workspace, "project");
    const cli = path.resolve("packages/cli/src/cli.ts");
    const env = { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" };
    const additionPreset = requireAddableDefinitionForRole(
      target,
      "runtime-service",
    );

    await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "init",
        target,
        "--preset",
        addablePreset.metadata.name,
        "--scope",
        "acme",
        "--yes",
      ],
      { env },
    );
    const dockerfilePath = path.join(target, ".devcontainer/Dockerfile");
    const originalDockerfile = await readFile(dockerfilePath, "utf8");
    await writeFile(
      dockerfilePath,
      `${originalDockerfile}\n# incompatible user insertion\n`,
    );
    const command = [
      "--conditions=source",
      cli,
      "add",
      "package",
      "--preset",
      additionPreset.metadata.name,
      "--name",
      "dashboard",
      "--path",
      "services/dashboard",
    ];
    const before = await workspaceSnapshot(target);

    const conflict = await execa("node", command, {
      cwd: target,
      env,
      reject: false,
    });

    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.stderr).toContain(".devcontainer/Dockerfile (text)");
    expect(conflict.stderr).toContain("Region:");
    expect(conflict.stderr).toContain("Before:");
    expect(conflict.stderr).toContain(
      "Current: \n# incompatible user insertion",
    );
    expect(conflict.stderr).toContain("After:");
    expect(await workspaceSnapshot(target)).toEqual(before);

    await writeFile(dockerfilePath, originalDockerfile);
    const rerun = await execa("node", command, { cwd: target, env });
    expect(rerun.stdout).toContain("Added package");
    await expect(
      readFile(path.join(target, "services/dashboard/package.json"), "utf8"),
    ).resolves.toContain('"name": "@acme/dashboard"');
  });

  it("exposes only the supported catalog, initialization, addition, and Blueprint workflows", async () => {
    const help = await execa("node", [
      "--conditions=source",
      "packages/cli/src/cli.ts",
      "--help",
    ]);

    expect(help.stdout).toContain("template presets");
    expect(help.stdout).toContain("template init <dir>");
    expect(help.stdout).toContain("template add package");
    expect(help.stdout).toContain("--dry-run");
    expect(help.stdout).toContain("--json");
    expect(help.stdout).toContain("template blueprint validate <path>");
    expect(help.stdout).not.toContain("schema preset");
    expect(help.stdout).not.toContain("schema");
    expect(help.stdout).not.toContain("preset validate");
  });

  it("plans and persists registry-owned Blueprint v2 metadata without Preset identity", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cutover-"));
    const target = path.join(workspace, "library");
    const command = ["--conditions=source", "packages/cli/src/cli.ts"];
    const dryRun = await execa(
      "node",
      [
        ...command,
        "init",
        target,
        "--preset",
        preset.metadata.name,
        "--yes",
        "--dry-run",
        "--json",
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );
    const planned: unknown = JSON.parse(dryRun.stdout);
    expect(planned).toMatchObject({
      blueprint: { schemaVersion: 2 },
      generationRecord: { preset: preset.metadata.name },
    });
    expect(JSON.stringify(planned)).not.toContain('"blueprint":{"preset"');

    await execa(
      "node",
      [...command, "init", target, "--preset", preset.metadata.name, "--yes"],
      {
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      },
    );
    const blueprint = JSON.parse(
      await readFile(path.join(target, ".template/blueprint.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(blueprint).toMatchObject({ schemaVersion: 2 });
    expect(blueprint).not.toHaveProperty("preset");
    expect(blueprint).not.toHaveProperty("features");
  });

  it("writes Template Source-backed next-step instructions unless --no-todo is selected", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-todo-"));
    const withTodo = path.join(workspace, "with-todo");
    const withoutTodo = path.join(workspace, "without-todo");
    const command = ["--conditions=source", "packages/cli/src/cli.ts"];

    const withTodoResult = await execa(
      "node",
      [...command, "init", withTodo, "--preset", preset.metadata.name, "--yes"],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );
    expect(withTodoResult.stdout).toContain("Next steps");
    expect(withTodoResult.stdout).toContain("pnpm install");
    await expect(
      readFile(path.join(withTodo, "TODO.md"), "utf8"),
    ).resolves.toContain("1. `pnpm install`");

    await execa(
      "node",
      [
        ...command,
        "init",
        withoutTodo,
        "--preset",
        preset.metadata.name,
        "--yes",
        "--no-todo",
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );
    await expect(
      readFile(path.join(withoutTodo, "TODO.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function workspaceSnapshot(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly content: Buffer }[]> {
  const snapshot: { path: string; content: Buffer }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      snapshot.push(...(await workspaceSnapshot(root, child)));
    } else if (entry.isFile()) {
      snapshot.push({
        path: child.split(path.sep).join("/"),
        content: await readFile(path.join(root, child)),
      });
    } else if (entry.isSymbolicLink()) {
      snapshot.push({
        path: child.split(path.sep).join("/"),
        content: Buffer.from(
          `symlink:${await readlink(path.join(root, child))}`,
        ),
      });
    }
  }
  return snapshot.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}
