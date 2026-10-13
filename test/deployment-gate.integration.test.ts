import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { execa } from "execa";

import {
  generatedScenariosFor,
  runGeneratedScenarioSet as runGeneratedScenarioSetProduction,
  type GeneratedCommandRunner,
} from "../packages/checks/src/check-generated-registry.ts";
import {
  FileFixtureEvidenceStorage,
  type FixtureEvidenceLifecycleEvent,
} from "../packages/checks/src/fixture-evidence/kernel/index.ts";
async function generatedTaskIds(root: string): Promise<readonly string[]> {
  const taskIds: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(entryPath, "utf8")) as {
          readonly name: string;
          readonly scripts?: Record<string, string>;
        };
        for (const taskName of Object.keys(manifest.scripts ?? {})) {
          taskIds.push(
            `${manifest.name.startsWith("@") ? manifest.name : "//"}#${taskName}`,
          );
        }
      }
    }
  }
  await visit(root);
  return taskIds;
}

function fixtureExecutorTestRunner(
  run: GeneratedCommandRunner,
): GeneratedCommandRunner {
  return async (command, args, options) => {
    if (command === "docker") return {};
    if (command !== "devcontainer") {
      return await run(command, args, options);
    }
    if (args[0] !== "exec") return {};
    const idLabelIndex = args.indexOf("--id-label");
    let nestedCommandIndex = idLabelIndex === -1 ? 3 : idLabelIndex + 2;
    while (args[nestedCommandIndex] === "--remote-env") {
      nestedCommandIndex += 2;
    }
    const nestedCommand = args[nestedCommandIndex]!;
    const nestedArgs = args.slice(nestedCommandIndex + 1);
    if (nestedCommand === "pnpm" && nestedArgs.includes("--lockfile-only")) {
      return await run(
        "pnpm",
        [
          "install",
          "--store-dir",
          path.join(path.dirname(options.cwd), ".pnpm-store"),
        ],
        options,
      );
    }
    if (
      nestedCommand === "pnpm" &&
      (nestedArgs[0] === "fetch" || nestedArgs.includes("--offline"))
    ) {
      return {};
    }
    const isQualityCommand =
      nestedCommand === "git" ||
      (nestedCommand === "pnpm" &&
        (nestedArgs[0] === "run" ||
          (nestedArgs[0] === "exec" && nestedArgs[1] === "turbo")));
    return isQualityCommand
      ? await run(nestedCommand, nestedArgs, options)
      : {};
  };
}

const runGeneratedScenarioSet = async (
  ...[set, options]: Parameters<typeof runGeneratedScenarioSetProduction>
): Promise<void> =>
  await runGeneratedScenarioSetProduction(set, {
    ...options,
    ...(options.run === undefined
      ? {}
      : { run: fixtureExecutorTestRunner(options.run) }),
  });

