import { parse as parseYaml } from "yaml";

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

function projectedDependabotConfig(presetName: string): DependabotConfig {
  const projection = findBuiltInPresetProjection(presetName);
  const plan = projection?.project({
    projectName: { kind: "ProjectName", value: "generated-repository" },
    preset: presetName,
    packageManager: { kind: "PackageManager", value: "pnpm" },
    blueprint: projection.blueprint({ targetDir: "generated-repository" }),
    toolchain: {
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.0.0" },
      source: "bundled-fallback",
      diagnostics: [],
    },
  });
  const operation = plan?.operations.find(
    (candidate) =>
      candidate.kind === "writeText" &&
      candidate.to === ".github/dependabot.yml",
  );

  if (!operation || operation.kind !== "writeText") {
    throw new Error(`${presetName} did not project .github/dependabot.yml`);
  }

  return parseYaml(operation.text) as DependabotConfig;
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
  it("maintains Node repositories through npm, GitHub Actions, and Docker without letting Dependabot move the Node baseline", () => {
    const dependabot = projectedDependabotConfig("ts-lib");

    expect(ecosystems(dependabot)).toEqual([
      "npm",
      "github-actions",
      "docker",
    ]);
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

  it("uses Dockerfile-first Dependabot policy for every supported generated repository", () => {
    const presetNames = [
      "hono-api",
      "rust-bin",
      "ts-lib",
      "vue-app",
      "vue-hono-app",
    ];

    for (const presetName of presetNames) {
      const dependabot = projectedDependabotConfig(presetName);

      expect(ecosystems(dependabot), presetName).toContain("docker");
      expect(ecosystems(dependabot), presetName).not.toContain(
        "devcontainers",
      );
      expect(updateFor(dependabot, "docker").directory, presetName).toBe(
        "/.devcontainer",
      );
    }
  });
});
