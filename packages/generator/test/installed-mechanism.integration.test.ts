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
        'import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";',
        'import { boundApiIdentity, boundPresetIdentity, boundWebIdentity, createDocumentationEngine, glossaryIdentity, guideIdentity, indexIdentity, presetIdentity, sharedAdditionPresetIdentity } from "./compiled/documentation.js";',
        'import { commitProjectProjectionPlan, planProjectProjections, readProjectProjectionCurrent } from "@ykdz/template-core/project-projection";',
        "const [phase, root, forbidden] = process.argv.slice(2);",
        'const target = phase === "init-direct-reversed" ? `${root}-direct-reversed` : phase === "init-dependency-only" || phase === "add-explicit-glossary" ? `${root}-dependency-only` : phase === "init-new-shared" || phase === "add-new-shared" ? `${root}-new-shared` : phase === "init-bound-preset" || phase === "add-bound-preset" ? `${root}-bound-preset` : phase === "init-bound-preset-corrupt" || phase === "reject-bound-preset-binding" ? `${root}-bound-preset-corrupt` : phase.startsWith("init-direct-bound-") || phase.startsWith("add-direct-bound-") ? `${root}-direct-bound` : phase.includes("direct") ? `${root}-direct` : phase.includes("preset") ? `${root}-preset` : phase === "conflict" ? `${root}-conflict` : phase === "old-format" ? `${root}-old-format` : phase === "invalid-relations" ? `${root}-invalid-relations` : ["empty-target", "dry-run", "dry-run-empty-target", "dry-run-non-empty-target", "non-empty-target"].includes(phase) ? `${root}-${phase}` : `${root}-sdk`;',
        'await assert.rejects(readFile(forbidden), { code: "ERR_ACCESS_DENIED" });',
        'for (const specifier of ["@ykdz/template-generator", "@ykdz/template-core/content-identity"]) assert.ok(import.meta.resolve(specifier).startsWith(new URL("./", import.meta.url).href));',
        'const createEngine = () => createDocumentationEngine({ author: "安装后作者" });',
        'const directSelection = { roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity }, { nodeIdentity: "guide", contentIdentity: guideIdentity, creationInput: { leafName: "overview" } }, { nodeIdentity: "glossary", contentIdentity: glossaryIdentity }] };',
        'const reversedDirectSelection = { roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity }, { nodeIdentity: "glossary", contentIdentity: glossaryIdentity }, { nodeIdentity: "guide", contentIdentity: guideIdentity, creationInput: { leafName: "overview" } }] };',
        "const presetSelection = { presets: [{ contentIdentity: presetIdentity }] };",
        "const boundPresetSelection = { presets: [{ contentIdentity: boundPresetIdentity }] };",
        'const conventions = { collection: "north", edition: "draft" };',
        "const operationFacts = (providerVersion) => ({ providerVersion });",
        'const init = async (targetRoot, selection) => { const result = await createEngine().init({ targetRoot, selection, conventions, operationFacts: operationFacts("initial") }); assert.equal(result.status, "success", JSON.stringify(result)); return result; };',
        'const add = async (targetRoot, creationInput) => createEngine().add({ repositoryRoot: targetRoot, contentIdentity: guideIdentity, creationInput, operationFacts: operationFacts("add-current") });',
        'const recordAt = async (targetRoot) => JSON.parse(await readFile(`${targetRoot}/.template/generation.json`, "utf8"));',
        'const verifyRecord = async (targetRoot, packageCount, guideCount) => { const record = await recordAt(targetRoot); assert.equal(record.schemaVersion, 6); assert.deepEqual(record.composition.conventions, conventions); assert.equal(record.packages.length, packageCount); const guides = record.packages.filter(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-guide"); const glossaries = record.packages.filter(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary"); assert.equal(guides.length, guideCount); assert.equal(glossaries.length, 1); assert.ok(guides.every(({ dependencyBindings }) => dependencyBindings.glossary === glossaries[0].packageDefinitionId)); const blueprint = JSON.parse(await readFile(`${targetRoot}/.template/blueprint.json`, "utf8")); assert.equal(blueprint.schemaVersion, 4); assert.ok(blueprint.packageLinkIntents.some(({ consumerId, providerId }) => consumerId === guides.at(-1).packageDefinitionId && providerId === glossaries[0].packageDefinitionId)); return record; };',
        'const assertStableInitialIds = async (targetRoot, record) => { const initialIds = JSON.parse(await readFile(`${targetRoot}.initial-ids.json`, "utf8")); assert.ok(initialIds.every((id) => record.packages.some(({ packageDefinitionId }) => packageDefinitionId === id))); };',
        'if (phase === "sdk") { const engine = createEngine(); const prepared = await engine.prepareProject({ selection: { roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity }] }, conventions, operationFacts: operationFacts("sdk") }); const computed = engine.computeProject(prepared); const before = { entries: [], reconciliation: [] }; const preconditions = [{ path: ".", kind: "directory-empty-or-missing", reason: "初始化目标必须为空或不存在" }]; const current = await readProjectProjectionCurrent({ targetRoot: target, before, after: computed.projection, preconditions }); const planning = planProjectProjections({ before, current, after: computed.projection, preconditions }); assert.equal(planning.ok, true, JSON.stringify(planning)); await assert.rejects(access(target), { code: "ENOENT" }); const committed = await commitProjectProjectionPlan({ targetRoot: target, plan: planning.plan }); assert.equal(committed.ok, true, JSON.stringify(committed)); }',
        'else if (["empty-target", "dry-run", "dry-run-empty-target", "dry-run-non-empty-target", "non-empty-target"].includes(phase)) { const needsDirectory = phase !== "dry-run"; const nonEmpty = phase === "dry-run-non-empty-target" || phase === "non-empty-target"; if (needsDirectory) await mkdir(target); if (nonEmpty) await writeFile(`${target}/keep.txt`, "用户文件\\n"); const dryRun = phase.startsWith("dry-run"); const result = await createEngine().init({ targetRoot: target, selection: directSelection, conventions, operationFacts: operationFacts("initial"), ...(dryRun ? { dryRun: true } : {}) }); if (nonEmpty) { assert.notEqual(result.status, "success", JSON.stringify(result)); assert.ok(result.conflicts.some(({ sources }) => sources?.length > 0)); assert.equal(await readFile(`${target}/keep.txt`, "utf8"), "用户文件\\n"); await assert.rejects(access(`${target}/INDEX.md`), { code: "ENOENT" }); } else { assert.equal(result.status, "success", JSON.stringify(result)); if (dryRun && needsDirectory) assert.deepEqual(await readdir(target), []); else if (dryRun) await assert.rejects(access(target), { code: "ENOENT" }); else await access(`${target}/INDEX.md`); } }',
        'else if (phase === "init-direct" || phase === "init-direct-reversed" || phase === "init-preset") { const selection = phase === "init-preset" ? presetSelection : phase === "init-direct-reversed" ? reversedDirectSelection : directSelection; const result = await init(target, selection); const record = await recordAt(target); await writeFile(`${target}.initial-ids.json`, JSON.stringify(record.packages.map(({ packageDefinitionId }) => packageDefinitionId))); assert.equal(record.packages.length, 3); assert.equal(record.selections.length, 1); assert.equal(await readFile(`${target}/docs/glossary/README.md`, "utf8"), "north/draft@initial glossary by 安装后作者\\nGlossary resource\\n"); assert.equal(result.generationRecord.schemaVersion, 6); if (phase !== "init-preset") assert.equal(record.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary").createdBy, "initialization"); }',
        'else if (phase === "init-dependency-only") { await init(target, { roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity }, { nodeIdentity: "guide", contentIdentity: guideIdentity }] }); const record = await recordAt(target); const glossary = record.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary"); assert.equal(glossary.createdBy, "shared-dependency"); await writeFile(`${target}.shared-dependency-id.json`, glossary.packageDefinitionId); }',
        'else if (phase === "add-explicit-glossary") { const engine = createEngine(); const planning = await engine.planAdd({ repositoryRoot: target, contentIdentity: glossaryIdentity, operationFacts: operationFacts("add-current") }); assert.equal(planning.status, "planned", JSON.stringify(planning)); if (planning.status !== "planned") throw new Error("共享词汇包显式加选未规划"); const previousId = await readFile(`${target}.shared-dependency-id.json`, "utf8"); const glossary = planning.generationRecord.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary"); assert.equal(glossary.packageDefinitionId, previousId); assert.equal(glossary.createdBy, "shared-dependency"); const committed = await engine.commitPlan(planning.plan); assert.equal(committed.status, "success", JSON.stringify(committed)); const record = await recordAt(target); const persisted = record.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary"); assert.equal(persisted.packageDefinitionId, previousId); assert.equal(persisted.createdBy, "shared-dependency"); }',
        'else if (phase === "init-new-shared") { await init(target, { roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity }] }); const record = await recordAt(target); assert.equal(record.packages.length, 1); await writeFile(`${target}.initial-ids.json`, JSON.stringify(record.packages.map(({ packageDefinitionId }) => packageDefinitionId))); }',
        'else if (phase === "init-bound-preset" || phase === "init-bound-preset-corrupt") { await init(target, boundPresetSelection); const record = await recordAt(target); assert.equal(record.packages.length, 4); const selected = record.selections[0].nodes; const web = record.packages.find(({ packageDefinitionId }) => packageDefinitionId === selected.web); const api = record.packages.find(({ packageDefinitionId }) => packageDefinitionId === selected.api); assert.equal(web.dependencyBindings.api, selected.api); assert.equal(api.createdBy, "initialization"); assert.deepEqual(api.creationInput, { leafName: "custom-api", packagePath: "apps/custom-api" }); await writeFile(`${target}.initial-ids.json`, JSON.stringify(record.packages.map(({ packageDefinitionId }) => packageDefinitionId))); if (phase === "init-bound-preset-corrupt") { const corrupted = await recordAt(target); const selectedNodes = corrupted.selections[0].nodes; const consumer = corrupted.packages.find(({ packageDefinitionId }) => packageDefinitionId === selectedNodes.web); consumer.dependencyBindings.api = selectedNodes["other-api"]; await writeFile(`${target}/.template/generation.json`, JSON.stringify(corrupted)); } }',
        'else if (phase === "init-direct-bound-provider") { await init(target, { roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity, creationInput: { leafName: "index", packagePath: "." } }, { nodeIdentity: "api", contentIdentity: boundApiIdentity, creationInput: { leafName: "custom-api", packagePath: "apps/custom-api" } }] }); const record = await recordAt(target); assert.equal(record.selections[0].presetIdentity, null); assert.equal(record.packages.length, 2); const api = record.packages.find(({ contentIdentity }) => contentIdentity.packageName === boundApiIdentity.packageName); assert.equal(api.createdBy, "initialization"); assert.deepEqual(api.creationInput, { leafName: "custom-api", packagePath: "apps/custom-api" }); await writeFile(`${target}.direct-api-id.json`, api.packageDefinitionId); }',
        'else if (phase === "add-direct-bound-web") { const before = await recordAt(target); const api = before.packages.find(({ contentIdentity }) => contentIdentity.packageName === boundApiIdentity.packageName); assert.ok(api); const engine = createEngine(); const planning = await engine.planAdd({ repositoryRoot: target, contentIdentity: boundWebIdentity, nodeIdentity: "web", creationInput: { leafName: "web", packagePath: "apps/web" }, dependencyBindings: { api: { packageDefinitionId: api.packageDefinitionId } }, operationFacts: operationFacts("add-current") }); assert.equal(planning.status, "planned", JSON.stringify(planning)); if (planning.status !== "planned") throw new Error("direct web绑定已有API未规划"); assert.equal(planning.generationRecord.packages.length, 3); const web = planning.generationRecord.packages.find(({ contentIdentity }) => contentIdentity.packageName === boundWebIdentity.packageName); assert.equal(web.dependencyBindings.api, api.packageDefinitionId); assert.equal(web.createdBy, "addition"); assert.ok(planning.blueprint.packageLinkIntents.some(({ consumerId, providerId }) => consumerId === web.packageDefinitionId && providerId === api.packageDefinitionId)); const committed = await engine.commitPlan(planning.plan); assert.equal(committed.status, "success", JSON.stringify(committed)); await writeFile(`${target}.direct-bound-ids.json`, JSON.stringify([api.packageDefinitionId, web.packageDefinitionId])); }',
        'else if (phase === "add-direct-bound-third") { const initialIds = JSON.parse(await readFile(`${target}.direct-bound-ids.json`, "utf8")); const engine = createEngine(); const planning = await engine.planAdd({ repositoryRoot: target, contentIdentity: glossaryIdentity, nodeIdentity: "glossary", creationInput: { leafName: "glossary", packagePath: "docs/glossary" }, operationFacts: operationFacts("add-current") }); assert.equal(planning.status, "planned", JSON.stringify(planning)); if (planning.status !== "planned") throw new Error("fresh process第三次加包未规划"); assert.ok(initialIds.every((id) => planning.generationRecord.packages.some(({ packageDefinitionId }) => packageDefinitionId === id))); assert.equal(planning.generationRecord.packages.length, 4); const api = planning.generationRecord.packages.find(({ contentIdentity }) => contentIdentity.packageName === boundApiIdentity.packageName); const web = planning.generationRecord.packages.find(({ contentIdentity }) => contentIdentity.packageName === boundWebIdentity.packageName); assert.equal(web.dependencyBindings.api, api.packageDefinitionId); assert.equal(api.createdBy, "initialization"); assert.deepEqual(api.creationInput, { leafName: "custom-api", packagePath: "apps/custom-api" }); const committed = await engine.commitPlan(planning.plan); assert.equal(committed.status, "success", JSON.stringify(committed)); }',
        'else if (phase === "add-bound-preset") { const engine = createEngine(); const planning = await engine.planAdd({ repositoryRoot: target, contentIdentity: boundApiIdentity, creationInput: { leafName: "extra-api", packagePath: "apps/extra-api" }, operationFacts: operationFacts("add-current") }); assert.equal(planning.status, "planned", JSON.stringify(planning)); if (planning.status !== "planned") throw new Error("独立 provider 绑定恢复后加包未规划"); const initialIds = JSON.parse(await readFile(`${target}.initial-ids.json`, "utf8")); assert.ok(initialIds.every((id) => planning.generationRecord.packages.some(({ packageDefinitionId }) => packageDefinitionId === id))); const selected = planning.generationRecord.selections[0].nodes; const web = planning.generationRecord.packages.find(({ packageDefinitionId }) => packageDefinitionId === selected.web); const api = planning.generationRecord.packages.find(({ packageDefinitionId }) => packageDefinitionId === selected.api); assert.equal(web.dependencyBindings.api, selected.api); assert.equal(api.createdBy, "initialization"); const extraApi = planning.generationRecord.packages.find(({ creationInput }) => creationInput?.packagePath === "apps/extra-api"); assert.equal(extraApi.createdBy, "addition"); const committed = await engine.commitPlan(planning.plan); assert.equal(committed.status, "success", JSON.stringify(committed)); }',
        'else if (phase === "reject-bound-preset-binding") { const recordPath = `${target}/.template/generation.json`; const before = await readFile(recordPath); const indexBefore = await readFile(`${target}/INDEX.md`); const result = await createEngine().planAdd({ repositoryRoot: target, contentIdentity: boundApiIdentity, creationInput: { leafName: "rejected", packagePath: "apps/rejected" }, operationFacts: operationFacts("add-current") }); assert.equal(result.status, "operation-failure", JSON.stringify(result)); if (result.status !== "operation-failure") throw new Error("篡改后的显式实例绑定被接受"); assert.equal(result.phase, "metadata"); assert.deepEqual(await readFile(recordPath), before); assert.deepEqual(await readFile(`${target}/INDEX.md`), indexBefore); await assert.rejects(access(`${target}/apps/rejected/README.md`), { code: "ENOENT" }); }',
        'else if (phase === "add-new-shared") { const engine = createEngine(); const planning = await engine.planAdd({ repositoryRoot: target, preset: sharedAdditionPresetIdentity, operationFacts: operationFacts("add-current") }); assert.equal(planning.status, "planned", JSON.stringify(planning)); if (planning.status !== "planned") throw new Error("显式共享实例加选未规划"); const glossary = planning.generationRecord.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary"); const guide = planning.generationRecord.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-guide"); assert.equal(glossary.createdBy, "addition"); assert.equal(guide.dependencyBindings.glossary, glossary.packageDefinitionId); const committed = await engine.commitPlan(planning.plan); assert.equal(committed.status, "success", JSON.stringify(committed)); const record = await verifyRecord(target, 3, 1); await assertStableInitialIds(target, record); assert.equal(record.packages.find(({ contentIdentity }) => contentIdentity.packageName === "@fixture/docs-glossary").createdBy, "addition"); }',
        'else if (phase === "add-direct-one") { const overview = `${target}/docs/overview/README.md`; await writeFile(overview, `${await readFile(overview, "utf8")}\\n用户定制\\n`); await chmod(overview, 0o755); await writeFile(`${target}/user-notes.txt`, "保留\\n"); const result = await add(target, { leafName: "appendix", packagePath: "docs/appendix" }); assert.equal(result.status, "success", JSON.stringify(result)); const record = await verifyRecord(target, 4, 2); await assertStableInitialIds(target, record); assert.equal(await readFile(`${target}/docs/appendix/README.md`, "utf8"), "north/draft@add-current by 安装后作者: north:appendix uses docs/glossary\\nGuide resource\\n"); }',
        'else if (phase === "add-direct-two") { const result = await add(target, { leafName: "faq", packagePath: "docs/faq" }); assert.equal(result.status, "success", JSON.stringify(result)); const record = await verifyRecord(target, 5, 3); await assertStableInitialIds(target, record); assert.match(await readFile(`${target}/docs/overview/README.md`, "utf8"), /用户定制/u); assert.equal((await stat(`${target}/docs/overview/README.md`)).mode & 0o111, 0o111); assert.equal(await readFile(`${target}/user-notes.txt`, "utf8"), "保留\\n"); assert.match(await readFile(`${target}/INDEX.md`, "utf8"), /docs\\/appendix/u); assert.match(await readFile(`${target}/INDEX.md`, "utf8"), /docs\\/faq/u); }',
        'else if (phase === "add-preset-repeat") { const engine = createEngine(); const planning = await engine.planAdd({ repositoryRoot: target, preset: presetIdentity, operationFacts: operationFacts("add-current") }); assert.equal(planning.status, "planned", JSON.stringify(planning)); if (planning.status !== "planned") throw new Error("重复预设选择未规划"); assert.equal(planning.generationRecord.selections.length, 1); assert.equal(planning.generationRecord.packages.length, 3); const committed = await engine.commitPlan(planning.plan); assert.equal(committed.status, "success", JSON.stringify(committed)); await assertStableInitialIds(target, await verifyRecord(target, 3, 1)); }',
        'else if (phase === "add-preset-one" || phase === "add-preset-two") { const input = phase === "add-preset-one" ? { leafName: "appendix", packagePath: "docs/appendix" } : { leafName: "faq", packagePath: "docs/faq" }; const result = await add(target, input); assert.equal(result.status, "success", JSON.stringify(result)); const record = await verifyRecord(target, phase === "add-preset-one" ? 4 : 5, phase === "add-preset-one" ? 2 : 3); await assertStableInitialIds(target, record); }',
        'else if (phase === "conflict") { await init(target, directSelection); await mkdir(`${target}/docs/appendix`); await writeFile(`${target}/docs/appendix/keep.txt`, "用户文件\\n"); const metadataBefore = await readFile(`${target}/.template/generation.json`); const result = await add(target, { leafName: "appendix", packagePath: "docs/appendix" }); assert.equal(result.status, "conflict", JSON.stringify(result)); assert.deepEqual(result.actions, []); assert.deepEqual(await readFile(`${target}/.template/generation.json`), metadataBefore); assert.equal(await readFile(`${target}/docs/appendix/keep.txt`, "utf8"), "用户文件\\n"); await assert.rejects(access(`${target}/docs/appendix/README.md`), { code: "ENOENT" }); }',
        'else { const initialized = await init(target, directSelection); const recordPath = `${target}/.template/generation.json`; const record = JSON.parse(await readFile(recordPath, "utf8")); if (phase === "old-format") record.schemaVersion = 5; else record.packages[0].dependencyBindings.invalid = `package-${"0".repeat(64)}`; await writeFile(recordPath, JSON.stringify(record)); const recordBefore = await readFile(recordPath); const indexBefore = await readFile(`${target}/INDEX.md`); const result = await add(target, { leafName: "rejected", packagePath: "docs/rejected" }); assert.equal(result.status, "operation-failure", JSON.stringify(result)); assert.equal(result.phase, "metadata"); assert.deepEqual(await readFile(recordPath), recordBefore); assert.deepEqual(await readFile(`${target}/INDEX.md`), indexBefore); assert.equal(initialized.status, "success"); await assert.rejects(access(`${target}/docs/rejected`), { code: "ENOENT" }); }',
      ].join("\n"),
    );
    await mkdir(path.join(consumer, "tmp"));
    for (const phase of [
      "sdk",
      "empty-target",
      "dry-run",
      "dry-run-empty-target",
      "dry-run-non-empty-target",
      "non-empty-target",
      "init-direct",
      "add-direct-one",
      "add-direct-two",
      "init-direct-reversed",
      "init-dependency-only",
      "add-explicit-glossary",
      "init-new-shared",
      "add-new-shared",
      "init-bound-preset",
      "add-bound-preset",
      "init-direct-bound-provider",
      "add-direct-bound-web",
      "add-direct-bound-third",
      "init-bound-preset-corrupt",
      "reject-bound-preset-binding",
      "init-preset",
      "add-preset-repeat",
      "add-preset-one",
      "add-preset-two",
      "conflict",
      "old-format",
      "invalid-relations",
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
    for (const suffix of ["direct", "preset"]) {
      const installedRecord = JSON.parse(
        await readFile(
          path.join(consumer, `project-${suffix}/.template/generation.json`),
          "utf8",
        ),
      ) as { schemaVersion: number; packages: readonly unknown[] };
      assert.equal(installedRecord.schemaVersion, 6);
      assert.equal(installedRecord.packages.length, 5);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