void describe("deployment quality gate", () => {
  void it(
    "establishes Root proof for real matrix-derived Deployment evidence and skips every warm executor",
    { timeout: 180_000 },
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "deployment-evidence-"));
      const evidenceRoot = path.join(root, "evidence");
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      type Command = {
        readonly command: string;
        readonly args: readonly string[];
        readonly cwd: string;
      };
      const createRunner =
        (commands: Command[]) =>
        async (
          command: string,
          args: readonly string[],
          options: { readonly cwd: string; readonly stdio?: "inherit" },
        ): Promise<unknown> => {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (command === "pnpm" && args[0] === "install") {
            await mkdir(path.join(options.cwd, "node_modules"), {
              recursive: true,
            });
            await writeFile(
              path.join(options.cwd, "pnpm-lock.yaml"),
              "fixture-created: true\n",
            );
            return {};
          }
          if (command === "pnpm") {
            try {
              await access(path.join(options.cwd, "node_modules"));
            } catch {
              throw new Error(
                "Local package.json exists, but node_modules missing",
              );
            }
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          return {};
        };
      const coldCommands: Command[] = [];
      const deploymentMissCommands: Command[] = [];
      const warmCommands: Command[] = [];
      const coldEvents: FixtureEvidenceLifecycleEvent[] = [];
      const warmEvents: FixtureEvidenceLifecycleEvent[] = [];
      const clock = () => new Date("2026-07-28T00:00:00.000Z");
      try {
        assert.deepStrictEqual(
          (await generatedScenariosFor("deployment")).map(({ id }) => id),
          (await generatedScenariosFor("package-addition-matrix")).map(
            ({ id }) => id,
          ),
        );
        await runGeneratedScenarioSet("deployment", {
          workspace: path.join(root, "cold"),
          run: createRunner(coldCommands),
          scheduling: { concurrency: 4 },
          evidence: {
            storage,
            clock,
            writeEnabled: true,
            producerCommit: "cold",
            recordLifecycle: (event) => {
              coldEvents.push(event);
            },
          },
        });
        await rm(path.join(evidenceRoot, "deployment-quality"), {
          recursive: true,
          force: true,
        });
        await runGeneratedScenarioSet("deployment", {
          workspace: path.join(root, "deployment-miss"),
          run: createRunner(deploymentMissCommands),
          scheduling: { concurrency: 4 },
          evidence: {
            storage,
            clock,
            writeEnabled: true,
            producerCommit: "deployment-miss",
          },
        });
        await runGeneratedScenarioSet("deployment", {
          workspace: path.join(root, "warm"),
          run: createRunner(warmCommands),
          scheduling: { concurrency: 4 },
          evidence: {
            storage,
            clock,
            writeEnabled: true,
            producerCommit: "warm",
            recordLifecycle: (event) => {
              warmEvents.push(event);
            },
          },
        });

        const deploymentCommands = coldCommands.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            args[0] === "run" &&
            args[1] === "check:deployment",
        );
        assert.ok(deploymentCommands.length > 0);
        assert.strictEqual(
          coldCommands.filter(
            ({ command, args }) => command === "pnpm" && args[0] === "install",
          ).length,
          deploymentCommands.length,
        );
        const deploymentMissExecutions = deploymentMissCommands.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            args[0] === "run" &&
            args[1] === "check:deployment",
        );
        assert.strictEqual(
          deploymentMissExecutions.length,
          deploymentCommands.length,
        );
        assert.strictEqual(
          deploymentMissCommands.filter(
            ({ command, args }) => command === "pnpm" && args[0] === "install",
          ).length,
          deploymentMissExecutions.length,
        );
        assert.deepStrictEqual(
          deploymentMissCommands.filter(
            ({ command, args }) =>
              command === "pnpm" && args[0] === "run" && args[1] === "check",
          ),
          [],
        );
        assert.deepStrictEqual(
          warmCommands.filter(({ command }) => command !== "git"),
          [],
        );
        assert.ok(
          warmCommands.filter(
            ({ command, args }) =>
              command === "git" && args[0] === "write-tree",
          ).length > 0,
        );

        const deploymentIssues = coldEvents.filter(
          (event) =>
            event.type === "issuance" &&
            event.gate === "deployment-quality" &&
            event.outcome === "issued",
        );
        assert.strictEqual(deploymentIssues.length, deploymentCommands.length);
        assert.strictEqual(
          warmEvents.filter(
            (event) =>
              event.type === "lookup" &&
              event.gate === "deployment-quality" &&
              event.outcome === "hit",
          ).length,
          deploymentCommands.length,
        );
        assert.deepStrictEqual(
          warmEvents.filter((event) => event.type === "execution"),
          [],
        );

        for (const recordName of await readdir(
          path.join(evidenceRoot, "deployment-quality"),
        )) {
          const deploymentRecord = JSON.parse(
            await readFile(
              path.join(evidenceRoot, "deployment-quality", recordName),
              "utf8",
            ),
          ) as {
            readonly components: {
              readonly generatedContent: string;
              readonly rootEvidence: string;
            };
          };
          const rootRecord = JSON.parse(
            await readFile(
              path.join(
                evidenceRoot,
                "generated-root-quality",
                `${deploymentRecord.components.rootEvidence}.json`,
              ),
              "utf8",
            ),
          ) as { readonly components: { readonly generatedContent: string } };
          assert.strictEqual(
            rootRecord.components.generatedContent,
            deploymentRecord.components.generatedContent,
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  void it("fails the deployment scenario set explicitly when Docker is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-absence-"));
    const messages: string[] = [];
    try {
      await assert.rejects(
        runGeneratedScenarioSetProduction("deployment", {
          workspace: root,
          reporter: { info: (message) => messages.push(message) },
          run: async (command, args, options) => {
            if (command === "git") {
              return await execa(command, [...args], options);
            }
            if (args.includes("--dry-run=json")) {
              return {
                stdout: JSON.stringify({
                  tasks: (await generatedTaskIds(options.cwd)).map(
                    (taskId) => ({ taskId }),
                  ),
                }),
              };
            }
            if (command === "docker") {
              throw new Error("docker executable unavailable");
            }
            return {};
          },
        }),
        (error: unknown) =>
          error instanceof Error &&
          /Docker is required for Generated Repository Fixture quality.*docker executable unavailable/u.test(
            error.message,
          ),
      );
      assert.ok(messages.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
