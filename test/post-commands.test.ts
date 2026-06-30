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
    ["hono-api", "Node API"],
    ["vue-app", "Vue app"],
    ["vue-hono-app", "workspace Vue app"]
  ] satisfies Array<[PresetName, string]>)(
    "plans template-maintained commands for a %s %s Preset",
    async (preset, _description) => {
      const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));

      const plan = planPostCommands({ preset, targetDir });

      expect(plan.commands).toEqual([
        {
          id: "node-ready-smoke",
          label: "Check Node runtime",
          command: "node",
          args: ["--version"],
          cwd: targetDir
        }
      ]);
    }
  );

  it("plans no Post Commands for the Rust Preset", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "template-post-commands-"));

    const plan = planPostCommands({ preset: "rust-bin", targetDir });

    expect(plan.commands).toEqual([]);
  });

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

    expect(executed).toEqual(["node-ready-smoke"]);
    expect(results).toEqual([
      {
        command: plan.commands[0],
        status: "failed",
        exitCode: 7,
        error: "Post Command failed with exit code 7: node-ready-smoke"
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
      "Post Command cwd must stay within the target directory: node-ready-smoke"
    );
  });
});
