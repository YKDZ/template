import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import {
  generatedScenarioId,
  generatedScenarioQualityGateSteps,
  selectGeneratedScenarios,
  type GeneratedScenario,
} from "@ykdz/template-core/generated-scenarios";
import { execa } from "execa";
import * as v from "valibot";

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

const commandRecordSchema = v.object({
  command: v.string(),
  args: v.array(v.string()),
  cwd: v.string(),
  ci: v.nullable(v.string()),
});

const fixtureScenarios = selectGeneratedScenarios(
  loadBuiltInPresetSourceManifest(),
  "package-addition-matrix",
).runnable;

function fixtureScenarioFromCwd(cwd: string): GeneratedScenario | undefined {
  const fixtureDirectory = path.basename(cwd).replace(/^fixture-/, "");

  return fixtureScenarios.find((scenario) => scenario.id === fixtureDirectory);
}

function scenarioNeedsPlaywrightEnvironment(
  scenario: GeneratedScenario,
): boolean {
  return generatedScenarioQualityGateSteps(
    loadBuiltInPresetSourceManifest(),
    scenario,
    "/generated-repository",
    scenario.addedPreset === undefined ? undefined : "packages/fixture-added",
    {
      repoRoot,
      cliPath: path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
      projectionSourceRoots: builtInPresetProjectionSourceRoots(),
      reporter: {},
      runCommand: async () => {},
    },
  ).some((step) => step.environmentNeedKind === "playwright-browser-assets");
}

