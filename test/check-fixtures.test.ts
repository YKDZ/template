import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

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

async function writeExecutable(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

describe("fixture checks", () => {
  it("runs generated root checks with CI-equivalent Playwright setup", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-fixture-test-"),
    );
    const binDir = path.join(workspace, "bin");
    const logPath = path.join(workspace, "commands.jsonl");
    const officialFetchLogPath = path.join(workspace, "official-fetches.txt");
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

    await execa(realPnpm, ["exec", "tsx", "scripts/check-fixtures.ts"], {
      cwd: repoRoot,
      env: {
        FIXTURE_COMMAND_LOG: logPath,
        OFFICIAL_TOOLCHAIN_FETCH_LOG: officialFetchLogPath,
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

    expect(records).toContainEqual(
      expect.objectContaining({
        command: "corepack",
        args: ["enable"],
      }),
    );
    expect(pnpmRecords).toContainEqual(
      expect.objectContaining({
        args: ["exec", "playwright", "install", "--with-deps", "chromium"],
      }),
    );
    expect(pnpmRecords).toContainEqual(
      expect.objectContaining({
        args: [
          "--filter",
          "./apps/web",
          "exec",
          "playwright",
          "install",
          "--with-deps",
          "chromium",
        ],
      }),
    );

    const generatedRootChecks = pnpmRecords.filter(
      (record) => record.args[0] === "run" && record.args[1] === "check",
    );
    expect(generatedRootChecks).toHaveLength(4);
    expect(generatedRootChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ci: "1",
          cwd: expect.stringContaining("fixture-ts-lib"),
        }),
        expect.objectContaining({
          ci: "1",
          cwd: expect.stringContaining("fixture-hono-api"),
        }),
        expect.objectContaining({
          ci: "1",
          cwd: expect.stringContaining("fixture-vue-app"),
        }),
        expect.objectContaining({
          ci: "1",
          cwd: expect.stringContaining("fixture-vue-hono-app"),
        }),
      ]),
    );

    for (const generatedRootCheck of generatedRootChecks) {
      const projectRecords = records.filter(
        (record) => record.cwd === generatedRootCheck.cwd,
      );
      const corepackIndex = projectRecords.findIndex(
        (record) =>
          record.command === "corepack" && record.args.join(" ") === "enable",
      );
      const installIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "install",
      );
      const playwrightIndex = projectRecords.findIndex((record) => {
        if (record.command !== "pnpm") {
          return false;
        }

        if (generatedRootCheck.cwd.includes("fixture-vue-app")) {
          return (
            record.args.join(" ") ===
            "exec playwright install --with-deps chromium"
          );
        }

        if (generatedRootCheck.cwd.includes("fixture-vue-hono-app")) {
          return (
            record.args.join(" ") ===
            "--filter ./apps/web exec playwright install --with-deps chromium"
          );
        }

        return false;
      });
      const checkIndex = projectRecords.findIndex(
        (record) =>
          record.command === "pnpm" && record.args.join(" ") === "run check",
      );

      expect(corepackIndex).toBeGreaterThanOrEqual(0);
      expect(installIndex).toBeGreaterThan(corepackIndex);
      if (generatedRootCheck.cwd.includes("fixture-vue")) {
        expect(playwrightIndex).toBeGreaterThan(installIndex);
        expect(checkIndex).toBeGreaterThan(playwrightIndex);
        continue;
      }

      expect(checkIndex).toBeGreaterThan(installIndex);
    }
  }, 120_000);
});
