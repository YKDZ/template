import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import type { ProjectBlueprint } from "@ykdz/template-core/declarations";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";

const packageJsonSchema = v.object({
  engines: v.object({ node: v.string() }),
  packageManager: v.string(),
});
const devcontainerSchema = v.object({
  build: v.object({
    dockerfile: v.string(),
    args: v.object({
      NODE_VERSION: v.string(),
      PACKAGE_MANAGER_PIN: v.string(),
    }),
  }),
});
const generationRecordSchema = v.object({
  toolchain: v.object({
    nodeLtsMajor: v.string(),
    packageManagerPin: v.string(),
    source: v.string(),
  }),
});

async function readJsonWithSchema<const Schema extends v.GenericSchema>(
  filePath: string,
  schema: Schema,
): Promise<v.InferOutput<Schema>> {
  return v.parse(
    schema,
    JSON.parse(await readFile(filePath, "utf8")) as unknown,
  );
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

    const packageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const generationRecord = await readJsonWithSchema(
      path.join(targetDir, ".template/generated-by.json"),
      generationRecordSchema,
    );

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
