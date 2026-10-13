import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  prepareGeneratedRepositoryInitialization,
  type InitializationPreparation,
} from "@ykdz/template-builtin-presets";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { tsCliDefinition } from "../src/ts-cli/definition.ts";

export function requireReadyInitialization(
  options: Parameters<typeof prepareGeneratedRepositoryInitialization>[0],
): Extract<InitializationPreparation, { readonly status: "ready" }> {
  const preparation = prepareGeneratedRepositoryInitialization(options);
  if (preparation.status !== "ready") {
    throw new Error(
      `Expected ready initialization, received ${preparation.status}`,
    );
  }
  return preparation;
}

export async function renderGeneratedRepository(
  prefix: string,
  installDependencies: boolean,
  initialName?: string,
): Promise<{
  readonly workspace: string;
  readonly targetDir: string;
  readonly packageRoot: string;
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const targetDir = path.join(workspace, "demo-cli");
  const prepared = requireReadyInitialization({
    definition: tsCliDefinition,
    targetDir,
    overrides: {
      scope: "demo",
      ...(initialName === undefined ? {} : { name: initialName }),
    },
  });
  const plan = prepared.plan;
  await renderNewProject({
    targetRoot: targetDir,
    operations: [...plan.operations],
  });
  if (installDependencies) await execa("pnpm", ["install"], { cwd: targetDir });
  else {
    const sourceModules = path.resolve(import.meta.dirname, "../node_modules");
    const targetModules = path.join(targetDir, "node_modules");
    await mkdir(targetModules);
    for (const entry of await readdir(sourceModules))
      await symlink(
        path.join(sourceModules, entry),
        path.join(targetModules, entry),
        "dir",
      );
  }
  return {
    workspace,
    targetDir,
    packageRoot: path.join(
      targetDir,
      prepared.resolved.packages.find((candidate) =>
        candidate.path.startsWith("packages/"),
      )?.path ?? "packages/cli",
    ),
  };
}

export async function renderInstalledGeneratedRepository(prefix: string) {
  return await renderGeneratedRepository(prefix, true);
}

export async function writeExecutable(
  filePath: string,
  body: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
}

export function expectNoControlCharacters(value: string): void {
  for (const line of value.split("\n"))
    assert.strictEqual(
      Array.from(line).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      }),
      false,
    );
}

export type TerminalConfirmationStep = {
  readonly marker: string;
  readonly prompt: string;
  readonly line: string;
  readonly before?: () => Promise<void>;
};

// 向导的每个确认阶段挂载一次性读取器，因此每行只能在其自身阶段提示出现后输入；提前输入的文本会被丢弃。
export async function driveGeneratedTerminal(
  command: string,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
  },
  steps: readonly TerminalConfirmationStep[],
) {
  const running = execa("script", ["-qefc", command, "/dev/null"], {
    cwd: options.cwd,
    env: options.env,
    reject: false,
    stdin: "pipe",
    timeout: 60_000,
  });
  let transcript = "";
  let closed = false;
  running.stdout?.on("data", (chunk: Buffer) => {
    transcript += chunk.toString("utf8");
  });
  running.stdout?.on("end", () => {
    closed = true;
  });
  let typedThrough = 0;
  for (const step of steps) {
    const waitForPrompt = async (): Promise<number> => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const observed = transcript.replaceAll("\r", "");
        const markerAt = observed.indexOf(step.marker, typedThrough);
        if (markerAt >= 0) {
          const promptAt = observed.indexOf(
            step.prompt,
            markerAt + step.marker.length,
          );
          if (promptAt >= 0) return promptAt;
        }
        if (closed) return -1;
        if (Date.now() >= deadline)
          throw new Error(
            `Terminal protocol stalled before ${step.marker}: ${observed}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const promptAt = await waitForPrompt();
    if (promptAt < 0) break;
    typedThrough = promptAt + step.prompt.length;
    await step.before?.();
    running.stdin?.write(`${step.line}\n`);
  }
  return await running;
}

export async function writeAcceptedFirstReleaseArtifact(options: {
  readonly root: string;
  readonly packageName: string;
  readonly commandName: string;
  readonly temporaryParent?: string;
}): Promise<{ readonly directory: string; readonly integrity: string }> {
  const directory = await mkdtemp(
    path.join(
      options.temporaryParent ?? path.dirname(options.root),
      "npm-publication-setup-artifact.",
    ),
  );
  const bytes = Buffer.from("ticket-13 accepted tarball\n");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const file = "ship-1.0.0.tgz";
  await writeFile(path.join(directory, file), bytes);
  await writeFile(
    path.join(directory, "SHA512SUMS"),
    `${createHash("sha512").update(bytes).digest("hex")}  ${file}\n`,
  );
  await writeFile(
    path.join(directory, "verified-publication-artifact.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        publication: {
          packageName: options.packageName,
          version: "1.0.0",
          commandName: options.commandName,
          repository: "git+https://github.com/demo/ship.git",
          releaseDate: "2026-08-30",
          releaseNotes: "Initial release.",
        },
        packedManifest: {
          name: options.packageName,
          version: "1.0.0",
          bin: { [options.commandName]: "./dist/cli.js" },
          repository: {
            type: "git",
            url: "git+https://github.com/demo/ship.git",
            directory: "packages/cli",
          },
        },
        artifact: {
          file,
          checksumFile: "SHA512SUMS",
          integrity,
          size: bytes.byteLength,
        },
        files: [
          "package/CHANGELOG.md",
          "package/LICENSE",
          "package/README.md",
          "package/dist/cli-command-identity.js",
          "package/dist/cli.js",
          "package/dist/main.js",
          "package/dist/standard-schema.js",
          "package/package.json",
        ].map((entry, index) => ({
          path: entry,
          mode: entry === "package/dist/cli.js" ? 0o755 : 0o644,
          size: index + 1,
        })),
        bin: {
          path: "package/dist/cli.js",
          shebang: "#!/usr/bin/env node",
          mode: 0o755,
          posixExecutableChecked: process.platform !== "win32",
        },
        smokes: [
          { name: "runtime-import", args: [], stdout: "" },
          {
            name: "help",
            args: ["--help"],
            stdout: `${options.commandName} lookup schema\n`,
          },
          {
            name: "version",
            args: ["--version"],
            stdout: `${options.commandName} 1.0.0\n`,
          },
          {
            name: "lookup",
            args: ["lookup", "ada"],
            stdout: JSON.stringify({
              schemaVersion: "1",
              command: "lookup",
              kind: "data",
              variant: "found",
              data: { name: "ada", title: "Ada Lovelace" },
            }),
          },
          {
            name: "schema",
            args: ["schema"],
            stdout: JSON.stringify({
              schemaVersion: "1",
              command: "schema",
              kind: "data",
              variant: "exported",
              data: {
                manifest: {
                  root: "cli",
                  commands: {
                    cli: { name: options.commandName },
                    schema: { name: "schema" },
                    lookup: {
                      name: "lookup",
                      input: { inputSchema: { type: "object" } },
                      success: { variants: { found: { exitCode: 0 } } },
                      failures: { notFound: { exitCode: 1 } },
                    },
                  },
                },
              },
            }),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { directory, integrity };
}