function scenarioNeedsDeployment(scenario: GeneratedScenario): boolean {
  return generatedScenarioQualityGateSteps(
    loadBuiltInPresetSourceManifest(),
    scenario,
    "/generated-repository",
    scenario.addedPreset === undefined ? undefined : "packages/fixture-added",
    {
      repoRoot,
      cliPath: path.join(repoRoot, "packages", "cli", "src", "cli.ts"),
      projectionSourceRoots: builtInPresetProjectionSourceRoots(),
      reporter: {},
      runCommand: async () => {},
    },
  ).some((step) => step.id === "run-deployment-check");
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
    const replayCachePath = path.join(workspace, "replay-cache");
    const fetchGuardPath = path.join(
      workspace,
      "guard-official-toolchain-fetches.mjs",
    );
    const realPnpm = (await execa("which", ["pnpm"])).stdout;

    await mkdir(binDir, { recursive: true });
    await writeExecutable(
      path.join(binDir, "node"),
      [
        `#!${process.execPath}`,
        'import { appendFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "",
        "const args = process.argv.slice(2);",
        "appendFileSync(",
        "  process.env.FIXTURE_COMMAND_LOG,",
        "  JSON.stringify({",
        "    command: 'node',",
        "    args,",
        "    cwd: process.cwd(),",
        "    ci: process.env.CI ?? null",
        "  }) + '\\n'",
        ");",
        `const result = spawnSync(${JSON.stringify(process.execPath)}, args, {`,
        "  cwd: process.cwd(),",
        "  env: process.env,",
        "  stdio: 'inherit'",
        "});",
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
    );
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
        'import { appendFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "",
        "const args = process.argv.slice(2);",
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
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(",
        "  process.env.FIXTURE_COMMAND_LOG,",
        "  JSON.stringify({",
        "    command: 'docker',",
        "    args: process.argv.slice(2),",
        "    cwd: process.cwd(),",
        "    ci: process.env.CI ?? null",
        "  }) + '\\n'",
        ");",
        "process.exit(process.env.FIXTURE_DOCKER_AVAILABLE === '1' ? 0 : 1);",
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

    const dockerAvailableRun = await execa(
      process.execPath,
      ["--conditions=source", "packages/checks/src/check-fixtures.ts"],
      {
        cwd: repoRoot,
        env: {
          FIXTURE_COMMAND_LOG: logPath,
          FIXTURE_DOCKER_AVAILABLE: "1",
          OFFICIAL_TOOLCHAIN_FETCH_LOG: officialFetchLogPath,
          TEMPLATE_FIXTURE_CONCURRENCY: "4",
          TEMPLATE_FIXTURE_REPLAY_CACHE_DIR: replayCachePath,
          TEMPLATE_FIXTURE_REPLAY_CACHE_READ: "0",
          TEMPLATE_FIXTURE_REPLAY_CACHE_WRITE: "1",
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchGuardPath}`]
            .filter(Boolean)
            .join(" "),
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          REAL_PNPM: realPnpm,
        },
      },
    );

    expect(dockerAvailableRun.exitCode).toBe(0);

    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line): CommandRecord =>
          v.parse(commandRecordSchema, JSON.parse(line) as unknown),
      );
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

    const packageAdditionCommands = records.filter(
      (record) =>
        record.command === "node" &&
        record.args[0] === "--conditions=source" &&
        record.args[2] === "add" &&
        record.args[3] === "package",
    );
    const packageAdditionScenarios = fixtureScenarios.filter(
      (scenario) => scenario.addedPreset,
    );
    expect(packageAdditionCommands).toHaveLength(
      packageAdditionScenarios.length,
    );
    for (const scenario of packageAdditionScenarios) {
      const addedPreset = scenario.addedPreset;

      if (!addedPreset) {
        throw new Error(`Scenario ${scenario.id} must add a package.`);
      }

      expect(
        packageAdditionCommands.some(
          (record) =>
            record.cwd.includes(`fixture-${generatedScenarioId(scenario)}`) &&
            record.args.includes("--preset") &&
            record.args.includes(addedPreset),
        ),
      ).toBe(true);
    }
    const linkedScenario = packageAdditionScenarios.find(
      (scenario) => scenario.linkFrom && scenario.linkFrom.length > 0,
    );
    expect(linkedScenario).toBeDefined();
    if (!linkedScenario) {
      throw new Error("Expected a linked Package Addition scenario.");
    }
    expect(packageAdditionCommands).toContainEqual(
      expect.objectContaining({
        cwd: expect.stringContaining(
          `fixture-${generatedScenarioId(linkedScenario)}`,
        ),
        args: expect.arrayContaining(["--link-from", "apps/web"]),
      }),
    );

    const generatedFixes = pnpmRecords.filter(
      (record) => record.args[0] === "run" && record.args[1] === "fix",
    );
    expect(generatedFixes).toHaveLength(fixtureScenarios.length);
    for (const scenario of fixtureScenarios) {
      expect(
        generatedFixes.some((record) =>
          record.cwd.includes(`fixture-${generatedScenarioId(scenario)}`),
        ),
      ).toBe(true);
    }

    const generatedRootChecks = pnpmRecords.filter(
      (record) => record.args[0] === "run" && record.args[1] === "check",
    );
    const generatedDeploymentChecks = pnpmRecords.filter(
      (record) =>
        record.args[0] === "run" && record.args[1] === "check:deployment",
    );
    const deploymentScenarios = fixtureScenarios.filter(
      scenarioNeedsDeployment,
    );
    expect(generatedDeploymentChecks).toHaveLength(deploymentScenarios.length);
    expect(
      records.filter(
        (record) => record.command === "docker" && record.args[0] === "info",
      ),
    ).toHaveLength(deploymentScenarios.length);
    expect(generatedRootChecks).toHaveLength(fixtureScenarios.length);
    for (const scenario of fixtureScenarios) {
      expect(
        generatedRootChecks.some(
          (record) =>
            record.ci === "1" &&
            record.cwd.includes(`fixture-${generatedScenarioId(scenario)}`),
        ),
      ).toBe(true);
    }

    expect(records).not.toContainEqual(
      expect.objectContaining({ command: "sh" }),
    );

    for (const generatedRootCheck of generatedRootChecks) {
      const scenario = fixtureScenarioFromCwd(generatedRootCheck.cwd);
      expect(scenario).toBeDefined();

      const projectRecords = records.filter(
        (record) => record.cwd === generatedRootCheck.cwd,
      );
      const lockfileInstallIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" &&
          record.args.join(" ") ===
            "install --lockfile-only --prefer-offline --no-frozen-lockfile",
      );
      const fetchIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "fetch",
      );
      const offlineInstallIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" &&
          record.args.join(" ") === "install --offline --frozen-lockfile",
      );
      const playwrightIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" &&
          record.args.includes("playwright") &&
          record.args.includes("install") &&
          record.args.includes("chromium"),
      );
      const checkIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "run check",
      );
      const fixIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "run fix",
      );
      const dockerIndex = projectRecords.findIndex(
        (record) => record.command === "docker" && record.args[0] === "info",
      );
      const deploymentIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" &&
          record.args.join(" ") === "run check:deployment",
      );

      expect(lockfileInstallIndex).toBeGreaterThanOrEqual(0);
      expect(fetchIndex).toBeGreaterThan(lockfileInstallIndex);
      expect(offlineInstallIndex).toBeGreaterThan(fetchIndex);
      expect(fixIndex).toBeGreaterThan(offlineInstallIndex);
      const needsPlaywrightEnvironment =
        scenario !== undefined && scenarioNeedsPlaywrightEnvironment(scenario);
      if (needsPlaywrightEnvironment) {
        expect(playwrightIndex).toBeGreaterThan(fixIndex);
        expect(checkIndex).toBeGreaterThan(playwrightIndex);
      } else {
        expect(playwrightIndex).toBe(-1);
        expect(checkIndex).toBeGreaterThan(fixIndex);
      }

      if (scenario !== undefined && scenarioNeedsDeployment(scenario)) {
        expect(dockerIndex).toBeGreaterThan(checkIndex);
        expect(deploymentIndex).toBeGreaterThan(dockerIndex);
      } else {
        expect(dockerIndex).toBe(-1);
        expect(deploymentIndex).toBe(-1);
      }
    }

    await writeFile(logPath, "", "utf8");
    const dockerUnavailableRun = await execa(
      process.execPath,
      ["--conditions=source", "packages/checks/src/check-fixtures.ts"],
      {
        cwd: repoRoot,
        env: {
          FIXTURE_COMMAND_LOG: logPath,
          FIXTURE_DOCKER_AVAILABLE: "0",
          OFFICIAL_TOOLCHAIN_FETCH_LOG: officialFetchLogPath,
          TEMPLATE_FIXTURE_CONCURRENCY: "4",
          TEMPLATE_FIXTURE_REPLAY_CACHE_DIR: replayCachePath,
          TEMPLATE_FIXTURE_REPLAY_CACHE_READ: "1",
          TEMPLATE_FIXTURE_REPLAY_CACHE_WRITE: "0",
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchGuardPath}`]
            .filter(Boolean)
            .join(" "),
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          REAL_PNPM: realPnpm,
        },
        reject: false,
      },
    );
    const unavailableRecords = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line): CommandRecord =>
          v.parse(commandRecordSchema, JSON.parse(line) as unknown),
      );

    expect(dockerUnavailableRun.exitCode).not.toBe(0);
    expect(dockerUnavailableRun.stderr).toMatch(
      /Deployment check requires the docker-engine Check Environment capability/u,
    );
    expect(dockerUnavailableRun.stdout).not.toMatch(
      /Replayed passed deployment fixture vike-app \+ ts-lib/u,
    );
    expect(
      unavailableRecords.filter(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "run check",
      ),
    ).toHaveLength(0);
    const unavailableInstalls = unavailableRecords.filter(
      (record) =>
        record.command === "pnpm" &&
        record.args.join(" ") ===
          "install --lockfile-only --prefer-offline --no-frozen-lockfile",
    );
    expect(unavailableInstalls.length).toBeGreaterThan(0);
    expect(unavailableInstalls.length).toBeLessThanOrEqual(
      fixtureScenarios.length,
    );
    expect(unavailableRecords).not.toContainEqual(
      expect.objectContaining({ args: ["run", "check:deployment"] }),
    );

    const reverseReplayCachePath = path.join(workspace, "reverse-replay-cache");
    const runReplayTransition = async (
      dockerAvailable: "0" | "1",
      read: "0" | "1",
      write: "0" | "1",
    ) => {
      await writeFile(logPath, "", "utf8");
      const result = await execa(
        process.execPath,
        ["--conditions=source", "packages/checks/src/check-fixtures.ts"],
        {
          cwd: repoRoot,
          env: {
            FIXTURE_COMMAND_LOG: logPath,
            FIXTURE_DOCKER_AVAILABLE: dockerAvailable,
            OFFICIAL_TOOLCHAIN_FETCH_LOG: officialFetchLogPath,
            TEMPLATE_FIXTURE_CONCURRENCY: "4",
            TEMPLATE_FIXTURE_REPLAY_CACHE_DIR: reverseReplayCachePath,
            TEMPLATE_FIXTURE_REPLAY_CACHE_READ: read,
            TEMPLATE_FIXTURE_REPLAY_CACHE_WRITE: write,
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${fetchGuardPath}`,
            ]
              .filter(Boolean)
              .join(" "),
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            REAL_PNPM: realPnpm,
          },
          reject: false,
        },
      );
      const transitionRecords = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line): CommandRecord =>
            v.parse(commandRecordSchema, JSON.parse(line) as unknown),
        );
      return { result, transitionRecords };
    };

    const unavailableMiss = await runReplayTransition("0", "0", "1");
    expect(unavailableMiss.result.exitCode).not.toBe(0);
    expect(unavailableMiss.result.stderr).toMatch(
      /Deployment check requires the docker-engine Check Environment capability/u,
    );
    expect(unavailableMiss.transitionRecords).not.toContainEqual(
      expect.objectContaining({ args: ["run", "check:deployment"] }),
    );

    const availableAfterUnavailable = await runReplayTransition("1", "1", "1");
    expect(
      availableAfterUnavailable.transitionRecords.filter(
        (record) => record.args.join(" ") === "run check:deployment",
      ),
    ).toHaveLength(deploymentScenarios.length);

    const availableReplay = await runReplayTransition("1", "1", "0");
    expect(
      availableReplay.transitionRecords.filter(
        (record) => record.command === "docker" && record.args[0] === "info",
      ),
    ).toHaveLength(deploymentScenarios.length);
    expect(availableReplay.transitionRecords).not.toContainEqual(
      expect.objectContaining({ args: ["run", "check:deployment"] }),
    );
    expect(availableReplay.result.stdout).toMatch(
      /Replayed passed deployment fixture vike-app \+ ts-lib/u,
    );
  }, 240_000);
});
