import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";

import {
  prepareGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryPackageAddition,
} from "../foundation.ts";

void it("新增 Vue 应用时原子创建共同包，后续独立实例复用共同包并保留定制", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "template-reference-composition-"),
  );
  const targetRoot = path.join(directory, "project");
  try {
    const initialization = prepareGeneratedRepositoryInitialization({
      preset: "ts-lib",
      targetDir: targetRoot,
      overrides: { scope: "acme" },
    });
    assert.equal(initialization.status, "ready");
    if (initialization.status !== "ready") return;
    await renderNewProject({
      targetRoot,
      operations: [...initialization.plan.operations],
    });
    for (const name of ["portal", "console"]) {
      const addition = prepareGeneratedRepositoryPackageAddition({
        repositoryRoot: targetRoot,
        preset: "vue-app",
        packageLeafName: name,
      });
      assert.equal(addition.status, "ready", JSON.stringify(addition));
      if (addition.status !== "ready") return;
      const applied = await reconcileAndApplyProjectProjections({
        targetRoot,
        ...addition.plan.projectProjections,
      });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      const manifest = JSON.parse(
        await readFile(
          path.join(targetRoot, `apps/${name}/package.json`),
          "utf8",
        ),
      ) as { dependencies: Record<string, string> };
      assert.equal(manifest.dependencies["@acme/vue-shared"], "workspace:*");
      const sharedPath = path.join(
        targetRoot,
        "packages/vue-shared/user-note.txt",
      );
      if (name === "portal") await writeFile(sharedPath, "用户定制\n");
      else assert.equal(await readFile(sharedPath, "utf8"), "用户定制\n");
    }
    const repeat = prepareGeneratedRepositoryPackageAddition({
      repositoryRoot: targetRoot,
      preset: "vue-app",
      packageLeafName: "console",
    });
    assert.equal(repeat.status, "ready");
    if (repeat.status !== "ready") return;
    const applied = await reconcileAndApplyProjectProjections({
      targetRoot,
      ...repeat.plan.projectProjections,
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    if (applied.ok) assert.deepEqual(applied.changedPaths, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory)).sort()) {
      const file = path.join(directory, entry);
      const info = await stat(file);
      hash.update(`${path.relative(root, file)}:${info.mode}:`);
      if (info.isDirectory()) await visit(file);
      else hash.update(await readFile(file));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

for (const scenario of [
  "共同路径已占用",
  "共同实例不唯一",
  "依赖身份缺失",
  "共同接口缺失",
  "共同接口禁用",
  "共同接口类型无效",
] as const) {
  void it(`${scenario}时整个多包新增零写入`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "template-reference-conflict-"),
    );
    const targetRoot = path.join(directory, "project");
    try {
      const initialization = prepareGeneratedRepositoryInitialization({
        preset: scenario === "共同路径已占用" ? "ts-lib" : "vue-app",
        targetDir: targetRoot,
        overrides: { scope: "acme" },
      });
      assert.equal(initialization.status, "ready");
      if (initialization.status !== "ready") return;
      await renderNewProject({
        targetRoot,
        operations: [...initialization.plan.operations],
      });
      if (scenario === "共同路径已占用") {
        await mkdir(path.join(targetRoot, "packages/vue-shared"));
        await writeFile(
          path.join(targetRoot, "packages/vue-shared/user.txt"),
          "已有内容\n",
        );
      } else if (
        scenario === "共同接口缺失" ||
        scenario === "共同接口禁用" ||
        scenario === "共同接口类型无效"
      ) {
        const manifestPath = path.join(
          targetRoot,
          "packages/vue-shared/package.json",
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          exports: Record<string, unknown>;
        };
        if (scenario === "共同接口缺失")
          delete manifest.exports["./CounterButton.vue"];
        else
          manifest.exports["./CounterButton.vue"] =
            scenario === "共同接口禁用" ? null : false;
        await writeFile(manifestPath, JSON.stringify(manifest));
      } else {
        const generationPath = path.join(
          targetRoot,
          ".template/generation.json",
        );
        const generation = JSON.parse(
          await readFile(generationPath, "utf8"),
        ) as {
          packages: {
            packageDefinitionId: string;
            path: string;
            referenceSource?: string;
            dependencyBindings?: Record<string, string>;
          }[];
        };
        if (scenario === "依赖身份缺失") {
          const app = generation.packages.find(
            (item) => item.referenceSource === "@ykdz/reference-vue-app",
          )!;
          delete app.dependencyBindings!["@ykdz/reference-vue-shared"];
        } else {
          const blueprintPath = path.join(
            targetRoot,
            ".template/blueprint.json",
          );
          const blueprint = JSON.parse(
            await readFile(blueprintPath, "utf8"),
          ) as {
            packages: {
              packageDefinitionId: string;
              path: string;
              name: string;
              role: string;
            }[];
          };
          const shared = blueprint.packages.find(
            (item) => item.path === "packages/vue-shared",
          )!;
          const duplicate = {
            ...shared,
            packageDefinitionId: `package-${"a".repeat(64)}`,
            name: "@acme/other",
            path: "packages/other",
          };
          blueprint.packages.push(duplicate);
          const source = generation.packages.find(
            (item) => item.packageDefinitionId === shared.packageDefinitionId,
          )!;
          generation.packages.push({
            ...source,
            packageDefinitionId: duplicate.packageDefinitionId,
            path: duplicate.path,
          });
          await cp(
            path.join(targetRoot, shared.path),
            path.join(targetRoot, duplicate.path),
            { recursive: true },
          );
          const manifestPath = path.join(
            targetRoot,
            duplicate.path,
            "package.json",
          );
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as Record<string, unknown>;
          manifest.name = duplicate.name;
          await writeFile(manifestPath, JSON.stringify(manifest));
          await writeFile(blueprintPath, JSON.stringify(blueprint));
        }
        await writeFile(generationPath, JSON.stringify(generation));
      }
      const before = await fingerprint(targetRoot);
      const addition = prepareGeneratedRepositoryPackageAddition({
        repositoryRoot: targetRoot,
        preset: "vue-app",
        packageLeafName: "portal",
      });
      if (scenario === "共同路径已占用") {
        assert.equal(addition.status, "ready");
        if (addition.status !== "ready") return;
        const result = await reconcileAndApplyProjectProjections({
          targetRoot,
          ...addition.plan.projectProjections,
        });
        assert.equal(result.ok, false);
      } else {
        assert.equal(addition.status, "operation-failure");
        if (addition.status !== "operation-failure") return;
        assert.ok(addition.diagnostic?.message);
      }
      assert.equal(await fingerprint(targetRoot), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

void it("同名同路径的共同包不能冒充另一个模板的重复新增", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "template-reference-source-"),
  );
  const targetRoot = path.join(directory, "project");
  try {
    const initialization = prepareGeneratedRepositoryInitialization({
      preset: "vue-app",
      targetDir: targetRoot,
    });
    assert.equal(initialization.status, "ready");
    if (initialization.status !== "ready") return;
    await renderNewProject({
      targetRoot,
      operations: [...initialization.plan.operations],
    });
    const before = await fingerprint(targetRoot);
    const addition = prepareGeneratedRepositoryPackageAddition({
      repositoryRoot: targetRoot,
      preset: "ts-lib",
      packageLeafName: "vue-shared",
    });
    assert.equal(addition.status, "conflict");
    assert.equal(await fingerprint(targetRoot), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void it("持久来源与所属预设矛盾时拒绝后续新增且零写入", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "template-reference-owner-"),
  );
  const targetRoot = path.join(directory, "project");
  try {
    const initialization = prepareGeneratedRepositoryInitialization({
      preset: "ts-lib",
      targetDir: targetRoot,
    });
    assert.equal(initialization.status, "ready");
    if (initialization.status !== "ready") return;
    await renderNewProject({
      targetRoot,
      operations: [...initialization.plan.operations],
    });
    const generationPath = path.join(targetRoot, ".template/generation.json");
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: {
        definitionName: string;
        contributionIdentity: string;
        referenceSource?: string;
      }[];
    };
    const library = generation.packages.find(
      (item) =>
        item.definitionName === "ts-lib" &&
        item.contributionIdentity === "library",
    )!;
    library.referenceSource = "@ykdz/reference-hono-api";
    await writeFile(generationPath, JSON.stringify(generation));
    const before = await fingerprint(targetRoot);
    const addition = prepareGeneratedRepositoryPackageAddition({
      repositoryRoot: targetRoot,
      preset: "ts-lib",
      packageLeafName: "another",
    });
    assert.equal(addition.status, "operation-failure");
    if (addition.status !== "operation-failure") return;
    assert.match(addition.diagnostic?.message ?? "", /来源.*所属预设/u);
    assert.equal(await fingerprint(targetRoot), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
