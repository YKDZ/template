import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { templatePresets } from "@ykdz/template-content";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

import { planPreset } from "../../support/preset-planning.ts";
import type { CliJourney } from "../journey.ts";

const presets = templatePresets.map((member) => member.definition);
const initializationPresets = templatePresets.filter((member) =>
  member.definition.operations.includes("init"),
);

function requireAddablePreset() {
  const member = templatePresets.find(
    ({ definition }) =>
      definition.operations.includes("init") &&
      definition.operations.includes("add") &&
      Object.keys(definition.nodes).length === 1,
  );
  if (member === undefined) {
    throw new Error("init journey requires an addable Preset");
  }
  return member;
}

function requireFixedTopologyPreset() {
  const preset = presets.find(
    (candidate) => Object.keys(candidate.nodes).length > 1,
  );
  if (preset === undefined) {
    throw new Error("init journey requires a fixed-topology Preset");
  }
  return preset;
}

const addablePreset = requireAddablePreset();
const addablePresetName = addablePreset.definition.metadata.alias;
const addablePackages = (await planPreset(addablePreset)).packages;
const defaultPackage = addablePackages[0];
if (defaultPackage === undefined) {
  throw new Error("可加包预设的正式规划没有生成所选包");
}
const fixedTopologyPresetName = requireFixedTopologyPreset().metadata.alias;

