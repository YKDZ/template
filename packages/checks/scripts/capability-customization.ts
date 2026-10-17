import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import formatterConfig from "@ykdz/reference-typescript-config/oxfmt";
import {
  loadLocalTemplateMetadata,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import { format } from "oxfmt";

const sharedSource = "@ykdz/reference-vue-shared";

export type SharedVueCustomization = {
  readonly file: string;
  readonly contents: string;
};

/** 在已有共同组件中加入真实定制，随后由新旧应用的正式浏览器入口观察。 */
export async function customizeSharedVue(
  plan: GeneratedRepositoryPlan,
  projectDir: string,
): Promise<SharedVueCustomization> {
  const shared = plan.packageContributions.find(
    (item) => item.referenceSource === sharedSource,
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
  readonly initialPlan: GeneratedRepositoryPlan;
  readonly finalPlan: GeneratedRepositoryPlan;
  readonly projectDir: string;
  readonly customization?: SharedVueCustomization;
}): Promise<void> {
  const initial = options.initialPlan.generationRecord.packages.filter(
    (item) => item.referenceSource === sharedSource,
  );
  loadLocalTemplateMetadata(options.projectDir);
  const record = JSON.parse(
    await readFile(
      path.join(options.projectDir, ".template/generation.json"),
      "utf8",
    ),
  ) as GeneratedRepositoryPlan["generationRecord"];
  const shared = record.packages.filter(
    (item) => item.referenceSource === sharedSource,
  );
  assert.equal(shared.length, 1);
  const provider = shared[0]!;
  if (initial.length > 0) {
    assert.equal(provider.packageDefinitionId, initial[0]!.packageDefinitionId);
    assert.equal(provider.path, initial[0]!.path);
  }
  const consumers = options.finalPlan.packageContributions.filter(
    (item) => item.referenceBindings?.[sharedSource] !== undefined,
  );
  assert.equal(consumers.length, initial.length === 0 ? 1 : 2);
  for (const consumer of consumers) {
    const consumerRecord = record.packages.find(
      (item) => item.path === consumer.definition.path,
    )!;
    assert.equal(
      consumerRecord.dependencyBindings?.[sharedSource],
      provider.packageDefinitionId,
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
    const directory = path.join(
      options.projectDir,
      consumer.definition.path,
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
