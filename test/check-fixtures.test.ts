import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import { PackageAdditionSupport } from "../src/package-addition-support.js";
import { builtInPresetProjections } from "../templates/registry.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type CommandRecord = {
  command: string;
  args: string[];
  cwd: string;
  ci: string | null;
};

type FixtureScenario = {
  basePreset: string;
  addedPreset?: string;
};

const supportedPresetNames = builtInPresetProjections
  .filter((projection) => projection.metadata.generation === "supported")
  .map((projection) => projection.metadata.name);
const addablePresetNames = builtInPresetProjections
  .filter(
    (projection) =>
      projection.metadata.generation === "supported" &&
      projection.metadata.packageAdditionSupport ===
        PackageAdditionSupport.Supported,
  )
  .map((projection) => projection.metadata.name);
const fixtureScenarios: FixtureScenario[] = [
  ...supportedPresetNames.map((basePreset) => ({ basePreset })),
  ...supportedPresetNames.flatMap((basePreset) =>
    addablePresetNames.map((addedPreset) => ({ basePreset, addedPreset })),
  ),
];

function fixtureScenarioId(scenario: FixtureScenario): string {
  if (!scenario.addedPreset) {
    return scenario.basePreset;
  }

  return `${scenario.basePreset}-add-${scenario.addedPreset}`;
}

function fixtureScenarioFromCwd(cwd: string): FixtureScenario | undefined {
  const fixtureDirectory = path.basename(cwd).replace(/^fixture-/, "");

  return fixtureScenarios.find(
    (scenario) => fixtureScenarioId(scenario) === fixtureDirectory,
  );
}

function scenarioNeedsPlaywrightEnvironment(
  scenario: FixtureScenario,
): boolean {
  return (
    scenario.basePreset === "vue-app" ||
    scenario.basePreset === "vue-hono-app" ||
    scenario.addedPreset === "vue-app"
  );
}

