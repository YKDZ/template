import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findPlanningEffectViolations } from "../scripts/check-author-planning-roles.ts";

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
          `import { readFileSync } from "node:fs";
import { definePreset } from "@ykdz/template-core/preset-definition";
import type { PresetProjectOptions } from "@ykdz/template-core/preset-definition";
import { readOwnerValue } from "./planning-helper.ts";

const projectHelperAlias = readOwnerValue;

export const preset = definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: "@fixture/planning-owner", exportPath: "./template" },
  project(_options: PresetProjectOptions<unknown, unknown>) {
    [1].map(() => readFileSync(new URL("./owner.txt", import.meta.url), "utf8"));
    return projectHelperAlias();
  },
});
`,
        ),
        writeFile(
          projectHelper,
          `import { readFileSync as readOwnerFile } from "node:fs";

const readOwnerFileAlias = readOwnerFile;

export function readOwnerValue(): string {
  return readOwnerFileAlias(new URL("./owner.txt", import.meta.url), "utf8");
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

      const violations = findPlanningEffectViolations(
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

      assert.equal(violations.length, 2);
      assert.deepEqual(
        violations.find(({ file }) => file === projectHelper),
        {
          role: "@fixture/planning-owner#./template:preset.project",
          effect: "filesystem",
          file: projectHelper,
          line: 6,
          column: 10,
        },
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("根据公开 SDK 的已安装声明识别规划角色", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "author-planning-declaration-"),
    );
    try {
      const packageRoot = path.join(fixtureRoot, "owner");
      const sdkRoot = path.join(
        packageRoot,
        "node_modules/@ykdz/template-core",
      );
      await mkdir(sdkRoot, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "@fixture/installed-owner", type: "module" }),
        ),
        writeFile(
          path.join(sdkRoot, "package.json"),
          JSON.stringify({
            name: "@ykdz/template-core",
            type: "module",
            exports: {
              "./preset-definition": {
                types: "./preset-definition.d.ts",
              },
            },
          }),
        ),
        writeFile(
          path.join(sdkRoot, "preset-definition.d.ts"),
          `export type PresetProjectOptions = Readonly<Record<string, unknown>>;
export declare function definePreset(options: {
  readonly owner: { readonly packageName: string; readonly exportPath: string };
  project(options: PresetProjectOptions): unknown;
}): unknown;
`,
        ),
      ]);
      const entryFile = path.join(packageRoot, "template.ts");
      await writeFile(
        entryFile,
        `import { readFileSync } from "node:fs";
import { definePreset } from "@ykdz/template-core/preset-definition";

export const preset = definePreset({
  owner: { packageName: "@fixture/installed-owner", exportPath: "./template" },
  project() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
});
`,
      );

      const violations = findPlanningEffectViolations(
        [
          {
            entryFile,
            packageRoot,
            identity: "@fixture/installed-owner#./template",
          },
        ],
        path.join(repositoryRoot, "tsconfig.json"),
      );

      assert.equal(violations.length, 1);
      assert.equal(
        violations[0]?.role,
        "@fixture/installed-owner#./template:preset.project",
      );
      assert.equal(violations[0]?.file, entryFile);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("通过公开 namespace SDK 导入识别规划角色", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "author-planning-namespace-sdk-"),
    );
    try {
      await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "dir",
      );
      const packageRoot = path.join(fixtureRoot, "owner");
      await mkdir(packageRoot);
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/namespace-owner",
          type: "module",
          dependencies: { "@ykdz/template-core": "workspace:*" },
        }),
      );
      const entryFile = path.join(packageRoot, "template.ts");
      await writeFile(
        entryFile,
        `import { readFileSync } from "node:fs";
import * as sdk from "@ykdz/template-core/preset-definition";

export const preset = sdk.definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: "@fixture/namespace-owner", exportPath: "./template" },
  project(_options: sdk.PresetProjectOptions<unknown, unknown>) {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
});
`,
      );

      const violations = findPlanningEffectViolations(
        [
          {
            entryFile,
            packageRoot,
            identity: "@fixture/namespace-owner#./template",
          },
        ],
        path.join(repositoryRoot, "tsconfig.json"),
      );

      assert.equal(violations.length, 1);
      assert.equal(violations[0]?.effect, "filesystem");
      assert.equal(
        violations[0]?.role,
        "@fixture/namespace-owner#./template:preset.project",
      );
      assert.equal(violations[0]?.file, entryFile);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("扫描 owner 生产配置中未从公开入口导入的规划角色", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "author-planning-production-sources-"),
    );
    try {
      await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "dir",
      );
      const packageRoot = path.join(fixtureRoot, "owner");
      await mkdir(packageRoot);
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/production-owner",
          type: "module",
          dependencies: { "@ykdz/template-core": "workspace:*" },
          scripts: { "build:template": "tsc -p tsconfig.template.json" },
        }),
      );
      await writeFile(
        path.join(packageRoot, "tsconfig.template.json"),
        JSON.stringify({
          extends: path.join(repositoryRoot, "tsconfig.json"),
          include: ["*.ts"],
        }),
      );
      const entryFile = path.join(packageRoot, "template.ts");
      const spareFile = path.join(packageRoot, "spare.ts");
      const presetPrefix = `import { definePreset } from "@ykdz/template-core/preset-definition";

