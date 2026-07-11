import { resolveToolchainVersions } from "@ykdz/template-core/toolchain-resolution";

const nodeReleaseIndex = [
  { version: "v24.11.0", lts: "Krypton" },
  { version: "v26.1.0", lts: false },
  { version: "v20.18.0", lts: "Iron" },
  { version: "v24.9.0", lts: false },
];

const pnpmRegistryMetadata = {
  time: {
    "10.1.0": "2026-01-01T00:00:00.000Z",
    "11.0.0": "2026-01-02T00:00:00.000Z",
    "12.0.0": "2026-01-03T00:00:00.000Z",
  },
  versions: {
    "10.1.0": { engines: { node: ">=18.12" } },
    "11.0.0": { engines: { node: ">=24.0.0" } },
    "12.0.0": { engines: { node: ">=26.0.0" } },
  },
};

describe("toolchain version resolution", () => {
  it("resolves online source data by default with caller-provided boundary data", async () => {
    const result = await resolveToolchainVersions({
      now: "2026-01-10T00:00:00.000Z",
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
      now: "2026-01-10T00:00:00.000Z",
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

  it("selects only pnpm releases that have completed the strict 24-hour maturity window", async () => {
    const result = await resolveToolchainVersions({
      now: "2026-01-04T00:00:00.000Z",
      fetchJson: async (url) =>
        url.includes("nodejs.org")
          ? nodeReleaseIndex
          : {
              time: {
                "11.0.0": "2026-01-03T00:00:00.000Z",
                "11.1.0": "2026-01-03T00:00:00.001Z",
              },
              versions: {
                "11.0.0": { engines: { node: ">=24" } },
                "11.1.0": { engines: { node: ">=24" } },
              },
            },
    });

    expect(result.packageManagerPin.value).toBe("pnpm@11.0.0");
  });

  it("selects deterministically regardless of registry object ordering and skips malformed publication times", async () => {
    const registry = {
      time: {
        "11.2.0": "not-an-instant",
        "11.1.0": "2025-01-01T00:00:00.000Z",
        "11.0.0": "2025-01-01T00:00:00.000Z",
      },
      versions: {
        "11.2.0": { engines: { node: ">=24" } },
        "11.1.0": { engines: { node: ">=24" } },
        "11.0.0": { engines: { node: ">=24" } },
      },
    };
    const resolve = (versions: typeof registry.versions) =>
      resolveToolchainVersions({
        now: "2026-01-01T00:00:00.000Z",
        fetchJson: async (url) =>
          url.includes("nodejs.org")
            ? nodeReleaseIndex
            : { ...registry, versions },
      });

    const forward = await resolve(registry.versions);
    const reverse = await resolve(
      Object.fromEntries(
        Object.entries(registry.versions).toReversed(),
      ) as typeof registry.versions,
    );

    expect(forward.packageManagerPin.value).toBe("pnpm@11.1.0");
    expect(reverse.packageManagerPin).toEqual(forward.packageManagerPin);
  });

  it("does not promote prerelease pnpm builds into the maintained baseline", async () => {
    const result = await resolveToolchainVersions({
      now: "2026-01-01T00:00:00.000Z",
      fetchJson: async (url) =>
        url.includes("nodejs.org")
          ? nodeReleaseIndex
          : {
              time: {
                "11.1.0": "2025-01-01T00:00:00.000Z",
                "12.0.0-alpha.1": "2025-01-01T00:00:00.000Z",
              },
              versions: {
                "11.1.0": { engines: { node: ">=24" } },
                "12.0.0-alpha.1": { engines: { node: ">=24" } },
              },
            },
    });

    expect(result.packageManagerPin.value).toBe("pnpm@11.1.0");
  });

  it.each([
    [">=24.11.0", "11.1.0"],
    [">=24.11.1", "11.0.0"],
    ["^24.10.0", "11.1.0"],
    ["~24.10.0", "11.0.0"],
    [">=26 || >=24.10.0", "11.1.0"],
    ["definitely-not-semver", "11.0.0"],
  ])(
    "evaluates the full Node baseline against pnpm engine range %s",
    async (range, expected) => {
      const result = await resolveToolchainVersions({
        now: "2026-01-10T00:00:00.000Z",
        fetchJson: async (url) =>
          url.includes("nodejs.org")
            ? nodeReleaseIndex
            : {
                time: {
                  "11.0.0": "2026-01-01T00:00:00.000Z",
                  "11.1.0": "2026-01-01T00:00:00.000Z",
                },
                versions: {
                  "11.0.0": { engines: { node: ">=20" } },
                  "11.1.0": { engines: { node: range } },
                },
              },
      });

      expect(result.packageManagerPin.value).toBe(`pnpm@${expected}`);
    },
  );

  it("falls back to bundled toolchain metadata with visible diagnostics when online source access fails", async () => {
    const result = await resolveToolchainVersions({
      source: "online",
      fetchJson: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(result.source).toBe("bundled-fallback");
    expect(result.nodeLtsMajor.value).toBe("24");
    expect(result.packageManagerPin.value).toBe("pnpm@11.11.0");
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
    expect(result.packageManagerPin.value).toBe("pnpm@11.11.0");
    expect(result.diagnostics).toEqual([]);
  });
});
