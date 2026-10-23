import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@ykdz/reference-workspace-root/template",
      load: () => import("@ykdz/reference-workspace-root/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/preset-ts-lib/template",
      load: () => import("@ykdz/preset-ts-lib/template"),
    },
  ],
});

const root = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-workspace-root",
);
const library = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-ts-lib",
);
const libraryPreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-lib",
);
assert.ok(root);
assert.ok(library);
assert.ok(libraryPreset);

async function withTarget(
  run: (targetRoot: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "native-workspace-"));
  try {
    await run(path.join(directory, "project"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readManifest(
  manifestPath: string,
): Promise<Record<string, any>> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    any
  >;
}

function generator() {
  return createDefaultGenerator({ content });
}

it("直接参考生成原生根并连续添加ts-lib与显式provider连接", async () => {
  await withTarget(async (targetRoot) => {
    const current = generator();
    const initialized = await current.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "root", contentIdentity: root.identity }],
      },
      conventions: {
        repositoryName: "native-demo",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    if (initialized.status !== "success") return;

    const rootManifestPath = path.join(targetRoot, "package.json");
    const rootManifest = await readManifest(rootManifestPath);
    assert.equal(rootManifest.private, true);
    assert.equal(rootManifest.name, "native-demo");
    assert.equal(
      rootManifest.scripts.check,
      "node --conditions=source scripts/task-gates.ts check",
    );
    assert.ok(rootManifest.devDependencies["@demo/tooling-config"]);
    assert.equal(
      (await stat(path.join(targetRoot, "scripts/task-gates.ts"))).mode & 0o777,
      0o644,
    );
    assert.match(
      await readFile(path.join(targetRoot, "tsconfig.config.json"), "utf8"),
      /@demo\/tooling-config\/node\.json/u,
    );

    rootManifest.scripts.check = "node scripts/task-gates.ts check --preserved";
    await writeFile(
      rootManifestPath,
      `${JSON.stringify(rootManifest, null, 2)}\n`,
    );

    const added = await current.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { packagePath: "packages/lib" },
    });
    assert.equal(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") return;

    const updatedRootManifest = await readManifest(rootManifestPath);
    const libraryManifestPath = path.join(
      targetRoot,
      "packages/lib/package.json",
    );
    const libraryManifest = await readManifest(libraryManifestPath);
    assert.equal(
      updatedRootManifest.scripts.check,
      "node scripts/task-gates.ts check --preserved",
    );
    assert.equal(
      updatedRootManifest.scripts["publication:pack"],
      "turbo run build && changeset pack --out-dir .changeset/packed",
    );
    assert.equal(libraryManifest.private, true);
    assert.equal(
      libraryManifest.devDependencies["@demo/tooling-config"],
      "workspace:../tooling-config",
    );
    assert.deepEqual(Object.keys(libraryManifest.exports["."]), [
      "source",
      "types",
      "default",
    ]);
    assert.equal(
      await readFile(
        path.join(targetRoot, ".changeset/config.json"),
        "utf8",
      ).then((value) => value.includes('"access": "public"')),
      true,
    );
    await stat(path.join(targetRoot, ".github/workflows/release.yml"));

    const linked = await current.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        packagePath: "packages/provider",
        leafName: "provider",
        linkFrom: ["packages/lib"],
      },
    });
    assert.equal(linked.status, "success", JSON.stringify(linked));
    const linkedLibrary = await readManifest(libraryManifestPath);
    assert.equal(linkedLibrary.dependencies["@demo/provider"], "workspace:*");
    assert.equal(
      linkedLibrary.dependenciesMeta?.["@demo/provider"],
      undefined,
      "source/types/default公开入口使用workspace符号链接",
    );
  });
});

it("ts-lib预设也明确创建基础root", async () => {
  await withTarget(async (targetRoot) => {
    const current = generator();
    const initialized = await current.init({
      targetRoot,
      selection: {
        presets: [{ contentIdentity: libraryPreset.identity }],
      },
      conventions: {
        repositoryName: "preset-demo",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    if (initialized.status !== "success") return;
    assert.deepEqual(
      initialized.blueprint.packages
        .map(({ path: packagePath }) => packagePath)
        .toSorted(),
      [".", "packages/tooling-config", "packages/lib"].toSorted(),
    );
    assert.equal(
      (await readManifest(path.join(targetRoot, "package.json"))).private,
      true,
    );
    await stat(path.join(targetRoot, "packages/lib/src/index.ts"));
  });
});

it("计划锁定实际根与provider事实、允许无关编辑并拒绝相关变更", async () => {
  await withTarget(async (targetRoot) => {
    const current = generator();
    const initialized = await current.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "root", contentIdentity: root.identity }],
      },
      conventions: {
        repositoryName: "facts-demo",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));

    const unrelatedPlan = await current.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        packagePath: "packages/independent",
        leafName: "independent",
      },
    });
    assert.equal(
      unrelatedPlan.status,
      "planned",
      JSON.stringify(unrelatedPlan),
    );
    if (unrelatedPlan.status !== "planned") return;
    await writeFile(path.join(targetRoot, "unrelated.txt"), "keep me\n");
    const unrelatedCommit = await current.commitPlan(unrelatedPlan.plan);
    assert.equal(
      unrelatedCommit.status,
      "success",
      JSON.stringify(unrelatedCommit),
    );
    assert.equal(
      await readFile(path.join(targetRoot, "unrelated.txt"), "utf8"),
      "keep me\n",
    );

    const providerPlan = await current.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        packagePath: "packages/provider-stale",
        leafName: "provider-stale",
      },
    });
    assert.equal(providerPlan.status, "planned", JSON.stringify(providerPlan));
    if (providerPlan.status !== "planned") return;
    const providerResource = path.join(
      targetRoot,
      "packages/tooling-config/node.json",
    );
    const providerBefore = await readFile(providerResource, "utf8");
    await writeFile(
      providerResource,
      `${providerBefore}\n// changed after plan\n`,
    );
    const providerCommit = await current.commitPlan(providerPlan.plan);
    assert.equal(
      providerCommit.status,
      "conflict",
      JSON.stringify(providerCommit),
    );
    await assert.rejects(
      stat(path.join(targetRoot, "packages/provider-stale/package.json")),
      { code: "ENOENT" },
    );

    const metadataPlan = await current.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        packagePath: "packages/metadata-stale",
        leafName: "metadata-stale",
      },
    });
    assert.equal(metadataPlan.status, "planned", JSON.stringify(metadataPlan));
    if (metadataPlan.status !== "planned") return;
    const recordPath = path.join(targetRoot, ".template/generation.json");
    const recordBefore = await readFile(recordPath);
    await writeFile(
      recordPath,
      Buffer.concat([recordBefore, Buffer.from(" ")]),
    );
    const metadataCommit = await current.commitPlan(metadataPlan.plan);
    assert.equal(
      metadataCommit.status,
      "conflict",
      JSON.stringify(metadataCommit),
    );
    await assert.rejects(
      stat(path.join(targetRoot, "packages/metadata-stale/package.json")),
      { code: "ENOENT" },
    );
  });
});
