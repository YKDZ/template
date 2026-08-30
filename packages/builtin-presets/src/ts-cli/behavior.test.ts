import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryInitialization,
  resolveBuiltInTemplateSource,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

import { tsCliDefinition } from "./definition.ts";

async function renderInstalledGeneratedRepository(prefix: string): Promise<{
  readonly workspace: string;
  readonly targetDir: string;
  readonly packageRoot: string;
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const targetDir = path.join(workspace, "demo-cli");
  const plan = planGeneratedRepositoryInitialization({
    definition: tsCliDefinition,
    context: createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    }),
  });
  await renderNewProject({
    targetRoot: targetDir,
    operations: [...plan.operations],
  });
  await execa("pnpm", ["install"], { cwd: targetDir });
  return {
    workspace,
    targetDir,
    packageRoot: path.join(targetDir, "packages/cli"),
  };
}

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
}

function expectNoControlCharacters(value: string): void {
  for (const line of value.split("\n"))
    expect(
      Array.from(line).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      }),
    ).toBe(false);
}

async function writeAcceptedFirstReleaseArtifact(options: {
  readonly root: string;
  readonly packageName: string;
  readonly commandName: string;
}): Promise<{ readonly directory: string; readonly integrity: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "ticket-13-artifact-"));
  const bytes = Buffer.from("ticket-13 accepted tarball\n");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const file = "ship-1.0.0.tgz";
  await writeFile(path.join(directory, file), bytes);
  await writeFile(
    path.join(directory, "SHA512SUMS"),
    `${createHash("sha512").update(bytes).digest("hex")}  ${file}\n`,
  );
  await writeFile(
    path.join(directory, "verified-publication-artifact.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        publication: {
          packageName: options.packageName,
          version: "1.0.0",
          commandName: options.commandName,
          repository: "git+https://github.com/demo/ship.git",
          releaseDate: "2026-08-30",
          releaseNotes: "Initial release.",
        },
        packedManifest: {
          name: options.packageName,
          version: "1.0.0",
          bin: { [options.commandName]: "./dist/cli.js" },
          repository: {
            type: "git",
            url: "git+https://github.com/demo/ship.git",
            directory: "packages/cli",
          },
        },
        artifact: {
          file,
          checksumFile: "SHA512SUMS",
          integrity,
          size: bytes.byteLength,
        },
        files: [
          "package/CHANGELOG.md",
          "package/LICENSE",
          "package/README.md",
          "package/dist/cli-command-identity.js",
          "package/dist/cli.js",
          "package/dist/main.js",
          "package/package.json",
        ].map((entry, index) => ({
          path: entry,
          mode: entry === "package/dist/cli.js" ? 0o755 : 0o644,
          size: index + 1,
        })),
        bin: {
          path: "package/dist/cli.js",
          shebang: "#!/usr/bin/env node",
          mode: 0o755,
          posixExecutableChecked: process.platform !== "win32",
        },
        smokes: [
          { name: "runtime-import", args: [], stdout: "" },
          {
            name: "help",
            args: ["--help"],
            stdout: `Usage: ${options.commandName} greet`,
          },
          { name: "version", args: ["--version"], stdout: "1.0.0\n" },
          {
            name: "greet",
            args: ["greet", "  Ada Lovelace  "],
            stdout: "Hello, Ada Lovelace\n",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { directory, integrity };
}

describe("ts-cli Preset Definition behavior", () => {
  it("plans the registered unpublished CLI Tool Package boundary", () => {
    expect(tsCliDefinition.initialPrimaryPackage.defaultLeafName).toBe("cli");
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-cli"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const contribution =
      tsCliDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "cli",
          definition: {
            name: "@demo/cli",
            path: "packages/cli",
            role: "cli-tool",
          },
        },
      });

    expect(resolveBuiltInTemplateSource(tsCliDefinition.source, ".")).toMatch(
      /templates[\\/]ts-cli$/,
    );
    expect(contribution.definition).toEqual({
      name: "@demo/cli",
      path: "packages/cli",
      role: "cli-tool",
    });
    expect(contribution.manifest).toMatchObject({
      name: "@demo/cli",
      private: true,
      files: ["dist"],
      type: "module",
      bin: { cli: "./dist/cli.js" },
      dependencies: { commander: "catalog:" },
      engines: { node: ">=24" },
      scripts: {
        build: "tsc -p tsconfig.build.json --pretty false",
        prepack: "pnpm exec turbo run build --filter=.",
        test: expect.any(String),
        "test:e2e": expect.any(String),
        postbuild: expect.stringContaining("chmodSync('dist/cli.js', 0o755)"),
        typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
      },
    });
    expect(contribution.exposure).toEqual({ exports: {}, imports: {} });
    expect(contribution.planningIdentity).toBe("cli-publication-candidate");
    expect(contribution.foundation.npmPublication).toEqual({
      kind: "public-cli-candidate",
    });
    for (const publicProgrammaticField of [
      "main",
      "types",
      "exports",
      "imports",
      "publishConfig",
      "version",
    ]) {
      expect(contribution.manifest).not.toHaveProperty(publicProgrammaticField);
    }
    expect(contribution.operations).toEqual(
      expect.arrayContaining([
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/cli.ts",
          to: "packages/cli/src/cli.ts",
        },
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/cli-command-identity.ts",
          to: "packages/cli/src/cli-command-identity.ts",
        },
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/main.ts",
          to: "packages/cli/src/main.ts",
        },
      ]),
    );
    expect(contribution.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "replaceAnchors" }),
      ]),
    );

    expect(
      builtInPresetRegistry
        .all()
        .filter((definition) => definition.metadata.name === "ts-cli"),
    ).toHaveLength(1);
    expect(builtInPresetRegistry.require("ts-cli").metadata).toEqual(
      tsCliDefinition.metadata,
    );
  });

  it("adds a CLI Tool Package at default and explicit two-segment paths", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-workspace"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });

    expect(
      tsCliDefinition.defaultPackagePath?.({
        context,
        packageLeafName: "release",
      }),
    ).toBe("packages/release");
    const addition = tsCliDefinition.planPackageAddition?.({
      context,
      packageLeafName: "release",
      packagePath: "tools/release",
    });
    expect(addition?.definition).toEqual({
      name: "@demo/release",
      path: "tools/release",
      role: "cli-tool",
    });
    expect(addition?.planningIdentity).toBe("cli-package-addition");
    expect(addition?.foundation.npmPublication).toBeUndefined();
  });

  it("projects publication readiness only for the initial CLI candidate", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "demo-cli"),
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    });
    const candidate = plan.packageContributions.find(
      (contribution) =>
        contribution.foundation.npmPublication?.kind === "public-cli-candidate",
    );
    const rootManifest = plan.manifests.find(
      (manifest) => manifest.name === "demo-cli",
    );

    expect(candidate?.manifest.devDependencies).toMatchObject({
      "@demo/typescript-config": "link:../typescript-config",
    });
    expect(
      plan.generationRecord.packages.find(
        (record) => record.path === "packages/cli",
      ),
    ).toMatchObject({
      contributionIdentity: "cli-publication-candidate",
      planningContribution: "planInitialization",
    });
    expect(rootManifest).toMatchObject({
      imports: {
        "#npm-publication/*": "./scripts/npm-publication/*.ts",
      },
      scripts: {
        check: expect.stringContaining("publication:artifact"),
        "publication:artifact":
          "node --conditions=source scripts/npm-publication/check-artifact.ts",
        "publication:readiness":
          "node --conditions=source scripts/npm-publication/check-readiness.ts",
      },
      devDependencies: {
        "@types/semver": "catalog:",
        "@types/spdx-expression-parse": "catalog:",
        semver: "catalog:",
        "spdx-expression-parse": "catalog:",
        npm: "catalog:",
        tar: "catalog:",
      },
    });
    const rootScripts = rootManifest?.scripts as Record<string, string>;
    expect(rootScripts.check).toContain(
      "build test:e2e --filter=!./packages/cli",
    );
    expect(rootScripts.check).not.toContain("publication:readiness --continue");
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: ".pnpmfile.mjs" }),
        expect.objectContaining({
          kind: "writeTextTemplate",
          from: "publication/check-readiness.ts",
          to: "scripts/npm-publication/check-readiness.ts",
          replacements: {
            PUBLIC_CLI_PACKAGE_PATH: "packages/cli",
          },
        }),
        expect.objectContaining({
          from: "publication/readiness.ts",
          to: "scripts/npm-publication/readiness.ts",
        }),
        expect.objectContaining({
          from: "publication/artifact.ts",
          to: "scripts/npm-publication/artifact.ts",
        }),
        expect.objectContaining({
          kind: "writeTextTemplate",
          from: "publication/check-artifact.ts",
          to: "scripts/npm-publication/check-artifact.ts",
          replacements: {
            PUBLIC_CLI_PACKAGE_PATH: "packages/cli",
          },
        }),
        expect.objectContaining({
          from: "publication/changelog.ts",
          to: "scripts/npm-publication/changelog.ts",
        }),
        expect.objectContaining({
          from: "src/cli-command-identity.ts",
          to: "scripts/npm-publication/cli-command-identity.ts",
        }),
        expect.objectContaining({
          kind: "writeTextTemplate",
          from: "publication-setup/setup.sh",
          to: "scripts/npm-publication-setup/setup.sh",
        }),
        expect.objectContaining({
          kind: "writeTextTemplate",
          from: "publication-setup/bridge.ts",
          to: "scripts/npm-publication-setup/bridge.ts",
          replacements: {
            PUBLIC_CLI_PACKAGE_PATH: "packages/cli",
          },
        }),
      ]),
    );
    expect(
      plan.operations.some(
        (operation) =>
          "from" in operation &&
          typeof operation.from === "string" &&
          operation.from.includes("bridge.mjs"),
      ),
    ).toBe(false);
  });

  it("keeps the one-time publication setup handoff outside the generated plan", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      targetDir: path.join("generated-repository", "demo-cli"),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });

    expect(preparation.publicationSetup).toEqual({
      command: "./scripts/npm-publication-setup/setup.sh",
    });
    expect(preparation.plan.nextStepInstructions).toHaveLength(3);
    expect(
      preparation.plan.nextStepInstructions.map(({ display }) => display),
    ).not.toContain("./scripts/npm-publication-setup/setup.sh");
  });

  it("does not expose a publication setup handoff for a non-candidate preset", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("ts-lib"),
      targetDir: path.join("generated-repository", "demo-library"),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });

    expect(preparation.publicationSetup).toBeNull();
    expect(
      preparation.plan.operations.some(
        (operation) =>
          "to" in operation &&
          operation.to.startsWith("scripts/npm-publication-setup/"),
      ),
    ).toBe(false);
  });

  it("serves the generated setup status through its only executable interface", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-setup-status-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    try {
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir,
          defaultPackageScope: "demo",
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        }),
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await symlink(
        path.resolve(import.meta.dirname, "../../node_modules"),
        path.join(targetDir, "node_modules"),
        "dir",
      );

      const commandsWithoutPnpm = path.join(workspace, "commands-without-pnpm");
      await writeExecutable(
        path.join(commandsWithoutPnpm, "bash"),
        '#!/bin/sh\nexec /usr/bin/bash "$@"\n',
      );
      await writeExecutable(
        path.join(commandsWithoutPnpm, "node"),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      );
      await writeExecutable(
        path.join(commandsWithoutPnpm, "dirname"),
        '#!/bin/sh\nexec /usr/bin/dirname "$@"\n',
      );
      await writeExecutable(
        path.join(commandsWithoutPnpm, "sed"),
        '#!/bin/sh\nexec /usr/bin/sed "$@"\n',
      );
      await writeExecutable(
        path.join(commandsWithoutPnpm, "tr"),
        '#!/bin/sh\nexec /usr/bin/tr "$@"\n',
      );
      const missingPnpm = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        {
          cwd: targetDir,
          env: { PATH: commandsWithoutPnpm },
          reject: false,
        },
      );
      expect(missingPnpm.exitCode).toBe(5);
      expect(missingPnpm.stdout).toContain("STAGE 1/7 Check prerequisites");
      expect(missingPnpm.stdout).toContain("CHECK local-toolchain");
      expect(missingPnpm.stdout).not.toContain(
        "STAGE 2/7 Configure the public package",
      );
      expect(missingPnpm.stderr).toContain("ERROR prerequisite-command");
      expect(missingPnpm.stderr).toContain("pnpm is unavailable");

      const result = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        { cwd: targetDir, reject: false },
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        currentStage: { id: "configure-public-package", number: 2 },
        observations: {
          packagePath: "packages/cli",
          readiness: "safe-unconfigured",
        },
        nextAction: { kind: "provide-public-facts" },
      });
      expect(result.stderr).toBe("");

      const missingFacts = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, reject: false, input: "unexpected stdin\n" },
      );
      expect(missingFacts.exitCode).toBe(3);
      expect(missingFacts.stderr).toContain(
        "ACTION REQUIRED public-fact-required",
      );

      const promptEof = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [],
        { cwd: targetDir, input: "", reject: false },
      );
      expect(promptEof.exitCode).toBe(3);
      expect(promptEof.stderr).toContain(
        "ACTION REQUIRED public-fact-required",
      );
      expect(promptEof.stderr).toContain("Observed: end of input");

      for (const args of [
        ["--status"],
        ["--json"],
        ["--password", "not-read"],
        ["--release-date", "2099-01-01"],
      ]) {
        const rejected = await execa(
          "./scripts/npm-publication-setup/setup.sh",
          args,
          { cwd: targetDir, reject: false, input: "must not be read\n" },
        );
        expect(rejected.exitCode).toBe(2);
        expect(rejected.stderr).toContain("ERROR publication-setup-usage");
      }

      const invalidStatus = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json", "--password", "not-read"],
        { cwd: targetDir, reject: false },
      );
      expect(invalidStatus.exitCode).toBe(2);
      expect(invalidStatus.stderr).toBe("");
      expect(JSON.parse(invalidStatus.stdout)).toMatchObject({
        schemaVersion: 1,
        blockers: [
          expect.objectContaining({ code: "publication-setup-usage" }),
        ],
      });

      const invalidLicense = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--package-name",
          "@demo/ship",
          "--bin",
          "ship",
          "--description",
          "A focused command-line release tool.",
          "--license",
          "definitely-not-spdx",
          "--copyright-holder",
          "Ada Lovelace",
          "--repository",
          "https://github.com/demo/ship",
          "--non-interactive",
        ],
        { cwd: targetDir, reject: false },
      );
      expect(invalidLicense.exitCode).toBe(2);
      expect(invalidLicense.stderr).toContain("ERROR public-fact-invalid");

      for (const [flag, value] of [
        ["--package-name", "@demo/UPPER"],
        ["--bin", "BAD"],
        ["--bin", "node"],
        ["--repository", "https://credential@github.com/demo/ship"],
      ] as const) {
        const invalidPublicFact = await execa(
          "./scripts/npm-publication-setup/setup.sh",
          [
            "--package-name",
            "@demo/ship",
            "--bin",
            "ship",
            "--description",
            "A focused command-line release tool.",
            "--license",
            "MIT",
            "--copyright-holder",
            "Ada Lovelace",
            "--repository",
            "https://github.com/demo/ship",
            flag,
            value,
            "--non-interactive",
          ],
          { cwd: targetDir, reject: false },
        );
        expect(invalidPublicFact.exitCode).toBe(2);
        expect(invalidPublicFact.stderr).toContain("public-fact-invalid");
      }

      const partialInteractive = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--package-name", "@demo/ship"],
        {
          cwd: targetDir,
          input:
            "ship\nA focused command-line release tool.\nMIT\nAda Lovelace\nhttps://github.com/demo/ship\n",
          reject: false,
        },
      );
      expect(partialInteractive.exitCode).toBe(5);
      expect(partialInteractive.stdout).toContain("Command name:");
      expect(partialInteractive.stdout).not.toContain("Package name:");

      const configured = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--package-name",
          "@demo/ship",
          "--bin",
          "ship",
          "--description",
          "A focused command-line release tool.",
          "--license",
          "MIT",
          "--copyright-holder",
          "Ada Lovelace",
          "--repository",
          "https://github.com/demo/ship",
          "--non-interactive",
        ],
        { cwd: targetDir, reject: false },
      );
      expect(
        configured.exitCode,
        `${configured.stdout}\n${configured.stderr}`,
      ).toBe(5);
      expect(configured.stdout).toContain(
        "STAGE 2/7 Configure the public package",
      );
      expect(configured.stdout).not.toContain(String.fromCharCode(27));
      expect(configured.stdout).not.toContain("\r");
      expect(configured.stderr).not.toContain("not-read");
      const configuredManifest = JSON.parse(
        await readFile(
          path.join(targetDir, "packages/cli/package.json"),
          "utf8",
        ),
      );
      expect(configuredManifest).toMatchObject({
        name: "@demo/ship",
        version: "1.0.0",
      });
      expect(configuredManifest).not.toHaveProperty("private");

      const holderConflict = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--copyright-holder", "Grace Hopper", "--non-interactive"],
        { cwd: targetDir, reject: false },
      );
      expect(holderConflict.exitCode).toBe(4);
      expect(holderConflict.stderr).toContain("owner-fact-conflict");
      expect(await readFile(path.join(targetDir, "LICENSE"), "utf8")).toContain(
        "Ada Lovelace",
      );

      const fakeBin = path.join(workspace, "fake-bin");
      const gitLedger = path.join(workspace, "git-ledger");
      await writeExecutable(
        path.join(fakeBin, "git"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(gitLedger)}
if [ "$1" = status ]; then printf ' M packages/cli/package.json\\n'; exit 0; fi
exit 97
`,
      );
      const dirty = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        {
          cwd: targetDir,
          reject: false,
          env: { PATH: `${fakeBin}:${process.env.PATH}` },
        },
      );
      expect(dirty.exitCode).toBe(3);
      expect(dirty.stderr).toContain("ACTION REQUIRED git-handoff-required");
      expect(await readFile(gitLedger, "utf8")).toBe("status --porcelain\n");

      const conflict = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--description",
          "A different public description.",
          "--non-interactive",
        ],
        { cwd: targetDir, reject: false },
      );
      expect(conflict.exitCode).toBe(4);
      expect(conflict.stderr).toContain("ERROR owner-fact-conflict");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed before configuration for metadata or reviewed owner intent and cleans a failed owner write", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-setup-stage-one-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    const facts = [
      "--package-name",
      "@demo/ship",
      "--bin",
      "ship",
      "--description",
      "A focused command-line release tool.",
      "--license",
      "MIT",
      "--copyright-holder",
      "Ada Lovelace",
      "--repository",
      "https://github.com/demo/ship",
      "--non-interactive",
    ];
    try {
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir,
          defaultPackageScope: "demo",
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        }),
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await symlink(
        path.resolve(import.meta.dirname, "../../node_modules"),
        path.join(targetDir, "node_modules"),
        "dir",
      );
      const unsafeUsage = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["ToKeN=closure-secret\rINJECT\u0085"],
        { cwd: targetDir, reject: false },
      );
      expect(unsafeUsage.exitCode).toBe(2);
      expect(`${unsafeUsage.stdout}\n${unsafeUsage.stderr}`).not.toContain(
        "closure-secret",
      );
      expectNoControlCharacters(`${unsafeUsage.stdout}\n${unsafeUsage.stderr}`);

      const generationPath = path.join(targetDir, ".template/generation.json");
      const originalGeneration = await readFile(generationPath, "utf8");
      await writeFile(generationPath, "{}\n");
      const corruptMetadata = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        facts,
        { cwd: targetDir, reject: false },
      );
      expect(corruptMetadata.exitCode).toBe(4);
      expect(corruptMetadata.stderr).toContain(
        "local-template-metadata-invalid",
      );
      expect(corruptMetadata.stdout).not.toContain(
        "STAGE 2/7 Configure the public package",
      );
      expect(corruptMetadata.stdout).toContain("STAGE 1/7 Check prerequisites");
      const corruptStatus = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        { cwd: targetDir, reject: false },
      );
      expect(corruptStatus.exitCode).toBe(0);
      const corruptStatusBody = JSON.parse(corruptStatus.stdout) as {
        readonly currentStage: { readonly id: string; readonly number: number };
        readonly blockers: readonly { readonly code: string }[];
      };
      expect(corruptStatusBody.currentStage).toMatchObject({
        id: "check-prerequisites",
        number: 1,
      });
      expect(corruptStatusBody).toMatchObject({
        nextAction: { kind: "retry-external-check" },
      });
      expect(corruptStatusBody.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "local-template-metadata-invalid" }),
        ]),
      );
      await writeFile(generationPath, originalGeneration);

      const readmePath = path.join(targetDir, "packages/cli/README.md");
      const manifestPath = path.join(targetDir, "packages/cli/package.json");
      const initialManifest = await readFile(manifestPath, "utf8");
      await writeFile(readmePath, "Reviewed public README.\n");
      const reviewedReadme = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        facts,
        { cwd: targetDir, reject: false },
      );
      expect(reviewedReadme.exitCode).toBe(4);
      expect(reviewedReadme.stderr).toContain("owner-fact-conflict");
      await expect(readFile(readmePath, "utf8")).resolves.toBe(
        "Reviewed public README.\n",
      );
      await expect(readFile(manifestPath, "utf8")).resolves.toBe(
        initialManifest,
      );

      await rm(readmePath);
      const preloader = path.join(workspace, "rename-failure.cjs");
      await writeFile(
        preloader,
        `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const original = fs.renameSync;
fs.renameSync = (from, to) => {
  if (from.includes(".npm-publication-setup-")) throw new Error("simulated rename failure");
  return original(from, to);
};
syncBuiltinESMExports();
`,
      );
      const renameFailure = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        facts,
        {
          cwd: targetDir,
          env: { NODE_OPTIONS: `--require=${preloader}` },
          reject: false,
        },
      );
      expect(renameFailure.exitCode).toBe(5);
      expect(renameFailure.stderr).toContain("configuration-platform-failure");
      expect(
        (await readdir(path.join(targetDir, "packages/cli"))).filter((entry) =>
          entry.includes(".npm-publication-setup-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports the existing Ticket 09 artifact failure without forwarding child bytes", async () => {
    const { workspace, targetDir } = await renderInstalledGeneratedRepository(
      "template-publication-setup-artifact-failure-",
    );
    try {
      const fakeBin = path.join(workspace, "fake-bin");
      await writeExecutable(
        path.join(fakeBin, "git"),
        `#!/usr/bin/env bash
case "$1" in
  status) exit 0 ;;
  symbolic-ref) printf 'main\\n' ;;
  remote) printf 'https://github.com/demo/ship\\n' ;;
  ls-remote)
    if [ "$2" = --symref ]; then printf 'ref: refs/heads/main\\tHEAD\\n0123456789012345678901234567890123456789\\tHEAD\\n'; else printf '0123456789012345678901234567890123456789\\trefs/heads/main\\n'; fi ;;
  rev-parse) printf '0123456789012345678901234567890123456789\\n' ;;
  *) exit 97 ;;
