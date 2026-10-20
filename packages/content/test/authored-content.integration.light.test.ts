import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  contentIdentityKey,
  createContentIndex,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

import {
  createAuthoredContentFixture,
  type AuthoredContentFixture,
} from "../test-support/authored-content-fixture.ts";

const fixtures: AuthoredContentFixture[] = [];
const workspaces: string[] = [];

async function createFixture(
  options: Parameters<typeof createAuthoredContentFixture>[0],
): Promise<AuthoredContentFixture> {
  const fixture = await createAuthoredContentFixture(options);
  fixtures.push(fixture);
  return fixture;
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-content-run-"));
  workspaces.push(workspace);
  return workspace;
}

function identityFor(
  fixture: AuthoredContentFixture,
  packageName: string,
): ContentIdentity {
  const member = fixture.members.find(
    (candidate) => candidate.identity.packageName === packageName,
  );
  assert.ok(member, `fixture omitted ${packageName}`);
  return member.identity;
}

after(async () => {
  await Promise.all([
    ...fixtures.map((fixture) => fixture.close()),
    ...workspaces.map((workspace) =>
      rm(workspace, { recursive: true, force: true }),
    ),
  ]);
});

void describe("外部specifier集合经默认策略走公开生成器", () => {
  void it("从两个同名来源各自init并add，持久实际身份、绑定和资源正文", async () => {
    for (const namespace of ["alpha", "beta"]) {
      const fixture = await createFixture({ namespace, marker: namespace });
      const workspace = await createWorkspace();
      const targetRoot = path.join(workspace, "project");
      const generator = createGenerator({
        content: fixture.members,
        strategy: createDefaultWorkspaceStrategy(),
      });

      const initialized = await generator.init({
        targetRoot,
        selection: {
          roots: [{ preset: { alias: "authored", namespace } }],
        },
        strategyInput: {
          repositoryName: `${namespace}-fixture`,
          defaultPackageScope: namespace,
        },
      });
      assert.equal(initialized.status, "success");
      if (initialized.status !== "success") return;

      const featureIdentity = identityFor(fixture, "@fixture/feature");
      const themeIdentity = identityFor(fixture, "@fixture/typescript-config");
      const featureRecord = initialized.generationRecord.packages.find(
        (record) =>
          contentIdentityKey(record.contentIdentity) ===
          contentIdentityKey(featureIdentity),
      );
      const themeRecord = initialized.generationRecord.packages.find(
        (record) =>
          contentIdentityKey(record.contentIdentity) ===
          contentIdentityKey(themeIdentity),
      );
      assert.ok(featureRecord);
      assert.ok(themeRecord);
      assert.equal(
        featureRecord.bindings[contentIdentityKey(themeIdentity)],
        themeRecord.definition.packageDefinitionId,
      );
      assert.equal(
        await readFile(
          path.join(
            targetRoot,
            featureRecord.definition.path,
            "src/content.ts",
          ),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${namespace}:feature`)};\n`,
      );
      assert.equal(
        await readFile(
          path.join(targetRoot, themeRecord.definition.path, "src/theme.ts"),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${namespace}:theme`)};\n`,
      );

      const beforeWrongKind = await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      );
      const presetIdentity = identityFor(fixture, "@fixture/preset");
      const wrongKind = await generator.add({
        repositoryRoot: targetRoot,
        contentIdentity: presetIdentity,
      });
      assert.equal(wrongKind.status, "operation-failure");
      if (wrongKind.status === "operation-failure") {
        assert.match(wrongKind.error.message, /种类不符/u);
      }
      assert.equal(
        await readFile(
          path.join(targetRoot, ".template/generation.json"),
          "utf8",
        ),
        beforeWrongKind,
      );

      const addition = await generator.add({
        repositoryRoot: targetRoot,
        contentIdentity: { alias: "addon", namespace },
        creationInput: { leafName: "addon-extra" },
      });
      assert.equal(addition.status, "success");
      if (addition.status !== "success") return;
      const addonIdentity = identityFor(fixture, "@fixture/addon");
      const addonRecord = addition.generationRecord.packages.find(
        (record) =>
          contentIdentityKey(record.contentIdentity) ===
          contentIdentityKey(addonIdentity),
      );
      assert.ok(addonRecord);
      assert.equal(addonRecord.createdBy, "addition");
      assert.equal(addonRecord.definition.path, "packages/addon-extra");
      assert.equal(
        await readFile(
          path.join(targetRoot, addonRecord.definition.path, "src/addon.ts"),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${namespace}:addon`)};\n`,
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            path.join(targetRoot, ".template/generation.json"),
            "utf8",
          ),
        ),
        addition.generationRecord,
      );
    }
  });

  void it("拒绝跨来源别名歧义和同身份未选修订，目标保持未创建", async () => {
    const alpha = await createFixture({ namespace: "alpha", marker: "alpha" });
    const beta = await createFixture({ namespace: "beta", marker: "beta" });
    const workspace = await createWorkspace();
    const targetRoot = path.join(workspace, "ambiguous");
    const generator = createGenerator({
      content: [...alpha.members, ...beta.members],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const ambiguous = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: "authored" }] },
      strategyInput: {
        repositoryName: "ambiguous",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(ambiguous.status, "operation-failure");
    if (ambiguous.status === "operation-failure") {
      assert.match(ambiguous.error.message, /歧义/u);
    }
    await assert.rejects(readFile(targetRoot));

    const firstRevision = await createFixture({
      namespace: "revision",
      marker: "first",
    });
    const secondRevision = await createFixture({
      namespace: "revision",
      marker: "second",
    });
    assert.throws(
      () =>
        createContentIndex([
          ...firstRevision.members,
          ...secondRevision.members,
        ]),
      /未明确选择的来源修订/u,
    );
  });

  void it("同一实际模块跨命名空间登记时按明确来源装载依赖与预设节点", async () => {
    const fixture = await createFixture({
      namespace: "shared-source",
      marker: "shared-source",
    });
    const [alphaMembers, betaMembers] = await Promise.all([
      fixture.load("alpha"),
      fixture.load("beta"),
    ]);
    const content = [...alphaMembers, ...betaMembers];
    const index = createContentIndex(content);
    const alphaFeature = index.resolve(
      {
        namespace: "alpha",
        packageName: "@fixture/feature",
        exportPath: "./template",
      },
      "reference",
    );
    const betaFeature = index.resolve(
      {
        namespace: "beta",
        packageName: "@fixture/feature",
        exportPath: "./template",
      },
      "reference",
    );
    const betaTheme = index.resolve(
      {
        namespace: "beta",
        packageName: "@fixture/typescript-config",
        exportPath: "./template",
      },
      "reference",
    );
    const betaPreset = index.resolve(
      { alias: "authored", namespace: "beta" },
      "preset",
    );
    assert.equal(alphaFeature.source.moduleURL, betaFeature.source.moduleURL);
    assert.strictEqual(alphaFeature.definition, betaFeature.definition);

    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const directTarget = path.join(
      await createWorkspace(),
      "explicit-reference",
    );
    const direct = await generator.init({
      targetRoot: directTarget,
      selection: {
        roots: [
          { nodeIdentity: "main", contentIdentity: betaFeature.identity },
        ],
      },
      strategyInput: {
        repositoryName: "explicit-reference",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(direct.status, "success");
    if (direct.status !== "success") return;
    const directFeature = direct.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(betaFeature.identity),
    );
    const directTheme = direct.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(betaTheme.identity),
    );
    assert.ok(directFeature);
    assert.ok(directTheme);
    assert.equal(
      directFeature.bindings[contentIdentityKey(betaTheme.identity)],
      directTheme.definition.packageDefinitionId,
    );
    assert.equal(
      direct.generationRecord.packages.some(
        (record) =>
          contentIdentityKey(record.contentIdentity) ===
          contentIdentityKey(alphaFeature.identity),
      ),
      false,
    );

    const presetTarget = path.join(await createWorkspace(), "explicit-preset");
    const initialized = await generator.init({
      targetRoot: presetTarget,
      selection: { roots: [{ preset: betaPreset.identity }] },
      strategyInput: {
        repositoryName: "explicit-preset",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(initialized.status, "success");
    if (initialized.status !== "success") return;
    const presetFeature = initialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(betaFeature.identity),
    );
    const presetTheme = initialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(betaTheme.identity),
    );
    assert.ok(presetFeature);
    assert.ok(presetTheme);
    assert.equal(
      initialized.generationRecord.nodeInstances.feature,
      presetFeature.definition.packageDefinitionId,
    );
    assert.equal(
      presetFeature.bindings[contentIdentityKey(betaTheme.identity)],
      presetTheme.definition.packageDefinitionId,
    );
    assert.equal(
      await readFile(
        path.join(
          presetTarget,
          presetFeature.definition.path,
          "src/content.ts",
        ),
        "utf8",
      ),
      'export const fixtureOrigin = "shared-source:feature";\n',
    );
  });

  void it("不自动登记必要依赖，缺失时在规划阶段零写入", async () => {
    const fixture = await createFixture({
      namespace: "incomplete",
      marker: "incomplete",
      includeTheme: false,
    });
    const workspace = await createWorkspace();
    const targetRoot = path.join(workspace, "missing-dependency");
    const generator = createGenerator({
      content: fixture.members,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [{ preset: { alias: "authored", namespace: "incomplete" } }],
      },
      strategyInput: {
        repositoryName: "missing-dependency",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(result.status, "operation-failure");
    if (result.status === "operation-failure") {
      assert.equal(result.phase, "planning");
      assert.match(result.error.message, /incomplete:@fixture\/feature/u);
      assert.match(result.error.message, /未登记/u);
    }
    await assert.rejects(readFile(targetRoot));
  });

  void it("别名和私有资源路径变化不改变三分量规范身份", async () => {
    const original = await createFixture({
      namespace: "stable",
      marker: "one",
    });
    const moved = await createFixture({
      namespace: "stable",
      marker: "two",
      featureAlias: "renamed-feature",
      featureResourcePath: "lib/renamed-content.ts",
    });
    const originalFeature = identityFor(original, "@fixture/feature");
    const movedFeature = identityFor(moved, "@fixture/feature");
    assert.deepEqual(movedFeature, originalFeature);
    assert.notEqual(
      original.members.find(
        (member) => member.identity.packageName === "@fixture/feature",
      )?.source.moduleURL,
      moved.members.find(
        (member) => member.identity.packageName === "@fixture/feature",
      )?.source.moduleURL,
    );
  });
});
