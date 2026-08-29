#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyNpmPublicationArtifact } from "./artifact.ts";

const publicCliPackagePath = "{{PUBLIC_CLI_PACKAGE_PATH}}";

function oneLine(value: string): string {
  return value.replaceAll(/\s*\r?\n\s*/gu, " ");
}

const rawArguments = process.argv.slice(2);
const arguments_ =
  rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
const explicitOutputDirectory =
  arguments_.length === 2 &&
  arguments_[0] === "--output-directory" &&
  arguments_[1]!.length > 0
    ? path.resolve(arguments_[1]!)
    : undefined;
const validArguments =
  arguments_.length === 0 || explicitOutputDirectory !== undefined;
if (!validArguments) {
  console.error("ERROR publication-artifact-usage");
  console.error(`Observed: ${JSON.stringify(arguments_)}`);
  console.error(
    "Expected: no arguments or --output-directory <existing-empty-directory>",
  );
  console.error(
    "Next action: Run without arguments for disposable verification, or pass one existing empty directory to retain the tgz, checksum, and receipt.",
  );
  process.exitCode = 2;
} else {
  const ownedTemporaryOutput = explicitOutputDirectory === undefined;
  const outputDirectory =
    explicitOutputDirectory ??
    (await mkdtemp(path.join(tmpdir(), "npm-publication-artifact-")));
  try {
    const result = await verifyNpmPublicationArtifact({
      repositoryRoot: process.cwd(),
      packagePath: publicCliPackagePath,
      outputDirectory,
    });
    if (result.kind === "blocked") {
      console.log("npm publication artifact: blocked");
      console.log(`Mode: ${result.readiness.mode}`);
      for (const item of result.readiness.blockers) {
        console.log(`BLOCKER ${item.code}`);
        console.log(`Owner: ${item.owner.path}${item.owner.pointer ?? ""}`);
        console.log(`Observed: ${oneLine(item.observed)}`);
        console.log(`Expected: ${oneLine(item.expected)}`);
        console.log(`Next action: ${oneLine(item.nextAction)}`);
      }
      if (result.readiness.mode === "public-intent") process.exitCode = 1;
    } else if (result.kind === "failed") {
      console.error(`ERROR ${result.failure.code}`);
      console.error(`Observed: ${oneLine(result.failure.observed)}`);
      console.error(`Expected: ${oneLine(result.failure.expected)}`);
      console.error(`Next action: ${oneLine(result.failure.nextAction)}`);
      process.exitCode = 1;
    } else {
      console.log("npm publication artifact: verified");
      console.log(
        `Package: ${result.receipt.publication.packageName}@${result.receipt.publication.version}`,
      );
      console.log(`Command: ${result.receipt.publication.commandName}`);
      for (const file of result.receipt.files)
        console.log(`File: ${file.path}`);
      console.log(`Integrity: ${result.receipt.artifact.integrity}`);
      console.log(`Checksum: ${result.receipt.artifact.checksumFile}`);
      for (const smoke of result.receipt.smokes)
        console.log(`Smoke: ${smoke.name}`);
      if (!ownedTemporaryOutput) {
        console.log(`Artifact: ${result.artifactPath}`);
        console.log(`Checksum file: ${result.checksumPath}`);
        console.log(`Receipt: ${result.receiptPath}`);
      }
    }
  } finally {
    if (ownedTemporaryOutput) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}