async function writeExecutable(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

describe("fixture checks", () => {
  it("runs machine-verifiable Next Step Instructions for generated repositories", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-fixture-test-"),
    );
    const binDir = path.join(workspace, "bin");
    const logPath = path.join(workspace, "commands.jsonl");
    const officialFetchLogPath = path.join(workspace, "official-fetches.txt");
    const webRootCheckLockPath = path.join(workspace, "web-root-check.lock");
    const fetchGuardPath = path.join(
      workspace,
      "guard-official-toolchain-fetches.mjs",
    );
    const realPnpm = (await execa("which", ["pnpm"])).stdout;

    await mkdir(binDir, { recursive: true });
    await writeFile(
      fetchGuardPath,
      [
        'import { appendFileSync } from "node:fs";',
        "",
        "const officialToolchainUrls = new Set([",
        '  "https://nodejs.org/dist/index.json",',
        '  "https://registry.npmjs.org/pnpm"',
        "]);",
        "const originalFetch = globalThis.fetch;",
        "globalThis.fetch = async (input, init) => {",
        "  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;",
        "  if (officialToolchainUrls.has(url)) {",
        "    appendFileSync(process.env.OFFICIAL_TOOLCHAIN_FETCH_LOG, `${url}\\n`);",
        "    return new Response('{}', {",
        "      status: 200,",
        "      headers: { 'content-type': 'application/json' }",
        "    });",
        "  }",
        "  return originalFetch(input, init);",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeExecutable(
      path.join(binDir, "pnpm"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync, closeSync, openSync, rmSync } from "node:fs";',
        'import path from "node:path";',
        'import { spawnSync } from "node:child_process";',
        "",
        "const args = process.argv.slice(2);",
        "const sleep = async (ms) => {",
        "  await new Promise((resolve) => setTimeout(resolve, ms));",
        "};",
        "const scenarioId = path.basename(process.cwd()).replace(/^fixture-/, '');",
        "const needsWebRootCheckLock =",
        "  scenarioId.startsWith('vue-app') ||",
        "  scenarioId.startsWith('vue-hono-app') ||",
        "  scenarioId.includes('-add-vue-app');",
        "appendFileSync(",
        "  process.env.FIXTURE_COMMAND_LOG,",
        "  JSON.stringify({",
        "    command: 'pnpm',",
        "    args,",
        "    cwd: process.cwd(),",
        "    ci: process.env.CI ?? null",
        "  }) + '\\n'",
        ");",
        "",
        "if (",
        "  args[0] === 'run' &&",
        "  args[1] === 'check' &&",
        "  needsWebRootCheckLock",
        ") {",
        "  let fd;",
        "  try {",
        "    fd = openSync(process.env.FIXTURE_WEB_ROOT_CHECK_LOCK, 'wx');",
        "  } catch {",
        "    appendFileSync(",
        "      process.env.FIXTURE_COMMAND_LOG,",
        "      JSON.stringify({",
        "        command: 'web-root-check-concurrency-violation',",
        "        args,",
        "        cwd: process.cwd(),",
        "        ci: process.env.CI ?? null",
        "      }) + '\\n'",
        "    );",
        "    process.exit(1);",
        "  }",
        "  await sleep(20);",
        "  closeSync(fd);",
        "  rmSync(process.env.FIXTURE_WEB_ROOT_CHECK_LOCK, { force: true });",
        "}",
        "",
        "if (",
        "  args[0] === 'exec' &&",
        "  args[1] === 'tsx' &&",
        "  args[2]?.endsWith('/src/cli.ts')",
        ") {",
        "  const result = spawnSync(process.env.REAL_PNPM, args, {",
        "    cwd: process.cwd(),",
        "    env: process.env,",
        "    stdio: 'inherit'",
        "  });",
        "  process.exit(result.status ?? 1);",
        "}",
        "",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    await writeExecutable(
      path.join(binDir, "corepack"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(",
        "  process.env.FIXTURE_COMMAND_LOG,",
        "  JSON.stringify({",
        "    command: 'corepack',",
        "    args: process.argv.slice(2),",
        "    cwd: process.cwd(),",
        "    ci: process.env.CI ?? null",
        "  }) + '\\n'",
        ");",
        "",
      ].join("\n"),
    );
    await writeExecutable(
      path.join(binDir, "cargo"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(",
        "  process.env.FIXTURE_COMMAND_LOG,",
        "  JSON.stringify({",
        "    command: 'cargo',",
        "    args: process.argv.slice(2),",
        "    cwd: process.cwd(),",
        "    ci: process.env.CI ?? null",
        "  }) + '\\n'",
        ");",
        "",
      ].join("\n"),
    );
    await writeExecutable(
      path.join(binDir, "sh"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "",
        "appendFileSync(",
        "  process.env.FIXTURE_COMMAND_LOG,",
        "  JSON.stringify({",
        "    command: 'sh',",
        "    args: process.argv.slice(2),",
        "    cwd: process.cwd(),",
        "    ci: process.env.CI ?? null",
        "  }) + '\\n'",
        ");",
        "",
        "const result = spawnSync('/bin/sh', process.argv.slice(2), {",
        "  cwd: process.cwd(),",
        "  env: process.env,",
        "  stdio: 'inherit'",
        "});",
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
    );

    await execa(realPnpm, ["exec", "tsx", "scripts/check-fixtures.ts"], {
      cwd: repoRoot,
      env: {
        FIXTURE_COMMAND_LOG: logPath,
        FIXTURE_WEB_ROOT_CHECK_LOCK: webRootCheckLockPath,
        OFFICIAL_TOOLCHAIN_FETCH_LOG: officialFetchLogPath,
        TEMPLATE_FIXTURE_CONCURRENCY: "4",
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchGuardPath}`]
          .filter(Boolean)
          .join(" "),
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        REAL_PNPM: realPnpm,
      },
    });

    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CommandRecord);
    const pnpmRecords = records.filter((record) => record.command === "pnpm");
    const officialFetches = await readFile(officialFetchLogPath, "utf8").catch(
      (error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return "";
        }

        throw error;
      },
    );

    expect(officialFetches).toBe("");

    expect(records).not.toContainEqual(
      expect.objectContaining({ command: "corepack" }),
    );
    expect(pnpmRecords).toContainEqual(
      expect.objectContaining({
        args: [
          "--filter",
          "./apps/web",
          "exec",
          "playwright",
          "install",
          "chromium",
        ],
      }),
    );

    const packageAdditionCommands = pnpmRecords.filter(
      (record) =>
        record.args[0] === "exec" &&
        record.args[1] === "tsx" &&
        record.args[3] === "add" &&
        record.args[4] === "package",
    );
    const packageAdditionScenarios = fixtureScenarios.filter(
      (scenario) => scenario.addedPreset,
    );
    expect(packageAdditionCommands).toHaveLength(
      packageAdditionScenarios.length,
    );
    expect(packageAdditionCommands).toEqual(
      expect.arrayContaining(
        packageAdditionScenarios.map((scenario) =>
          expect.objectContaining({
            cwd: expect.stringContaining(
              `fixture-${fixtureScenarioId(scenario)}`,
            ),
            args: expect.arrayContaining(["--preset", scenario.addedPreset]),
          }),
        ),
      ),
    );

    const generatedFixes = pnpmRecords.filter(
      (record) => record.args[0] === "run" && record.args[1] === "fix",
    );
    expect(generatedFixes).toHaveLength(fixtureScenarios.length);
    expect(generatedFixes).toEqual(
      expect.arrayContaining(
        fixtureScenarios.map((scenario) =>
          expect.objectContaining({
            cwd: expect.stringContaining(
              `fixture-${fixtureScenarioId(scenario)}`,
            ),
          }),
        ),
      ),
    );

    const generatedRootChecks = pnpmRecords.filter(
      (record) => record.args[0] === "run" && record.args[1] === "check",
    );
    expect(generatedRootChecks).toHaveLength(fixtureScenarios.length);
    expect(generatedRootChecks).toEqual(
      expect.arrayContaining(
        fixtureScenarios.map((scenario) =>
          expect.objectContaining({
            ci: "1",
            cwd: expect.stringContaining(
              `fixture-${fixtureScenarioId(scenario)}`,
            ),
          }),
        ),
      ),
    );

    expect(records).not.toContainEqual(
      expect.objectContaining({ command: "sh" }),
    );
    expect(records).not.toContainEqual(
      expect.objectContaining({
        command: "web-root-check-concurrency-violation",
      }),
    );

    for (const generatedRootCheck of generatedRootChecks) {
      const scenario = fixtureScenarioFromCwd(generatedRootCheck.cwd);
      expect(scenario).toBeDefined();

      const projectRecords = records.filter(
        (record) => record.cwd === generatedRootCheck.cwd,
      );
      const installIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "install",
      );
      const playwrightIndex = projectRecords.findIndex((record) => {
        if (record.command !== "pnpm") {
          return false;
        }

        if (scenario && scenarioNeedsPlaywrightEnvironment(scenario)) {
          return (
            record.args.includes("playwright") &&
            record.args.includes("install") &&
            record.args.includes("chromium")
          );
        }

        return false;
      });
      const checkIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "run check",
      );
      const fixIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "run fix",
      );

      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(fixIndex).toBeGreaterThan(installIndex);
      if (scenario && scenarioNeedsPlaywrightEnvironment(scenario)) {
        expect(playwrightIndex).toBeGreaterThan(fixIndex);
        expect(checkIndex).toBeGreaterThan(playwrightIndex);
        continue;
      }

      expect(checkIndex).toBeGreaterThan(fixIndex);
    }
  }, 240_000);
});
