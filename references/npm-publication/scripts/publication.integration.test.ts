import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  acceptArtifact,
  inspectTarget,
  prepareArtifact,
  readPreparedArtifact,
} from "./publication.ts";

async function makePackage(root: string): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@example/lifecycle-package",
        version: "1.2.3-beta.1+build.2",
        type: "module",
        exports: "./index.mjs",
        files: ["index.mjs", "lifecycle.mjs", "consume.mjs"],
        scripts: {
          prepack: "node lifecycle.mjs prepack",
          postinstall: "node lifecycle.mjs postinstall",
          "publication:consume": "node consume.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "index.mjs"),
    'export const value = "installed archive";\n',
  );
  await writeFile(
    path.join(root, "lifecycle.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      "const log = process.env.NPM_PUBLICATION_EVENT_LOG;",
      "if (log) await appendFile(log, `${process.argv[2]}\\n`);",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "consume.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { createRequire } from "node:module";',
      'import path from "node:path";',
      'import { appendFile } from "node:fs/promises";',
      "const consumer = process.env.NPM_PUBLICATION_CONSUMER_ROOT;",
      "assert.ok(consumer);",
      'const require = createRequire(path.join(consumer, "package.json"));',
      'assert.equal(require("@example/lifecycle-package").value, "installed archive");',
      'await appendFile(process.env.NPM_PUBLICATION_EVENT_LOG, "consume\\n");',
    ].join("\n"),
  );
}

void describe("shared npm artifact preparation", () => {
  void it("packs and normally installs an ordinary package before its own consumer command", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-contract-"),
    );
    const packageRoot = path.join(workspace, "package");
    const outputDirectory = path.join(workspace, "artifacts");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(packageRoot, { recursive: true });
    await makePackage(packageRoot);
    const env = { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog };

    try {
      const originalManifest = await readFile(
        path.join(packageRoot, "package.json"),
        "utf8",
      );
      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory,
        env,
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") throw new Error("共享制品准备被阻断");
      assert.equal(prepared.packageVersion, "1.2.3-beta.1+build.2");
      assert.equal(prepared.artifactVersion, "1.2.3-beta.1");

      await writeFile(
        path.join(packageRoot, "package.json"),
        originalManifest.replace("1.2.3-beta.1+build.2", "2.0.0"),
      );
      await assert.rejects(
        acceptArtifact({
          packageRoot,
          artifactPath: prepared.artifactPath,
          env,
        }),
        /制品 @example\/lifecycle-package/u,
      );
      await writeFile(path.join(packageRoot, "package.json"), originalManifest);

      const accepted = await acceptArtifact({
        packageRoot,
        artifactPath: prepared.artifactPath,
        env,
      });
      assert.equal(accepted.kind, "accepted");
      if (accepted.kind !== "accepted") throw new Error("共享制品验收被阻断");
      assert.equal(accepted.sha512, prepared.sha512);
      assert.equal(accepted.artifactVersion, prepared.artifactVersion);
      const receipt = JSON.parse(
        await readFile(
          path.join(outputDirectory, "publication-preparation.json"),
          "utf8",
        ),
      ) as { readonly acceptance?: unknown };
      assert.deepEqual(receipt.acceptance, {
        packageName: prepared.packageName,
        artifactVersion: prepared.artifactVersion,
        sha512: prepared.sha512,
        installation: "passed",
        consumption: "passed",
      });
      const reread = await readPreparedArtifact({
        packageRoot,
        artifactDirectory: outputDirectory,
      });
      assert.equal(reread.kind, "prepared");
      if (reread.kind !== "prepared") {
        throw new Error("共享制品回执读取被阻断");
      }
      assert.equal(reread.artifactPath, prepared.artifactPath);
      assert.equal(reread.packageVersion, "1.2.3-beta.1+build.2");
      assert.equal(reread.artifactVersion, "1.2.3-beta.1");
      assert.equal(reread.sha512, prepared.sha512);
      assert.equal(reread.receipt.acceptance?.consumption, "passed");
      await writeFile(prepared.artifactPath, "modified original bytes");
      await assert.rejects(
        readPreparedArtifact({
          packageRoot,
          artifactPath: prepared.artifactPath,
        }),
        /原件已变化/u,
      );
      assert.deepEqual((await readFile(eventLog, "utf8")).trim().split("\n"), [
        "prepack",
        "postinstall",
        "consume",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("reports target-owned configuration gaps and propagates consumer failure", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-failure-"),
    );
    const packageRoot = path.join(workspace, "package");
    const outputDirectory = path.join(workspace, "artifacts");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@example/missing-consumer","version":"1.0.0"}\n',
    );
    const missing = await inspectTarget({ packageRoot });
    assert.equal(missing.kind, "blocked");
    assert.ok(
      missing.blockers.some(
        (item) =>
          item.field === "package.json#/scripts/publication:consume" &&
          item.target === packageRoot &&
          item.nextAction.includes("publication:consume"),
      ),
    );

    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@example/invalid-version","version":"banana","scripts":{"publication:consume":"node consume.mjs"}}\n',
    );
    const invalidVersion = await inspectTarget({ packageRoot });
    assert.equal(invalidVersion.kind, "blocked");
    assert.ok(
      invalidVersion.blockers.some(
        (item) =>
          item.field === "package.json#/version" &&
          item.code === "publication-package-version-invalid" &&
          item.target === packageRoot &&
          item.nextAction.includes("SemVer"),
      ),
    );

    await makePackage(packageRoot);
    const manifestPath = path.join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["publication:consume"] = 'node -e "process.exit(37)"';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const prepared = await prepareArtifact({
      packageRoot,
      outputDirectory,
      env: { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog },
    });
    assert.equal(prepared.kind, "prepared");
    const originalDigest = prepared.sha512;

    try {
      await assert.rejects(
        acceptArtifact({ packageRoot, artifactPath: prepared.artifactPath }),
        /退出状态 37/u,
      );
      assert.equal(
        await import("node:crypto").then(({ createHash }) =>
          readFile(prepared.artifactPath).then((bytes) =>
            createHash("sha512").update(bytes).digest("hex"),
          ),
        ),
        originalDigest,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
