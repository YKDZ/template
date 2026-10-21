import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  acceptArtifact,
  inspectTarget,
  prepareArtifact,
  readAcceptedArtifact,
  readPreparedArtifact,
} from "./publication.ts";

async function makePackage(root: string): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@example/lifecycle-package",
        version: "1.2.3-beta.1+build.2",
        code: "consumer-metadata",
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

async function makeBatchPackage(
  root: string,
  options: {
    readonly name: string;
    readonly value: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly consumerExpectations?: Readonly<Record<string, string>>;
  },
): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: options.name,
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
        files: ["index.mjs", "lifecycle.mjs", "consume.mjs"],
        scripts: {
          prepack: "node lifecycle.mjs prepack",
          postinstall: "node lifecycle.mjs postinstall",
          "publication:consume": "node consume.mjs",
        },
        ...(options.dependencies === undefined
          ? {}
          : { dependencies: options.dependencies }),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "index.mjs"),
    `export const value = ${JSON.stringify(options.value)};\n`,
  );
  await writeFile(
    path.join(root, "lifecycle.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      "const log = process.env.NPM_PUBLICATION_EVENT_LOG;",
      `if (log) await appendFile(log, ${JSON.stringify(`${options.value}:`)} + process.argv[2] + "\\n");`,
    ].join("\n"),
  );
  const expected = {
    [options.name]: options.value,
    ...options.consumerExpectations,
  };
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
      `for (const [name, value] of Object.entries(${JSON.stringify(expected)})) {`,
      "  assert.equal(require(name).value, value);",
      "}",
      `await appendFile(process.env.NPM_PUBLICATION_EVENT_LOG, ${JSON.stringify(`${options.value}:consume\n`)});`,
    ].join("\n"),
  );
}

