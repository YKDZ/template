import assert from "node:assert/strict";
import {
  chmod,
  readFile,
  rm,
  mkdtemp,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
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
      const presetIdentity = identityFor(fixture, "@fixture/preset");
      assert.equal(initialized.generationRecord.schemaVersion, 3);
      assert.deepEqual(initialized.generationRecord.presetSelections, [
        presetIdentity,
      ]);

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
      assert.equal(Object.hasOwn(featureRecord, "definition"), false);
      assert.equal(featureRecord.creationInput, null);
      assert.equal(
        initialized.blueprint.packages.find(
          (definition) =>
            definition.packageDefinitionId ===
            featureRecord.packageDefinitionId,
        )?.path,
        "packages/feature",
      );
      assert.equal(
        featureRecord.bindings[contentIdentityKey(themeIdentity)],
        themeRecord.packageDefinitionId,
      );
      const featureDefinition = initialized.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === featureRecord.packageDefinitionId,
      );
      assert.ok(featureDefinition);
      const firstPackageNote = path.join(
        targetRoot,
        featureDefinition.path,
        "owner-note.txt",
      );
      await writeFile(firstPackageNote, "首包原始事实\n");
      await chmod(firstPackageNote, 0o600);
      assert.equal(
        await readFile(
          path.join(targetRoot, featureDefinition.path, "src/content.ts"),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${namespace}:feature`)};\n`,
      );
      assert.equal(
        await readFile(
          path.join(
            targetRoot,
            initialized.blueprint.packages.find(
              (definition) =>
                definition.packageDefinitionId ===
                themeRecord.packageDefinitionId,
            )!.path,
            "src/theme.ts",
          ),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${namespace}:theme`)};\n`,
      );

      const beforeWrongKind = await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      );
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

      const replayGenerator = createGenerator({
        content: fixture.members,
        strategy: createDefaultWorkspaceStrategy(),
      });

      const movedRoot = path.join(workspace, "moved-project");
      await rename(targetRoot, movedRoot);
      const movedPackageNote = path.join(
        movedRoot,
        featureDefinition.path,
        "owner-note.txt",
      );
      await writeFile(movedPackageNote, "首包更新事实\n");
      const firstPackageManifestPath = path.join(
        movedRoot,
        featureDefinition.path,
        "package.json",
      );
      const changedFirstPackageManifest = JSON.parse(
        await readFile(firstPackageManifestPath, "utf8"),
      ) as Record<string, unknown>;
      changedFirstPackageManifest.name = `@renamed-${namespace}/feature`;
      await writeFile(
        firstPackageManifestPath,
        `${JSON.stringify(changedFirstPackageManifest, null, 2)}\n`,
      );

      const addition = await replayGenerator.add({
        repositoryRoot: movedRoot,
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
      assert.equal(addonRecord.creationInput?.leafName, "addon-extra");
      const addonDefinition = addition.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === addonRecord.packageDefinitionId,
      );
      assert.ok(addonDefinition);
      assert.equal(addonDefinition.path, "packages/addon-extra");
      assert.equal(addonDefinition.name, `@${namespace}/addon-extra`);
      const strategyState = addition.generationRecord.strategyState as {
        repositoryName: string;
        defaultPackageScope: string;
      };
      assert.equal(strategyState.repositoryName, `${namespace}-fixture`);
      assert.equal(strategyState.defaultPackageScope, namespace);
      assert.equal(addonDefinition.name, `@${namespace}/addon-extra`);
      assert.equal(await readFile(movedPackageNote, "utf8"), "首包更新事实\n");
      assert.deepEqual(
        JSON.parse(await readFile(firstPackageManifestPath, "utf8")),
        changedFirstPackageManifest,
      );
      assert.equal((await stat(movedPackageNote)).mode & 0o777, 0o600);
      assert.equal(
        await readFile(
          path.join(movedRoot, addonDefinition.path, "src/addon.ts"),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${namespace}:addon`)};\n`,
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            path.join(movedRoot, ".template/generation.json"),
            "utf8",
          ),
        ),
        addition.generationRecord,
      );

      const followupGenerator = createGenerator({
        content: fixture.members,
        strategy: createDefaultWorkspaceStrategy(),
      });
      const followup = await followupGenerator.add({
        repositoryRoot: movedRoot,
        contentIdentity: { alias: "addon", namespace },
        creationInput: { leafName: "addon-next" },
      });
      assert.equal(followup.status, "success", JSON.stringify(followup));
      if (followup.status !== "success") return;
      const followupRecord = followup.generationRecord.packages.find(
        (record) =>
          contentIdentityKey(record.contentIdentity) ===
            contentIdentityKey(addonIdentity) &&
          record.creationInput?.leafName === "addon-next",
      );
      assert.ok(followupRecord);
      const followupDefinition = followup.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === followupRecord.packageDefinitionId,
      );
      assert.ok(followupDefinition);
      assert.equal(followupDefinition.path, "packages/addon-next");
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
      directTheme.packageDefinitionId,
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
      presetFeature.packageDefinitionId,
    );
    assert.equal(
      presetFeature.bindings[contentIdentityKey(betaTheme.identity)],
      presetTheme.packageDefinitionId,
    );
    const presetFeatureDefinition = initialized.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === presetFeature.packageDefinitionId,
    );
    assert.ok(presetFeatureDefinition);
    assert.equal(
      await readFile(
        path.join(presetTarget, presetFeatureDefinition.path, "src/content.ts"),
        "utf8",
      ),
      'export const fixtureOrigin = "shared-source:feature";\n',
    );
  });

  void it("同一生成器按明确来源选择不同正文与各自共享绑定", async () => {
    const alpha = await createFixture({
      namespace: "source-alpha",
      marker: "A",
    });
    const beta = await createFixture({ namespace: "source-beta", marker: "B" });
    const content = [...alpha.members, ...beta.members];
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });

    for (const fixture of [alpha, beta]) {
      const targetRoot = path.join(
        await createWorkspace(),
        fixture.members[0]!.identity.namespace,
      );
      const preset = fixture.members.find((member) => member.kind === "preset");
      assert.ok(preset);
      const initialized = await generator.init({
        targetRoot,
        selection: { roots: [{ preset: preset.identity }] },
        strategyInput: {
          repositoryName: fixture.members[0]!.identity.namespace,
          defaultPackageScope: fixture.members[0]!.identity.namespace,
        },
      });
      assert.equal(initialized.status, "success");
      if (initialized.status !== "success") continue;

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
      const featureDefinition = initialized.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === featureRecord.packageDefinitionId,
      );
      const themeDefinition = initialized.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === themeRecord.packageDefinitionId,
      );
      assert.ok(featureDefinition);
      assert.ok(themeDefinition);
      assert.equal(
        featureRecord.bindings[contentIdentityKey(themeIdentity)],
        themeRecord.packageDefinitionId,
      );
      const marker = fixture.members[0]!.identity.namespace.endsWith("alpha")
        ? "A"
        : "B";
      assert.equal(
        await readFile(
          path.join(targetRoot, featureDefinition.path, "src/content.ts"),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${marker}:feature`)};\n`,
      );
      assert.equal(
        await readFile(
          path.join(targetRoot, themeDefinition.path, "src/theme.ts"),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(`${marker}:theme`)};\n`,
      );
      assert.equal(
        initialized.generationRecord.packages.some(
          (record) =>
            record.contentIdentity.namespace !== featureIdentity.namespace &&
            record.contentIdentity.packageName === featureIdentity.packageName,
        ),
        false,
      );
    }
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

  void it("别名和资源路径变化保持身份并实际生成新路径正文", async () => {
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
    const targetRoot = path.join(await createWorkspace(), "moved-resource");
    const generator = createGenerator({
      content: moved.members,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const generated = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "feature", contentIdentity: movedFeature }],
      },
      strategyInput: {
        repositoryName: "moved-resource",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(generated.status, "success");
    if (generated.status !== "success") return;
    const featureRecord = generated.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(movedFeature),
    );
    assert.ok(featureRecord);
    const featureDefinition = generated.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === featureRecord.packageDefinitionId,
    );
    assert.ok(featureDefinition);
    assert.equal(featureDefinition.path, "packages/renamed-feature");
    assert.equal(
      await readFile(
        path.join(targetRoot, featureDefinition.path, "lib/renamed-content.ts"),
        "utf8",
      ),
      'export const fixtureOrigin = "two:feature";\n',
    );
  });

  void it("公开包名变更产生新身份，旧身份不会映射到新成员", async () => {
    const original = await createFixture({
      namespace: "renamed-package",
      marker: "old",
    });
    const renamed = await createFixture({
      namespace: "renamed-package",
      marker: "new",
      featurePackageName: "@fixture/feature-v2",
    });
    const oldIdentity = identityFor(original, "@fixture/feature");
    const newIdentity = identityFor(renamed, "@fixture/feature-v2");
    assert.notDeepEqual(oldIdentity, newIdentity);
    const generator = createGenerator({
      content: renamed.members,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const newTargetRoot = path.join(await createWorkspace(), "new-package");
    const generated = await generator.init({
      targetRoot: newTargetRoot,
      selection: {
        roots: [{ nodeIdentity: "feature", contentIdentity: newIdentity }],
      },
      strategyInput: {
        repositoryName: "new-package",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(generated.status, "success");
    if (generated.status !== "success") return;
    const newFeature = generated.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(newIdentity),
    );
    assert.ok(newFeature);
    const newFeatureDefinition = generated.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === newFeature.packageDefinitionId,
    );
    assert.ok(newFeatureDefinition);
    assert.equal(
      await readFile(
        path.join(newTargetRoot, newFeatureDefinition.path, "src/content.ts"),
        "utf8",
      ),
      'export const fixtureOrigin = "new:feature";\n',
    );

    const oldTargetRoot = path.join(await createWorkspace(), "old-identity");
    const stale = await generator.init({
      targetRoot: oldTargetRoot,
      selection: {
        roots: [{ nodeIdentity: "feature", contentIdentity: oldIdentity }],
      },
      strategyInput: {
        repositoryName: "old-identity",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(stale.status, "operation-failure");
    if (stale.status === "operation-failure") {
      assert.match(stale.error.message, /规范内容不存在/u);
    }
    await assert.rejects(readFile(oldTargetRoot));
  });
});