const journey: CliJourney = {
  name: "init",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands() {
    return [
      {
        name: "dry-run JSON",
        args: [
          "init",
          "preview",
          "--preset",
          addablePresetName,
          "--scope",
          "@acme",
          "--name",
          "runner",
          "--path",
          "tools/release",
          "--dry-run",
        ],
      },
      {
        name: "fixed-topology identity override rejection",
        args: [
          "init",
          "fixed-rejected",
          "--preset",
          fixedTopologyPresetName,
          "--name",
          "renamed",
        ],
      },
      {
        name: "non-interactive initialization",
        args: ["init", "automatic", "--preset", addablePresetName],
      },
      {
        name: "invalid durable scope rejection",
        args: [
          "init",
          "invalid-scope",
          "--preset",
          addablePresetName,
          "--scope",
          ".bad",
        ],
      },
      {
        name: "successful JSON without TODO",
        args: [
          "init",
          "project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
          "--no-todo",
        ],
      },
      {
        name: "existing target conflict",
        args: ["init", "project", "--preset", addablePresetName],
      },
      ...initializationPresets.map(({ definition }) => ({
        name: `通过 CLI 进程初始化 ${definition.metadata.alias} 预设`,
        args: [
          "init",
          `matrix-${definition.metadata.alias}`,
          "--preset",
          definition.metadata.alias,
          "--scope",
          "acme",
        ],
      })),
    ];
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0);
    const envelope = JSON.parse(results[0]?.stdout ?? "");
    assert.equal(envelope.command, "init");
    assert.equal(envelope.variant, "planned");
    const preview = envelope.data;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.targetDir, "preview");
    assert.deepEqual(preview.resolved, {
      preset: addablePresetName,
      topology: "configurable-primary-package",
      packages: [{ name: "@acme/runner", path: "tools/release" }],
      scope: "acme",
    });
    assert.deepEqual(preview.followUpDocument, {
      enabled: true,
      path: "TODO.md",
    });
    await assert.rejects(stat(path.join(context.workDir, "preview")), {
      code: "ENOENT",
    });

    assert.equal(results[1]?.exitCode, 2);
    assert.partialDeepStrictEqual(JSON.parse(results[1]?.stderr ?? ""), {
      schemaVersion: "2",
      helpArgv: ["template", "init", "--help"],
      issues: [{ code: "conditionalConstraintViolation" }],
    });
    await assert.rejects(stat(path.join(context.workDir, "fixed-rejected")), {
      code: "ENOENT",
    });

    assert.equal(results[2]?.exitCode, 0);
    assert.equal(JSON.parse(results[2]?.stdout ?? "").variant, "initialized");

    assert.equal(results[3]?.exitCode, 2);
    assert.match(
      results[3]?.stderr ?? "",
      /--scope 必须是不含空白字符的有效 npm scope/u,
    );
    await assert.rejects(stat(path.join(context.workDir, "invalid-scope")), {
      code: "ENOENT",
    });

    assert.equal(results[4]?.exitCode, 0);
    const initialized = JSON.parse(results[4]?.stdout ?? "").data;
    assert.deepEqual(initialized.followUpDocument, { enabled: false });
    assert.deepEqual(initialized.toolchain, {
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    });
    const rootManifest = JSON.parse(
      await readFile(
        path.join(context.workDir, "project/package.json"),
        "utf8",
      ),
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
        path.join(context.workDir, "project/.template/generation.json"),
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
    assert.deepEqual(generationRecord.composition.conventions, {
      repositoryName: "project",
      defaultPackageScope: "acme",
      todo: false,
    });
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(
            context.workDir,
            "project",
            defaultPackage.path,
            "package.json",
          ),
          "utf8",
        ),
      ).name,
      defaultPackage.name,
    );
    await assert.rejects(stat(path.join(context.workDir, "project/TODO.md")), {
      code: "ENOENT",
    });

    assert.equal(results[5]?.exitCode, 1);
    assert.equal(
      JSON.parse(results[5]?.stderr ?? "").variant,
      "operationFailed",
    );

    const matrixResults = results.slice(6);
    assert.equal(matrixResults.length, initializationPresets.length);
    for (const [index, member] of initializationPresets.entries()) {
      const result = matrixResults[index]!;
      assert.equal(result.exitCode, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.variant, "initialized");
      const data = envelope.data;
      const projectName = `matrix-${member.definition.metadata.alias}`;
      const project = path.join(context.workDir, projectName);
      const generationRecord = JSON.parse(
        await readFile(path.join(project, ".template/generation.json"), "utf8"),
      ) as {
        readonly schemaVersion: number;
        readonly composition: {
          readonly conventions: {
            readonly repositoryName: string;
            readonly defaultPackageScope: string;
          };
        };
        readonly selections: readonly {
          readonly presetIdentity: { readonly packageName: string } | null;
        }[];
      };
      assert.deepEqual(data.generationRecord, generationRecord);
      assert.equal(generationRecord.schemaVersion, 6);
      assert.equal(
        generationRecord.composition.conventions.repositoryName,
        projectName,
      );
      assert.equal(
        generationRecord.composition.conventions.defaultPackageScope,
        "acme",
      );
      assert.ok(
        generationRecord.selections.some(
          (selection) =>
            selection.presetIdentity?.packageName ===
            member.identity.packageName,
        ),
      );

      const blueprint = JSON.parse(
        await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
      );
      assert.deepEqual(data.blueprint, blueprint);
      const planned = await planPreset(member);
      const plannedRootManifestEntry = planned.projection.entries.find(
        ({ path: entryPath }) => entryPath === "package.json",
      );
      if (plannedRootManifestEntry === undefined) {
        throw new Error("正式规划没有生成目标根 manifest");
      }
      const plannedRootManifest = JSON.parse(
        new TextDecoder().decode(plannedRootManifestEntry.content),
      ) as {
        readonly devDependencies?: Readonly<Record<string, string>>;
      };
      const rootManifest = JSON.parse(
        await readFile(path.join(project, "package.json"), "utf8"),
      ) as {
        readonly devDependencies?: Readonly<Record<string, string>>;
      };
      assert.equal(
        rootManifest.devDependencies?.["@changesets/cli"],
        plannedRootManifest.devDependencies?.["@changesets/cli"],
      );
      for (const packageEntry of data.resolved.packages as readonly {
        readonly name: string;
        readonly path: string;
      }[]) {
        const manifest = JSON.parse(
          await readFile(
            path.join(project, packageEntry.path, "package.json"),
            "utf8",
          ),
        ) as { readonly name: string; readonly private?: boolean };
        assert.equal(manifest.name, packageEntry.name);
        assert.equal(manifest.private, true);
      }
    }
  },
};

export default journey;