esac
`,
      );
      await writeExecutable(
        path.join(fakeBin, "pnpm"),
        `#!/usr/bin/env bash
[ "$1" = pack ] || exit 97
printf 'TOKEN=artifact-secret \\033[2J\\r\\302\\205\\n' >&2
exit 19
`,
      );
      const result = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--package-name",
          "@demo/ship",
          "--bin",
          "ship",
          "--description",
          "A focused command-line release tool.",
          "--license",
          "MIT",
          "--copyright-holder",
          "Ada Lovelace",
          "--repository",
          "https://github.com/demo/ship",
          "--non-interactive",
        ],
        {
          cwd: targetDir,
          env: { PATH: `${fakeBin}:${process.env.PATH}` },
          reject: false,
        },
      );
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toContain("ERROR artifact-pack-failed");
      expect(result.stderr).toContain("TOKEN=[REDACTED]");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "artifact-secret",
      );
      expectNoControlCharacters(`${result.stdout}\n${result.stderr}`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reaches the existing Ticket 09 artifact caller through setup.sh", async () => {
    const { workspace, targetDir } = await renderInstalledGeneratedRepository(
      "template-publication-setup-real-artifact-",
    );
    try {
      const fakeBin = path.join(workspace, "fake-bin");
      await writeExecutable(
        path.join(fakeBin, "git"),
        `#!/usr/bin/env bash
