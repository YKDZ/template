import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findPlanningIoViolations } from "../scripts/check-author-planning-roles.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

void describe("author planning role check", () => {
  void it("follows project planning into owner helpers and allows prepare I/O", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "author-planning-rules-"),
    );
    try {
      await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "dir",
      );

      const planningRoot = path.join(fixtureRoot, "planning-owner");
      const preparationRoot = path.join(fixtureRoot, "preparation-owner");
      await Promise.all([
        mkdir(planningRoot),
        mkdir(preparationRoot),
        writeFile(
          path.join(planningRoot, "package.json"),
          JSON.stringify({ name: "@fixture/planning-owner", type: "module" }),
        ),
        writeFile(
          path.join(preparationRoot, "package.json"),
          JSON.stringify({
            name: "@fixture/preparation-owner",
            type: "module",
          }),
        ),
      ]);

      const projectEntry = path.join(planningRoot, "template.ts");
      const projectHelper = path.join(planningRoot, "planning-helper.ts");
      const preparationEntry = path.join(preparationRoot, "template.ts");
      await Promise.all([
        writeFile(
          projectEntry,
          `import { definePreset } from "@ykdz/template-core/preset-definition";
import type { PresetProjectOptions } from "@ykdz/template-core/preset-definition";
import { readOwnerValue } from "./planning-helper.ts";

export const preset = definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: "@fixture/planning-owner", exportPath: "./template" },
  project(_options: PresetProjectOptions<unknown, unknown>) {
    return readOwnerValue();
  },
});
`,
        ),
        writeFile(
          projectHelper,
          `import { readFileSync } from "node:fs";

export function readOwnerValue(): string {
  return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
}
`,
        ),
        writeFile(
          preparationEntry,
          `import { readFileSync } from "node:fs";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@fixture/preparation-owner",
  resolve: () => "file:///fixture/reference.json",
  resourceRoot: new URL("./", import.meta.url),
  alias: "fixture-library",
  instance: "shared",
  defaultLeafName: "fixture-library",
  role: "shared-library",
  resources: ["."],
  template: { dependencies: [], scripts: [] },
  prepare() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  foundation: {
    toolchains: {},
    editorCapabilities: [],
    dependencyMaintenance: { ecosystems: [], interval: "weekly" },
  },
  environmentNeeds: [],
  project(contribution) {
    return contribution;
  },
});
`,
        ),
      ]);

      const violations = findPlanningIoViolations(
        [
          {
            entryFile: projectEntry,
            packageRoot: planningRoot,
            identity: "@fixture/planning-owner#./template",
          },
          {
            entryFile: preparationEntry,
            packageRoot: preparationRoot,
            identity: "@fixture/preparation-owner#./template",
          },
        ],
        path.join(repositoryRoot, "tsconfig.json"),
      );

      assert.equal(violations.length, 1);
      assert.deepEqual(violations[0], {
        role: "@fixture/planning-owner#./template:preset.project",
        effect: "filesystem",
        file: projectHelper,
        line: 4,
        column: 10,
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
