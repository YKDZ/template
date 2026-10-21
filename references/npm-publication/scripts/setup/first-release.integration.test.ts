import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./first-release.ts", import.meta.url));

void test("直接运行 setup 会显示首次使用引导", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-setup-entry-"),
  );
  try {
    const result = spawnSync(
      process.execPath,
      ["--conditions=source", "--experimental-strip-types", entry],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PUBLICATION_TOOL_NAME:
            process.env.PUBLICATION_TOOL_NAME ??
            "@ykdz/reference-npm-publication",
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /一次性向导已就绪/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
