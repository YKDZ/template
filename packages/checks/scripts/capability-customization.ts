import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import formatterConfig from "@ykdz/reference-tooling-config/oxfmt";
import { format } from "oxfmt";

import type { SuccessfulScenarioResult } from "../src/generated-content.ts";

export type VueApplicationCustomization = {
  readonly file: string;
  readonly contents: string;
};

function applications(result: SuccessfulScenarioResult) {
  const identities = new Set(
    result.generationRecord.packages
      .filter(
        (item) =>
          item.contentIdentity.packageName === "@ykdz/reference-vue-app",
      )
      .map((item) => item.packageDefinitionId),
  );
  return result.blueprint.packages.filter((item) =>
    identities.has(item.packageDefinitionId),
  );
}

/** 定制已有应用，后续新增应用应保留这份定制并拥有独立示例。 */
export async function customizeVueApplication(
  result: SuccessfulScenarioResult,
  projectDir: string,
): Promise<VueApplicationCustomization> {
  const application = applications(result)[0];
  assert.ok(application);
  const file = path.join(
    projectDir,
    application.path,
    "src/components/CounterButton.vue",
  );
  const original = await readFile(file, "utf8");
  const edited = original.replace(
    '    type="button"',
    '    data-app-customization="preserved"\n    type="button"',
  );
  assert.notEqual(edited, original);
  const formatted = await format("CounterButton.vue", edited, formatterConfig);
  assert.equal(formatted.errors.length, 0);
  await writeFile(file, formatted.code);
  return { file, contents: formatted.code };
}

export async function verifyVueApplicationCombination(options: {
  readonly initialization: SuccessfulScenarioResult;
  readonly result: SuccessfulScenarioResult;
  readonly projectDir: string;
  readonly customization?: VueApplicationCustomization;
}): Promise<void> {
  const apps = applications(options.result);
  assert.equal(apps.length, applications(options.initialization).length + 1);
  if (options.customization === undefined) return;
  assert.equal(
    await readFile(options.customization.file, "utf8"),
    options.customization.contents,
  );
  for (const app of apps) {
    const customized =
      path.join(
        options.projectDir,
        app.path,
        "src/components/CounterButton.vue",
      ) === options.customization.file;
    const observer = await format(
      "app-customization.spec.ts",
      'import { expect, test } from "@playwright/test";\n\ntest("已有应用保留定制，新增应用保持独立", async ({ page }) => {\n  await page.goto("/");\n  await expect(page.getByRole("button", { name: "计数：0" }))' +
        (customized
          ? '.toHaveAttribute("data-app-customization", "preserved")'
          : '.not.toHaveAttribute("data-app-customization", "preserved")') +
        ";\n});\n",
      formatterConfig,
    );
    assert.equal(observer.errors.length, 0);
    const directory = path.join(options.projectDir, app.path, "test/e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "app-customization.spec.ts"),
      observer.code,
      { flag: "wx" },
    );
  }
}
