import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { vueHonoAppDefinition } from "./definition.ts";

void describe("vue-hono-app Built-in Preset Definition integration behavior", () => {
  /**
   * 运行夹具：真正渲染并执行生成仓库自身检查的现场必须携带发版快照的精确 Node 事实，
   * 因为该检查要求根 engines.node 是精确三段版本。发版快照是固定副本里的既有真源，
   * 这里不另立版本常量。
   */
  const runtimeToolchain = {
    nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
      0,
      releaseToolchainSnapshot.nodeVersion.indexOf("."),
    ),
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
  };

  void it(
    "generates a checked browser-backed multi-package workspace",
    { timeout: 300_000 },
    async () => {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-vue-hono-check-")),
        "demo-stack",
      );
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: runtimeToolchain,
      });
      const plan = planGeneratedRepositoryInitialization({
        definition: vueHonoAppDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });

      await execa("pnpm", ["install"], { cwd: targetDir });
      await execa("pnpm", ["exec", "playwright", "install", "chromium"], {
        cwd: targetDir,
      });
      await execa("pnpm", ["run", "check"], { cwd: targetDir });
    },
  );
});
