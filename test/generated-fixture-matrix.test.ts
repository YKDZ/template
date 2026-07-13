import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { describe, expect, it } from "vitest";

import { assertGeneratedTaskDiscovery } from "../packages/checks/src/check-generated-registry.ts";

describe("registry-derived Package Addition Fixture Matrix", () => {
  const plan = planGeneratedRepositoryInitialization({
    definition: builtInPresetRegistry.require("ts-lib"),
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "fixture-dry-run"),
      scope: "fixture",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    }),
  });

  it("fails the matrix when Turbo dry-run omits a generated task despite a successful command", async () => {
    await expect(
      assertGeneratedTaskDiscovery({
        plan,
        projectDir: "/tmp/generated-fixture-matrix",
        taskNames: ["lint", "typecheck"],
        run: async () => ({ stdout: JSON.stringify({ tasks: [] }) }),
      }),
    ).rejects.toThrow("Turbo dry-run omitted generated task(s)");
  });

  it("fails the matrix when a successful command does not produce Turbo dry-run JSON", async () => {
    await expect(
      assertGeneratedTaskDiscovery({
        plan,
        projectDir: "/tmp/generated-fixture-matrix",
        taskNames: ["lint", "typecheck"],
        run: async () => ({ stdout: "completed successfully" }),
      }),
    ).rejects.toThrow("Turbo dry-run did not return a task graph");
  });
});
