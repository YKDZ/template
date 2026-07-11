import { runOnlineToolchainResolutionContractCheck } from "@ykdz/template-checks/check-online-toolchain-resolution-contract";
import {
  nodeReleaseIndexUrl,
  pnpmRegistryUrl,
} from "@ykdz/template-core/toolchain-resolution";

describe("check-online-toolchain-resolution-contract script", () => {
  it("prints selected online toolchain versions when the contract passes", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runOnlineToolchainResolutionContractCheck({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetchJson: async (url) => {
        if (url === nodeReleaseIndexUrl) {
          return [{ version: "v24.11.0", lts: "Krypton" }];
        }

        if (url === pnpmRegistryUrl) {
          return {
            time: { "11.0.0": "2025-01-01T00:00:00.000Z" },
            versions: { "11.0.0": { engines: { node: ">=24.0.0" } } },
          };
        }

        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain(
      "Online toolchain resolution contract check passed.",
    );
    expect(stdout.join("\n")).toContain("Node LTS major: 24");
    expect(stdout.join("\n")).toContain("Package Manager Pin: pnpm@11.0.0");
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
    expect(stderr.join("\n")).toContain(
      "Online toolchain resolution contract check failed.",
    );
    expect(stderr.join("\n")).toContain(
      "Online toolchain resolution contract failed during Node source parsing",
    );
  });
});
