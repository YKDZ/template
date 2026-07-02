import { parse as parseYaml } from "yaml";

import { projectDependabotConfig } from "../src/project-github.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

type DependabotConfig = {
  version: number;
  updates: DependabotUpdate[];
};

type DependabotUpdate = {
  "package-ecosystem": string;
  directory: string;
  schedule: { interval: string };
  ignore?: {
    "dependency-name": string;
    "update-types": string[];
  }[];
};

const generatedRepositoryPresetNames = [
  "hono-api",
  "rust-bin",
  "ts-lib",
  "vue-app",
  "vue-hono-app",
];

function projectedDependabotConfig(
  presetName: string,
  projectName = "generated-repository",
): DependabotConfig {
  const projection = findBuiltInPresetProjection(presetName);
  const plan = projection?.project({
    projectName: { kind: "ProjectName", value: projectName },
    preset: presetName,
    packageManager: { kind: "PackageManager", value: "pnpm" },
    blueprint: projection.blueprint({ targetDir: projectName }),
    toolchain: {
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.0.0" },
      source: "bundled-fallback",
      diagnostics: [],
    },
  });
  if (!plan) {
    throw new Error(`${presetName} did not project .github/dependabot.yml`);
  }

  return parseYaml(
    projectDependabotConfig(plan.dependencyMaintenancePolicy),
  ) as DependabotConfig;
}

function ecosystems(config: DependabotConfig): string[] {
  return config.updates.map((update) => update["package-ecosystem"]);
}

function updateFor(
  config: DependabotConfig,
  ecosystem: string,
): DependabotUpdate {
  const update = config.updates.find(
    (candidate) => candidate["package-ecosystem"] === ecosystem,
  );

  if (!update) {
    throw new Error(`Missing ${ecosystem} Dependabot update`);
  }

  return update;
}

describe("Generated Repository dependency maintenance policy", () => {
  it("maintains GitHub Actions for every generated repository that has real workflows", () => {
    for (const presetName of generatedRepositoryPresetNames) {
      const projection = findBuiltInPresetProjection(presetName);
      const plan = projection?.project({
        projectName: { kind: "ProjectName", value: "generated-repository" },
        preset: presetName,
        packageManager: { kind: "PackageManager", value: "pnpm" },
        blueprint: projection.blueprint({ targetDir: "generated-repository" }),
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@10.0.0",
          },
          source: "bundled-fallback",
          diagnostics: [],
        },
      });
      const hasWorkflow = plan?.operations.some(
        (operation) =>
          (operation.kind === "writeText" ||
            operation.kind === "copyFile" ||
            operation.kind === "writeTextTemplate") &&
          operation.to.startsWith(".github/workflows/"),
      );

      expect(hasWorkflow, presetName).toBe(true);
      expect(
        ecosystems(projectedDependabotConfig(presetName)),
        presetName,
      ).toContain("github-actions");
      expect(
        updateFor(projectedDependabotConfig(presetName), "github-actions")
          .directory,
        presetName,
      ).toBe("/");
    }
  });

  it("maintains Node repositories through npm, GitHub Actions, and Docker without letting Dependabot move the Node baseline", () => {
    const dependabot = projectedDependabotConfig("ts-lib");

    expect(ecosystems(dependabot)).toEqual(["npm", "github-actions", "docker"]);
    expect(ecosystems(dependabot)).not.toContain("devcontainers");
    expect(updateFor(dependabot, "docker").directory).toBe("/.devcontainer");
    expect(updateFor(dependabot, "npm").ignore).toContainEqual({
      "dependency-name": "@types/node",
      "update-types": ["version-update:semver-major"],
    });
    expect(updateFor(dependabot, "docker").ignore).toContainEqual({
      "dependency-name": "mcr.microsoft.com/devcontainers/typescript-node",
      "update-types": ["version-update:semver-major"],
    });
  });

  it("maintains Rust repositories through npm, Cargo, GitHub Actions, Docker, and rust-toolchain", () => {
    const dependabot = projectedDependabotConfig("rust-bin");

    expect(ecosystems(dependabot)).toEqual([
      "npm",
      "cargo",
      "github-actions",
      "docker",
      "rust-toolchain",
    ]);
    expect(ecosystems(dependabot)).not.toContain("devcontainers");
    expect(updateFor(dependabot, "docker").directory).toBe("/.devcontainer");
    expect(updateFor(dependabot, "rust-toolchain").directory).toBe("/");
    expect(updateFor(dependabot, "docker").ignore).toContainEqual({
      "dependency-name": "mcr.microsoft.com/devcontainers/typescript-node",
      "update-types": ["version-update:semver-major"],
    });
  });

  it("maintains the Rust package manifest through Cargo Dependabot in its generated package boundary", () => {
    const dependabot = projectedDependabotConfig("rust-bin", "My Demo App");

    expect(updateFor(dependabot, "cargo").directory).toBe(
      "/packages/my-demo-app",
    );
  });

  it("uses Dockerfile-first Dependabot policy for every supported generated repository", () => {
    for (const presetName of generatedRepositoryPresetNames) {
      const dependabot = projectedDependabotConfig(presetName);

      expect(ecosystems(dependabot), presetName).toContain("docker");
      expect(ecosystems(dependabot), presetName).not.toContain("devcontainers");
      expect(updateFor(dependabot, "docker").directory, presetName).toBe(
        "/.devcontainer",
      );
    }
  });
});