case "$1" in
  status) exit 0 ;;
  symbolic-ref) printf 'main\\n' ;;
  remote) printf 'https://github.com/demo/ship\\n' ;;
  ls-remote)
    if [ "$2" = --symref ]; then
      printf 'ref: refs/heads/main\\tHEAD\\n0123456789012345678901234567890123456789\\tHEAD\\n'
    else
      printf '0123456789012345678901234567890123456789\\trefs/heads/main\\n'
    fi ;;
  rev-parse) printf '0123456789012345678901234567890123456789\\n' ;;
  *) exit 97 ;;
esac
`,
      );
      const result = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--package-name",
          "@demo/ship",
          "--bin",
          "ship",
          "--description",
          "A focused command-line release tool.",
          "--license",
          "MIT",
          "--copyright-holder",
          "Ada Lovelace",
          "--repository",
          "https://github.com/demo/ship",
          "--non-interactive",
        ],
        {
          cwd: targetDir,
          env: { PATH: `${fakeBin}:${process.env.PATH}` },
          reject: false,
        },
      );
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(3);
      expect(result.stdout).toContain(
        "STAGE 4/7 Verify the first release artifact",
      );
      expect(result.stdout).toContain("Package: @demo/ship@1.0.0");
      expect(result.stdout).toContain("Artifact:");
      expect(result.stderr).toContain("artifact-acceptance-required");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs the isolated npm first-publish and exact-resume bridge through a generated terminal", async () => {
    const { workspace, targetDir } = await renderInstalledGeneratedRepository(
      "template-publication-setup-ticket-13-",
    );
    const fakeBin = path.join(workspace, "fake-bin");
    const statePath = path.join(workspace, "npm-state.json");
    const setupDirectory = path.join(
      targetDir,
      "scripts/npm-publication-setup",
    );
    const bridgePath = path.join(setupDirectory, "bridge.ts");
    const configureEnvironment = {
      REPOSITORY_ROOT: targetDir,
      SETUP_DIR: setupDirectory,
      PACKAGE_NAME: "@demo/ship",
      COMMAND_NAME: "ship",
      DESCRIPTION: "A focused command-line release tool.",
      LICENSE_NAME: "MIT",
      COPYRIGHT_HOLDER: "Ada Lovelace",
      REPOSITORY_URL: "https://github.com/demo/ship",
    };
    try {
      for (const command of ["format:check", "lint", "typecheck"] as const) {
        const checked = await execa("pnpm", ["run", command], {
          cwd: targetDir,
          reject: false,
        });
        expect(
          checked.exitCode,
          `${command}: ${checked.stdout}\n${checked.stderr}`,
        ).toBe(0);
      }
      const projectedBridge = await readFile(bridgePath, "utf8");
      await writeFile(
        bridgePath,
        `${projectedBridge}\nconst formatProbe={ value: 1 };\n`,
      );
      const malformed = await execa("pnpm", ["run", "format:check"], {
        cwd: targetDir,
        reject: false,
      });
      expect(malformed.exitCode).not.toBe(0);
      await writeFile(bridgePath, projectedBridge);
      await writeFile(bridgePath, `${projectedBridge}\nconst lintProbe = 1;\n`);
      const lintViolation = await execa("pnpm", ["run", "lint"], {
        cwd: targetDir,
        reject: false,
      });
      expect(lintViolation.exitCode).not.toBe(0);
      await writeFile(bridgePath, projectedBridge);
      await writeFile(
        bridgePath,
        `${projectedBridge}\nenum InvalidBridgeEnum { Value }\n`,
      );
      const nonErasable = await execa("pnpm", ["run", "typecheck"], {
        cwd: targetDir,
        reject: false,
      });
      expect(nonErasable.exitCode).not.toBe(0);
      await writeFile(bridgePath, projectedBridge);
      const restoredTypecheck = await execa("pnpm", ["run", "typecheck"], {
        cwd: targetDir,
        reject: false,
      });
      expect(restoredTypecheck.exitCode).toBe(0);
      const configured = await execa(
        process.execPath,
        [
          "--conditions=source",
          "scripts/npm-publication-setup/bridge.ts",
          "configure",
        ],
        { cwd: targetDir, env: configureEnvironment, reject: false },
      );
      expect(configured.exitCode).toBe(0);
      await writeExecutable(
        path.join(fakeBin, "git"),
        `#!/usr/bin/env bash
