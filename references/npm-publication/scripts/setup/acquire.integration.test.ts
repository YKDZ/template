import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquirePublicationSetup } from "./acquire.ts";

void test("显式重新取得补回缺项并保留维护者编辑", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-setup-acquire-"),
  );
  try {
    const manifest = '{"name":"fixture","version":"7.3.2"}\n';
    await writeFile(path.join(repositoryRoot, "package.json"), manifest);

    const first = await acquirePublicationSetup({ repositoryRoot });
    assert.equal(first.kind, "created");
    await writeFile(
      path.join(first.directory, "setup.ts"),
      "// 维护者自行修改\n",
    );
    await unlink(path.join(first.directory, "README.md"));

    const second = await acquirePublicationSetup({ repositoryRoot });

    assert.equal(second.kind, "restored-missing");
    assert.equal(
      await readFile(path.join(second.directory, "setup.ts"), "utf8"),
      "// 维护者自行修改\n",
    );
    assert.equal(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      manifest,
    );
    assert.equal(
      (await acquirePublicationSetup({ repositoryRoot })).kind,
      "already-present",
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
