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

void it("正式安装后的中立内容在新进程中初始化非 npm 根目录与子包", async () => {
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
        'import { readFile, writeFile, access, readdir } from "node:fs/promises";',
        'import { createDocumentationEngine, guideIdentity, indexIdentity } from "./compiled/documentation.js";',
        'import { commitProjectProjectionPlan, planProjectProjections, readProjectProjectionCurrent } from "@ykdz/template-core/project-projection";',
        "const [phase, root, forbidden] = process.argv.slice(2);",
        "const target = `${root}-${phase}`;",
        'await assert.rejects(readFile(forbidden), { code: "ERR_ACCESS_DENIED" });',
        'for (const specifier of ["@ykdz/template-generator", "@ykdz/template-core/content-identity"]) assert.ok(import.meta.resolve(specifier).startsWith(new URL("./", import.meta.url).href));',
        'const engine = createDocumentationEngine({ author: "安装后作者" });',
        'const input = { selection: { roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity }, { nodeIdentity: "guide", contentIdentity: guideIdentity }] }, conventions: { collection: "north", edition: "draft" } };',
        'if (["empty-target", "dry-run-empty-target", "non-empty-target", "dry-run-non-empty-target"].includes(phase)) { await (await import("node:fs/promises")).mkdir(target); }',
        'if (phase === "non-empty-target" || phase === "dry-run-non-empty-target") await writeFile(`${target}/keep.txt`, "用户文件\\n");',
        'const dryRun = phase.startsWith("dry-run");',
        'let result = { status: "success" };',
        'if (phase === "sdk") { const prepared = await engine.prepareProject(input); const computed = engine.computeProject(prepared); const before = { entries: [], reconciliation: [] }; const preconditions = [{ path: ".", kind: "directory-empty-or-missing", reason: "初始化目标必须为空或不存在" }]; const current = await readProjectProjectionCurrent({ targetRoot: target, before, after: computed.projection, preconditions }); const planning = planProjectProjections({ before, current, after: computed.projection, preconditions }); assert.equal(planning.ok, true, JSON.stringify(planning)); await assert.rejects(access(target), { code: "ENOENT" }); const committed = await commitProjectProjectionPlan({ targetRoot: target, plan: planning.plan }); assert.equal(committed.ok, true, JSON.stringify(committed)); } else { result = await engine.init({ targetRoot: target, ...input, ...(dryRun ? { dryRun: true } : {}) }); }',
        'if (phase === "non-empty-target" || phase === "dry-run-non-empty-target") { assert.notEqual(result.status, "success", JSON.stringify(result)); assert.equal(await readFile(`${target}/keep.txt`, "utf8"), "用户文件\\n"); await assert.rejects(access(`${target}/INDEX.md`), { code: "ENOENT" }); }',
        'else if (phase === "dry-run") { assert.equal(result.status, "success", JSON.stringify(result)); await assert.rejects(access(target), { code: "ENOENT" }); }',
        'else if (phase === "dry-run-empty-target") { assert.equal(result.status, "success", JSON.stringify(result)); assert.deepEqual(await readdir(target), []); }',
        'else { assert.equal(result.status, "success", JSON.stringify(result)); assert.equal(await readFile(`${target}/docs/overview/README.md`, "utf8"), "north/draft by 安装后作者: north:guide uses docs/glossary\\nGuide resource\\n"); assert.equal(await readFile(`${target}/docs/glossary/README.md`, "utf8"), "north/draft glossary by 安装后作者\\nGlossary resource\\n"); assert.equal((await readFile(`${target}/INDEX.md`, "utf8")).startsWith("3 packages\\n"), true); assert.equal(await access(`${target}/package.json`).then(() => true, () => false), false); const record = JSON.parse(await readFile(`${target}/.template/generation.json`, "utf8")); assert.equal(record.schemaVersion, 6); assert.equal(record.composition.identity.exportPath, "./composition"); assert.equal(record.packages.length, 3); const guide = record.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-guide"); const glossary = record.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary"); assert.equal(guide.dependencyBindings.glossary, glossary.packageDefinitionId); const blueprint = JSON.parse(await readFile(`${target}/.template/blueprint.json`, "utf8")); assert.equal(blueprint.schemaVersion, 4); assert.equal(blueprint.packages.find(({ path }) => path === ".").name, "north:index"); assert.deepEqual(blueprint.packageLinkIntents, [{ consumerId: guide.packageDefinitionId, providerId: glossary.packageDefinitionId }]); }',
      ].join("\n"),
    );
    await mkdir(path.join(consumer, "tmp"));
    for (const phase of [
      "init",
      "sdk",
      "empty-target",
      "dry-run",
      "dry-run-empty-target",
      "dry-run-non-empty-target",
      "non-empty-target",
    ]) {
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
    const installedRecord = JSON.parse(
      await readFile(
        path.join(consumer, "project-init/.template/generation.json"),
        "utf8",
      ),
    ) as { schemaVersion: number };
    assert.equal(installedRecord.schemaVersion, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
