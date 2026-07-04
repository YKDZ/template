import { resolveToolchainVersions } from "@ykdz/template-core/toolchain-resolution";

const nodeReleaseIndex = [
  { version: "v24.11.0", lts: "Krypton" },
  { version: "v26.1.0", lts: false },
  { version: "v20.18.0", lts: "Iron" },
  { version: "v24.9.0", lts: false },
];

const pnpmRegistryMetadata = {
  versions: {
    "10.1.0": { engines: { node: ">=18.12" } },
    "11.0.0": { engines: { node: ">=24.0.0" } },
    "12.0.0": { engines: { node: ">=26.0.0" } },
  },
};

describe("toolchain version resolution", () => {
  it("resolves online source data by default with caller-provided boundary data", async () => {
    const result = await resolveToolchainVersions({
      fetchJson: async (url) => {
        if (url.includes("nodejs.org")) {
          return nodeReleaseIndex;
        }

        return pnpmRegistryMetadata;
      },
    });

    expect(result.source).toBe("online");
    expect(result.nodeLtsMajor.value).toBe("24");
    expect(result.packageManagerPin.value).toBe("pnpm@11.0.0");
    expect(result.diagnostics).toEqual([]);
  });

  it("resolves the latest Node LTS major and latest compatible pnpm from online source data", async () => {
    const result = await resolveToolchainVersions({
      source: "online",
      fetchJson: async (url) => {
        if (url.includes("nodejs.org")) {
          return nodeReleaseIndex;
        }

        return pnpmRegistryMetadata;
      },
    });

    expect(result.source).toBe("online");
    expect(result.nodeLtsMajor.value).toBe("24");
    expect(result.packageManagerPin.value).toBe("pnpm@11.0.0");
    expect(result.diagnostics).toEqual([]);
  });

  it("falls back to bundled toolchain metadata with visible diagnostics when online source access fails", async () => {
    const result = await resolveToolchainVersions({
      source: "online",
      fetchJson: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(result.source).toBe("bundled-fallback");
    expect(result.nodeLtsMajor.value).toBe("24");
    expect(result.packageManagerPin.value).toBe("pnpm@10.0.0");
    expect(result.diagnostics).toEqual([
      expect.stringContaining("Using bundled fallback toolchain metadata"),
    ]);
    expect(result.diagnostics.join("\n")).toContain("network unavailable");
  });

  it("uses bundled fallback metadata without source access for deterministic local generation", async () => {
    const result = await resolveToolchainVersions({
      source: "bundled-fallback",
      fetchJson: async () => {
        throw new Error("should not fetch");
      },
    });

    expect(result.source).toBe("bundled-fallback");
    expect(result.nodeLtsMajor.value).toBe("24");
    expect(result.packageManagerPin.value).toBe("pnpm@10.0.0");
    expect(result.diagnostics).toEqual([]);
  });
});
