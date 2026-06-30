import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGenerationContext } from "../src/generation-context.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("Preset Registry", () => {
  it("projects a ts-lib Generated Repository through the Preset Projection contract", async () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    expect(projection?.metadata).toMatchObject({
      name: "ts-lib",
      title: "TypeScript library",
      generation: "supported",
    });

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-registry-"),
    );
    const targetDir = path.join(workspace, "demo-lib");
    const blueprint = projection!.blueprint({ targetDir });
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

    const plan = projection!.project(context);
    await projection!.render({ targetDir, plan });

    expect(
      plan.checkPlan.components.map((component) => component.kind),
    ).toEqual(["typescript-typecheck", "oxc-lint", "oxc-format-check"]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-write",
      "oxc-lint-fix",
    ]);
    expect(plan.packageScripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );

    const packageJson = await readJson<{
      engines: { node: string };
      packageManager: string;
      scripts: Record<string, string>;
    }>(path.join(targetDir, "package.json"));
    const generationRecord = await readJson<{
      command: string;
      toolchain: { nodeLtsMajor: string; packageManagerPin: string };
    }>(path.join(targetDir, ".project-kit/generated-by.json"));

    expect(packageJson.scripts).toEqual(plan.packageScripts);
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(generationRecord).toMatchObject({
      command: "template init --preset ts-lib",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.2.3" },
    });
  });
});
