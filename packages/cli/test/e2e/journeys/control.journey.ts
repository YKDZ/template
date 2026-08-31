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
      { name: "unknown command", args: ["unknown"] },
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
    assert.match(results[1]?.stdout ?? "", /用法: template/u);
    assert.match(results[1]?.stdout ?? "", /template add package/u);

    assert.equal(results[2]?.exitCode, 0);
    assert.match(results[2]?.stdout ?? "", /用法: template init/u);
    assert.match(results[2]?.stdout ?? "", /--no-todo/u);
    assert.equal(results[3]?.exitCode, 0);
    assert.match(results[3]?.stdout ?? "", /用法: template add package/u);
    assert.match(results[3]?.stdout ?? "", /--link-from <path>/u);

    assert.equal(results[4]?.exitCode, 64);
    assert.equal(results[4]?.stdout, "");
    assert.match(
      results[4]?.stderr ?? "",
      new RegExp(`^template ${manifest.version}\\n`, "u"),
    );
    assert.match(results[4]?.stderr ?? "", /USAGE_UNKNOWN_COMMAND/u);
    assert.match(results[4]?.stderr ?? "", /未知命令/u);
    assert.match(results[4]?.stderr ?? "", /用法: template/u);
  },
};

export default journey;
