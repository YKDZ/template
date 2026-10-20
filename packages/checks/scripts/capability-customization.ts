import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import formatterConfig from "@ykdz/reference-typescript-config/oxfmt";
import {
  contentIdentityKey,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import { format } from "oxfmt";

import type {
  GeneratedScenarioRuntime,
  SuccessfulScenarioResult,
} from "../src/generated-content.ts";

const sharedSource = "@ykdz/reference-vue-shared";

export type SharedVueCustomization = {
  readonly file: string;
  readonly contents: string;
};

function referenceIdentity(
  runtime: GeneratedScenarioRuntime,
  packageName: string,
): ContentIdentity {
  const references = runtime.content.filter(
    (member) =>
      member.kind === "reference" &&
      member.identity.packageName === packageName,
  );
  if (references.length !== 1) {
    throw new Error(
      `唯一内容集合必须明确公开一个${packageName} reference，实际为${references.length}项`,
    );
  }
  return references[0]!.identity;
}

/** 在实际生成的共同组件中加入定制，供后续真实浏览器入口观察。 */
export async function customizeSharedVue(
  result: SuccessfulScenarioResult,
  projectDir: string,
  runtime: GeneratedScenarioRuntime,
): Promise<SharedVueCustomization> {
  const identity = referenceIdentity(runtime, sharedSource);
  const identityKey = contentIdentityKey(identity);
  const shared = result.generationRecord.packages.find(
    (item) =>
      item.createdBy === "shared-dependency" &&
      contentIdentityKey(item.contentIdentity) === identityKey,
  );
  assert.ok(shared);
  const file = path.join(
    projectDir,
    shared.definition.path,
    "src/components/CounterButton.vue",
  );
  const original = await readFile(file, "utf8");
  const edited = original.replace(
    '    type="button"',
    '    data-shared-customization="preserved"\n    type="button"',
  );
  assert.notEqual(edited, original);
  const formatted = await format("CounterButton.vue", edited, formatterConfig);
  assert.equal(formatted.errors.length, 0);
  await writeFile(file, formatted.code);
  return { file, contents: formatted.code };
}

export async function verifySharedVueCombination(options: {
  readonly initialization: SuccessfulScenarioResult;
  readonly result: SuccessfulScenarioResult;
  readonly projectDir: string;
  readonly runtime: GeneratedScenarioRuntime;
  readonly customization?: SharedVueCustomization;
}): Promise<void> {
  const identity = referenceIdentity(options.runtime, sharedSource);
  const identityKey = contentIdentityKey(identity);
  const initial = options.initialization.generationRecord.packages.filter(
    (item) =>
      item.createdBy === "shared-dependency" &&
      contentIdentityKey(item.contentIdentity) === identityKey,
  );
  const record = JSON.parse(
    await readFile(
      path.join(options.projectDir, ".template/generation.json"),
      "utf8",
    ),
  ) as SuccessfulScenarioResult["generationRecord"];
  const shared = record.packages.filter(
    (item) =>
      item.createdBy === "shared-dependency" &&
      contentIdentityKey(item.contentIdentity) === identityKey,
  );
  assert.equal(shared.length, 1);
  const provider = shared[0]!;
  if (initial.length > 0) {
    assert.equal(
      provider.definition.packageDefinitionId,
      initial[0]!.definition.packageDefinitionId,
    );
    assert.equal(provider.definition.path, initial[0]!.definition.path);
  }
  const consumers = options.result.generationRecord.packages.filter(
    (item) => item.bindings[identityKey] !== undefined,
  );
  assert.equal(consumers.length, initial.length === 0 ? 1 : 2);
  for (const consumer of consumers) {
    assert.equal(
      consumer.bindings[identityKey],
      provider.definition.packageDefinitionId,
    );
  }
  if (options.customization === undefined) return;
  assert.equal(
    await readFile(options.customization.file, "utf8"),
    options.customization.contents,
  );
  const observer = await format(
    "shared-customization.spec.ts",
    `import { expect, test } from "@playwright/test";

test("新旧应用复用已有共同组件并保留定制", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "计数：0" })).toHaveAttribute("data-shared-customization", "preserved");
});
`,
    formatterConfig,
  );
  assert.equal(observer.errors.length, 0);
  for (const consumer of consumers) {
    const definition = options.result.blueprint.packages.find(
      (item) =>
        item.packageDefinitionId === consumer.definition.packageDefinitionId,
    );
    assert.ok(definition);
    const directory = path.join(
      options.projectDir,
      definition.path,
      "test/e2e",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "shared-customization.spec.ts"),
      observer.code,
      { flag: "wx" },
    );
  }
}
