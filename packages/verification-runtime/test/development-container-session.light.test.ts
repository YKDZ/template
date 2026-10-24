import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import {
  createDevelopmentContainerSession,
  type ContainerCommandRunner,
} from "../src/development-container-session.ts";

void it("在单个自有容器会话中执行项目命令并记录生命周期", async () => {
  const projectDir = await mkdtemp(
    path.join(tmpdir(), "verification-session-"),
  );
  const calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
  }> = [];
  const activities: Array<Record<string, unknown>> = [];
  const run: ContainerCommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "docker" && args[0] === "ps")
      return { stdout: "owned-container\n" };
    return {};
  };

  try {
    const session = createDevelopmentContainerSession({
      projectDir,
      probes: [],
      dependencyPreparation: {
        commands: [{ command: "pnpm", args: ["install"] }],
      },
      run,
      recordActivity: (event) => {
        activities.push(event);
      },
    });
    const result = await session.execute(async (execute) => {
      await execute("pnpm", ["run", "check"], { cwd: projectDir });
      return "passed";
    });

    assert.equal(result, "passed");
    assert.ok(
      calls.some(
        ({ command, args }) => command === "devcontainer" && args[0] === "up",
      ),
    );
    assert.ok(
      calls.some(({ command, args }) => {
        if (command !== "devcontainer" || args[0] !== "exec") return false;
        return args.slice(-3).join(" ") === "pnpm run check";
      }),
    );
    assert.deepEqual(
      calls.filter(
        ({ command, args }) => command === "docker" && args[0] === "rm",
      ),
      [{ command: "docker", args: ["rm", "-f", "owned-container"] }],
    );
    assert.ok(
      activities.some(
        (event) =>
          event.type === "phase" &&
          event.phase === "container-preparation" &&
          event.outcome === "succeeded",
      ),
    );
    assert.ok(
      activities.some(
        (event) =>
          event.type === "phase" &&
          event.phase === "dependency-installation" &&
          event.outcome === "succeeded",
      ),
    );
    const cleanupQuery = calls.find(
      ({ command, args }) => command === "docker" && args[0] === "ps",
    );
    assert.ok(
      cleanupQuery?.args.some((arg) =>
        arg.startsWith("label=com.ykdz.template.verification.project="),
      ),
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