case "$1" in
  status) exit 0 ;;
  symbolic-ref) printf 'main\\n' ;;
  remote) printf 'https://github.com/demo/ship\\n' ;;
  ls-remote)
    if [ "$2" = --symref ]; then
      printf 'ref: refs/heads/main\\tHEAD\\n0123456789012345678901234567890123456789\\tHEAD\\n'
    else
      printf '0123456789012345678901234567890123456789\\trefs/heads/main\\n'
    fi ;;
  rev-parse) printf '0123456789012345678901234567890123456789\\n' ;;
  *) exit 97 ;;
esac
`,
      );
      await writeExecutable(
        path.join(fakeBin, "corepack"),
        "#!/bin/sh\nexit 0\n",
      );
      await rm(path.join(targetDir, "node_modules/npm"), {
        recursive: true,
        force: true,
      });
      await mkdir(path.join(targetDir, "node_modules/npm/bin"), {
        recursive: true,
      });
      await writeFile(
        path.join(targetDir, "node_modules/npm/package.json"),
        '{"version":"11.19.1","bin":{"npm":"bin/npm-cli.js"}}\n',
      );
      await writeFile(
        path.join(targetDir, "node_modules/npm/bin/npm-cli.js"),
        `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { published: false, trusted: false, calls: [] };
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const spec = "@demo/ship@1.0.0";
const integrity = ${JSON.stringify("placeholder")};
if (args[0] === "login") { save(); process.exit(0); }
if (args[0] === "logout") { save(); process.exit(0); }
if (args[0] === "whoami") { save(); process.stdout.write("alice\\n"); process.exit(0); }
if (args[0] === "view" && args[2] === "dist-tags") { save(); process.stdout.write('{"latest":"1.0.0"}'); process.exit(0); }
if (args[0] === "view") {
  if (!state.published) { process.stderr.write(JSON.stringify({ code: "E404", pkgid: spec })); save(); process.exit(1); }
  const tgz = Buffer.from(state.tgz, "base64");
  process.stdout.write(JSON.stringify({ dist: { integrity: "sha512-" + require("node:crypto").createHash("sha512").update(tgz).digest("base64") }, repository: "git+https://github.com/demo/ship.git" })); save(); process.exit(0);
}
if (args[0] === "pack") { const target = args.find((arg) => arg.startsWith("--pack-destination=")).slice("--pack-destination=".length); fs.writeFileSync(path.join(target, "remote.tgz"), Buffer.from(state.tgz, "base64")); save(); process.exit(0); }
if (args[0] === "publish") { state.published = true; state.tgz = fs.readFileSync(args[1]).toString("base64"); save(); process.exit(0); }
if (args[0] === "trust" && args[1] === "list") { if (state.trusted) process.stdout.write('{"id":"trust-1","type":"github","repository":"demo/ship","file":"release.yml","permissions":["createPackage"]}'); save(); process.exit(0); }
if (args[0] === "trust" && args.includes("--dry-run")) { process.stdout.write('{"package":"@demo/ship","type":"github","repository":"demo/ship","file":"release.yml","permissions":["createPackage"]}'); save(); process.exit(0); }
if (args[0] === "trust") { state.trusted = true; save(); process.exit(0); }
if (args[0] === "access") { process.stdout.write('{"alice":"read-write"}'); save(); process.exit(0); }
save(); process.exit(97);
`,
      );
      const first = await writeAcceptedFirstReleaseArtifact({
        root: targetDir,
        packageName: "@demo/ship",
        commandName: "ship",
      });
      const bridge = `${JSON.stringify(process.execPath)} --conditions=source scripts/npm-publication-setup/bridge.ts external`;
      const terminalInput = (lines: readonly string[]) =>
        lines
          .map((line) => `printf '%s\\n' ${JSON.stringify(line)}; sleep 1`)
          .join("; ");
      const firstRun = await execa(
        "bash",
        [
          "-c",
          `(sleep 1; ${terminalInput([
            "CONFIRM NPM 2FA AND RECOVERY CODES READY",
            `PUBLISH @demo/ship@1.0.0 ${first.integrity}`,
            "TRUST @demo/ship GITHUB demo/ship release.yml createPackage",
          ])}) | script -qefc ${JSON.stringify(bridge)} /dev/null`,
        ],
        {
          cwd: targetDir,
          env: {
            PATH: `${fakeBin}:${process.env.PATH}`,
            REPOSITORY_ROOT: targetDir,
            ARTIFACT_ROOT: first.directory,
          },
          reject: false,
          timeout: 60_000,
        },
      );
      expect(firstRun.exitCode, `${firstRun.stdout}\n${firstRun.stderr}`).toBe(
        0,
      );
      expect(firstRun.stdout).toContain("STAGE 5/7 Authenticate with npm");
      expect(firstRun.stdout).toContain("INTERACTIVE npm-login BEGIN");
      expect(firstRun.stdout).toContain("INTERACTIVE npm-publish END 0");
      expect(firstRun.stdout).toContain("INTERACTIVE npm-trust-write END 0");
      expect(firstRun.stdout).toContain(
        "STAGE 7/7 Configure trusted publishing",
      );
      const calls = (
        JSON.parse(await readFile(statePath, "utf8")) as {
          calls: string[][];
        }
      ).calls;
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(["login", "--auth-type=web"]),
          expect.arrayContaining([
            "publish",
            expect.stringMatching(/\.tgz$/u),
            "--access=public",
            "--tag=latest",
          ]),
          expect.arrayContaining(["trust", "github", "@demo/ship", "--yes"]),
          expect.arrayContaining(["logout"]),
        ]),
      );
      expect(
        calls
          .flat()
          .some(
            (argument) => argument === "--provenance" || argument === "--otp",
          ),
      ).toBe(false);

      const resume = await writeAcceptedFirstReleaseArtifact({
        root: targetDir,
        packageName: "@demo/ship",
        commandName: "ship",
      });
      const resumeRun = await execa(
        "bash",
        [
          "-c",
          `(sleep 1; ${terminalInput(["CONFIRM NPM 2FA AND RECOVERY CODES READY"])} ) | script -qefc ${JSON.stringify(bridge)} /dev/null`,
        ],
        {
          cwd: targetDir,
          env: {
            PATH: `${fakeBin}:${process.env.PATH}`,
            REPOSITORY_ROOT: targetDir,
            ARTIFACT_ROOT: resume.directory,
          },
          reject: false,
          timeout: 60_000,
        },
      );
      expect(
        resumeRun.exitCode,
        `${resumeRun.stdout}\n${resumeRun.stderr}`,
      ).toBe(0);
      expect(resumeRun.stdout).toContain("OK npm-publish-resumed-exact");
      const afterResume = JSON.parse(await readFile(statePath, "utf8")) as {
        calls: string[][];
      };
      expect(
        afterResume.calls.filter((args) => args[0] === "publish"),
      ).toHaveLength(1);
      expect(
        afterResume.calls.filter(
          (args) => args[0] === "trust" && args[1] === "github",
        ),
      ).toHaveLength(2);
      const generatedManifest = JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as { readonly imports?: Record<string, string> };
      expect(generatedManifest.imports).toEqual({
        "#npm-publication/*": "./scripts/npm-publication/*.ts",
      });
      await rm(setupDirectory, { recursive: true, force: true });
      for (const command of ["format:check", "lint", "typecheck"] as const) {
        const permanentTask = await execa("pnpm", ["run", command], {
          cwd: targetDir,
          reject: false,
        });
        expect(permanentTask.exitCode).toBe(0);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("restores SIGTERM after setup.sh transfers the accepted artifact to the blocking npm session", async () => {
    const { workspace, targetDir } = await renderInstalledGeneratedRepository(
      "template-publication-setup-signal-",
    );
    const fakeBin = path.join(workspace, "fake-bin");
    const ownedTemporaryDirectory = path.join(workspace, "owned-temporary");
    const statePath = path.join(workspace, "signal-npm-state.json");
    try {
      await mkdir(ownedTemporaryDirectory, { recursive: true });
      await writeExecutable(
        path.join(fakeBin, "git"),
        `#!/usr/bin/env bash
