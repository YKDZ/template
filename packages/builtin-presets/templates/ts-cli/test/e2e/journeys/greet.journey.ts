import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "greet",
  modes: ["source", "distribution", "packed"],
  async setup(context) {
    await writeFile(
      path.join(context.workDir, "journey-ready.txt"),
      `${context.mode}\n`,
    );
  },
  commands() {
    return [
      {
        name: "valid greeting",
        args: ["greet", "  Ada Lovelace  "],
      },
      {
        name: "invalid greeting",
        args: ["greet", "   "],
      },
    ];
  },
  async assertions({ context, results }) {
    assert.equal(
      await readFile(path.join(context.workDir, "journey-ready.txt"), "utf8"),
      `${context.mode}\n`,
    );
    assert.deepEqual(results[0], {
      commandName: "valid greeting",
      exitCode: 0,
      stdout: "Hello, Ada Lovelace\n",
      stderr: "",
    });
    assert.equal(results[1]?.commandName, "invalid greeting");
    assert.equal(results[1]?.exitCode, 1);
    assert.equal(results[1]?.stdout, "");
    assert.match(results[1]?.stderr ?? "", /error: Name must not be empty/u);
  },
};

export default journey;
