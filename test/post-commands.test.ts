import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  planPostCommands,
  runPostCommands,
  type PostCommandPlan,
  type PostCommandExecution
} from "../src/post-commands.js";
import type { PresetName } from "../src/declarations.js";

describe("Post Commands", () => {
  it.each([
    ["ts-lib", "Node library"],
    ["hono-api", "Node API"]
  ] satisfies Array<[PresetName, string]>)(
    "plans ready commands for a %s %s Preset",
    async (preset, _description) => {
      const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));

      const plan = planPostCommands({ preset, targetDir });

      expect(plan.commands).toEqual([
        {
          id: "node-enable-corepack",
          label: "Enable Corepack",
          command: "corepack",
          args: ["enable"],
          cwd: targetDir
        },
        {
          id: "node-refresh-package-manager-pin",
          label: "Refresh Package Manager Pin and Install Dependencies",
          command: "corepack",
          args: ["use", "pnpm@10.0.0"],
          cwd: targetDir
        },
        {
          id: "node-run-fix",
          label: "Run Fix Command",
          command: "pnpm",
          args: ["run", "fix"],
          cwd: targetDir
        }
      ]);
    }
  );

  it("plans Playwright browser installation after Node ready commands for the Vue Preset", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));

    const plan = planPostCommands({ preset: "vue-app", targetDir });

    expect(plan.commands).toEqual([
      expect.objectContaining({ id: "node-enable-corepack", cwd: targetDir }),
      expect.objectContaining({ id: "node-refresh-package-manager-pin", cwd: targetDir }),
      expect.objectContaining({ id: "node-run-fix", cwd: targetDir }),
      {
        id: "vue-install-playwright-browsers",
        label: "Install Playwright browser assets",
        command: "pnpm",
        args: ["exec", "playwright", "install", "chromium"],
        cwd: targetDir
      }
    ]);
  });

  it("plans Playwright browser installation for the Vue/Hono web workspace package", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));

    const plan = planPostCommands({ preset: "vue-hono-app", targetDir });

    expect(plan.commands).toEqual([
      expect.objectContaining({ id: "node-enable-corepack", cwd: targetDir }),
      expect.objectContaining({ id: "node-refresh-package-manager-pin", cwd: targetDir }),
      expect.objectContaining({ id: "node-run-fix", cwd: targetDir }),
      {
        id: "vue-hono-install-playwright-browsers",
        label: "Install Playwright browser assets for web workspace",
        command: "pnpm",
        args: ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
        cwd: targetDir
      }
    ]);
  });

  it("plans no Post Commands for the Rust Preset", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));

    const plan = planPostCommands({ preset: "rust-bin", targetDir });

    expect(plan.commands).toEqual([]);
  });

  it.each(["ts-app", "node-cli"] satisfies PresetName[])(
    "plans no Post Commands for unsupported future Preset %s",
    async (preset) => {
      const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));

      const plan = planPostCommands({ preset, targetDir });

      expect(plan.commands).toEqual([]);
    }
  );

  it("runs only planned commands and stops with a clear failed result", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));
    const plan = planPostCommands({ preset: "ts-lib", targetDir });
    const executed: string[] = [];

    const results = await runPostCommands({
      plan,
      executor: async (command) => {
        executed.push(command.id);
        return { exitCode: 7 };
      }
    });

    expect(executed).toEqual(["node-enable-corepack"]);
    expect(results).toEqual([
      {
        command: plan.commands[0],
        status: "failed",
        exitCode: 7,
        error: "Post Command failed with exit code 7: node-enable-corepack"
      }
    ] satisfies PostCommandExecution[]);
  });

  it("rejects commands that were not returned by the planner", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));
    const plan = planPostCommands({ preset: "ts-lib", targetDir });
    const tamperedPlan = {
      ...plan,
      commands: [
        {
          id: "unplanned-command",
          label: "Unplanned command",
          command: "node",
          args: ["--version"],
          cwd: targetDir
        }
      ]
    } as PostCommandPlan;

    await expect(runPostCommands({ plan: tamperedPlan })).rejects.toThrow(
      "Unplanned Post Command: unplanned-command"
    );
  });

  it("rejects planned command sequences with missing commands", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));
    const plan = planPostCommands({ preset: "ts-lib", targetDir });
    const tamperedPlan = {
      ...plan,
      commands: plan.commands.slice(0, -1)
    } as PostCommandPlan;

    await expect(runPostCommands({ plan: tamperedPlan })).rejects.toThrow(
      "Post Command plan must match the complete planned sequence"
    );
  });

  it("rejects planned command sequences with reordered commands", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));
    const plan = planPostCommands({ preset: "ts-lib", targetDir });
    const tamperedPlan = {
      ...plan,
      commands: [plan.commands[1], plan.commands[0], ...plan.commands.slice(2)]
    } as PostCommandPlan;

    await expect(runPostCommands({ plan: tamperedPlan })).rejects.toThrow(
      "Post Command plan must match the complete planned sequence"
    );
  });

  it("rejects planned command directories outside the target directory", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));
    const targetDir = path.join(workspace, "target");
    const plan = planPostCommands({ preset: "ts-lib", targetDir });
    const tamperedPlan = {
      ...plan,
      commands: [
        {
          ...plan.commands[0],
          cwd: path.dirname(targetDir)
        }
      ]
    } as PostCommandPlan;

    await expect(runPostCommands({ plan: tamperedPlan })).rejects.toThrow(
      "Post Command cwd must stay within the target directory: node-enable-corepack"
    );
  });
});