case "$1" in
  status) exit 0 ;;
  symbolic-ref) printf 'main\\n' ;;
  remote) printf 'https://github.com/demo/ship\\n' ;;
  ls-remote)
    if [ "$2" = --symref ]; then
      printf 'ref: refs/heads/main\\tHEAD\\n0123456789012345678901234567890123456789\\tHEAD\\n'
    else
      printf '0123456789012345678901234567890123456789\\trefs/heads/main\\n'
    fi ;;
  rev-parse) printf '0123456789012345678901234567890123456789\\n' ;;
  *) exit 97 ;;
esac
`,
      );
      const setupDirectory = path.join(
        targetDir,
        "scripts/npm-publication-setup",
      );
      const configured = await execa(
        process.execPath,
        [
          "--conditions=source",
          "scripts/npm-publication-setup/bridge.ts",
          "configure",
        ],
        {
          cwd: targetDir,
          env: {
            REPOSITORY_ROOT: targetDir,
            SETUP_DIR: setupDirectory,
            PACKAGE_NAME: "@demo/ship",
            COMMAND_NAME: "ship",
            DESCRIPTION: "A focused command-line release tool.",
            LICENSE_NAME: "MIT",
            COPYRIGHT_HOLDER: "Ada Lovelace",
            REPOSITORY_URL: "https://github.com/demo/ship",
          },
          reject: false,
        },
      );
      expect(configured.exitCode).toBe(0);
      const staged = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        {
          cwd: targetDir,
          env: {
            PATH: `${fakeBin}:${process.env.PATH}`,
            TMPDIR: ownedTemporaryDirectory,
          },
          reject: false,
        },
      );
      expect(staged.exitCode).toBe(3);
      const acceptance = /^Expected: (ACCEPT .+)$/mu.exec(
        `${staged.stdout}\n${staged.stderr}`,
      )?.[1];
      if (acceptance === undefined)
        throw new Error(`${staged.stdout}\n${staged.stderr}`);
      await writeExecutable(
        path.join(fakeBin, "corepack"),
        "#!/bin/sh\nexit 0\n",
      );
      const npmCli = path.join(targetDir, "node_modules/npm/bin/npm-cli.js");
      const realNpmCli = `${npmCli}.real`;
      await rename(npmCli, realNpmCli);
      await writeFile(
        npmCli,
        `const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const statePath = ${JSON.stringify(statePath)};
const realNpmCli = ${JSON.stringify(realNpmCli)};
const events = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : [];
const save = () => fs.writeFileSync(statePath, JSON.stringify(events));
const session = process.cwd();
const isolation = path.dirname(session);
if (process.argv[2] === "install") {
  process.exit(spawnSync(process.execPath, [realNpmCli, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 5);
}
if (process.argv[2] === "login") {
  events.push({ kind: "login", session, isolation, bridgePid: process.ppid }); save();
  process.on("SIGTERM", () => {
    events.push({ kind: "login-signal", session, isolation, bridgePid: process.ppid }); save(); process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else if (process.argv[2] === "logout") {
  events.push({ kind: "logout", session, isolation, sessionExists: fs.existsSync(session), isolationExists: fs.existsSync(isolation) }); save(); process.exit(0);
} else { events.push({ kind: process.argv[2], session, isolation }); save(); process.exit(0); }
`,
      );
      const command = `./scripts/npm-publication-setup/setup.sh`;
      const running = execa("script", ["-qefc", command, "/dev/null"], {
        cwd: targetDir,
        env: {
          PATH: `${fakeBin}:${process.env.PATH}`,
          TMPDIR: ownedTemporaryDirectory,
        },
        reject: false,
        stdin: "pipe",
        timeout: 60_000,
      });
      running.stdin?.write(`${acceptance}\n`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      running.stdin?.write("CONFIRM NPM 2FA AND RECOVERY CODES READY\n");
      let artifactRoot: string | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const state = await readFile(statePath, "utf8").catch(() => "[]");
        const loginStarted = (
          JSON.parse(state) as Array<{ kind: string }>
        ).find(
          (
            event,
          ): event is { readonly kind: string; readonly bridgePid: number } =>
            event.kind === "login" && "bridgePid" in event,
        );
        if (loginStarted !== undefined) {
          const environment = await readFile(
            `/proc/${loginStarted.bridgePid}/environ`,
            "utf8",
          );
          artifactRoot = environment
            .split("\0")
            .find((entry) => entry.startsWith("ARTIFACT_ROOT="))
            ?.slice("ARTIFACT_ROOT=".length);
        }
        if (loginStarted !== undefined && artifactRoot !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (artifactRoot === undefined)
        throw new Error(await readFile(statePath, "utf8"));
      expect(artifactRoot).toMatch(
        new RegExp(
          `^${ownedTemporaryDirectory}/npm-publication-setup-artifact\\.`,
          "u",
        ),
      );
      const beforeSignal = JSON.parse(
        await readFile(statePath, "utf8"),
      ) as Array<{
        readonly kind: string;
        readonly bridgePid?: number;
      }>;
      const login = beforeSignal.find((event) => event.kind === "login");
      expect(login?.bridgePid).toBeTypeOf("number");
      process.kill(login?.bridgePid as number, "SIGTERM");
      const terminated = await running;
      expect(terminated.exitCode).toBe(143);
      const events = JSON.parse(await readFile(statePath, "utf8")) as Array<{
        readonly kind: string;
        readonly session: string;
        readonly isolation: string;
        readonly bridgePid?: number;
        readonly sessionExists?: boolean;
        readonly isolationExists?: boolean;
      }>;
      expect(events.map((event) => event.kind)).toEqual([
        "login",
        "login-signal",
        "logout",
      ]);
      const logout = events.at(-1);
      expect(logout?.sessionExists).toBe(true);
      expect(logout?.isolationExists).toBe(true);
      await expect(stat(logout?.isolation ?? "")).rejects.toThrow();
      await expect(stat(artifactRoot as string)).rejects.toThrow();
      expect((await stat(setupDirectory)).isDirectory()).toBe(true);
      await expect(
        stat(path.join(targetDir, "package.json")),
      ).resolves.toBeDefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("fails the parameterized Ticket 13 registry matrix in the generated external bridge", async () => {
    const { workspace, targetDir } = await renderInstalledGeneratedRepository(
      "template-publication-setup-negative-matrix-",
    );
    const fakeBin = path.join(workspace, "fake-bin");
    const ownedTemporaryDirectory = path.join(workspace, "owned-temporary");
    const statePath = path.join(workspace, "negative-matrix-state.json");
    const cases = [
      ["preimage", 4, true],
      ["race", 4, true],
      ["unknown", 5, false],
      ["collaborator-missing", 4, false],
      ["collaborator-read-only", 4, false],
      ["collaborator-nonobject", 5, false],
      ["collaborator-invalid", 5, false],
      ["collaborator-mixed-stderr", 5, false],
      ["collaborator-substring", 4, false],
      ["identity", 4, false],
      ["bytes", 4, false],
      ["launcher", 5, false],
      ["ambient", 4, false],
      ["non-tty", 3, false],
      ["bootstrap", 5, false],
      ["trust-array", 5, false],
      ["trust-scalar", 5, false],
      ["trust-partial", 5, false],
      ["trust-garbage", 5, false],
      ["trust-mixed-stderr", 5, false],
      ["trust-environment", 4, false],
      ["trust-stage", 4, false],
    ] as const;
    try {
      await mkdir(ownedTemporaryDirectory, { recursive: true });
      await writeExecutable(
        path.join(fakeBin, "git"),
        `#!/usr/bin/env bash
case "$1" in
  status) exit 0 ;;
  symbolic-ref) printf 'main\\n' ;;
  remote) printf 'https://github.com/demo/ship\\n' ;;
  ls-remote)
    if [ "$2" = --symref ]; then
      printf 'ref: refs/heads/main\\tHEAD\\n0123456789012345678901234567890123456789\\tHEAD\\n'
    else
      printf '0123456789012345678901234567890123456789\\trefs/heads/main\\n'
    fi ;;
  rev-parse) printf '0123456789012345678901234567890123456789\\n' ;;
  *) exit 97 ;;
