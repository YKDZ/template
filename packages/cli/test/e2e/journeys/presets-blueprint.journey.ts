import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "presets-blueprint",
  modes: ["source", "distribution", "packed"],
  async setup(context) {
    await Promise.all([
      writeFile(
        path.join(context.workDir, "valid-blueprint.json"),
        JSON.stringify({
          schemaVersion: 3,
          packages: [
            {
              name: "@demo/library",
              packageDefinitionId: `package-${"1".repeat(64)}`,
              path: "packages/library",
              role: "shared-library",
            },
          ],
        }),
      ),
      writeFile(
        path.join(context.workDir, "legacy-blueprint.json"),
        JSON.stringify({ schemaVersion: 1, packages: [] }),
      ),
      writeFile(path.join(context.workDir, "malformed-blueprint.json"), "{"),
    ]);
  },
  commands() {
    return [
      { name: "list presets", args: ["presets"] },
      { name: "list presets JSON", args: ["presets", "--json"] },
      {
        name: "valid blueprint",
        args: ["blueprint", "validate", "valid-blueprint.json"],
      },
      {
        name: "valid blueprint JSON",
        args: ["blueprint", "validate", "valid-blueprint.json", "--json"],
      },
      {
        name: "legacy blueprint",
        args: ["blueprint", "validate", "legacy-blueprint.json"],
      },
      {
        name: "legacy blueprint JSON",
        args: ["blueprint", "validate", "legacy-blueprint.json", "--json"],
      },
      {
        name: "missing blueprint JSON",
        args: ["blueprint", "validate", "missing-blueprint.json", "--json"],
      },
      {
        name: "malformed blueprint",
        args: ["blueprint", "validate", "malformed-blueprint.json"],
      },
    ];
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0);
    assert.match(results[0]?.stdout ?? "", /^template .+\n内置预设/mu);
    assert.match(results[0]?.stdout ?? "", /\n  ts-cli:/u);
    assert.match(results[0]?.stdout ?? "", /\n  ts-lib:/u);
    assert.equal(results[0]?.stderr, "");

    const catalog = JSON.parse(results[1]?.stdout ?? "") as {
      readonly schemaVersion: number;
      readonly command: string;
      readonly status: string;
      readonly presets: readonly { readonly name: string }[];
      readonly cliVersion: string;
    };
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.command, "presets");
    assert.equal(catalog.status, "success");
    const presetNames = catalog.presets.map((preset) => preset.name);
    assert.ok(presetNames.length > 0);
    assert.ok(presetNames.every((name) => name.length > 0));
    assert.equal(new Set(presetNames).size, presetNames.length);
    for (const name of presetNames) {
      assert.ok((results[0]?.stdout ?? "").includes(`\n  ${name}:`));
    }
    assert.equal(catalog.cliVersion, "0.0.36");
    assert.equal(results[1]?.stderr, "");

    assert.equal(results[2]?.exitCode, 0);
    assert.match(results[2]?.stdout ?? "", /^template .+\n蓝图有效。/mu);
    assert.equal(results[2]?.stderr, "");
    assert.deepEqual(JSON.parse(results[3]?.stdout ?? ""), {
      schemaVersion: 1,
      command: "blueprint validate",
      status: "success",
      path: path.join(context.workDir, "valid-blueprint.json"),
      cliVersion: "0.0.36",
    });
    assert.equal(results[3]?.stderr, "");

    assert.equal(results[4]?.exitCode, 1);
    assert.equal(results[4]?.stdout, "");
    assert.match(results[4]?.stderr ?? "", /蓝图无效/u);
    assert.match(results[4]?.stderr ?? "", /建议:/u);
    const invalid = JSON.parse(results[5]?.stdout ?? "") as {
      readonly status: string;
      readonly code: string;
      readonly issues: readonly { readonly path: string }[];
    };
    assert.equal(results[5]?.exitCode, 1);
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.code, "BLUEPRINT_INVALID");
    assert.deepEqual(
      invalid.issues.map((issue) => issue.path),
      [".schemaVersion"],
    );
    assert.equal(results[5]?.stderr, "");

    const missing = JSON.parse(results[6]?.stdout ?? "") as {
      readonly status: string;
      readonly code: string;
      readonly path: string;
    };
    assert.equal(results[6]?.exitCode, 65);
    assert.equal(missing.status, "operation-failure");
    assert.equal(missing.code, "OPERATION_BLUEPRINT_READ_FAILED");
    assert.equal(
      missing.path,
      path.join(context.workDir, "missing-blueprint.json"),
    );
    assert.equal(results[6]?.stderr, "");
    assert.equal(results[7]?.exitCode, 65);
    assert.equal(results[7]?.stdout, "");
    assert.match(results[7]?.stderr ?? "", /OPERATION_BLUEPRINT_PARSE_FAILED/u);
    assert.match(results[7]?.stderr ?? "", /建议:/u);
  },
};

export default journey;
