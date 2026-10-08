import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "control",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands() {
    return [
      { name: "version", args: ["--version"] },
      { name: "top help", args: ["--help"] },
      { name: "init help", args: ["init", "--help"] },
      { name: "add help", args: ["add", "package", "--help"] },
      { name: "unknown command", args: ["unknown", "--output-format", "text"] },
      { name: "schema", args: ["schema"] },
    ];
  },
  async assertions({ context, results }) {
    const manifest = JSON.parse(
      await readFile(path.join(context.packageRoot, "package.json"), "utf8"),
    ) as { readonly version: string };
    assert.equal(results[0]?.exitCode, 0);
    assert.equal(results[0]?.stdout, `template ${manifest.version}\n`);
    assert.equal(results[0]?.stderr, "");

    assert.equal(results[1]?.exitCode, 0);
    assert.match(results[1]?.stdout ?? "", /template/u);
    assert.match(results[1]?.stdout ?? "", /add/u);

    assert.equal(results[2]?.exitCode, 0);
    assert.match(results[2]?.stdout ?? "", /template init/u);
    assert.match(results[2]?.stdout ?? "", /--no-todo/u);
    assert.equal(results[3]?.exitCode, 0);
    assert.match(results[3]?.stdout ?? "", /template add package/u);
    assert.match(results[3]?.stdout ?? "", /--link-from/u);

    assert.equal(results[4]?.exitCode, 2);
    assert.equal(results[4]?.stdout, "");
    assert.equal(JSON.parse(results[4]?.stderr ?? "").kind, "usageFailure");
    assert.equal(results[5]?.exitCode, 0);
    const schema = JSON.parse(results[5]?.stdout ?? "");
    assert.equal(schema.command, "schema");
    assert.equal(schema.kind, "data");
    assert.equal(schema.data.manifest.root, "template");
    for (const command of [
      "init",
      "addPackage",
      "presets",
      "validateBlueprint",
      "schema",
    ])
      assert.ok(JSON.stringify(schema.data.manifest).includes(command));
  },
};

export default journey;