esac
`,
      );
      const setupDirectory = path.join(
        targetDir,
        "scripts/npm-publication-setup",
      );
      const configured = await execa(
        process.execPath,
        [
          "--conditions=source",
          "scripts/npm-publication-setup/bridge.ts",
          "configure",
        ],
        {
          cwd: targetDir,
          env: {
            REPOSITORY_ROOT: targetDir,
            SETUP_DIR: setupDirectory,
            PACKAGE_NAME: "@demo/ship",
            COMMAND_NAME: "ship",
            DESCRIPTION: "A focused command-line release tool.",
            LICENSE_NAME: "MIT",
            COPYRIGHT_HOLDER: "Ada Lovelace",
            REPOSITORY_URL: "https://github.com/demo/ship",
          },
          reject: false,
        },
      );
      expect(configured.exitCode).toBe(0);
      await writeExecutable(
        path.join(fakeBin, "corepack"),
        "#!/bin/sh\nexit 0\n",
      );
      const npmCli = path.join(targetDir, "node_modules/npm/bin/npm-cli.js");
      const realNpmCli = `${npmCli}.matrix-real`;
      await rename(npmCli, realNpmCli);
      const npmManifest = path.join(targetDir, "node_modules/npm/package.json");
      const originalNpmManifest = await readFile(npmManifest, "utf8");
      const writeFakeNpm = async (mode: string): Promise<void> => {
        await writeFile(
          npmCli,
          `const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const mode = ${JSON.stringify(mode)};
