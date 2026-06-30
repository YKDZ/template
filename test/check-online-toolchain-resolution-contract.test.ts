import { runOnlineToolchainResolutionContractCheck } from "../scripts/check-online-toolchain-resolution-contract.js";
import { nodeReleaseIndexUrl, pnpmRegistryUrl } from "../src/toolchain-resolution.js";

describe("check-online-toolchain-resolution-contract script", () => {
  it("prints selected online toolchain versions when the contract passes", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runOnlineToolchainResolutionContractCheck({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetchJson: async (url) => {
        if (url === nodeReleaseIndexUrl) {
          return [{ version: "v22.11.0", lts: "Jod" }];
        }

        if (url === pnpmRegistryUrl) {
          return { versions: { "10.2.0": { engines: { node: ">=22.0.0" } } } };
        }

        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Online toolchain resolution contract check passed.");
    expect(stdout.join("\n")).toContain("Node LTS major: 22");
    expect(stdout.join("\n")).toContain("Package Manager Pin: pnpm@10.2.0");
  });

  it("prints clear diagnostics when the contract fails", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runOnlineToolchainResolutionContractCheck({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetchJson: async () => ({ versions: {} }),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Online toolchain resolution contract check failed.");
    expect(stderr.join("\n")).toContain(
      "Online toolchain resolution contract failed during Node source parsing",
    );
  });
});
