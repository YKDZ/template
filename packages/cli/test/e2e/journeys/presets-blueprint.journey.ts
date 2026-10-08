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
      {
        name: "list presets text",
        args: ["presets", "--output-format", "text"],
      },
      { name: "list presets", args: ["presets"] },
      {
        name: "valid blueprint text",
        args: [
          "blueprint",
          "validate",
          "valid-blueprint.json",
          "--output-format",
          "text",
        ],
      },
      {
        name: "valid blueprint",
        args: ["blueprint", "validate", "valid-blueprint.json"],
      },
      {
        name: "invalid blueprint text",
        args: [
          "blueprint",
          "validate",
          "legacy-blueprint.json",
          "--output-format",
          "text",
        ],
      },
      {
        name: "invalid blueprint",
        args: ["blueprint", "validate", "legacy-blueprint.json"],
      },
      {
        name: "missing blueprint",
        args: ["blueprint", "validate", "missing-blueprint.json"],
      },
      {
        name: "malformed blueprint text",
        args: [
          "blueprint",
          "validate",
          "malformed-blueprint.json",
          "--output-format",
          "text",
        ],
      },
    ];
  },
  async assertions({ context, results }) {
    for (const result of results.slice(0, 4)) {
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
    }
    for (const result of results.slice(4)) {
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
    }
    assert.match(results[0]?.stdout ?? "", /内置预设/u);
    const catalog = JSON.parse(results[1]?.stdout ?? "");
    assert.equal(catalog.schemaVersion, "1");
    assert.equal(catalog.kind, "data");
    assert.equal(catalog.variant, "listed");
    const names: string[] = catalog.data.presets.map(
      (preset: { name: string }) => preset.name,
    );
    assert.ok(names.length > 0);
    assert.equal(new Set(names).size, names.length);
    for (const name of names)
      assert.ok(results[0]?.stdout.includes(`${name}:`));
    assert.match(results[2]?.stdout ?? "", /蓝图有效/u);
    assert.deepEqual(JSON.parse(results[3]?.stdout ?? ""), {
      schemaVersion: "1",
      command: "validateBlueprint",
      kind: "data",
      variant: "valid",
      data: { path: path.join(context.workDir, "valid-blueprint.json") },
    });
    assert.match(results[4]?.stderr ?? "", /蓝图无效/u);
    const invalid = JSON.parse(results[5]?.stderr ?? "");
    assert.equal(invalid.kind, "failure");
    assert.equal(invalid.variant, "invalid");
    assert.deepEqual(
      invalid.data.issues.map((issue: { path: string }) => issue.path),
      [".schemaVersion"],
    );
    const missing = JSON.parse(results[6]?.stderr ?? "");
    assert.equal(missing.variant, "operationFailed");
    assert.equal(missing.data.reason, "not-found");
    assert.equal(
      missing.data.path,
      path.join(context.workDir, "missing-blueprint.json"),
    );
    assert.match(results[7]?.stderr ?? "", /JSON 格式无效/u);
    assert.match(results[7]?.stderr ?? "", /建议/u);
  },
};

export default journey;
