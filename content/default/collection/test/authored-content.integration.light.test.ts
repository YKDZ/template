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

import { templateContent } from "@ykdz/template-content";
import {
  contentIdentityKey,
  createContentIndex,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

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

function generatorFor(content: AuthoredContentFixture["members"]) {
  return createDefaultGenerator({ content: [...templateContent, ...content] });
}

function leafNameFrom(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("leafName" in value) ||
    typeof value.leafName !== "string"
  ) {
    return undefined;
  }
  return value.leafName;
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
      const generator = generatorFor(fixture.members);

      const initialized = await generator.init({
        targetRoot,
        selection: {
          presets: [{ contentIdentity: { alias: "authored", namespace } }],
        },
        conventions: {
          repositoryName: `${namespace}-fixture`,
          defaultPackageScope: namespace,
        },
      });
      assert.equal(initialized.status, "success");
      if (initialized.status !== "success") return;
      const presetIdentity = identityFor(fixture, "@fixture/preset");
      assert.equal(initialized.generationRecord.schemaVersion, 6);
      assert.deepEqual(
        initialized.generationRecord.selections
          .map(({ presetIdentity }) => presetIdentity)
          .filter((identity) => identity !== null),
        [presetIdentity],
      );

      const featureIdentity = identityFor(fixture, "@fixture/feature");
      const themeIdentity = identityFor(fixture, "@fixture/tooling-config");
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
        featureRecord.dependencyBindings["tooling-config"],
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

      const replayGenerator = generatorFor(fixture.members);

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
      assert.equal(leafNameFrom(addonRecord.creationInput), "addon-extra");
      const addonDefinition = addition.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === addonRecord.packageDefinitionId,
      );
      assert.ok(addonDefinition);
      assert.equal(addonDefinition.path, "packages/addon-extra");
      assert.equal(addonDefinition.name, `@${namespace}/addon-extra`);
      assert.deepEqual(addition.generationRecord.composition.conventions, {
        repositoryName: `${namespace}-fixture`,
        defaultPackageScope: namespace,
        todo: false,
      });
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

      const followupGenerator = generatorFor(fixture.members);
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
          leafNameFrom(record.creationInput) === "addon-next",
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

  void it("统一依赖用途并在fresh add回放中保留目标加执行共享依赖", async () => {
    const fixture = await createFixture({
      namespace: "dependency-uses",
      marker: "uses",
      featureNativeDevDependencies: {
        "@fixture/execution-only": "workspace:*",
        "@fixture/build-only": "workspace:*",
      },
      featureTemplateDependencies: [
        {
          name: "@ykdz/default-content-authoring",
          purpose: "template-execution",
        },
        { name: "@fixture/tooling-config", purpose: "target" },
        {
          name: "@fixture/tooling-config",
          purpose: "template-execution",
        },
        { name: "@fixture/execution-only", purpose: "template-execution" },
        { name: "@fixture/build-only", purpose: "template-build" },
      ],
    });
    const workspace = await createWorkspace();
    const targetRoot = path.join(workspace, "project");
    const initialized = await generatorFor(fixture.members).init({
      targetRoot,
      selection: { presets: [{ contentIdentity: { alias: "authored" } }] },
      conventions: {
        repositoryName: "dependency-uses",
        defaultPackageScope: "uses",
      },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    if (initialized.status !== "success") return;

    const featureIdentity = identityFor(fixture, "@fixture/feature");
    const themeIdentity = identityFor(fixture, "@fixture/tooling-config");
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
      featureRecord.dependencyBindings["tooling-config"],
      themeRecord.packageDefinitionId,
    );
    const featureDefinition = initialized.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === featureRecord.packageDefinitionId,
    );
    assert.ok(featureDefinition);
    const readGeneratedManifest = async () =>
      JSON.parse(
        await readFile(
          path.join(targetRoot, featureDefinition.path, "package.json"),
          "utf8",
        ),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    const assertTargetDependencies = async () => {
      const manifest = await readGeneratedManifest();
      assert.ok(manifest.dependencies?.["@uses/fixture-tooling-config"]);
      for (const field of ["dependencies", "devDependencies"] as const) {
        assert.equal(
          Object.hasOwn(manifest[field] ?? {}, "@fixture/execution-only"),
          false,
        );
        assert.equal(
          Object.hasOwn(manifest[field] ?? {}, "@fixture/build-only"),
          false,
        );
      }
      assert.equal(
        Object.hasOwn(
          manifest.devDependencies ?? {},
          "@ykdz/default-content-authoring",
        ),
        false,
      );
    };
    await assertTargetDependencies();

    const added = await generatorFor(fixture.members).add({
      repositoryRoot: targetRoot,
      contentIdentity: identityFor(fixture, "@fixture/addon"),
      creationInput: { leafName: "uses-addon" },
    });
    assert.equal(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") return;
    const retainedFeature = added.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(featureIdentity),
    );
    const retainedTheme = added.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(themeIdentity),
    );
    assert.ok(retainedFeature);
    assert.ok(retainedTheme);
    assert.equal(
      retainedFeature.dependencyBindings["tooling-config"],
      retainedTheme.packageDefinitionId,
    );
    await assertTargetDependencies();
  });

  void it("当前内容修订经fresh engine回放时保留旧包与用户定制", async () => {
    const original = await createFixture({
      namespace: "current-content-revision",
      marker: "original",
    });
    const current = await createFixture({
      namespace: "current-content-revision",
      marker: "current",
      featureResourcePath: "lib/renamed-content.ts",
    });
    const workspace = await createWorkspace();
    const targetRoot = path.join(workspace, "project");
    const initialized = await generatorFor(original.members).init({
      targetRoot,
      selection: { presets: [{ contentIdentity: { alias: "authored" } }] },
      conventions: {
        repositoryName: "revision-project",
        defaultPackageScope: "revision",
      },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    if (initialized.status !== "success") return;

    const featureIdentity = identityFor(current, "@fixture/feature");
    const featureRecord = initialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(featureIdentity),
    );
    assert.ok(featureRecord);
    const featureDefinition = initialized.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === featureRecord.packageDefinitionId,
    );
    assert.ok(featureDefinition);
    const oldSource = path.join(
      targetRoot,
      featureDefinition.path,
      "src/content.ts",
    );
    await writeFile(oldSource, "用户定制的旧源码\n");
    await chmod(oldSource, 0o600);
    const rootManifestPath = path.join(targetRoot, "package.json");
    const rootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as Record<string, unknown>;
    rootManifest.userOwnedSetting = { retained: true };
    await writeFile(
      rootManifestPath,
      `${JSON.stringify(rootManifest, null, 2)}\n`,
    );

    const addition = await generatorFor(current.members).add({
      repositoryRoot: targetRoot,
      contentIdentity: identityFor(current, "@fixture/addon"),
      creationInput: { leafName: "revision-addon" },
    });
    assert.equal(addition.status, "success", JSON.stringify(addition));
    if (addition.status !== "success") return;
    assert.equal(await readFile(oldSource, "utf8"), "用户定制的旧源码\n");
    assert.equal((await stat(oldSource)).mode & 0o777, 0o600);
    await assert.rejects(
      readFile(
        path.join(targetRoot, featureDefinition.path, "lib/renamed-content.ts"),
      ),
      { code: "ENOENT" },
    );
    assert.deepEqual(
      (
        JSON.parse(await readFile(rootManifestPath, "utf8")) as Record<
          string,
          unknown
        >
      ).userOwnedSetting,
      { retained: true },
    );
    const addonRecord = addition.generationRecord.packages.find(
      (record) => record.createdBy === "addition",
    );
    assert.ok(addonRecord);
    const addonDefinition = addition.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === addonRecord.packageDefinitionId,
    );
    assert.ok(addonDefinition);
    assert.equal(addonDefinition.name, "@revision/revision-addon");
    assert.equal(
      await readFile(
        path.join(targetRoot, addonDefinition.path, "src/addon.ts"),
        "utf8",
      ),
      'export const fixtureOrigin = "current:addon";\n',
    );
  });

  void it("当前内容删除依赖槽后仍保留既有共享实例与绑定", async () => {
    const original = await createFixture({
      namespace: "removed-dependency-slot",
      marker: "original",
    });
    const current = await createFixture({
      namespace: "removed-dependency-slot",
      marker: "current",
      featureDependsOnTheme: false,
    });
    const workspace = await createWorkspace();
    const targetRoot = path.join(workspace, "project");
    const initialized = await generatorFor(original.members).init({
      targetRoot,
      selection: { presets: [{ contentIdentity: { alias: "authored" } }] },
      conventions: {
        repositoryName: "slot-project",
        defaultPackageScope: "slot",
      },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    if (initialized.status !== "success") return;

    const featureIdentity = identityFor(current, "@fixture/feature");
    const themeIdentity = identityFor(current, "@fixture/tooling-config");
    const originalFeature = initialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(featureIdentity),
    );
    const originalTheme = initialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(themeIdentity),
    );
    assert.ok(originalFeature);
    assert.ok(originalTheme);
    assert.equal(originalTheme.createdBy, "shared-dependency");
    assert.equal(
      originalFeature.dependencyBindings["tooling-config"],
      originalTheme.packageDefinitionId,
    );
    const themeDefinition = initialized.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === originalTheme.packageDefinitionId,
    );
    assert.ok(themeDefinition);
    const themeSource = path.join(
      targetRoot,
      themeDefinition.path,
      "src/theme.ts",
    );
    await writeFile(themeSource, "用户定制的共享源码\n");
    await chmod(themeSource, 0o600);

    const currentFeatureManifest = JSON.parse(
      await readFile(
        path.join(
          current.root,
          "removed-dependency-slot/authors/feature/package.json",
        ),
        "utf8",
      ),
    ) as { readonly dependencies?: Readonly<Record<string, unknown>> };
    assert.equal(
      Object.hasOwn(
        currentFeatureManifest.dependencies ?? {},
        "@fixture/tooling-config",
      ),
      false,
    );

    const addition = await generatorFor(current.members).add({
      repositoryRoot: targetRoot,
      contentIdentity: identityFor(current, "@fixture/addon"),
      creationInput: { leafName: "after-slot-removal" },
    });
    assert.equal(addition.status, "success", JSON.stringify(addition));
    if (addition.status !== "success") return;

    const retainedFeature = addition.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(featureIdentity),
    );
    const retainedTheme = addition.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(themeIdentity),
    );
    assert.ok(retainedFeature);
    assert.ok(retainedTheme);
    assert.equal(
      addition.generationRecord.packages.length,
      initialized.generationRecord.packages.length + 1,
    );
    assert.equal(
      retainedTheme.packageDefinitionId,
      originalTheme.packageDefinitionId,
    );
    assert.deepEqual(
      retainedFeature.dependencyBindings,
      originalFeature.dependencyBindings,
    );
    assert.deepEqual(
      addition.generationRecord.selections.find(
        ({ presetIdentity }) => presetIdentity !== null,
      )?.nodes,
      initialized.generationRecord.selections.find(
        ({ presetIdentity }) => presetIdentity !== null,
      )?.nodes,
    );
    assert.ok(
      addition.blueprint.packages.some(
        (definition) =>
          definition.packageDefinitionId ===
            originalTheme.packageDefinitionId &&
          definition.path === themeDefinition.path,
      ),
    );
    assert.equal(await readFile(themeSource, "utf8"), "用户定制的共享源码\n");
    assert.equal((await stat(themeSource)).mode & 0o777, 0o600);
  });

  void it("拒绝跨来源别名歧义和同身份未选修订，目标保持未创建", async () => {
    const alpha = await createFixture({ namespace: "alpha", marker: "alpha" });
    const beta = await createFixture({ namespace: "beta", marker: "beta" });
    const workspace = await createWorkspace();
    const targetRoot = path.join(workspace, "ambiguous");
    const generator = generatorFor([...alpha.members, ...beta.members]);
    const ambiguous = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: "authored" }] },
      conventions: {
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
        packageName: "@fixture/tooling-config",
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

    const generator = generatorFor(content);
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
      conventions: {
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
      directFeature.dependencyBindings["tooling-config"],
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
      selection: { presets: [{ contentIdentity: betaPreset.identity }] },
      conventions: {
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
    assert.deepEqual(
      initialized.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [betaPreset.identity],
    );
    assert.equal(
      initialized.generationRecord.selections[0]?.nodes.feature,
      presetFeature.packageDefinitionId,
    );
    assert.equal(
      presetFeature.dependencyBindings["tooling-config"],
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
    const generator = generatorFor(content);

    for (const fixture of [alpha, beta]) {
      const targetRoot = path.join(
        await createWorkspace(),
        fixture.members[0]!.identity.namespace,
      );
      const preset = fixture.members.find((member) => member.kind === "preset");
      assert.ok(preset);
      const initialized = await generator.init({
        targetRoot,
        selection: { presets: [{ contentIdentity: preset.identity }] },
        conventions: {
          repositoryName: fixture.members[0]!.identity.namespace,
          defaultPackageScope: fixture.members[0]!.identity.namespace,
        },
      });
      assert.equal(initialized.status, "success");
      if (initialized.status !== "success") continue;

      const featureIdentity = identityFor(fixture, "@fixture/feature");
      const themeIdentity = identityFor(fixture, "@fixture/tooling-config");
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
        featureRecord.dependencyBindings["tooling-config"],
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
    const generator = generatorFor(fixture.members);
    const result = await generator.init({
      targetRoot,
      selection: {
        presets: [
          { contentIdentity: { alias: "authored", namespace: "incomplete" } },
        ],
      },
      conventions: {
        repositoryName: "missing-dependency",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(result.status, "operation-failure");
    if (result.status === "operation-failure") {
      assert.equal(result.phase, "preparation");
      assert.match(result.error.message, /@fixture\/tooling-config\/template/u);
      assert.match(result.error.message, /同一命名空间公开/u);
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
    assert.throws(
      () => moved.resolve("@fixture/feature/assets/lib/renamed-content.ts"),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
    );
    assert.notEqual(
      original.members.find(
        (member) => member.identity.packageName === "@fixture/feature",
      )?.source.moduleURL,
      moved.members.find(
        (member) => member.identity.packageName === "@fixture/feature",
      )?.source.moduleURL,
    );
    const targetRoot = path.join(await createWorkspace(), "moved-resource");
    const generator = generatorFor(moved.members);
    const generated = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "feature", contentIdentity: movedFeature }],
      },
      conventions: {
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

    const freshGenerator = generatorFor(moved.members);
    const added = await freshGenerator.add({
      repositoryRoot: targetRoot,
      contentIdentity: identityFor(moved, "@fixture/addon"),
    });
    assert.equal(added.status, "success", JSON.stringify(added));
    assert.equal(
      await readFile(
        path.join(targetRoot, featureDefinition.path, "lib/renamed-content.ts"),
        "utf8",
      ),
      'export const fixtureOrigin = "two:feature";\n',
    );
    assert.equal(
      await readFile(
        path.join(targetRoot, "packages/addon/src/addon.ts"),
        "utf8",
      ),
      'export const fixtureOrigin = "two:addon";\n',
    );
  });

  void it("拥有者源码变化传播到本包生成内容而不改共享参考事实", async () => {
    const original = await createFixture({
      namespace: "source-propagation",
      marker: "shared-fact",
      featureMarker: "before",
    });
    const changed = await createFixture({
      namespace: "source-propagation",
      marker: "shared-fact",
      featureMarker: "after",
    });
    const generatedRoots = await Promise.all([
      createWorkspace().then((workspace) => path.join(workspace, "original")),
      createWorkspace().then((workspace) => path.join(workspace, "changed")),
    ]);
    const generated = await Promise.all(
      [original, changed].map(async (fixture, index) => {
        const result = await generatorFor(fixture.members).init({
          targetRoot: generatedRoots[index]!,
          selection: {
            presets: [
              {
                contentIdentity: {
                  alias: "authored",
                  namespace: "source-propagation",
                },
              },
            ],
          },
          conventions: {
            repositoryName: "source-propagation",
            defaultPackageScope: "demo",
          },
        });
        assert.equal(result.status, "success", JSON.stringify(result));
        if (result.status !== "success") return undefined;
        return {
          blueprint: result.blueprint,
          record: result.generationRecord,
        };
      }),
    );
    assert.ok(generated[0]);
    assert.ok(generated[1]);

    for (const [index, expected] of [
      "before:feature",
      "after:feature",
    ].entries()) {
      const { blueprint, record } = generated[index]!;
      const feature = record.packages.find(
        (pkg) =>
          contentIdentityKey(pkg.contentIdentity) ===
          contentIdentityKey(
            identityFor(index === 0 ? original : changed, "@fixture/feature"),
          ),
      );
      const theme = record.packages.find(
        (pkg) => pkg.contentIdentity.packageName === "@fixture/tooling-config",
      );
      assert.ok(feature);
      assert.ok(theme);
      const featureDefinition = blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === feature.packageDefinitionId,
      );
      const themeDefinition = blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === theme.packageDefinitionId,
      );
      assert.ok(featureDefinition);
      assert.ok(themeDefinition);
      assert.equal(
        await readFile(
          path.join(
            generatedRoots[index]!,
            featureDefinition.path,
            "src/content.ts",
          ),
          "utf8",
        ),
        `export const fixtureOrigin = ${JSON.stringify(expected)};\n`,
      );
      assert.equal(
        await readFile(
          path.join(
            generatedRoots[index]!,
            themeDefinition.path,
            "src/theme.ts",
          ),
          "utf8",
        ),
        'export const fixtureOrigin = "shared-fact:theme";\n',
      );
    }
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
    const generator = generatorFor(renamed.members);
    const newTargetRoot = path.join(await createWorkspace(), "new-package");
    const generated = await generator.init({
      targetRoot: newTargetRoot,
      selection: {
        roots: [{ nodeIdentity: "feature", contentIdentity: newIdentity }],
      },
      conventions: {
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
      conventions: {
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