export const preset = definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: "@fixture/production-owner", exportPath: "./template" },
  project() {
    return `;
      await Promise.all([
        writeFile(
          entryFile,
          `${presetPrefix}"safe";
  },
});
`,
        ),
        writeFile(
          spareFile,
          `import { readFileSync } from "node:fs";
import { definePreset } from "@ykdz/template-core/preset-definition";

export const spare = definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: "@fixture/production-owner", exportPath: "./template" },
  project() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
});
`,
        ),
      ]);

      const violations = findPlanningEffectViolations(
        [
          {
            entryFile,
            packageRoot,
            identity: "@fixture/production-owner#./template",
          },
        ],
        path.join(repositoryRoot, "tsconfig.json"),
      );

      assert.deepEqual(
        violations.map(({ effect, file }) => ({ effect, file })),
        [{ effect: "filesystem", file: spareFile }],
      );
      assert.equal(
        violations[0]?.role,
        "@fixture/production-owner#./template:preset.project",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("拒绝规划 helper 中的进程全局、require 和计算式动态加载", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "author-planning-effects-"),
    );
    try {
      await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "dir",
      );
      const packageRoot = path.join(fixtureRoot, "owner");
      await mkdir(packageRoot);
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@fixture/effect-owner", type: "module" }),
      );
      const entryFile = path.join(packageRoot, "template.ts");
      const helperFile = path.join(packageRoot, "planning-helper.ts");
      await Promise.all([
        writeFile(
          entryFile,
          `import { definePreset } from "@ykdz/template-core/preset-definition";
import { inspectOwnerState, loadComputedModule } from "./planning-helper.ts";

export const preset = definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: "@fixture/effect-owner", exportPath: "./template" },
  project() {
    inspectOwnerState();
    loadComputedModule();
    return undefined;
  },
});
`,
        ),
        writeFile(
          helperFile,
          `export function inspectOwnerState(): string | undefined {
  return process.env.NODE_ENV;
}

export function loadComputedModule(): void {
  require("node:fs");
  const moduleName = "./resource";
  void import(moduleName + ".ts");
}
`,
        ),
      ]);

      const violations = findPlanningEffectViolations(
        [
          {
            entryFile,
            packageRoot,
            identity: "@fixture/effect-owner#./template",
          },
        ],
        path.join(repositoryRoot, "tsconfig.json"),
      );

      assert.deepEqual(
        [...new Set(violations.map(({ effect }) => effect))].sort(),
        ["computed-dynamic-import", "process-global", "require"],
      );
      assert.ok(
        violations.every(
          (violation) =>
            violation.role ===
              "@fixture/effect-owner#./template:preset.project" &&
            violation.file === helperFile,
        ),
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("拒绝规划代码绕过 prepare 直接导入所属数据资源", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "author-planning-data-"),
    );
    try {
      await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "dir",
      );
      const packageRoot = path.join(fixtureRoot, "owner");
      await mkdir(packageRoot);
      await Promise.all([
        writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "@fixture/data-owner",
            type: "module",
            dependencies: { "@ykdz/template-core": "workspace:*" },
          }),
        ),
        writeFile(
          path.join(packageRoot, "owner.json"),
          JSON.stringify({ value: "owner fact" }),
        ),
      ]);
      const entryFile = path.join(packageRoot, "template.ts");
      await writeFile(
        entryFile,
        `import ownerData from "./owner.json" with { type: "json" };
import { definePreset } from "@ykdz/template-core/preset-definition";

const ownerDataAlias = ownerData;

export const preset = definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: "@fixture/data-owner", exportPath: "./template" },
  project() {
    return ownerDataAlias.value;
  },
});
`,
      );

      const violations = findPlanningEffectViolations(
        [
          {
            entryFile,
            packageRoot,
            identity: "@fixture/data-owner#./template",
          },
        ],
        path.join(repositoryRoot, "tsconfig.json"),
      );

      assert.equal(violations.length, 1);
      assert.equal(violations[0]?.effect, "data-as-code");
      assert.equal(
        violations[0]?.role,
        "@fixture/data-owner#./template:preset.project",
      );
      assert.equal(violations[0]?.file, entryFile);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("允许规划只把 owner JSON 用于可擦除的类型查询", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "author-planning-json-type-query-"),
    );
    try {
      await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "dir",
      );
      const packageRoot = path.join(fixtureRoot, "owner");
      await mkdir(packageRoot);
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/json-type-owner",
          type: "module",
          dependencies: { "@ykdz/template-core": "workspace:*" },
        }),
      );
      const entryFile = path.join(packageRoot, "template.ts");
      await writeFile(
        entryFile,
        `import manifest from "./package.json" with { type: "json" };
import { definePreset } from "@ykdz/template-core/preset-definition";

export const preset = definePreset({
  metadata: { alias: "fixture", title: "Fixture", description: "Fixture" },
  operations: ["init"],
  nodes: { service: { reference: { alias: "service", instance: "shared" } } },
  owner: { packageName: manifest.name, exportPath: "./template" },
  project() {
    const result: Pick<typeof manifest, "name"> = { name: "generated" };
    return result;
  },
});
`,
      );

      const violations = findPlanningEffectViolations(
        [
          {
            entryFile,
            packageRoot,
            identity: "@fixture/json-type-owner#./template",
          },
        ],
        path.join(repositoryRoot, "tsconfig.json"),
      );

      assert.deepEqual(violations, []);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
