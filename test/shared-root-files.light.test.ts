import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { templateContent, templatePresets } from "@ykdz/template-content";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import type { SharedRootContribution } from "@ykdz/template-workspace/shared-root-files";
import { parse as parseYaml } from "yaml";

void it("正式生成合成多个来源的根脚本并复用等价声明", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shared-root-files-"));
  try {
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy({
        project: () => [
          {
            kind: "shared-root-files",
            source: "文档拥有者",
            manifest: { scripts: { "docs:check": "node --version" } },
          },
          {
            kind: "shared-root-files",
            source: "检查拥有者",
            manifest: {
              scripts: {
                "docs:check": "node --version",
                "assets:check": "pnpm --version",
              },
            },
          },
        ],
      }),
    });
    const result = await generator.init({
      targetRoot: path.join(root, "project"),
      selection: {
        roots: [
          {
            preset: templatePresets.find((preset) => preset.alias === "ts-lib")!
              .identity,
          },
        ],
      },
      strategyInput: { repositoryName: "shared-root" },
    });
    assert.equal(result.status, "success", JSON.stringify(result));
    const manifest = JSON.parse(
      await readFile(path.join(root, "project/package.json"), "utf8"),
    );
    assert.equal(manifest.scripts["docs:check"], "node --version");
    assert.equal(manifest.scripts["assets:check"], "pnpm --version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("来源矛盾指出字段与双方来源，并在初始化写入前失败", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shared-root-conflict-"));
  try {
    const targetRoot = path.join(root, "project");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy({
        project: () => [
          {
            kind: "shared-root-files",
            source: "文档拥有者",
            manifest: { scripts: { "docs:check": "node --version" } },
          },
          {
            kind: "shared-root-files",
            source: "检查拥有者",
            manifest: { scripts: { "docs:check": "pnpm --version" } },
          },
        ],
      }),
    });
    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            preset: templatePresets.find((preset) => preset.alias === "ts-lib")!
              .identity,
          },
        ],
      },
      strategyInput: { repositoryName: "shared-root" },
    });
    assert.equal(result.status, "operation-failure");
    assert.match(
      JSON.stringify(result),
      /package.json#\/scripts\/docs:check.*文档拥有者.*检查拥有者/u,
    );
    await assert.rejects(readFile(path.join(targetRoot, "package.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function files(root: string): Promise<Record<string, string>> {
  const names = await readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      names
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [
            path.relative(root, file),
            (await readFile(file)).toString("base64"),
          ];
        }),
    ),
  );
}

