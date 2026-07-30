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

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";

import {
  generatedScenariosFor,
  runGeneratedScenarioSet as runGeneratedScenarioSetProduction,
  type GeneratedCommandRunner,
} from "../packages/checks/src/check-generated-registry.ts";
import {
  deriveDeploymentQualityContractIdentity,
  deriveDeploymentQualityPlanInput,
  executeDeploymentQuality,
  normalizedDeploymentQualityPlan,
} from "../packages/checks/src/fixture-evidence/gates/deployment-quality/index.ts";
import {
  FileFixtureEvidenceStorage,
  runFixtureEvidenceGate,
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

function deploymentPlan() {
  const definition = builtInPresetRegistry.all().find((candidate) =>
    planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "deployment-gate"),
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    }).manifests.some(
      (manifest) =>
        (manifest.scripts as Record<string, unknown> | undefined)?.[
          "check:deployment"
        ] !== undefined,
    ),
  );
  if (definition === undefined) {
    throw new Error("A deployment Definition is required");
  }
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "deployment-gate"),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    }),
  });
}

describe("deployment quality gate", () => {
  it("owns the normalized Deployment Quality contract and complete executor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-contract-"));
    const plan = deploymentPlan();
    const deployment = deriveDeploymentQualityPlanInput(plan);
    const projectDir = path.join(root, "project");
    const fixtureWorkspace = path.join(root, "workspace");
    try {
      expect(deployment).toBeDefined();
      expect(normalizedDeploymentQualityPlan(deployment!)).toMatchObject({
        gate: "deployment-quality",
        executionResources: ["docker"],
        dependencyInstallation: {
          storeDir: "/pnpm/store",
          commands: [
            {
              command: "pnpm",
              args: [
                "install",
                "--lockfile-only",
                "--store-dir",
                "/pnpm/store",
              ],
            },
            {
              command: "pnpm",
              args: ["fetch", "--store-dir", "/pnpm/store"],
            },
            {
              command: "pnpm",
              args: [
                "install",
                "--offline",
                "--frozen-lockfile",
                "--store-dir",
                "/pnpm/store",
              ],
            },
          ],
        },
        generatedDeployment: {
          command: "pnpm",
          args: ["run", "check:deployment"],
        },
      });
      await expect(
        deriveDeploymentQualityContractIdentity(deployment!),
      ).resolves.toMatch(/^[0-9a-f]{64}$/u);

      const calls: Array<{ command: string; args: readonly string[] }> = [];
      await executeDeploymentQuality({
        deployment: deployment!,
        projectDir,
        fixtureWorkspace,
        run: async (command, args) => {
          calls.push({ command, args });
          return args.includes("--dry-run=json")
            ? {
                stdout: JSON.stringify({
                  tasks: plan.manifests.flatMap((manifest) =>
                    typeof manifest.name === "string" &&
                    typeof (manifest.scripts as Record<string, unknown> | null)
                      ?.deployment === "string"
                      ? [{ taskId: `${manifest.name}#deployment` }]
                      : [],
                  ),
                }),
              }
            : {};
        },
      });

      expect(calls).toEqual([
        {
          command: "pnpm",
          args: ["exec", "turbo", "run", "deployment", "--dry-run=json"],
        },
        { command: "pnpm", args: ["run", "check:deployment"] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("establishes Root proof for real matrix-derived Deployment evidence and skips every warm executor", async () => {
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
      expect(
        (await generatedScenariosFor("deployment")).map(({ id }) => id),
      ).toEqual(
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
      expect(deploymentCommands.length).toBeGreaterThan(0);
      expect(
        coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
      ).toHaveLength(deploymentCommands.length);
      const deploymentMissExecutions = deploymentMissCommands.filter(
        ({ command, args }) =>
          command === "pnpm" &&
          args[0] === "run" &&
          args[1] === "check:deployment",
      );
      expect(deploymentMissExecutions).toHaveLength(deploymentCommands.length);
      expect(
        deploymentMissCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
      ).toHaveLength(deploymentMissExecutions.length);
      expect(
        deploymentMissCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "check",
        ),
      ).toEqual([]);
      expect(warmCommands.filter(({ command }) => command !== "git")).toEqual(
        [],
      );
      expect(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ).length,
      ).toBeGreaterThan(0);

      const deploymentIssues = coldEvents.filter(
        (event) =>
          event.type === "issuance" &&
          event.gate === "deployment-quality" &&
          event.outcome === "issued",
      );
      expect(deploymentIssues).toHaveLength(deploymentCommands.length);
      expect(
        warmEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "deployment-quality" &&
            event.outcome === "hit",
        ),
      ).toHaveLength(deploymentCommands.length);
      expect(warmEvents.filter((event) => event.type === "execution")).toEqual(
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
        expect(rootRecord.components.generatedContent).toBe(
          deploymentRecord.components.generatedContent,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes no Deployment Quality claim without a generated entrypoint", () => {
    const planWithoutDeployment = builtInPresetRegistry
      .all()
      .map((definition) =>
        planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir: path.join(
              "generated-repository",
              definition.metadata.name,
            ),
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
            },
          }),
        }),
      )
      .find(
        (plan) =>
          !plan.manifests.some(
            (manifest) =>
              typeof (manifest.scripts as Record<string, unknown> | null)?.[
                "check:deployment"
              ] === "string",
          ),
      );
    expect(planWithoutDeployment).toBeDefined();
    expect(
      deriveDeploymentQualityPlanInput(planWithoutDeployment!),
    ).toBeUndefined();
  });

  it("runs the generated deployment gate after task discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-success-"));
    const plan = deploymentPlan();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    try {
      await executeDeploymentQuality({
        deployment: deriveDeploymentQualityPlanInput(plan)!,
        projectDir: path.join(root, "project"),
        fixtureWorkspace: root,
        run: async (command, args) => {
          calls.push({ command, args });
          return args.includes("--dry-run=json")
            ? {
                stdout: JSON.stringify({
                  tasks: plan.manifests.flatMap((manifest) =>
                    typeof manifest.name === "string" &&
                    typeof (manifest.scripts as Record<string, unknown> | null)
                      ?.deployment === "string"
                      ? [{ taskId: `${manifest.name}#deployment` }]
                      : [],
                  ),
                }),
              }
            : {};
        },
      });

      expect(calls).toEqual([
        {
          command: "pnpm",
          args: ["exec", "turbo", "run", "deployment", "--dry-run=json"],
        },
        { command: "pnpm", args: ["run", "check:deployment"] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the deployment scenario set explicitly when Docker is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-absence-"));
    const messages: string[] = [];
    try {
      await expect(
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
      ).rejects.toThrow(
        /Docker is required for Generated Repository Fixture quality.*docker executable unavailable/u,
      );
      expect(messages.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("issues no Deployment evidence after a partially completed command is cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-cancelled-"));
    const storage = new FileFixtureEvidenceStorage(path.join(root, "evidence"));
    const plan = deploymentPlan();
    const generatedContentIdentity = "c".repeat(40);
    const events: FixtureEvidenceLifecycleEvent[] = [];
    try {
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity,
        contractIdentity: "d".repeat(64),
        scenario: {
          id: "deployment-cancelled",
          label: "deployment cancelled",
          presetIdentities: ["deployment"],
        },
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });
      await expect(
        runFixtureEvidenceGate({
          gate: "deployment-quality",
          rootEvidence,
          generatedContentIdentity,
          contractIdentity: "e".repeat(64),
          scenario: {
            id: "deployment-cancelled",
            label: "deployment cancelled",
            presetIdentities: ["deployment"],
          },
          producerCommit: "test",
          storage,
          writeEnabled: true,
          recordLifecycle: (event) => {
            events.push(event);
          },
          execute: async () =>
            await executeDeploymentQuality({
              deployment: deriveDeploymentQualityPlanInput(plan)!,
              projectDir: path.join(root, "project"),
              fixtureWorkspace: root,
              run: async (command, args) => {
                if (args.includes("--dry-run=json")) {
                  return {
                    stdout: JSON.stringify({
                      tasks: plan.manifests.flatMap((manifest) =>
                        typeof manifest.name === "string" &&
                        typeof (
                          manifest.scripts as Record<string, unknown> | null
                        )?.deployment === "string"
                          ? [{ taskId: `${manifest.name}#deployment` }]
                          : [],
                      ),
                    }),
                  };
                }
                if (args[0] === "install") return {};
                if (command === "docker") return {};
                throw new Error("deployment command cancelled");
              },
            }),
        }),
      ).rejects.toThrow("deployment command cancelled");

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "execution",
          gate: "deployment-quality",
          outcome: "failed",
        }),
      );
      expect(events.filter((event) => event.type === "issuance")).toEqual([]);
      await expect(
        readdir(path.join(root, "evidence", "deployment-quality")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
