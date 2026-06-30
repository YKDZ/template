#!/usr/bin/env node
import {
  checkOnlineToolchainResolutionContract,
  type OnlineToolchainResolutionContractResult,
} from "../src/toolchain-resolution.js";

type RunOnlineToolchainResolutionContractCheckOptions = {
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
};

export async function runOnlineToolchainResolutionContractCheck(
  options: RunOnlineToolchainResolutionContractCheckOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;

  try {
    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: options.fetchJson,
    });
    printSuccess(result, stdout);
    return 0;
  } catch (error: unknown) {
    stderr("Online toolchain resolution contract check failed.");
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printSuccess(
  result: OnlineToolchainResolutionContractResult,
  stdout: (line: string) => void,
): void {
  stdout("Online toolchain resolution contract check passed.");
  stdout(`Node LTS major: ${result.nodeLtsMajor.value}`);
  stdout(`Package Manager Pin: ${result.packageManagerPin.value}`);
  for (const diagnostic of result.diagnostics) {
    stdout(diagnostic);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runOnlineToolchainResolutionContractCheck();
}
