import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
      ]),
    );
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

      const result = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        { cwd: targetDir, reject: false },
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        currentStage: { id: "configure-public-package", number: 2 },
        observations: { packagePath: "packages/cli" },
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
        "STAGE 2/4 Configure the public package",
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
        "STAGE 2/4 Configure the public package",
      );
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

  it("uses the read-only Git ledger and a receipt for the local artifact handoff", async () => {
    const { workspace, targetDir } = await renderInstalledGeneratedRepository(
      "template-publication-setup-handoff-",
    );
    try {
      const fakeBin = path.join(workspace, "fake-bin");
      const gitLedger = path.join(workspace, "git-ledger");
      const artifactLedger = path.join(workspace, "artifact-ledger");
      await writeExecutable(
        path.join(fakeBin, "git"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(gitLedger)}
[ "${"${GIT_DOWN:-}"}" != true ] || exit 97
case "$1" in
  status) exit 0 ;;
  symbolic-ref)
    [ "${"${FAKE_BRANCH:-main}"}" != detached ] || exit 1
    printf '%s\\n' "${"${FAKE_BRANCH:-main}"}" ;;
  remote) printf '%s\\n' "${"${FAKE_REMOTE:-https://github.com/demo/ship}"}" ;;
  ls-remote)
    if [ "$2" = --symref ]; then
      printf 'ref: refs/heads/%s\\tHEAD\\n%s\\tHEAD\\n' "${"${FAKE_DEFAULT_BRANCH:-main}"}" "${"${FAKE_REMOTE_HEAD:-0123456789012345678901234567890123456789}"}"
    else
      printf '%s\\trefs/heads/%s\\n' "${"${FAKE_REMOTE_HEAD:-0123456789012345678901234567890123456789}"}" "${"${FAKE_DEFAULT_BRANCH:-main}"}"
    fi ;;
  rev-parse) printf '%s\\n' "${"${FAKE_LOCAL_HEAD:-0123456789012345678901234567890123456789}"}" ;;
  *) exit 97 ;;
esac
`,
      );
      await writeExecutable(
        path.join(fakeBin, "pnpm"),
        `#!/usr/bin/env bash
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output-directory ]; then shift; out=$1; fi
  shift
done
if [ "${"${FAKE_ARTIFACT_FAILURE:-}"}" = true ]; then
  printf 'ignored child bytes ToKeN=artifact-secret https://credential@example.invalid/ \\033[2J\\r\\302\\205\n' >&2
  printf 'ERROR consumer-smoke-failed\nObserved: ToKeN=artifact-secret\\rINJECT\nExpected: a clean consumer smoke\nNext action: correct the packed command\n' >&2
  exit 1
