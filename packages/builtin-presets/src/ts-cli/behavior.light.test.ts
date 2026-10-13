import assert from "node:assert/strict";
import {
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
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  planGeneratedRepositoryInitialization,
  resolveBuiltInTemplateSource,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import {
  expectNoControlCharacters,
  requireReadyInitialization,
  writeExecutable,
} from "../../test-support/ts-cli-behavior.ts";
import { tsCliDefinition } from "./definition.ts";

void describe("ts-cli Preset Definition behavior", () => {
  void it("keeps the checked bridge in the direct source task inputs", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "../..");
    const shown = await execa(
      "pnpm",
      ["exec", "tsc", "-p", "tsconfig.json", "--showConfig"],
      { cwd: packageRoot },
    );
    const config = JSON.parse(shown.stdout) as {
      readonly compilerOptions: Record<string, unknown>;
      readonly files: readonly string[];
    };
    assert.strictEqual(config.compilerOptions.erasableSyntaxOnly, true);
    assert.strictEqual(config.compilerOptions.module, "nodenext");
    assert.strictEqual(config.compilerOptions.moduleResolution, "nodenext");
    assert.ok(
      config.files.includes("./templates/ts-cli/publication-setup/bridge.ts"),
    );
    const bridge = await readFile(
      path.join(packageRoot, "templates/ts-cli/publication-setup/bridge.ts"),
      "utf8",
    );
    const sourceManifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { readonly scripts: Record<string, string> };
    const formatCheck = sourceManifest.scripts["format:check"];
    assert.ok(typeof formatCheck === "string" && formatCheck.includes(" ."));
    assert.ok(
      typeof sourceManifest.scripts.lint === "string" &&
        sourceManifest.scripts.lint.includes(
          "templates/ts-cli/publication-setup/bridge.ts",
        ),
    );
    assert.strictEqual(
      sourceManifest.scripts.typecheck,
      "tsc -p tsconfig.json --noEmit --pretty false && tsc -p tsconfig.quality-gates.json --noEmit --pretty false",
    );
    const publicationSpecifiers = [
      ...bridge.matchAll(/from "([^"]*(?:npm-)?publication[^"]*)"/gu),
    ].map((match) => match[1]);
    assert.deepStrictEqual(publicationSpecifiers, [
      "#npm-publication/artifact",
      "#npm-publication/handoff",
      "#npm-publication/readiness",
    ]);
    assert.doesNotMatch(bridge, /from "\.\.\/(?:npm-)?publication\//u);
  });

  void it("plans the registered unpublished CLI Tool Package boundary", () => {
    assert.strictEqual(
      tsCliDefinition.initialPrimaryPackage.defaultLeafName,
      "cli",
    );
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-cli"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: "24.16.0",
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

    assert.match(
      resolveBuiltInTemplateSource(tsCliDefinition.source, "."),
      /templates[\\/]ts-cli$/,
    );
    assert.deepStrictEqual(contribution.definition, {
      name: "@demo/cli",
      path: "packages/cli",
      role: "cli-tool",
    });
    assert.partialDeepStrictEqual(contribution.manifest, {
      name: "@demo/cli",
      private: true,
      type: "module",
      bin: { cli: "./dist/cli.js" },
      dependencies: {
        "@ykdz/cli-contract": "catalog:",
        "@valibot/to-json-schema": "catalog:",
        valibot: "catalog:",
      },
      engines: { node: "^24.16.0" },
      scripts: {
        build: "tsc -p tsconfig.build.json --pretty false",
        prepack: "pnpm exec turbo run build --filter=.",
        typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
      },
    });
    assert.deepStrictEqual(contribution.manifest.files, ["dist"]);
    const generatedScripts = contribution.manifest.scripts as Record<
      string,
      string
    >;
    assert.ok(
      Object.hasOwn(generatedScripts, "test") &&
        typeof generatedScripts.test === "string",
    );
    assert.strictEqual(
      Object.hasOwn(generatedScripts, "test:e2e") &&
        typeof generatedScripts["test:e2e"] === "string",
      true,
    );
    const postbuild = generatedScripts.postbuild;
    assert.ok(
      Object.hasOwn(generatedScripts, "postbuild") &&
        typeof postbuild === "string" &&
        postbuild.includes("chmodSync('dist/cli.js', 0o755)"),
    );
    assert.deepStrictEqual(contribution.exposure, { exports: {}, imports: {} });
    assert.strictEqual(
      contribution.planningIdentity,
      "cli-publication-candidate",
    );
    assert.deepStrictEqual(contribution.foundation.npmPublication, {
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
      assert.strictEqual(
        publicProgrammaticField in contribution.manifest,
        false,
      );
    }
    const expectedCopiedFiles = [
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
    ] as const;
    for (const expectedOperation of expectedCopiedFiles) {
      assert.ok(
        contribution.operations.some((operation) =>
          isDeepStrictEqual(operation, expectedOperation),
        ),
      );
    }
    assert.strictEqual(
      contribution.operations.some(
        (operation) =>
          Object.hasOwn(operation, "kind") &&
          operation.kind === "replaceAnchors",
      ),
      false,
    );

    assert.strictEqual(
      builtInPresetRegistry
        .all()
        .filter((definition) => definition.metadata.name === "ts-cli").length,
      1,
    );
    assert.deepStrictEqual(
      builtInPresetRegistry.require("ts-cli").metadata,
      tsCliDefinition.metadata,
    );
  });

  void it("adds a CLI Tool Package at default and explicit two-segment paths", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-workspace"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: "24.16.0",
      },
    });

    assert.strictEqual(
      tsCliDefinition.defaultPackagePath?.({
        context,
        packageLeafName: "release",
      }),
      "packages/release",
    );
    const addition = tsCliDefinition.planPackageAddition?.({
      context,
      packageLeafName: "release",
      packagePath: "tools/release",
    });
    assert.deepStrictEqual(addition?.definition, {
      name: "@demo/release",
      path: "tools/release",
      role: "cli-tool",
    });
    assert.strictEqual(addition?.planningIdentity, "cli-package-addition");
    assert.strictEqual(addition?.foundation.npmPublication, undefined);
    assert.deepStrictEqual(addition?.manifest.engines, { node: ">=24" });
  });

  void it("projects publication readiness only for the initial CLI candidate", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "demo-cli"),
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: "24.16.0",
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

    assert.partialDeepStrictEqual(candidate?.manifest.devDependencies, {
      "@demo/typescript-config": "link:../typescript-config",
    });
    assert.partialDeepStrictEqual(
      plan.generationRecord.packages.find(
        (record) => record.path === "packages/cli",
      ),
      {
        contributionIdentity: "cli-publication-candidate",
        planningContribution: "planInitialization",
      },
    );
    assert.partialDeepStrictEqual(rootManifest, {
      imports: {
        "#npm-publication/*": "./scripts/npm-publication/*.ts",
      },
      scripts: {
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
    const rootScripts = rootManifest?.scripts as
      | Record<string, string>
      | undefined;
    assert.ok(rootScripts);
    assert.ok(Object.hasOwn(rootScripts, "check"));
    const rootCheck = rootScripts.check;
    assert.ok(
      typeof rootCheck === "string" &&
        rootCheck.includes("publication:artifact") &&
        rootCheck.includes("build test:e2e --filter=!./packages/cli"),
    );
    assert.strictEqual(
      typeof rootCheck === "string" &&
        rootCheck.includes("publication:readiness --continue"),
      false,
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          "to" in operation &&
          Object.hasOwn(operation, "to") &&
          operation.to === ".pnpmfile.mjs",
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          Object.hasOwn(operation, "kind") &&
          Object.hasOwn(operation, "from") &&
          operation.from === "publication/check-readiness.ts" &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication/check-readiness.ts" &&
          Object.hasOwn(operation, "replacements") &&
          isDeepStrictEqual(operation.replacements, {
            PUBLIC_CLI_PACKAGE_PATH: "packages/cli",
          }),
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          "from" in operation &&
          Object.hasOwn(operation, "from") &&
          operation.from === "publication/readiness.ts" &&
          "to" in operation &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication/readiness.ts",
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          "from" in operation &&
          Object.hasOwn(operation, "from") &&
          operation.from === "publication/artifact.ts" &&
          "to" in operation &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication/artifact.ts",
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          Object.hasOwn(operation, "kind") &&
          Object.hasOwn(operation, "from") &&
          operation.from === "publication/check-artifact.ts" &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication/check-artifact.ts" &&
          Object.hasOwn(operation, "replacements") &&
          isDeepStrictEqual(operation.replacements, {
            PUBLIC_CLI_PACKAGE_PATH: "packages/cli",
          }),
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          "from" in operation &&
          Object.hasOwn(operation, "from") &&
          operation.from === "publication/changelog.ts" &&
          "to" in operation &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication/changelog.ts",
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          "from" in operation &&
          Object.hasOwn(operation, "from") &&
          operation.from === "src/cli-command-identity.ts" &&
          "to" in operation &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication/cli-command-identity.ts",
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          Object.hasOwn(operation, "kind") &&
          Object.hasOwn(operation, "from") &&
          operation.from === "publication-setup/setup.sh" &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication-setup/setup.sh",
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          Object.hasOwn(operation, "kind") &&
          Object.hasOwn(operation, "from") &&
          operation.from === "publication-setup/bridge.ts" &&
          Object.hasOwn(operation, "to") &&
          operation.to === "scripts/npm-publication-setup/bridge.ts" &&
          Object.hasOwn(operation, "replacements") &&
          isDeepStrictEqual(operation.replacements, {
            PUBLIC_CLI_PACKAGE_PATH: "packages/cli",
          }),
      ),
    );
    assert.strictEqual(
      plan.operations.some(
        (operation) =>
          "from" in operation &&
          typeof operation.from === "string" &&
          operation.from.includes("bridge.mjs"),
      ),
      false,
    );
  });

  void it("keeps the one-time publication setup handoff outside the generated plan", () => {
    const preparation = requireReadyInitialization({
      definition: tsCliDefinition,
      targetDir: path.join("generated-repository", "demo-cli"),
    });

    assert.deepStrictEqual(preparation.publicationSetup, {
      command: "./scripts/npm-publication-setup/setup.sh",
    });
    assert.strictEqual(preparation.plan.nextStepInstructions.length, 3);
    assert.strictEqual(
      preparation.plan.nextStepInstructions
        .map(({ display }) => display)
        .includes("./scripts/npm-publication-setup/setup.sh"),
      false,
    );
  });

  void it("does not expose a publication setup handoff for a non-candidate preset", () => {
    const preparation = requireReadyInitialization({
      definition: builtInPresetRegistry.require("ts-lib"),
      targetDir: path.join("generated-repository", "demo-library"),
    });

    assert.strictEqual(preparation.publicationSetup, null);
    assert.strictEqual(
      preparation.plan.operations.some(
        (operation) =>
          "to" in operation &&
          operation.to.startsWith("scripts/npm-publication-setup/"),
      ),
      false,
    );
  });

  void it("serves the generated setup status through its only executable interface", async () => {
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
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: "24.16.0",
          },
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
      assert.strictEqual(missingPnpm.exitCode, 5);
      assert.ok(missingPnpm.stdout.includes("STAGE 1/9 Check prerequisites"));
      assert.ok(missingPnpm.stdout.includes("CHECK local-toolchain"));
      assert.strictEqual(
        missingPnpm.stdout.includes("STAGE 2/9 Configure the public package"),
        false,
      );
      assert.ok(missingPnpm.stderr.includes("ERROR prerequisite-command"));
      assert.ok(missingPnpm.stderr.includes("pnpm is unavailable"));

      const result = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        { cwd: targetDir, reject: false },
      );

      assert.strictEqual(result.exitCode, 0);
      assert.partialDeepStrictEqual(JSON.parse(result.stdout), {
        schemaVersion: 1,
        currentStage: { id: "configure-public-package", number: 2 },
        observations: {
          packagePath: "packages/cli",
          readiness: "safe-unconfigured",
        },
        nextAction: { kind: "provide-public-facts" },
      });
      assert.strictEqual(result.stderr, "");

      const missingFacts = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, reject: false, input: "unexpected stdin\n" },
      );
      assert.strictEqual(missingFacts.exitCode, 3);
      assert.ok(
        missingFacts.stderr.includes("ACTION REQUIRED public-fact-required"),
      );

      const promptEof = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [],
        { cwd: targetDir, input: "", reject: false },
      );
      assert.strictEqual(promptEof.exitCode, 3);
      assert.ok(
        promptEof.stderr.includes("ACTION REQUIRED public-fact-required"),
      );
      assert.ok(promptEof.stderr.includes("Observed: end of input"));

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
        assert.strictEqual(rejected.exitCode, 2);
        assert.ok(rejected.stderr.includes("ERROR publication-setup-usage"));
      }

      const invalidStatus = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json", "--password", "not-read"],
        { cwd: targetDir, reject: false },
      );
      assert.strictEqual(invalidStatus.exitCode, 2);
      assert.strictEqual(invalidStatus.stderr, "");
      assert.partialDeepStrictEqual(JSON.parse(invalidStatus.stdout), {
        schemaVersion: 1,
      });
      const invalidStatusBody = JSON.parse(invalidStatus.stdout) as {
        readonly blockers: readonly { readonly code: string }[];
      };
      assert.strictEqual(invalidStatusBody.blockers.length, 1);
      const [publicationSetupBlocker] = invalidStatusBody.blockers;
      assert.ok(publicationSetupBlocker);
      assert.strictEqual(Object.hasOwn(publicationSetupBlocker, "code"), true);
      assert.strictEqual(
        publicationSetupBlocker.code,
        "publication-setup-usage",
      );

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
      assert.strictEqual(invalidLicense.exitCode, 2);
      assert.ok(invalidLicense.stderr.includes("ERROR public-fact-invalid"));

      for (const [flag, value] of [
        ["--package-name", "@demo/UPPER"],
        ["--bin", "BAD"],
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
        assert.strictEqual(invalidPublicFact.exitCode, 2);
        assert.ok(invalidPublicFact.stderr.includes("public-fact-invalid"));
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
      assert.strictEqual(partialInteractive.exitCode, 5);
      assert.ok(partialInteractive.stdout.includes("Command name:"));
      assert.strictEqual(
        partialInteractive.stdout.includes("Package name:"),
        false,
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
          "MIT",
          "--copyright-holder",
          "Ada Lovelace",
          "--repository",
          "https://github.com/demo/ship",
          "--non-interactive",
        ],
        { cwd: targetDir, reject: false },
      );
      assert.strictEqual(
        configured.exitCode,
        5,
        `${configured.stdout}\n${configured.stderr}`,
      );
      assert.ok(
        configured.stdout.includes("STAGE 2/9 Configure the public package"),
      );
      assert.strictEqual(
        configured.stdout.includes(String.fromCharCode(27)),
        false,
      );
      assert.strictEqual(configured.stdout.includes("\r"), false);
      assert.strictEqual(configured.stderr.includes("not-read"), false);
      const configuredManifest = JSON.parse(
        await readFile(
          path.join(targetDir, "packages/cli/package.json"),
          "utf8",
        ),
      );
      assert.partialDeepStrictEqual(configuredManifest, {
        name: "@demo/ship",
        version: "1.0.0",
      });
      assert.strictEqual("private" in configuredManifest, false);

      const holderConflict = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--copyright-holder", "Grace Hopper", "--non-interactive"],
        { cwd: targetDir, reject: false },
      );
      assert.strictEqual(holderConflict.exitCode, 4);
      assert.ok(holderConflict.stderr.includes("owner-fact-conflict"));
      assert.ok(
        (await readFile(path.join(targetDir, "LICENSE"), "utf8")).includes(
          "Ada Lovelace",
        ),
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
      assert.strictEqual(dirty.exitCode, 3);
      assert.ok(dirty.stderr.includes("ACTION REQUIRED git-handoff-required"));
      assert.strictEqual(
        await readFile(gitLedger, "utf8"),
        "status --porcelain\n",
      );

      const conflict = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        [
          "--description",
          "A different public description.",
          "--non-interactive",
        ],
        { cwd: targetDir, reject: false },
      );
      assert.strictEqual(conflict.exitCode, 4);
      assert.ok(conflict.stderr.includes("ERROR owner-fact-conflict"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("fails closed before configuration for metadata or reviewed owner intent and cleans a failed owner write", async () => {
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
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: "24.16.0",
          },
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
      assert.strictEqual(unsafeUsage.exitCode, 2);
      assert.strictEqual(
        `${unsafeUsage.stdout}\n${unsafeUsage.stderr}`.includes(
          "closure-secret",
        ),
        false,
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
      assert.strictEqual(corruptMetadata.exitCode, 4);
      assert.ok(
        corruptMetadata.stderr.includes("local-template-metadata-invalid"),
      );
      assert.strictEqual(
        corruptMetadata.stdout.includes(
          "STAGE 2/9 Configure the public package",
        ),
        false,
      );
      assert.ok(
        corruptMetadata.stdout.includes("STAGE 1/9 Check prerequisites"),
      );
      const corruptStatus = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--status", "--json"],
        { cwd: targetDir, reject: false },
      );
      assert.strictEqual(corruptStatus.exitCode, 0);
      const corruptStatusBody = JSON.parse(corruptStatus.stdout) as {
        readonly currentStage: { readonly id: string; readonly number: number };
        readonly blockers: readonly { readonly code: string }[];
      };
      assert.partialDeepStrictEqual(corruptStatusBody.currentStage, {
        id: "check-prerequisites",
        number: 1,
      });
      assert.partialDeepStrictEqual(corruptStatusBody, {
        nextAction: { kind: "retry-external-check" },
      });
      assert.ok(
        corruptStatusBody.blockers.some(
          (blocker) =>
            Object.hasOwn(blocker, "code") &&
            blocker.code === "local-template-metadata-invalid",
        ),
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
      assert.strictEqual(reviewedReadme.exitCode, 4);
      assert.ok(reviewedReadme.stderr.includes("owner-fact-conflict"));
      assert.strictEqual(
        await readFile(readmePath, "utf8"),
        "Reviewed public README.\n",
      );
      assert.strictEqual(await readFile(manifestPath, "utf8"), initialManifest);

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
      assert.strictEqual(renameFailure.exitCode, 5);
      assert.ok(
        renameFailure.stderr.includes("configuration-platform-failure"),
      );
      assert.deepStrictEqual(
        (await readdir(path.join(targetDir, "packages/cli"))).filter((entry) =>
          entry.includes(".npm-publication-setup-"),
        ),
        [],
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("configures Apache-2.0 from the checked full license text", async () => {
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
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: "24.16.0",
          },
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
      assert.strictEqual(
        configured.exitCode,
        5,
        `${configured.stdout}\n${configured.stderr}`,
      );
      const rootLicense = await readFile(
        path.join(targetDir, "LICENSE"),
        "utf8",
      );
      assert.ok(rootLicense.includes("Apache License"));
      assert.ok(rootLicense.includes("Copyright (c) Ada Lovelace"));
      assert.strictEqual(
        rootLicense.includes("[name of copyright owner]"),
        false,
      );
      assert.strictEqual(
        await readFile(path.join(targetDir, "packages/cli/LICENSE"), "utf8"),
        rootLicense,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("resumes a ready custom SPDX configuration without a transient holder", async () => {
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
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: "24.16.0",
          },
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
      assert.strictEqual(configured.exitCode, 5);
      const resumed = await execa(
        "./scripts/npm-publication-setup/setup.sh",
        ["--non-interactive"],
        { cwd: targetDir, reject: false },
      );
      assert.strictEqual(resumed.exitCode, 5);
      assert.strictEqual(
        resumed.stderr.includes("public-fact-required"),
        false,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects a single-invocation owner preimage race before its writes", async () => {
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
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: "24.16.0",
          },
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
      assert.strictEqual(raced.exitCode, 4);
      assert.ok(raced.stderr.includes("configuration-preimage-changed"));
      assert.strictEqual(await readFile(racePath, "utf8"), "");
      assert.strictEqual(
        await readFile(blueprintPath, "utf8"),
        originalBlueprint,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("inherits an exact partial changelog date instead of recapturing UTC", async () => {
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
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: "24.16.0",
          },
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
      assert.strictEqual(initial.exitCode, 5);
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
      assert.strictEqual(resumed.exitCode, 5);
      assert.ok(
        (await readFile(changelogPath, "utf8")).includes(
          `## [1.0.0] - ${oldDate}`,
        ),
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
      assert.strictEqual(invalidDate.exitCode, 4);
      assert.ok(
        invalidDate.stderr.includes("changelog-target-release-date-invalid"),
      );
      assert.ok((await readFile(changelogPath, "utf8")).includes("2020-02-30"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("fails closed when CLI replay identity conflicts with its planning phase", async () => {
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
          nodeVersion: "24.16.0",
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
      assert.strictEqual(
        addition.packageContributions.filter(
          (contribution) =>
            contribution.foundation.npmPublication?.kind ===
            "public-cli-candidate",
        ).length,
        1,
      );
      assert.partialDeepStrictEqual(
        addition.generationRecord.packages.find(
          (record) => record.path === "packages/release",
        ),
        {
          contributionIdentity: "cli-package-addition",
          planningContribution: "planPackageAddition",
        },
      );
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
      assert.throws(
        () => loadLocalTemplateMetadata(targetDir),
        (error: unknown) =>
          (error instanceof Error ? error.message : String(error)).includes(
            "cli-package-addition replay identity requires planPackageAddition provenance",
          ),
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
      assert.throws(
        () => loadLocalTemplateMetadata(targetDir),
        (error: unknown) =>
          (error instanceof Error ? error.message : String(error)).includes(
            "cli-publication-candidate replay identity requires planInitialization provenance",
          ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("derives a new public CLI candidate engine as a caret over the exact root version", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "future-cli"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "26",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: "26.4.2",
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

    assert.deepStrictEqual(contribution.manifest.engines, { node: "^26.4.2" });
  });

  void it("fails a new public CLI candidate when the exact root version is missing or imprecise", () => {
    const planNewCandidate = (toolchain: {
      readonly nodeLtsMajor: string;
      readonly packageManagerPin: string;
      readonly nodeVersion?: string;
    }) =>
      tsCliDefinition.initialPrimaryPackage.planInitialContribution({
        context: createGenerationContext({
          targetDir: path.join("generated-repository", "future-cli"),
          defaultPackageScope: "demo",
          toolchain,
        }),
        resolvedPackageIdentity: {
          leafName: "cli",
          definition: {
            name: "@demo/cli",
            path: "packages/cli",
            role: "cli-tool",
          },
        },
      });

    assert.throws(
      () =>
        planNewCandidate({
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@11.11.0",
        }),
      (error: unknown) =>
        (error instanceof Error ? error.message : String(error)).includes(
          "新建公开 ts-cli 发布候选要求 Generation Context 提供精确三段 toolchain.nodeVersion，实际缺失；不能从 nodeLtsMajor 猜 patch 派生公开 caret 范围。",
        ),
    );
    assert.throws(
      () =>
        planNewCandidate({
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: "26.4",
        }),
      (error: unknown) =>
        (error instanceof Error ? error.message : String(error)).includes(
          '实际收到 "26.4"',
        ),
    );
    assert.throws(
      () =>
        planNewCandidate({
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: ">=26.4.2",
        }),
      (error: unknown) =>
        (error instanceof Error ? error.message : String(error)).includes(
          '实际收到 ">=26.4.2"',
        ),
    );
    assert.throws(
      () =>
        planNewCandidate({
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: "24.16.0",
        }),
      (error: unknown) =>
        (error instanceof Error ? error.message : String(error)).includes(
          "与 nodeLtsMajor 26 大版本不一致",
        ),
    );
  });

  void it("replays an existing public CLI candidate with the engine form of its root declaration", () => {
    const replay = tsCliDefinition.packageContributionReplayAdapters.find(
      (adapter) => adapter.identity === "cli-publication-candidate",
    );
    if (replay === undefined)
      throw new Error("Missing candidate replay adapter");
    const packageDefinition = {
      name: "@demo/cli",
      path: "packages/cli",
      role: "cli-tool" as const,
    };
    const replayCandidate = (nodeVersion?: string) =>
      replay.replay({
        context: createGenerationContext({
          targetDir: path.join("generated-repository", "demo-cli"),
          defaultPackageScope: "demo",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            ...(nodeVersion === undefined ? {} : { nodeVersion }),
          },
        }),
        planningContribution: "planInitialization",
        packageDefinition,
        packageLeafName: "cli",
        initialPackages: {
          require: () => {
            throw new Error(
              "candidate replay does not require initial packages",
            );
          },
        },
      });

    assert.deepStrictEqual(replayCandidate().manifest.engines, {
      node: ">=24",
    });

    assert.deepStrictEqual(replayCandidate("24.16.0").manifest.engines, {
      node: "^24.16.0",
    });
  });

  void it("rejects an added command that conflicts with an existing manifest fact before writes", async () => {
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
        nodeVersion: "24.16.0",
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

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition: tsCliDefinition,
            localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
            packageLeafName: "release",
          }),
        (error: unknown) =>
          (error instanceof Error ? error.message : String(error)).includes(
            'CLI command name "release" from @demo/release is already used by @demo/cli',
          ),
      );
      await assert.rejects(stat(path.join(targetDir, "packages/release")), {
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("appears in the public CLI Preset Catalog without exporting planner internals", async () => {
    const publicApi = await import("../index.ts");
    assert.strictEqual("tsCliDefinition" in publicApi, false);
    assert.strictEqual("tsCli" in publicApi.templateSources, true);

    const repositoryRoot = path.resolve(process.cwd(), "..", "..");
    const result = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repositoryRoot, "packages/cli/src/cli.ts"),
        "presets",
        "--output-format",
        "text",
      ],
      { cwd: repositoryRoot },
    );
    assert.ok(result.stdout.includes("内置预设"));
    assert.match(result.stdout, /\bts-cli\b/u);
    assert.ok(
      result.stdout.includes("TypeScript 命令行工具 - TypeScript 命令行包。"),
    );
  });
});
