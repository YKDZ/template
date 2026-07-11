import {
  checkOnlineToolchainResolutionContract,
  nodeReleaseIndexUrl,
  pnpmRegistryUrl,
} from "@ykdz/template-core/toolchain-resolution";

describe("online toolchain resolution contract check", () => {
  it("validates official Node and pnpm source data through the online resolution contract", async () => {
    const requestedUrls: string[] = [];

    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: async (url) => {
        requestedUrls.push(url);

        if (url === nodeReleaseIndexUrl) {
          return [
            { version: "v24.11.0", lts: "Krypton" },
            { version: "v26.1.0", lts: false },
            { version: "v20.18.0", lts: "Iron" },
          ];
        }

        if (url === pnpmRegistryUrl) {
          return {
            time: {
              "10.1.0": "2025-01-01T00:00:00.000Z",
              "11.0.0": "2025-01-01T00:00:00.000Z",
              "12.0.0": "2025-01-01T00:00:00.000Z",
            },
            versions: {
              "10.1.0": { engines: { node: ">=18.12" } },
              "11.0.0": { engines: { node: ">=24.0.0" } },
              "12.0.0": { engines: { node: ">=26.0.0" } },
            },
          };
        }

        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(requestedUrls).toEqual([nodeReleaseIndexUrl, pnpmRegistryUrl]);
    expect(result.nodeLtsMajor.value).toBe("24");
    expect(result.packageManagerPin.value).toBe("pnpm@11.0.0");
    expect(result.diagnostics).toEqual([
      "Node source parsing succeeded; latest LTS major is 24.",
      "pnpm source parsing succeeded; latest compatible pnpm release is 11.0.0.",
      "Compatibility selection succeeded for pnpm@11.0.0 on Node 24.",
    ]);
  });

  it("identifies Node source parsing failures", async () => {
    await expect(
      checkOnlineToolchainResolutionContract({
        fetchJson: async () => ({ versions: {}, time: {} }),
      }),
    ).rejects.toThrow(
      "Online toolchain resolution contract failed during Node source parsing: Node release index was not an array",
    );
  });

  it("identifies pnpm source parsing failures", async () => {
    await expect(
      checkOnlineToolchainResolutionContract({
        fetchJson: async (url) => {
          if (url === nodeReleaseIndexUrl) {
            return [{ version: "v24.11.0", lts: "Krypton" }];
          }

          return [];
        },
      }),
    ).rejects.toThrow(
      "Online toolchain resolution contract failed during pnpm source parsing: pnpm registry metadata is missing versions",
    );
  });

  it("identifies compatible pnpm selection failures", async () => {
    await expect(
      checkOnlineToolchainResolutionContract({
        fetchJson: async (url) => {
          if (url === nodeReleaseIndexUrl) {
            return [{ version: "v24.11.0", lts: "Krypton" }];
          }

          return {
            time: { "12.0.0": "2025-01-01T00:00:00.000Z" },
            versions: {
              "12.0.0": { engines: { node: ">=26.0.0" } },
            },
          };
        },
      }),
    ).rejects.toThrow(
      "Online toolchain resolution contract failed during compatibility selection: pnpm registry metadata did not contain a release compatible with Node 24",
    );
  });

  it("skips incompatible higher pnpm releases during compatibility selection", async () => {
    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: async (url) => {
        if (url === nodeReleaseIndexUrl) {
          return [{ version: "v24.11.0", lts: "Krypton" }];
        }

        return {
          time: {
            "10.3.0": "2025-01-01T00:00:00.000Z",
            "11.0.0": "2025-01-01T00:00:00.000Z",
          },
          versions: {
            "10.3.0": { engines: { node: ">=20.0.0" } },
            "11.0.0": { engines: { node: ">=26.0.0" } },
          },
        };
      },
    });

    expect(result.packageManagerPin.value).toBe("pnpm@10.3.0");
  });

  it("uses npm semver semantics for pnpm engine ranges", async () => {
    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: async (url) => {
        if (url === nodeReleaseIndexUrl) {
          return [{ version: "v24.11.0", lts: "Krypton" }];
        }

        return {
          time: {
            "11.0.0": "2025-01-01T00:00:00.000Z",
            "12.0.0": "2025-01-01T00:00:00.000Z",
            "12.1.0": "2025-01-01T00:00:00.000Z",
            "12.2.0": "2025-01-01T00:00:00.000Z",
          },
          versions: {
            "11.0.0": { engines: { node: ">=24.0.0" } },
            "12.0.0": { engines: { node: "^24.0.0" } },
            "12.1.0": { engines: { node: ">=20.0.0 || >=24.0.0" } },
            "12.2.0": { engines: { node: "~24.0.0" } },
          },
        };
      },
    });

    expect(result.packageManagerPin.value).toBe("pnpm@12.1.0");
  });

  it.each([
    ["caret", "^24.0.0"],
    ["OR", ">=20.0.0 || >=24.0.0"],
  ])("accepts compatible %s pnpm engine ranges", async (_label, range) => {
    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: async (url) => {
        if (url === nodeReleaseIndexUrl) {
          return [{ version: "v24.11.0", lts: "Krypton" }];
        }

        return {
          time: { "11.0.0": "2025-01-01T00:00:00.000Z" },
          versions: {
            "11.0.0": { engines: { node: range } },
          },
        };
      },
    });
    expect(result.packageManagerPin.value).toBe("pnpm@11.0.0");
  });

  it("rejects a valid pnpm engine range that excludes the current Node LTS", async () => {
    await expect(
      checkOnlineToolchainResolutionContract({
        fetchJson: async (url) =>
          url === nodeReleaseIndexUrl
            ? [{ version: "v24.11.0", lts: "Krypton" }]
            : {
                time: { "11.0.0": "2025-01-01T00:00:00.000Z" },
                versions: {
                  "11.0.0": { engines: { node: "~24.0.0" } },
                },
              },
      }),
    ).rejects.toThrow(
      "Online toolchain resolution contract failed during compatibility selection: pnpm registry metadata did not contain a release compatible with Node 24",
    );
  });
});
