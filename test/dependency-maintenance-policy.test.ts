import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import { projectDependabotConfig } from "@ykdz/template-core/project-github";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";

type DependabotConfig = {
  version: number;
  updates: DependabotUpdate[];
};

type DependabotUpdate = {
  "package-ecosystem": string;
  directory: string;
  schedule: { interval: string };
  ignore?:
    | {
        "dependency-name": string;
        "update-types": string[];
      }[]
    | undefined;
};

const generatedRepositoryPresetNames = [
  "hono-api",
  "rust-bin",
  "ts-lib",
  "vue-app",
  "vue-hono-app",
];
const dependabotConfigSchema = v.object({
  version: v.number(),
  updates: v.array(
    v.object({
      "package-ecosystem": v.string(),
      directory: v.string(),
      schedule: v.object({ interval: v.string() }),
      ignore: v.optional(
        v.array(
          v.object({
            "dependency-name": v.string(),
            "update-types": v.array(v.string()),
          }),
        ),
      ),
    }),
  ),
});

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

  return v.parse(
    dependabotConfigSchema,
    parseYaml(
      projectDependabotConfig(plan.dependencyMaintenancePolicy),
    ) as unknown,
  );
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

      expect({ hasWorkflow, presetName }).toMatchObject({
        hasWorkflow: true,
      });
      expect(ecosystems(projectedDependabotConfig(presetName))).toContain(
        "github-actions",
      );
      expect({
        directory: updateFor(
          projectedDependabotConfig(presetName),
          "github-actions",
        ).directory,
        presetName,
      }).toMatchObject({ directory: "/" });
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

      expect(ecosystems(dependabot)).toContain("docker");
      expect(ecosystems(dependabot)).not.toContain("devcontainers");
      expect({
        directory: updateFor(dependabot, "docker").directory,
        presetName,
      }).toMatchObject({ directory: "/.devcontainer" });
    }
  });
});