for (const scenario of ["定制保留", "来源冲突", "消费者冲突"] as const) {
  void it(`fresh add 的共享根协调：${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shared-root-add-"));
    try {
      const preset = templatePresets.find(
        (preset) => preset.alias === "ts-lib",
      )!;
      const targetRoot = path.join(root, "project");
      const generator = createGenerator({
        content: templateContent,
        strategy: createDefaultWorkspaceStrategy({
          project: ({ contributions }) => {
            const added = contributions.some(
              (contribution) =>
                contribution.definition.path === "packages/extra",
            );
            return [
              {
                kind: "shared-root-files",
                source: "文档拥有者",
                manifest: {
                  scripts: {
                    "docs:check": "node --version",
                    ...(added ? { "docs:extra": "node --version" } : {}),
                  },
                },
              },
              {
                kind: "shared-root-files",
                source: "检查拥有者",
                manifest: {
                  scripts: {
                    "docs:check":
                      scenario === "来源冲突" && added
                        ? "pnpm --version"
                        : "node --version",
                  },
                },
              },
            ];
          },
        }),
      });
      const initialized = await generator.init({
        targetRoot,
        selection: { roots: [{ preset: preset.identity }] },
        strategyInput: { repositoryName: "shared-root" },
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));
      const manifestPath = path.join(targetRoot, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.description = "消费者的仓库说明";
      manifest.scripts["consumer:check"] = "node -p process.version";
      if (scenario === "消费者冲突")
        manifest.scripts["docs:extra"] = "pnpm --version";
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      const before = await files(targetRoot);
      const added = await generator.add({
        repositoryRoot: targetRoot,
        preset: preset.identity,
        creationInput: { leafName: "extra", packagePath: "packages/extra" },
      });
      if (scenario === "定制保留") {
        assert.equal(added.status, "success", JSON.stringify(added));
        const after = JSON.parse(await readFile(manifestPath, "utf8"));
        assert.equal(after.description, "消费者的仓库说明");
        assert.equal(
          after.scripts["consumer:check"],
          "node -p process.version",
        );
        assert.equal(after.scripts["docs:extra"], "node --version");
      } else {
        assert.equal(
          added.status,
          scenario === "来源冲突" ? "operation-failure" : "conflict",
          JSON.stringify(added),
        );
        if (scenario === "来源冲突")
          assert.match(
            JSON.stringify(added),
            /package.json#\/scripts\/docs:check.*文档拥有者.*检查拥有者/u,
          );
        else assert.match(JSON.stringify(added), /package.json/u);
        assert.deepEqual(await files(targetRoot), before);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void it("有序根内容保留重复片段和 CI 步骤顺序，独占资源由拥有者交付", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shared-root-order-"));
  try {
    await writeFile(path.join(root, "ignore-first"), "blocked\n!blocked\n");
    await writeFile(path.join(root, "ignore-last"), "blocked\n");
    const source = createTemplateSourceHandle(root);
    const declarations: SharedRootContribution[] = [
      {
        kind: "shared-root-files",
        source: "文档拥有者",
        manifest: { scripts: { "docs:check": "node --version" } },
        turboTasks: { "//#docs:check": { tags: ["quality:light"] } },
        typescript: { include: ["docs.config.ts"] },
        resources: [
          {
            operation: {
              kind: "writeText",
              to: "docs.config.ts",
              text: "export {};\n",
            },
          },
        ],
        gitignoreFragments: [{ source, from: "ignore-first" }],
        ciSteps: [
          { steps: [{ id: "docs-check", run: "pnpm run docs:check" }] },
        ],
      },
      {
        kind: "shared-root-files",
        source: "检查拥有者",
        gitignoreFragments: [{ source, from: "ignore-last" }],
        ciSteps: [{ steps: [{ id: "assets-check", run: "node --version" }] }],
      },
    ];
    const targetRoot = path.join(root, "project");
    const content = templateContent.map((member) =>
      member.kind === "preset" && member.alias === "ts-lib"
        ? {
            ...member,
            definition: {
              ...member.definition,
              owner: {
                packageName: member.identity.packageName,
                exportPath: member.identity.exportPath,
              },
              project: () => declarations,
            },
          }
        : member,
    );
    const result = await createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    }).init({
      targetRoot,
      selection: {
        roots: [
          {
            preset: templatePresets.find((preset) => preset.alias === "ts-lib")!
              .identity,
          },
        ],
      },
      strategyInput: { repositoryName: "shared-root" },
    });
    assert.equal(result.status, "success", JSON.stringify(result));
    const ignore = await readFile(path.join(targetRoot, ".gitignore"), "utf8");
    assert.match(ignore, /blocked\n!blocked\n\nblocked\n$/u);
    const workflow = parseYaml(
      await readFile(
        path.join(targetRoot, ".github/workflows/check.yml"),
        "utf8",
      ),
    );
    assert.deepEqual(
      workflow.jobs.check.steps
        .slice(-2)
        .map((step: { readonly id: string }) => step.id),
      ["docs-check", "assets-check"],
    );
    const turbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    );
    assert.deepEqual(turbo.tasks["//#docs:check"], { tags: ["quality:light"] });
    const tsconfig = JSON.parse(
      await readFile(path.join(targetRoot, "tsconfig.config.json"), "utf8"),
    );
    assert.ok(tsconfig.include.includes("docs.config.ts"));
    assert.equal(
      await readFile(path.join(targetRoot, "docs.config.ts"), "utf8"),
      "export {};\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const domain of ["CI步骤", "独占资源", "真实包范围"] as const) {
  void it(`${domain} 的矛盾来源不能通过等价复用绕过独占合同`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shared-root-exclusive-"));
    try {
      const declaration = (
        source: string,
        packagePath: string,
      ): SharedRootContribution => ({
        kind: "shared-root-files",
        source,
        ...(domain === "CI步骤"
          ? {
              ciSteps: [
                { steps: [{ id: "same-step", run: "node --version" }] },
              ],
            }
          : {
              resources: [
                {
                  operation: {
                    kind: "writeText",
                    to:
                      domain === "真实包范围"
                        ? `${packagePath}/owned.txt`
                        : "docs.config.ts",
                    text: "export {};\n",
                  },
                },
              ],
            }),
      });
      const targetRoot = path.join(root, "project");
      const result = await createGenerator({
        content: templateContent,
        strategy: createDefaultWorkspaceStrategy({
          project: ({ contributions }) => [
            declaration("文档拥有者", contributions[0]!.definition.path),
            declaration("检查拥有者", contributions[0]!.definition.path),
          ],
        }),
      }).init({
        targetRoot,
        selection: {
          roots: [
            {
              preset: templatePresets.find(
                (preset) => preset.alias === "ts-lib",
              )!.identity,
            },
          ],
        },
        strategyInput: { repositoryName: "shared-root" },
      });
      assert.equal(result.status, "operation-failure", JSON.stringify(result));
      if (domain === "真实包范围")
        assert.match(JSON.stringify(result), /真实包/u);
      else assert.match(JSON.stringify(result), /文档拥有者.*检查拥有者/u);
      await assert.rejects(readFile(path.join(targetRoot, "package.json")), {
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