const statePath = ${JSON.stringify(statePath)};
const realNpmCli = ${JSON.stringify(realNpmCli)};
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { calls: [], views: 0 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const args = process.argv.slice(2);
const bytes = Buffer.from("ticket-13 accepted tarball\\n");
const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
const present = (identity) => JSON.stringify({ dist: { integrity }, repository: identity ? "git+https://github.com/demo/other.git" : "git+https://github.com/demo/ship.git" });
const absent = () => { process.stderr.write(JSON.stringify({ code: "E404", pkgid: "@demo/ship@1.0.0" })); save(); process.exit(1); };
state.calls.push(args); save();
if (args[0] === "install") process.exit(spawnSync(process.execPath, [realNpmCli, ...args], { stdio: "inherit" }).status ?? 5);
if (args[0] === "login" || args[0] === "logout") process.exit(0);
if (args[0] === "whoami") { process.stdout.write("alice\\n"); process.exit(0); }
if (args[0] === "access") {
  if (mode === "collaborator-missing") process.stdout.write("{}");
  else if (mode === "collaborator-read-only") process.stdout.write('{"alice":"read-only"}');
  else if (mode === "collaborator-nonobject") process.stdout.write("[]");
  else if (mode === "collaborator-invalid") process.stdout.write("not-json");
  else if (mode === "collaborator-mixed-stderr") { process.stdout.write('{"alice":"read-write"}'); process.stderr.write("warning"); }
  else if (mode === "collaborator-substring") process.stdout.write('{"malice":"read-write"}');
  else process.stdout.write('{"alice":"read-write"}');
  process.exit(0);
}
if (args[0] === "view" && args[2] === "dist-tags") { process.stdout.write('{"latest":"1.0.0"}'); process.exit(0); }
if (args[0] === "view") {
  if (mode === "unknown") { process.stdout.write("registry-unknown"); process.exit(1); }
  if (mode === "preimage" || mode === "race") {
    state.views += 1; save();
    if (mode === "race" && state.views > 1) { process.stdout.write(present(false)); process.exit(0); }
    absent();
  }
  process.stdout.write(present(mode === "identity")); process.exit(0);
}
if (args[0] === "pack") {
  const destination = args.find((argument) => argument.startsWith("--pack-destination=")).slice("--pack-destination=".length);
  fs.writeFileSync(path.join(destination, "remote.tgz"), mode === "bytes" ? Buffer.from("different bytes") : bytes);
  process.exit(0);
}
if (args[0] === "trust" && args[1] === "list") {
  if (mode === "trust-array") process.stdout.write("[]");
  else if (mode === "trust-scalar") process.stdout.write('"scalar"');
  else if (mode === "trust-partial") process.stdout.write('{"id":"only-id"}');
  else if (mode === "trust-garbage") process.stdout.write("{} garbage");
  else if (mode === "trust-mixed-stderr") { process.stdout.write("{}"); process.stderr.write("warning"); }
  else process.stdout.write("");
  process.exit(0);
}
if (args[0] === "trust" && args.includes("--dry-run")) {
  if (mode === "trust-environment") process.stdout.write('{"package":"@demo/ship","type":"github","repository":"demo/ship","file":"release.yml","permissions":["createPackage"],"environment":"production"}');
  else if (mode === "trust-stage") process.stdout.write('{"package":"@demo/ship","type":"github","repository":"demo/ship","file":"release.yml","permissions":["createPackage"],"stage":"production"}');
  else process.stdout.write('{"package":"@demo/ship","type":"github","repository":"demo/ship","file":"release.yml","permissions":["createPackage"]}');
  process.exit(0);
}
process.exit(97);
`,
        );
      };
      for (const [mode, expectedExit, needsPublishPhrase] of cases) {
        await writeFile(statePath, '{"calls":[],"views":0}');
        await writeFile(
          npmManifest,
          mode === "launcher"
            ? '{"version":"0.0.0","bin":{"npm":"bin/npm-cli.js"}}\n'
            : originalNpmManifest,
        );
        await writeFakeNpm(mode);
        await writeExecutable(
          path.join(fakeBin, "corepack"),
          `#!/bin/sh\nexit ${mode === "bootstrap" ? "1" : "0"}\n`,
        );
        const accepted = await writeAcceptedFirstReleaseArtifact({
          root: targetDir,
          packageName: "@demo/ship",
          commandName: "ship",
        });
        const externalEnvironment = {
          PATH: `${fakeBin}:${process.env.PATH}`,
          TMPDIR: ownedTemporaryDirectory,
          REPOSITORY_ROOT: targetDir,
          ARTIFACT_ROOT: accepted.directory,
          ...(mode === "ambient" ? { NPM_TOKEN: "poisoned" } : {}),
        };
        const bridge = `${JSON.stringify(process.execPath)} --conditions=source scripts/npm-publication-setup/bridge.ts external`;
        const running =
          mode === "non-tty"
            ? execa(
                process.execPath,
                [
                  "--conditions=source",
                  "scripts/npm-publication-setup/bridge.ts",
                  "external",
                ],
                {
                  cwd: targetDir,
                  env: externalEnvironment,
                  reject: false,
                  timeout: 60_000,
                },
              )
            : execa("script", ["-qefc", bridge, "/dev/null"], {
                cwd: targetDir,
                env: externalEnvironment,
                reject: false,
                stdin: "pipe",
                timeout: 60_000,
              });
        if (
          mode !== "ambient" &&
          mode !== "non-tty" &&
          mode !== "launcher" &&
          mode !== "bootstrap"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          running.stdin?.write("CONFIRM NPM 2FA AND RECOVERY CODES READY\n");
          if (needsPublishPhrase) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            if (mode === "preimage") {
              await writeFile(
                path.join(accepted.directory, "ship-1.0.0.tgz"),
                "changed after publish confirmation",
              );
            }
            running.stdin?.write(
              `PUBLISH @demo/ship@1.0.0 ${accepted.integrity}\n`,
            );
          }
        }
        const result = await running;
        expect(
          result.exitCode,
          `${mode}: ${result.stdout}\n${result.stderr}`,
        ).toBe(expectedExit);
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          readonly calls: string[][];
        };
        expect(
          state.calls.filter(
            (arguments_) =>
              arguments_[0] === "publish" ||
              (arguments_[0] === "trust" && arguments_.includes("--yes")),
          ),
        ).toHaveLength(0);
        expect(
          (await readdir(ownedTemporaryDirectory)).filter((entry) =>
            entry.startsWith("npm-publication-setup-"),
          ),
        ).toEqual([]);
        await expect(stat(accepted.directory)).rejects.toThrow();
      }
      expect((await stat(setupDirectory)).isDirectory()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 300_000);

  it("configures Apache-2.0 from the checked full license text", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-setup-apache-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    try {
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir,
          defaultPackageScope: "demo",
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        }),
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await symlink(
        path.resolve(import.meta.dirname, "../../node_modules"),
        path.join(targetDir, "node_modules"),
        "dir",
      );
      const configured = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--package-name",
          "@demo/ship",
          "--bin",
          "ship",
          "--description",
          "A focused command-line release tool.",
          "--license",
          "Apache-2.0",
          "--copyright-holder",
          "Ada Lovelace",
          "--repository",
          "https://github.com/demo/ship",
          "--non-interactive",
        ],
        { cwd: targetDir, reject: false },
      );
      expect(
        configured.exitCode,
        `${configured.stdout}\n${configured.stderr}`,
      ).toBe(5);
      const rootLicense = await readFile(
        path.join(targetDir, "LICENSE"),
        "utf8",
      );
      expect(rootLicense).toContain("Apache License");
      expect(rootLicense).toContain("Copyright (c) Ada Lovelace");
      expect(rootLicense).not.toContain("[name of copyright owner]");
      expect(
        await readFile(path.join(targetDir, "packages/cli/LICENSE"), "utf8"),
      ).toBe(rootLicense);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("resumes a ready custom SPDX configuration without a transient holder", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-setup-custom-license-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    try {
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir,
          defaultPackageScope: "demo",
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        }),
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await symlink(
        path.resolve(import.meta.dirname, "../../node_modules"),
        path.join(targetDir, "node_modules"),
        "dir",
      );
      await writeFile(
        path.join(targetDir, "LICENSE"),
        "A reviewed custom license text.\n",
      );
      const facts = [
        "--package-name",
        "@demo/ship",
        "--bin",
        "ship",
        "--description",
        "A focused command-line release tool.",
        "--license",
        "BSD-3-Clause",
        "--copyright-holder",
        "Ada Lovelace",
        "--repository",
        "https://github.com/demo/ship",
        "--non-interactive",
      ];
      const configured = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        facts,
        { cwd: targetDir, reject: false },
      );
      expect(configured.exitCode).toBe(5);
      const resumed = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, reject: false },
      );
      expect(resumed.exitCode).toBe(5);
      expect(resumed.stderr).not.toContain("public-fact-required");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a single-invocation owner preimage race before its writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-setup-preimage-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    try {
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir,
          defaultPackageScope: "demo",
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        }),
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await symlink(
        path.resolve(import.meta.dirname, "../../node_modules"),
        path.join(targetDir, "node_modules"),
        "dir",
      );
      const racePath = path.join(targetDir, "LICENSE");
      const blueprintPath = path.join(targetDir, ".template/blueprint.json");
      const originalBlueprint = await readFile(blueprintPath, "utf8");
      const preloader = path.join(workspace, "preimage-race.cjs");
      await writeFile(
        preloader,
        `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const original = fs.cpSync;
fs.cpSync = (...args) => {
  original(...args);
  fs.writeFileSync(
    process.env.SETUP_RACE_FILE,
    process.env.SETUP_RACE_EMPTY === "true" ? "" : '{"external":true}\\n',
  );
};
syncBuiltinESMExports();
`,
      );
      const raced = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--package-name",
          "@demo/ship",
          "--bin",
          "ship",
          "--description",
          "A focused command-line release tool.",
          "--license",
          "MIT",
          "--copyright-holder",
          "Ada Lovelace",
          "--repository",
          "https://github.com/demo/ship",
          "--non-interactive",
        ],
        {
          cwd: targetDir,
          env: {
            NODE_OPTIONS: `--require=${preloader}`,
            SETUP_RACE_FILE: racePath,
            SETUP_RACE_EMPTY: "true",
          },
          reject: false,
        },
      );
      expect(raced.exitCode).toBe(4);
      expect(raced.stderr).toContain("configuration-preimage-changed");
      expect(await readFile(racePath, "utf8")).toBe("");
      expect(await readFile(blueprintPath, "utf8")).toBe(originalBlueprint);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("inherits an exact partial changelog date instead of recapturing UTC", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-setup-date-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    try {
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir,
          defaultPackageScope: "demo",
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        }),
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      await symlink(
        path.resolve(import.meta.dirname, "../../node_modules"),
        path.join(targetDir, "node_modules"),
        "dir",
      );
      const facts = [
        "--package-name",
        "@demo/ship",
        "--bin",
        "ship",
        "--description",
        "A focused command-line release tool.",
        "--license",
        "MIT",
        "--copyright-holder",
        "Ada Lovelace",
        "--repository",
        "https://github.com/demo/ship",
        "--non-interactive",
      ];
      const initial = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        facts,
        { cwd: targetDir, reject: false },
      );
      expect(initial.exitCode).toBe(5);
      const changelogPath = path.join(targetDir, "packages/cli/CHANGELOG.md");
      const initialChangelog = await readFile(changelogPath, "utf8");
      const oldDate = "2020-02-29";
      await writeFile(
        changelogPath,
        initialChangelog.replace(
          /## \[1\.0\.0\] - \d{4}-\d{2}-\d{2}/u,
          `## [1.0.0] - ${oldDate}`,
        ),
      );
      const resumed = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, reject: false },
      );
      expect(resumed.exitCode).toBe(5);
      expect(await readFile(changelogPath, "utf8")).toContain(
        `## [1.0.0] - ${oldDate}`,
      );
      const validPartial = await readFile(changelogPath, "utf8");
      await writeFile(
        changelogPath,
        validPartial.replace(oldDate, "2020-02-30"),
      );
      const invalidDate = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, reject: false },
      );
      expect(invalidDate.exitCode).toBe(4);
      expect(invalidDate.stderr).toContain(
        "changelog-target-release-date-invalid",
      );
      expect(await readFile(changelogPath, "utf8")).toContain("2020-02-30");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when CLI replay identity conflicts with its planning phase", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-cli-retired-replay-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    });

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition: tsCliDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
        packageLeafName: "release",
        packagePath: "packages/release",
      });
      expect(
        addition.packageContributions.filter(
          (contribution) =>
            contribution.foundation.npmPublication?.kind ===
            "public-cli-candidate",
        ),
      ).toHaveLength(1);
      expect(
        addition.generationRecord.packages.find(
          (record) => record.path === "packages/release",
        ),
      ).toMatchObject({
        contributionIdentity: "cli-package-addition",
        planningContribution: "planPackageAddition",
      });
      const generationPath = path.join(targetDir, ".template/generation.json");
      const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
        packages: { path: string; contributionIdentity: string }[];
      };
      const candidate = generation.packages.find(
        (record) => record.path === "packages/cli",
      )!;
      candidate.contributionIdentity = "cli-package-addition";
      await writeFile(
        generationPath,
        `${JSON.stringify(generation, null, 2)}\n`,
      );
      expect(() => loadLocalTemplateMetadata(targetDir)).toThrow(
        "cli-package-addition replay identity requires planPackageAddition provenance",
      );

      candidate.contributionIdentity = "cli-publication-candidate";
      await writeFile(
        generationPath,
        `${JSON.stringify(generation, null, 2)}\n`,
      );
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      const addedGeneration = JSON.parse(
        await readFile(generationPath, "utf8"),
      ) as {
        packages: { path: string; contributionIdentity: string }[];
      };
      addedGeneration.packages.find(
        (record) => record.path === "packages/release",
      )!.contributionIdentity = "cli-publication-candidate";
      await writeFile(
        generationPath,
        `${JSON.stringify(addedGeneration, null, 2)}\n`,
      );
      expect(() => loadLocalTemplateMetadata(targetDir)).toThrow(
        "cli-publication-candidate replay identity requires planInitialization provenance",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("derives the CLI consumer engine from the Generation Context", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "future-cli"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "26",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const contribution =
      tsCliDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "cli",
          definition: {
            name: "@demo/cli",
            path: "packages/cli",
            role: "cli-tool",
          },
        },
      });

    expect(contribution.manifest.engines).toEqual({ node: ">=26" });
  });

  it("rejects a reserved command identity before initialization writes", () => {
    expect(() =>
      prepareGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        targetDir: path.join("generated-repository", "demo-cli"),
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
        overrides: { name: "node" },
      }),
    ).toThrow('CLI command name is a reserved system tool; received "node"');
  });

  it("rejects an added command that conflicts with an existing manifest fact before writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-cli-command-conflict-"),
    );
    const targetDir = path.join(workspace, "demo-cli");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const manifestPath = path.join(targetDir, "packages/cli/package.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        manifestPath,
        `${JSON.stringify(
          { ...manifest, bin: { release: "./dist/cli.js" } },
          null,
          2,
        )}\n`,
      );

      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition: tsCliDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
          packageLeafName: "release",
        }),
      ).toThrow(
        'CLI command name "release" from @demo/release is already used by @demo/cli',
      );
      await expect(
        stat(path.join(targetDir, "packages/release")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("appears in the public CLI Preset Catalog without exporting planner internals", async () => {
    const publicApi = await import("../index.ts");
    expect(publicApi).not.toHaveProperty("tsCliDefinition");
    expect(publicApi.templateSources).toHaveProperty("tsCli");

    const repositoryRoot = path.resolve(process.cwd(), "..", "..");
    const result = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repositoryRoot, "packages/cli/src/cli.ts"),
        "presets",
      ],
      { cwd: repositoryRoot },
    );
    expect(result.stdout).toContain("Built-in presets");
    expect(result.stdout).toMatch(/\bts-cli\b/u);
  });

  it("runs identity and greet unit tests from TypeScript source without a build", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-unit-",
    );

    try {
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await execa(
        "pnpm",
        ["--dir", project.packageRoot, "exec", "vitest", "run", "test/unit"],
        { cwd: project.targetDir },
      );
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("keeps the private candidate Root Check green while require-ready fails closed", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-publication-readiness-",
    );

    try {
      await rm(path.join(project.targetDir, "scripts/npm-publication-setup"), {
        recursive: true,
        force: true,
      });
      const rootCheck = await execa("pnpm", ["run", "check"], {
        cwd: project.targetDir,
        reject: false,
      });
      expect(
        rootCheck.exitCode,
        `${rootCheck.stdout}\n${rootCheck.stderr}`,
      ).toBe(0);

      const baseline = await execa("pnpm", ["run", "publication:readiness"], {
        cwd: project.targetDir,
        reject: false,
      });
      expect(baseline.exitCode).toBe(0);
      expect(baseline.stdout).toContain("npm publication readiness: blocked");

      const required = await execa(
        "pnpm",
        ["run", "publication:readiness", "--require-ready"],
        { cwd: project.targetDir, reject: false },
      );
      expect(required.exitCode).toBe(1);
      expect(required.stdout).toContain("npm publication readiness: blocked");
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("runs Commander integration tests in process without a build", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-integration-",
    );

    try {
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await execa(
        "pnpm",
        [
          "--dir",
          project.packageRoot,
          "exec",
          "vitest",
          "run",
          "test/integration/command.test.ts",
        ],
        { cwd: project.targetDir },
      );
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("discovers and runs the complete greet journey through source", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-source-e2e-",
    );

    try {
      const manifestPath = path.join(project.packageRoot, "package.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      await expect(
        execa("node", ["--conditions=source", "src/cli.ts", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("unpublished");
      await writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...manifest,
            version: "7.8.9",
            bin: { release: "./dist/cli.js" },
          },
          null,
          2,
        )}\n`,
      );
      await expect(
        execa("node", ["--conditions=source", "src/cli.ts", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("7.8.9");
      await expect(
        execa("node", ["--conditions=source", "src/cli.ts", "--help"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toContain("Usage: release [options] [command]");
      await expect(
        readFile(
          path.join(project.packageRoot, "test/e2e/run-journeys.ts"),
          "utf8",
        ),
      ).resolves.not.toContain('"greet"');
      const result = await execa(
        "node",
        ["--conditions=source", "test/e2e/run-journeys.ts", "source"],
        { cwd: project.packageRoot },
      );

      expect(result.stdout).toBe("source:greet:passed");
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("builds through Turbo and runs both modes from the package e2e script", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-dist-e2e-",
    );

    try {
      const dryRun = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "test",
          "test:e2e",
          "--filter=@demo/cli",
          "--dry-run=json",
        ],
        { cwd: project.targetDir },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly {
            taskId: string;
            dependencies: readonly string[];
          }[];
        }
      ).tasks;
      expect(
        tasks.find(({ taskId }) => taskId === "@demo/cli#test")?.dependencies,
      ).not.toContain("@demo/cli#build");
      expect(
        tasks.find(({ taskId }) => taskId === "@demo/cli#test:e2e")
          ?.dependencies,
      ).toContain("@demo/cli#build");

      await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@demo/cli", "--force"],
        { cwd: project.targetDir },
      );
      await expect(
        readFile(path.join(project.packageRoot, "dist/cli.js"), "utf8"),
      ).resolves.toMatch(/^#!\/usr\/bin\/env node/u);
      await expect(
        execa("node", ["dist/cli.js", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("unpublished");
      const manifestPath = path.join(project.packageRoot, "package.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...manifest,
            version: "4.5.6",
            bin: { deliver: "./dist/cli.js" },
          },
          null,
          2,
        )}\n`,
      );
      await expect(
        execa("node", ["dist/cli.js", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("4.5.6");
      await expect(
        execa("node", ["dist/cli.js", "--help"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toContain("Usage: deliver [options] [command]");

      const result = await execa("pnpm", ["run", "test:e2e"], {
        cwd: project.packageRoot,
      });
      expect(
        result.stdout
          .split("\n")
          .filter((line) => line.endsWith(":greet:passed")),
      ).toEqual(["source:greet:passed", "distribution:greet:passed"]);
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("rejects invalid journey runner arguments before running a journey", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-e2e-argv-",
    );
    const invalidCases = [
      {
        name: "missing mode",
        args: [],
        message: "missing journey mode",
      },
      {
        name: "unknown mode",
        args: ["preview"],
        message: 'unknown journey mode "preview"',
      },
      {
        name: "duplicate mode",
        args: ["source", "source"],
        message: 'duplicate journey mode "source"',
      },
      {
        name: "packed without bin",
        args: ["packed"],
        message: "packed journey mode requires exactly one bin path",
      },
      {
        name: "packed with extra argument",
        args: ["packed", "/tmp/demo-cli", "distribution"],
        message: "packed journey mode accepts exactly one bin path",
      },
      {
        name: "packed combined with source",
        args: ["source", "packed", "/tmp/demo-cli"],
        message: "packed journey mode cannot be combined",
      },
      {
        name: "mode used as packed bin",
        args: ["packed", "source"],
        message: 'packed bin path cannot be journey mode "source"',
      },
    ] as const;

    try {
      for (const invalidCase of invalidCases) {
        const result = await execa(
          "node",
          [
            "--conditions=source",
            "test/e2e/run-journeys.ts",
            ...invalidCase.args,
          ],
          { cwd: project.packageRoot, reject: false },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(invalidCase.message);
        expect(result.stdout).not.toContain(":passed");
      }
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("installs the compiled CLI bin into a workspace consumer without a package version", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-workspace-bin-",
    );

    try {
      const consumerRoot = path.join(project.targetDir, "packages/consumer");
      await mkdir(consumerRoot);
      await writeFile(
        path.join(consumerRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "@demo/consumer",
            private: true,
            dependencies: { "@demo/cli": "workspace:*" },
          },
          null,
          2,
        )}\n`,
      );
      await execa("pnpm", ["install"], { cwd: project.targetDir });
      await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@demo/cli", "--force"],
        { cwd: project.targetDir },
      );

      const binPath = path.join(consumerRoot, "node_modules/.bin/cli");
      await expect(stat(binPath)).resolves.toMatchObject({
        mode: expect.any(Number),
      });
      await expect(
        execa(binPath, ["--version"], { cwd: consumerRoot }).then(
          ({ stdout }) => stdout,
        ),
      ).resolves.toBe("unpublished");
      await expect(
        execa(binPath, ["greet", "Ada"], { cwd: consumerRoot }).then(
          ({ stdout }) => stdout,
        ),
      ).resolves.toBe("Hello, Ada");
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses to pack the unpublished CLI without injecting a version", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-unpublished-pack-",
    );

    try {
      await rm(path.join(project.packageRoot, "dist"), {
        recursive: true,
        force: true,
      });
      const sourceManifestPath = path.join(project.packageRoot, "package.json");
      const sourceManifestBytes = await readFile(sourceManifestPath, "utf8");
      const sourceManifest = JSON.parse(sourceManifestBytes) as Record<
        string,
        unknown
      >;
      expect(sourceManifest).toMatchObject({
        private: true,
        bin: { cli: "./dist/cli.js" },
        devDependencies: {
          "@demo/typescript-config": "link:../typescript-config",
        },
      });
      expect(sourceManifest).not.toHaveProperty("version");
      await expect(
        stat(path.join(project.targetDir, ".pnpmfile.mjs")),
      ).resolves.toMatchObject({ mode: expect.any(Number) });

      const packDestination = path.join(project.workspace, "packs");
      await mkdir(packDestination);
      const pack = await execa(
        "pnpm",
        ["pack", "--pack-destination", packDestination],
        { cwd: project.packageRoot, reject: false },
      );
      expect(pack.exitCode).toBe(1);
      expect(pack.stdout).toContain("ERR_PNPM_PACKAGE_VERSION_NOT_FOUND");
      await expect(readFile(sourceManifestPath, "utf8")).resolves.toBe(
        sourceManifestBytes,
      );
      expect(await readdir(packDestination)).toEqual([]);
      await expect(
        readFile(path.join(project.packageRoot, "dist/cli.js"), "utf8"),
      ).resolves.toMatch(/^#!\/usr\/bin\/env node/u);
      expect(
        (await stat(path.join(project.packageRoot, "dist/cli.js"))).mode &
          0o111,
      ).not.toBe(0);
      await expect(
        execa("node", ["dist/cli.js", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("unpublished");
      for (const absentField of [
        "version",
        "main",
        "types",
        "exports",
        "imports",
        "publishConfig",
      ]) {
        expect(sourceManifest).not.toHaveProperty(absentField);
      }
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
