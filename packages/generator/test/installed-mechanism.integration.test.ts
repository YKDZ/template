import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

void it("正式机制制品独立安装后复用文档策略完成初始化、新进程加包与真实冲突", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "installed-mechanism-"));
  const archives = path.join(root, "archives");
  const consumer = path.join(root, "consumer");
  await mkdir(archives);
  await mkdir(consumer);
  try {
    const { stdout: pnpmVersion } = await run("pnpm", ["--version"], {
      cwd: packageRoot,
    });
    const dependencies: Record<string, string> = {};
    for (const name of ["@ykdz/template-core", "@ykdz/template-generator"]) {
      const { stdout } = await run(
        "pnpm",
        ["--filter", name, "pack", "--json", "--pack-destination", archives],
        { cwd: packageRoot },
      );
      const packed = JSON.parse(stdout) as { filename: string };
      dependencies[name] = `file:${packed.filename}`;
    }
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({
        name: "installed-mechanism-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: `pnpm@${pnpmVersion.trim()}`,
        dependencies,
      }),
    );
    await writeFile(
      path.join(consumer, "pnpm-workspace.yaml"),
      `packages: []\noverrides:\n  "@ykdz/template-core": ${JSON.stringify(dependencies["@ykdz/template-core"])}\n`,
    );
    await run("pnpm", ["install"], { cwd: consumer });
    const tree = await run(
      "pnpm",
      ["list", "--prod", "--depth", "Infinity", "--json"],
      { cwd: consumer },
    );
    assert.doesNotMatch(
      tree.stdout,
      /@ykdz\/(?:template-workspace|template-content|template-environment|reference-|preset-)/u,
    );
    const support = path.join(consumer, "support");
    const compiled = path.join(consumer, "compiled");
    await mkdir(support);
    await copyFile(
      fileURLToPath(
        new URL("../test-support/documentation.ts", import.meta.url),
      ),
      path.join(support, "documentation.ts"),
    );
    await run(
      "pnpm",
      [
        "exec",
        "tsc",
        "--ignoreConfig",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--target",
        "es2024",
        "--skipLibCheck",
        "--rootDir",
        support,
        "--outDir",
        compiled,
        path.join(support, "documentation.ts"),
      ],
      { cwd: packageRoot },
    );
    const driver = path.join(consumer, "driver.mjs");
    await writeFile(
      driver,
      [
        'import assert from "node:assert/strict";',
        'import { readFile, writeFile, access } from "node:fs/promises";',
        'import { createDocumentationEngine, guideIdentity } from "./compiled/documentation.js";',
        "const [phase, root, forbidden] = process.argv.slice(2);",
        'await assert.rejects(readFile(forbidden), { code: "ERR_ACCESS_DENIED" });',
        'for (const specifier of ["@ykdz/template-generator", "@ykdz/template-core/content-identity"]) assert.ok(import.meta.resolve(specifier).startsWith(new URL("./", import.meta.url).href));',
        'assert.throws(() => import.meta.resolve("@ykdz/template-workspace/default-workspace-strategy"), { code: "ERR_MODULE_NOT_FOUND" });',
        'const engine = createDocumentationEngine({ policyId: "test-policy:installed", author: "安装后作者" });',
        'if (phase === "init") {',
        '  const result = await engine.init({ targetRoot: root, selection: { roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }] }, strategyInput: { collection: "north", edition: "draft" } });',
        '  assert.equal(result.status, "success", JSON.stringify(result));',
        '  assert.equal(await readFile(`${root}/docs/overview/README.md`, "utf8"), "north/draft by 安装后作者: north:overview uses docs/glossary\\n");',
        '} else if (phase === "add") {',
        '  const result = await engine.add({ repositoryRoot: root, contentIdentity: guideIdentity, creationInput: { leafName: "appendix" } });',
        '  assert.equal(result.status, "success", JSON.stringify(result));',
        "  assert.equal(result.generationRecord.packages.length, 3);",
        '  assert.equal(await readFile(`${root}/docs/appendix/README.md`, "utf8"), "north/draft by 安装后作者: north:appendix uses docs/glossary\\n");',
        '  assert.equal(result.blueprint.packages.filter(({ path }) => path === "docs/glossary").length, 1);',
        "} else {",
        '  await writeFile(`${root}/INDEX.md`, "# 用户编辑\\n");',
        '  const before = await readFile(`${root}/.template/generation.json`, "utf8");',
        '  const result = await engine.add({ repositoryRoot: root, contentIdentity: guideIdentity, creationInput: { leafName: "late" } });',
        '  assert.equal(result.status, "conflict", JSON.stringify(result));',
        '  assert.equal(await readFile(`${root}/.template/generation.json`, "utf8"), before);',
        '  assert.equal(await readFile(`${root}/INDEX.md`, "utf8"), "# 用户编辑\\n");',
        '  await assert.rejects(access(`${root}/docs/late`), { code: "ENOENT" });',
        "}",
      ].join("\n"),
    );
    await mkdir(path.join(consumer, "tmp"));
    for (const phase of ["init", "add", "conflict"]) {
      await run(
        process.execPath,
        [
          "--permission",
          `--allow-fs-read=${consumer}`,
          `--allow-fs-write=${consumer}`,
          "--no-global-search-paths",
          driver,
          phase,
          path.join(consumer, "project"),
          fileURLToPath(
            new URL("../test-support/documentation.ts", import.meta.url),
          ),
        ],
        {
          cwd: consumer,
          env: {
            ...process.env,
            NODE_OPTIONS: "",
            NODE_PATH: "",
            TMPDIR: path.join(consumer, "tmp"),
          },
        },
      );
    }
    const record = JSON.parse(
      await readFile(
        path.join(consumer, "project/.template/generation.json"),
        "utf8",
      ),
    ) as { schemaVersion: number; strategyIdentity: string };
    assert.equal(record.schemaVersion, 5);
    assert.equal(record.strategyIdentity, "test-policy:installed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
