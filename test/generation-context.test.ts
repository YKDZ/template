import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProjectBlueprint } from "../src/declarations.js";
import { assembleGenerationContext } from "../src/generation-context.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("generation context", () => {
  it("carries resolved Node and pnpm values as named toolchain values for the ts-lib tracer preset", () => {
    const blueprint: ProjectBlueprint = {
      schemaVersion: 1,
      preset: "ts-lib",
      packageManager: "pnpm",
      projectKind: "single-package",
      features: ["pnpm-catalog"],
    };

    const context = assembleGenerationContext({
      targetDir: "/tmp/demo-lib",
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    expect(context.projectName).toEqual({
      kind: "ProjectName",
      value: "demo-lib",
    });
    expect(context.preset).toBe("ts-lib");
    expect(context.packageManager).toEqual({
      kind: "PackageManager",
      value: "pnpm",
    });
    expect(context.toolchain.nodeLtsMajor).toEqual({
      kind: "NodeLtsMajor",
      value: "24",
    });
    expect(context.toolchain.packageManagerPin).toEqual({
      kind: "PackageManagerPin",
      value: "pnpm@11.2.3",
    });
    expect(context.toolchain.source).toBe("online");
  });

  it("projects the generation context toolchain into ts-lib package metadata and generation record", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generation-context-"),
    );
    const targetDir = path.join(workspace, "demo-lib");
    const blueprint: ProjectBlueprint = {
      schemaVersion: 1,
      preset: "ts-lib",
      packageManager: "pnpm",
      projectKind: "single-package",
      features: ["pnpm-catalog"],
    };
    const context = assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const projection = findBuiltInPresetProjection("ts-lib");
    const plan = projection?.project(context);
    expect(projection).toBeDefined();
    expect(plan).toBeDefined();
    await projection!.render({ targetDir, plan: plan! });

    const packageJson = await readJson<{
      engines: { node: string };
      packageManager: string;
    }>(path.join(targetDir, "package.json"));
    const devcontainer = await readJson<{
      build: {
        dockerfile: string;
        args: {
          NODE_VERSION: string;
          PACKAGE_MANAGER_PIN: string;
        };
      };
    }>(path.join(targetDir, ".devcontainer/devcontainer.json"));
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const generationRecord = await readJson<{
      toolchain: {
        nodeLtsMajor: string;
        packageManagerPin: string;
        source: string;
      };
    }>(path.join(targetDir, ".template/generated-by.json"));

    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
      },
    });
    expect(dockerfile).toContain("ARG NODE_VERSION");
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain(
      "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
    );
    expect(generationRecord.toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.2.3",
      source: "online",
    });
  });
});
