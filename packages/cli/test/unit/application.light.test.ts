import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { templatePresets } from "@ykdz/template-content";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

import {
  runAddPackage,
  runInit,
  type ApplicationRuntime,
} from "../../src/application.ts";
import { planPreset } from "../support/preset-planning.ts";

function createRuntime(workspace: string): ApplicationRuntime {
  return {
    cwd: workspace,
    env: {},
  };
}

void describe("init toolchain snapshot consumption", () => {
  void it("writes the exact snapshot Node and pnpm to the private root", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-snapshot-init-"),
    );
    try {
      // 本业务需要一个共享库角色的初始包，从唯一内容集合中选取 Preset。
      let snapshotInitPreset: (typeof templatePresets)[number] | undefined;
      for (const member of templatePresets) {
        if (!member.definition.operations.includes("init")) continue;
        const plan = await planPreset(member);
        if (plan.packages.some(({ role }) => role === "shared-library")) {
          snapshotInitPreset = member;
          break;
        }
      }
      if (snapshotInitPreset === undefined)
        throw new Error(
          "Expected a Built-in Preset with a shared-library initial Package",
        );
      const output = await runInit(
        {
          dir: "project",
          preset: snapshotInitPreset.definition.metadata.alias,
          dryRun: false,
          todo: false,
          scope: "acme",
        },
        createRuntime(workspace),
      );

      assert.equal(output.status, "success");
      if (output.status !== "success") throw new Error("Expected init success");
      assert.deepEqual(output.toolchain, {
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      });

      const rootManifest = JSON.parse(
        await readFile(path.join(workspace, "project/package.json"), "utf8"),
      ) as {
        readonly engines: { readonly node: string };
        readonly packageManager: string;
      };
      assert.equal(
        rootManifest.engines.node,
        releaseToolchainSnapshot.nodeVersion,
      );
      assert.equal(
        rootManifest.packageManager,
        releaseToolchainSnapshot.packageManagerPin,
      );

      const generationRecord = JSON.parse(
        await readFile(
          path.join(workspace, "project/.template/generation.json"),
          "utf8",
        ),
      ) as {
        readonly schemaVersion: number;
        readonly composition: {
          readonly conventions: {
            readonly repositoryName: string;
            readonly defaultPackageScope: string;
            readonly todo: boolean;
          };
        };
      };
      assert.equal(generationRecord.schemaVersion, 6);
      assert.deepEqual(generationRecord, output.generationRecord);
      assert.deepEqual(generationRecord.composition.conventions, {
        repositoryName: "project",
        defaultPackageScope: "acme",
        todo: false,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("通过正式规划拒绝占用配置包身份且不创建目标", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-identity-conflict-"),
    );
    try {
      for (const [index, overrides] of [
        { name: "tooling-config" },
        { path: "packages/tooling-config" },
      ].entries()) {
        const targetDir = `project-${index}`;
        const output = await runInit(
          {
            dir: targetDir,
            preset: "ts-lib",
            dryRun: false,
            todo: true,
            scope: "acme",
            ...overrides,
          },
          createRuntime(workspace),
        );

        assert.deepEqual(output, {
          status: "usage-error",
          targetDir,
          issues: [{ code: "CONFLICTING_PACKAGE_IDENTITY" }],
        });
        await assert.rejects(stat(path.join(workspace, targetDir)), {
          code: "ENOENT",
        });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("正式加包规划保留身份冲突并在预览和提交时零写入", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-add-identity-conflict-"),
    );
    try {
      const targetRoot = path.join(workspace, "project");
      const initialized = await runInit(
        {
          dir: "project",
          preset: "ts-lib",
          dryRun: false,
          todo: true,
          scope: "acme",
        },
        createRuntime(workspace),
      );
      assert.equal(initialized.status, "success");

      const blueprintPath = path.join(targetRoot, ".template/blueprint.json");
      const recordPath = path.join(targetRoot, ".template/generation.json");
      const blueprintBefore = await readFile(blueprintPath, "utf8");
      const recordBefore = await readFile(recordPath, "utf8");
      const blueprint = JSON.parse(blueprintBefore) as {
        readonly packages: readonly {
          readonly name: string;
          readonly path: string;
          readonly role: string;
        }[];
      };
      const existing = blueprint.packages.find(
        ({ name }) => name === "@acme/tooling-config",
      );
      if (existing === undefined) {
        throw new Error("初始化蓝图未包含已有配置包");
      }
      const { name, path: existingPath, role } = existing;

      for (const dryRun of [true, false]) {
        const result = await runAddPackage(
          {
            preset: "ts-lib",
            name: "tooling-config",
            path: "packages/rejected",
            linkFrom: [],
            dryRun,
          },
          createRuntime(targetRoot),
        );
        assert.equal(result.status, "conflict");
        if (result.status !== "conflict")
          throw new Error("Expected a package identity conflict");
        assert.equal(result.dryRun, dryRun);
        assert.deepEqual(result.actions, []);
        assert.deepEqual(result.conflicts, [
          {
            kind: "identity",
            existing: { name, path: existingPath, role },
            requested: {
              name: "@acme/tooling-config",
              path: "packages/rejected",
              role: "shared-library",
            },
          },
        ]);
        assert.equal(await readFile(blueprintPath, "utf8"), blueprintBefore);
        assert.equal(await readFile(recordPath, "utf8"), recordBefore);
        await assert.rejects(stat(path.join(targetRoot, "packages/rejected")), {
          code: "ENOENT",
        });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