fi
printf 'token=artifact-secret https://credential@example.invalid/ \\033[2J\\r' >&2
printf '%s\\n' "$out" >> ${JSON.stringify(artifactLedger)}
mkdir -p "$out/receipt"
if [ "${"${FAKE_EVIL_RECEIPT:-}"}" = true ]; then
cat > "$out/receipt/verified-publication-artifact.json" <<'JSON'
{"schemaVersion":1,"artifact":{"file":"ship-1.0.0.tgz","checksumFile":"SHA512SUMS","size":1,"integrity":"sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=="},"publication":{"packagePath":"packages/cli","packageName":"@demo/ship","version":"1.0.0","commandName":"ship","repository":"git+https://github.com/demo/ship.git","releaseDate":"2026-08-29","releaseNotes":"### Added\\n\\n- Publish the first stable CLI.\\n"},"packedManifest":{"name":"@demo/ship","version":"1.0.0","bin":{"ship":"./dist/cli.js"}},"files":[{"path":"package/CHANGELOG.md","mode":420,"size":1},{"path":"package/LICENSE","mode":420,"size":1},{"path":"package/README.md","mode":420,"size":1},{"path":"package/dist/cli-command-identity.js","mode":420,"size":1},{"path":"package/dist/cli.js","mode":493,"size":1},{"path":"package/dist/main.js","mode":420,"size":1},{"path":"package/package.json","mode":420,"size":1}],"bin":{"path":"package/dist/cli.js","shebang":"#!/usr/bin/env node","mode":493,"posixExecutableChecked":true},"smokes":[{"name":"runtime-import","args":[],"stdout":""},{"name":"help","args":["--help"],"stdout":"help"},{"name":"version","args":["--version"],"stdout":"1.0.0"},{"name":"greet","args":["greet","  Ada Lovelace  "],"stdout":"Hello, Ada Lovelace"}]}
JSON
exit 0
fi
cat > "$out/receipt/verified-publication-artifact.json" <<'JSON'
{"schemaVersion":1,"artifact":{"file":"ship-1.0.0.tgz","checksumFile":"SHA512SUMS","size":12,"integrity":"sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=="},"publication":{"packagePath":"packages/cli","packageName":"@demo/ship","version":"1.0.0","commandName":"ship","repository":"git+https://github.com/demo/ship.git","releaseDate":"2026-08-29","releaseNotes":"### Added\\n\\n- Publish the first stable CLI.\\n"},"packedManifest":{"name":"@demo/ship","version":"1.0.0","description":"A focused command-line release tool.","homepage":"https://github.com/demo/ship#readme","bugs":{"url":"https://github.com/demo/ship/issues"},"license":"MIT","repository":{"type":"git","url":"git+https://github.com/demo/ship.git","directory":"packages/cli"},"bin":{"ship":"./dist/cli.js"},"files":["dist","README.md","LICENSE","CHANGELOG.md"],"type":"module","publishConfig":{"access":"public","registry":"https://registry.npmjs.org/"},"dependencies":{"commander":"^1.0.0"},"engines":{"node":">=24"}},"files":[{"path":"package/CHANGELOG.md","mode":420,"size":30},{"path":"package/LICENSE","mode":420,"size":7},{"path":"package/README.md","mode":420,"size":12},{"path":"package/dist/cli-command-identity.js","mode":420,"size":1},{"path":"package/dist/cli.js","mode":493,"size":1},{"path":"package/dist/main.js","mode":420,"size":1},{"path":"package/package.json","mode":420,"size":30}],"bin":{"path":"package/dist/cli.js","shebang":"#!/usr/bin/env node","mode":493,"posixExecutableChecked":true},"smokes":[{"name":"runtime-import","args":[],"stdout":""},{"name":"help","args":["--help"],"stdout":"ship --help\\n"},{"name":"version","args":["--version"],"stdout":"1.0.0\\n"},{"name":"greet","args":["greet","  Ada Lovelace  "],"stdout":"Hello, Ada Lovelace\\n"}]}
JSON
`,
      );
      const env = { PATH: `${fakeBin}:${process.env.PATH}` };
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
      ];
      const accepted = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        facts,
        {
          cwd: targetDir,
          env,
          input:
            "ACCEPT @demo/ship@1.0.0 sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==\n",
          reject: false,
        },
      );
      expect(accepted.exitCode, `${accepted.stdout}\n${accepted.stderr}`).toBe(
        0,
      );
      expect(accepted.stdout).toContain("Package: @demo/ship@1.0.0");
      expect(accepted.stdout).toContain("Command: ship");
      expect(accepted.stdout).toContain(
        "Repository: git+https://github.com/demo/ship.git",
      );
      expect(accepted.stdout).toContain("Release date: 2026-08-29");
      expect(accepted.stdout).toContain("Artifact: ship-1.0.0.tgz (12 bytes)");
      expect(accepted.stdout).toContain(
        "File: package/LICENSE mode 420 size 7",
      );
      expect(accepted.stdout).toContain("Bin: package/dist/cli.js mode 493");
      expect(accepted.stdout).toContain(
        "Integrity: sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==",
      );
      expect(accepted.stdout).toContain("Checksum: SHA512SUMS");
      expect(accepted.stdout).toContain("Smoke: greet");
      expect(accepted.stdout).toContain("OK local-preparation-complete");
      expect(accepted.stdout).not.toContain(String.fromCharCode(27));
      expect(accepted.stdout).not.toContain("\r");
      expect(`${accepted.stdout}\n${accepted.stderr}`).not.toContain(
        "artifact-secret",
      );
      expect(`${accepted.stdout}\n${accepted.stderr}`).not.toContain(
        "credential@example.invalid",
      );
      expect(`${accepted.stdout}\n${accepted.stderr}`).not.toContain(
        String.fromCharCode(27),
      );
      expectNoControlCharacters(`${accepted.stdout}\n${accepted.stderr}`);
      expect(await readFile(gitLedger, "utf8")).toBe(
        [
          "status --porcelain",
          "symbolic-ref --quiet --short HEAD",
          "remote get-url origin",
          "ls-remote --symref origin HEAD",
          "ls-remote origin refs/heads/main",
          "rev-parse HEAD",
        ].join("\n") + "\n",
      );
      const output = (await readFile(artifactLedger, "utf8")).trim();
      expect(output).toContain("npm-publication-setup-artifact.");
      await expect(stat(output)).rejects.toThrow();

      for (const [, gitFacts] of [
        ["feature branch", { FAKE_BRANCH: "feature" }],
        ["detached HEAD", { FAKE_BRANCH: "detached" }],
        [
          "ahead local HEAD",
          { FAKE_LOCAL_HEAD: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
        ],
        [
          "behind local HEAD",
          { FAKE_REMOTE_HEAD: "ffffffffffffffffffffffffffffffffffffffff" },
        ],
      ] as const) {
        const handoff = await execa(
          "./scripts/npm-publication-setup/setup.sh",
          ["--non-interactive"],
          { cwd: targetDir, env: { ...env, ...gitFacts }, reject: false },
        );
        expect(handoff.exitCode).toBe(3);
        expect(handoff.stderr).toContain("git-handoff-required");
      }

      const nonInteractiveAcceptance = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, env, reject: false },
      );
      expect(nonInteractiveAcceptance.exitCode).toBe(3);
      expect(nonInteractiveAcceptance.stderr).toContain(
        "artifact-acceptance-required",
      );

      const mismatchAcceptance = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [],
        {
          cwd: targetDir,
          env,
          input: "ACCEPT another receipt\n",
          reject: false,
        },
      );
      expect(mismatchAcceptance.exitCode).toBe(3);
      expect(mismatchAcceptance.stderr).toContain(
        "acceptance did not match this receipt",
      );

      const eofAcceptance = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [],
        { cwd: targetDir, env, input: "", reject: false },
      );
      expect(eofAcceptance.exitCode).toBe(3);
      expect(eofAcceptance.stderr).toContain("Observed: end of input");

      const remoteMismatch = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        {
          cwd: targetDir,
          env: {
            ...env,
            FAKE_REMOTE: "https://credential@github.com/demo/other",
          },
          reject: false,
        },
      );
      expect(remoteMismatch.exitCode).toBe(4);
      expect(remoteMismatch.stderr).toContain("repository-remote-conflict");
      expect(remoteMismatch.stderr).not.toContain("credential");

      const credentialRemote = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        {
          cwd: targetDir,
          env: {
            ...env,
            FAKE_REMOTE: "https://credential@github.com/demo/ship",
          },
          reject: false,
        },
      );
      expect(credentialRemote.exitCode).toBe(4);
      expect(credentialRemote.stderr).toContain("repository-remote-conflict");
      expect(credentialRemote.stderr).not.toContain("credential");

      const conflictStatus = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        {
          cwd: targetDir,
          env: {
            ...env,
            FAKE_REMOTE: "https://credential@github.com/demo/other",
          },
          reject: false,
        },
      );
      expect(conflictStatus.exitCode).toBe(4);
      expect(conflictStatus.stderr).toBe("");
      expect(JSON.parse(conflictStatus.stdout)).toMatchObject({
        blockers: [
          expect.objectContaining({ code: "repository-remote-conflict" }),
        ],
      });

      const detachedStatus = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        {
          cwd: targetDir,
          env: { ...env, FAKE_BRANCH: "detached" },
          reject: false,
        },
      );
      expect(detachedStatus.exitCode).toBe(3);
      expect(detachedStatus.stderr).toBe("");
      expect(JSON.parse(detachedStatus.stdout)).toMatchObject({
        blockers: [expect.objectContaining({ code: "git-handoff-required" })],
      });

      const unavailableStatus = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        {
          cwd: targetDir,
          env: { ...env, GIT_DOWN: "true" },
          reject: false,
        },
      );
      expect(unavailableStatus.exitCode).toBe(5);
      expect(unavailableStatus.stderr).toBe("");
      expect(JSON.parse(unavailableStatus.stdout)).toMatchObject({
        schemaVersion: 1,
        blockers: [expect.objectContaining({ code: "git-status-unavailable" })],
      });

      const unavailableGitHandoff = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, env: { ...env, GIT_DOWN: "true" }, reject: false },
      );
      expect(unavailableGitHandoff.exitCode).toBe(5);
      expect(unavailableGitHandoff.stderr).toContain("git-read-unavailable");

      const artifactFailure = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        {
          cwd: targetDir,
          env: { ...env, FAKE_ARTIFACT_FAILURE: "true" },
          reject: false,
        },
      );
      expect(artifactFailure.exitCode).toBe(5);
      expect(artifactFailure.stderr).toContain("ERROR consumer-smoke-failed");
      expect(artifactFailure.stderr).toContain("Observed: ToKeN=[REDACTED]");
      expect(
        `${artifactFailure.stdout}\n${artifactFailure.stderr}`,
      ).not.toContain("artifact-secret");
      expectNoControlCharacters(
        `${artifactFailure.stdout}\n${artifactFailure.stderr}`,
      );

      const evilReceipt = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        {
          cwd: targetDir,
          env: { ...env, FAKE_EVIL_RECEIPT: "true" },
          reject: false,
        },
      );
      expect(evilReceipt.exitCode).toBe(5);
      expect(evilReceipt.stderr).toContain("artifact-receipt-invalid");
      expect(`${evilReceipt.stdout}\n${evilReceipt.stderr}`).not.toContain(
        "ACCEPT @demo/ship@1.0.0",
      );
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
        "STAGE 4/4 Verify the first release artifact",
      );
      expect(result.stdout).toContain("Package: @demo/ship@1.0.0");
      expect(result.stdout).toContain("Artifact:");
      expect(result.stderr).toContain("artifact-acceptance-required");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