async function sha512(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha512")
    .update(await readFile(filePath))
    .digest("hex");
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
      await assert.rejects(
        readAcceptedArtifact({
          packageRoot,
          artifactDirectory: outputDirectory,
        }),
        /消费验收尚未通过/u,
      );

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
      const acceptedArtifact = await readAcceptedArtifact({
        packageRoot,
        artifactDirectory: outputDirectory,
      });
      assert.equal(acceptedArtifact.kind, "prepared");
      if (acceptedArtifact.kind !== "prepared") {
        throw new Error("已验收共享制品回执读取被阻断");
      }
      assert.equal(acceptedArtifact.sha512, prepared.sha512);
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

    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"JSONStream","version":"1.3.5","scripts":{"publication:consume":"node consume.mjs"}}\n',
    );
    const legacyName = await inspectTarget({ packageRoot });
    assert.equal(legacyName.kind, "ready");

    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"%%%","version":"1.3.5","scripts":{"publication:consume":"node consume.mjs"}}\n',
    );
    const invalidName = await inspectTarget({ packageRoot });
    assert.equal(invalidName.kind, "blocked");
    assert.ok(
      invalidName.blockers.some(
        (item) =>
          item.field === "package.json#/name" &&
          item.code === "publication-package-name-invalid",
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

  void it("一次正常安装并验收有依赖关系的整批 tgz", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-batch-"),
    );
    const baseRoot = path.join(workspace, "base");
    const dependentRoot = path.join(workspace, "dependent");
    const baseOutput = path.join(workspace, "artifacts", "base");
    const dependentOutput = path.join(workspace, "artifacts", "dependent");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(baseRoot, { recursive: true });
    await mkdir(dependentRoot, { recursive: true });
    await makeBatchPackage(baseRoot, {
      name: "@example/batch-base",
      value: "base",
    });
    await makeBatchPackage(dependentRoot, {
      name: "@example/batch-dependent",
      value: "dependent",
      dependencies: { "@example/batch-base": "1.0.0" },
      consumerExpectations: { "@example/batch-base": "base" },
    });
    const env = { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog };

    try {
      const base = await prepareArtifact({
        packageRoot: baseRoot,
        outputDirectory: baseOutput,
        env,
      });
      const dependent = await prepareArtifact({
        packageRoot: dependentRoot,
        outputDirectory: dependentOutput,
        env,
      });
      assert.equal(base.kind, "prepared");
      assert.equal(dependent.kind, "prepared");
      if (base.kind !== "prepared" || dependent.kind !== "prepared") {
        throw new Error("依赖批次制品准备失败");
      }

      const accepted = await acceptArtifact({
        packageRoot: baseRoot,
        artifactPath: base.artifactPath,
        additionalArtifacts: [
          { packageRoot: dependentRoot, artifactPath: dependent.artifactPath },
        ],
        env,
      });
      assert.equal(accepted.kind, "accepted");
      if (accepted.kind !== "accepted") {
        throw new Error("依赖批次制品消费验收失败");
      }
      assert.equal(accepted.installation.command, "npm");
      assert.ok(accepted.installation.arguments.includes(base.artifactPath));
      assert.ok(
        accepted.installation.arguments.includes(dependent.artifactPath),
      );
      assert.deepEqual(
        accepted.artifacts.map((artifact) => artifact.packageName),
        ["@example/batch-base", "@example/batch-dependent"],
      );
      assert.deepEqual(
        accepted.artifacts.map((artifact) => artifact.sha512),
        [base.sha512, dependent.sha512],
      );
      assert.deepEqual(
        await Promise.all([
          sha512(base.artifactPath),
          sha512(dependent.artifactPath),
        ]),
        [base.sha512, dependent.sha512],
      );
      for (const [packageRoot, artifactDirectory] of [
        [baseRoot, baseOutput],
        [dependentRoot, dependentOutput],
      ] as const) {
        const reread = await readAcceptedArtifact({
          packageRoot,
          artifactDirectory,
        });
        assert.equal(reread.kind, "prepared");
        if (reread.kind !== "prepared") {
          throw new Error("整批回执无法作为已验收原件读取");
        }
        assert.equal(reread.receipt.acceptance?.consumption, "passed");
      }
      const events = (await readFile(eventLog, "utf8")).trim().split("\n");
      assert.deepEqual(
        events.toSorted(),
        [
          "base:prepack",
          "dependent:prepack",
          "base:postinstall",
          "dependent:postinstall",
          "base:consume",
          "dependent:consume",
        ].toSorted(),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("任一目标消费失败时不写入整批回执", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-batch-failure-"),
    );
    const baseRoot = path.join(workspace, "base");
    const dependentRoot = path.join(workspace, "dependent");
    const baseOutput = path.join(workspace, "artifacts", "base");
    const dependentOutput = path.join(workspace, "artifacts", "dependent");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(baseRoot, { recursive: true });
    await mkdir(dependentRoot, { recursive: true });
    await makeBatchPackage(baseRoot, {
      name: "@example/failure-base",
      value: "base",
    });
    await makeBatchPackage(dependentRoot, {
      name: "@example/failure-dependent",
      value: "dependent",
      dependencies: { "@example/failure-base": "1.0.0" },
      consumerExpectations: { "@example/failure-base": "base" },
    });

    try {
      const base = await prepareArtifact({
        packageRoot: baseRoot,
        outputDirectory: baseOutput,
      });
      const dependent = await prepareArtifact({
        packageRoot: dependentRoot,
        outputDirectory: dependentOutput,
      });
      assert.equal(base.kind, "prepared");
      assert.equal(dependent.kind, "prepared");
      if (base.kind !== "prepared" || dependent.kind !== "prepared") {
        throw new Error("依赖批次制品准备失败");
      }
      const manifestPath = path.join(dependentRoot, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts["publication:consume"] = 'node -e "process.exit(37)"';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        acceptArtifact({
          packageRoot: baseRoot,
          artifactPath: base.artifactPath,
          additionalArtifacts: [
            {
              packageRoot: dependentRoot,
              artifactPath: dependent.artifactPath,
            },
          ],
          env: { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog },
        }),
        /退出状态 37/u,
      );
      assert.deepEqual(
        await Promise.all([
          sha512(base.artifactPath),
          sha512(dependent.artifactPath),
        ]),
        [base.sha512, dependent.sha512],
      );
      for (const output of [baseOutput, dependentOutput]) {
        const receipt = JSON.parse(
          await readFile(
            path.join(output, "publication-preparation.json"),
            "utf8",
          ),
        ) as { readonly acceptance?: unknown };
        assert.equal(receipt.acceptance, undefined);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("未发布且未选依赖安装失败时提示显式补选", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-batch-unselected-"),
    );
    const packageRoot = path.join(workspace, "package");
    const outputDirectory = path.join(workspace, "artifacts");
    await mkdir(packageRoot, { recursive: true });
    await makeBatchPackage(packageRoot, {
      name: "@example/unselected-consumer",
      value: "consumer",
      dependencies: { "@example/not-selected": "1.0.0" },
    });

    try {
      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory,
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") {
        throw new Error("未选依赖制品准备失败");
      }

      await assert.rejects(
        acceptArtifact({
          packageRoot,
          artifactPath: prepared.artifactPath,
          env: { npm_config_offline: "true" },
        }),
        /未纳入本批.*显式补选该目标/u,
      );
      assert.equal(await sha512(prepared.artifactPath), prepared.sha512);
      const receipt = JSON.parse(
        await readFile(
          path.join(outputDirectory, "publication-preparation.json"),
          "utf8",
        ),
      ) as { readonly acceptance?: unknown };
      assert.equal(receipt.acceptance, undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
