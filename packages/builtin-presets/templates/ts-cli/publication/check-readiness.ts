#!/usr/bin/env node
import { inspectNpmPublicationReadiness } from "./readiness.ts";

const publicCliPackagePath = "{{PUBLIC_CLI_PACKAGE_PATH}}";

function oneLine(value: string): string {
  return value.replaceAll(/\s*\r?\n\s*/gu, " ");
}

const cliArguments = process.argv.slice(2);
const unknownArguments = cliArguments.filter(
  (argument) => argument !== "--require-ready",
);
if (
  unknownArguments.length > 0 ||
  cliArguments.filter((argument) => argument === "--require-ready").length > 1
) {
  console.error("ERROR publication-readiness-usage");
  console.error(`Observed: ${JSON.stringify(cliArguments)}`);
  console.error("Expected: no arguments or --require-ready");
  console.error(
    "Next action: Run the generated publication:readiness script with a supported option.",
  );
  process.exitCode = 2;
} else {
  try {
    const result = await inspectNpmPublicationReadiness({
      repositoryRoot: process.cwd(),
      packagePath: publicCliPackagePath,
    });
    if (result.kind === "ready") {
      console.log("npm publication readiness: ready");
      console.log(
        `Package: ${result.publication.packageName}@${result.publication.version}`,
      );
      console.log(`Command: ${result.publication.commandName}`);
      console.log(`Repository: ${result.publication.repository}`);
    } else {
      console.log("npm publication readiness: blocked");
      console.log(`Mode: ${result.mode}`);
      for (const item of result.blockers) {
        console.log(`BLOCKER ${item.code}`);
        console.log(`Owner: ${item.owner.path}${item.owner.pointer ?? ""}`);
        console.log(`Observed: ${oneLine(item.observed)}`);
        console.log(`Expected: ${oneLine(item.expected)}`);
        console.log(`Next action: ${oneLine(item.nextAction)}`);
      }
      if (
        cliArguments.includes("--require-ready") ||
        result.mode === "public-intent"
      ) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error("ERROR publication-readiness-inspection");
    console.error(
      `Observed: ${oneLine(error instanceof Error ? error.message : String(error))}`,
    );
    console.error("Expected: readable local npm publication owner facts");
    console.error(
      "Next action: Correct the reported repository path or filesystem failure and retry.",
    );
    process.exitCode = 1;
  }
}
