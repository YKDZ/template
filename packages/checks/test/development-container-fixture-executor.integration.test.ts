import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { execa } from "execa";

import {
  generatedScenariosFor,
  runGeneratedScenarioSet,
} from "../src/check-generated-registry.ts";
import {
  checkFixtureEvidenceHealth,
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
} from "../src/fixture-evidence/kernel/index.ts";
import {
  registryCapabilityProbes,
  requiredCapabilityProbeIdentities,
} from "./development-container-fixture-executor.test-support.ts";
type Command = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
};

function nestedDevcontainerCommand(args: readonly string[]): {
  readonly command: string | undefined;
  readonly args: readonly string[];
} {
  let commandIndex = args.indexOf("--id-label") + 2;
  while (args[commandIndex] === "--remote-env") commandIndex += 2;
  return {
    command: args[commandIndex],
    args: args.slice(commandIndex + 1),
  };
}

void describe("Development Container Fixture Executor", () => {
  void it("routes cold registry quality through one container lifecycle per scenario", async () => {
    const workspace = path.resolve(
      "/tmp/template-development-container-registry-test",
    );
    const calls: Command[] = [];
    const containerGeneratedLockfiles = new Set<string>();
    await rm(workspace, { recursive: true, force: true });
    const evidenceRoot = path.join(workspace, ".test-evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(workspace, ".test-activity"),
      evidenceRoot,
    });

    try {
      await runGeneratedScenarioSet("package-addition-matrix", {
        workspace,
        evidence: {
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          readEnabled: false,
          writeEnabled: false,
          activity: {
            ledger,
            runId: "cold-registry-phases",
            runAttempt: "1",
          },
        },
        run: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          if (command === "git") {
            if (
              args[0] === "add" &&
              containerGeneratedLockfiles.has(options.cwd)
            ) {
              throw new Error(
                'error: open("pnpm-lock.yaml"): Permission denied',
              );
            }
            return await execa(command, [...args], options);
          }
          if (command === "docker" && args[0] === "ps") {
            return {
              stdout: `${createHash("sha256").update(options.cwd).digest("hex").slice(0, 12)}\n`,
            };
          }
          if (command !== "devcontainer" || args[0] !== "exec") return {};

          const { command: nestedCommand, args: nestedArgs } =
            nestedDevcontainerCommand(args);
          if (
            nestedCommand === "pnpm" &&
            nestedArgs.includes("--lockfile-only")
          ) {
            await writeFile(
              path.join(options.cwd, "pnpm-lock.yaml"),
              "lockfileVersion: '9.0'\n",
            );
            containerGeneratedLockfiles.add(options.cwd);
          }
          if (nestedCommand === "git") {
            if (
              nestedArgs[0] !== "-c" ||
              nestedArgs[1] !==
                `safe.directory=/workspaces/${path.basename(options.cwd)}`
            ) {
              throw new Error(
                `fatal: detected dubious ownership in repository at '/workspaces/${path.basename(options.cwd)}'`,
              );
            }
            return await execa(nestedCommand, [...nestedArgs], options);
          }
          return {};
        },
      });

      const scenarioCount = (
        await generatedScenariosFor("package-addition-matrix")
      ).length;
      const records = await ledger.read();
      const phases = records.flatMap((record) =>
        record.event.type === "phase" ? [record.event] : [],
      );
      assert.strictEqual(
        phases.filter((event) => event.outcome === "started").length,
        scenarioCount * 5,
      );
      assert.strictEqual(
        phases.filter((event) => event.outcome === "succeeded").length,
        scenarioCount * 5,
      );
      assert.deepStrictEqual(
        records.filter((record) => record.event.type === "retry"),
        [],
      );
      const health = await checkFixtureEvidenceHealth({
        ledger,
        runId: "cold-registry-phases",
        runAttempt: "1",
        enabledScenarioSets: ["package-addition-matrix"],
      });
      assert.strictEqual(health.healthy, true);
      assert.strictEqual(health.stages.length, 1);
      assert.partialDeepStrictEqual(health.stages[0], {
        retries: 0,
        recoveries: 0,
      });
      assert.strictEqual(
        calls.filter(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        calls.filter(({ command, args }) => {
          if (command !== "devcontainer" || args[0] !== "exec") return false;
          const nested = nestedDevcontainerCommand(args);
          const nestedGitArgs =
            nested.args[0] === "-c" &&
            nested.args[1]?.startsWith("safe.directory=")
              ? nested.args.slice(2)
              : nested.args;
          return (
            nested.command === "git" &&
            (nestedGitArgs[0] === "add" || nestedGitArgs[0] === "write-tree")
          );
        }).length,
        scenarioCount * 4,
      );
      const buildCacheSources = calls
        .filter(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        )
        .map(({ args }) => {
          const cacheFrom = args.indexOf("--cache-from");
          assert.ok(cacheFrom > 0);
          assert.ok(args.includes("--cache-to"));
          return args[cacheFrom + 1];
        });
      assert.ok(new Set(buildCacheSources).size < buildCacheSources.length);
      assert.strictEqual(
        calls.filter(
          ({ command, args }) => command === "docker" && args[0] === "ps",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        calls.filter(
          ({ command, args }) => command === "docker" && args[0] === "rm",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        calls.some(
          ({ command, args }) =>
            command === "devcontainer" && args[0] === "down",
        ),
        false,
      );
      assert.deepStrictEqual(
        calls.filter(({ command }) => command === "pnpm" || command === "node"),
        [],
      );
      const capabilityProbes = registryCapabilityProbes(workspace);
      assert.deepStrictEqual(
        new Set(capabilityProbes.map((probe) => probe.identity)),
        requiredCapabilityProbeIdentities,
      );
      assert.deepStrictEqual(
        calls.filter(({ command }) =>
          capabilityProbes.some((probe) => probe.command === command),
        ),
        [],
      );
      for (const probe of capabilityProbes) {
        assert.strictEqual(
          calls.some(({ command, args }) => {
            if (command !== "devcontainer" || args[0] !== "exec") return false;
            const nested = nestedDevcontainerCommand(args);
            return (
              nested.command === probe.command &&
              JSON.stringify(nested.args) === JSON.stringify(probe.args ?? [])
            );
          }),
          true,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("shares one cold container session while Deployment derives from Root full", async () => {
    const workspace = path.resolve(
      "/tmp/template-development-container-shared-deployment-test",
    );
    const calls: Command[] = [];
    const lifecycle: Array<{
      readonly type: string;
      readonly gate?: string;
      readonly identity?: string;
      readonly outcome?: string;
      readonly scenario?: { readonly id: string };
    }> = [];
    await rm(workspace, { recursive: true, force: true });

    try {
      await runGeneratedScenarioSet("deployment", {
        workspace,
        containerEnvironment: {},
        evidence: {
          writeEnabled: false,
          recordLifecycle: (event) => {
            lifecycle.push(event);
          },
        },
        run: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (command === "docker" && args[0] === "ps") {
            return {
              stdout: `${createHash("sha256").update(options.cwd).digest("hex").slice(0, 12)}\n`,
            };
          }
          if (command !== "devcontainer" || args[0] !== "exec") return {};
          const { command: nestedCommand, args: nestedArgs } =
            nestedDevcontainerCommand(args);
          if (nestedCommand === "pnpm" && args.includes("--lockfile-only")) {
            await writeFile(
              path.join(options.cwd, "pnpm-lock.yaml"),
              "lockfileVersion: '9.0'\n",
            );
          }
          if (nestedCommand === "git") {
            return await execa("git", [...nestedArgs], {
              cwd: options.cwd,
            });
          }
          return {};
        },
      });

      const started = lifecycle.filter(
        (event) => event.type === "execution" && event.outcome === "started",
      );
      const rootStarts = started.filter(
        (event) => event.gate === "generated-root-quality",
      );
      const deploymentExecutions = started.filter(
        (event) => event.gate === "deployment-quality",
      );
      const deploymentDerivations = lifecycle.filter(
        (event) =>
          event.type === "derivation" && event.gate === "deployment-quality",
      );
      assert.ok(rootStarts.length > 0);
      assert.ok(deploymentDerivations.length > 0);
      assert.deepStrictEqual(deploymentExecutions, []);
      const fullCommands = calls.filter(({ command, args }) => {
        if (command !== "devcontainer" || args[0] !== "exec") return false;
        const nested = nestedDevcontainerCommand(args);
        return (
          nested.command === "node" &&
          nested.args[1] === "scripts/task-gates.ts" &&
          nested.args[2] === "check:full"
        );
      });
      assert.strictEqual(fullCommands.length, rootStarts.length * 2);
      assert.deepStrictEqual(
        calls.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            args[0] === "run" &&
            args[1] === "check:deployment",
        ),
        [],
      );
      for (const derivation of deploymentDerivations) {
        const root = started.find(
          (event) =>
            event.gate === "generated-root-quality" &&
            event.scenario?.id === derivation.scenario?.id,
        );
        assert.notStrictEqual(root, undefined);
        assert.notStrictEqual(root?.identity, derivation.identity);
      }
      for (const root of rootStarts) {
        const projectDir = path.join(workspace, root.scenario!.id);
        assert.strictEqual(
          calls.filter(
            ({ command, args, cwd }) =>
              cwd === projectDir &&
              command === "devcontainer" &&
              args[0] === "up",
          ).length,
          1,
        );
        assert.strictEqual(
          calls.filter(
            ({ command, args, cwd }) =>
              cwd === projectDir && command === "docker" && args[0] === "ps",
          ).length,
          1,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
