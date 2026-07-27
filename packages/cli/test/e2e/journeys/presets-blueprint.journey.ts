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
          schemaVersion: 2,
          packages: [
            {
              name: "@demo/library",
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
    ]);
  },
  commands() {
    return [
      { name: "list presets", args: ["presets"] },
      {
        name: "valid blueprint",
        args: ["blueprint", "validate", "valid-blueprint.json"],
      },
      {
        name: "legacy blueprint",
        args: ["blueprint", "validate", "legacy-blueprint.json"],
      },
    ];
  },
  async assertions({ results }) {
    assert.equal(results[0]?.exitCode, 0);
    assert.match(results[0]?.stdout ?? "", /Built-in presets/u);
    assert.match(results[0]?.stdout ?? "", /\n  ts-cli:/u);
    assert.match(results[0]?.stdout ?? "", /\n  ts-lib:/u);

    assert.deepEqual(results[1], {
      commandName: "valid blueprint",
      exitCode: 0,
      stdout: "Blueprint is valid\n",
      stderr: "",
    });
    assert.equal(results[2]?.exitCode, 1);
    assert.equal(results[2]?.stdout, "");
    assert.match(
      results[2]?.stderr ?? "",
      /Blueprint version 1 is not supported/u,
    );
  },
};

export default journey;
