import {
  checkOnlineToolchainResolutionContract,
  nodeReleaseIndexUrl,
  pnpmRegistryUrl,
} from "../src/toolchain-resolution.js";

describe("online toolchain resolution contract check", () => {
  it("validates official Node and pnpm source data through the online resolution contract", async () => {
    const requestedUrls: string[] = [];

    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: async (url) => {
        requestedUrls.push(url);

        if (url === nodeReleaseIndexUrl) {
          return [
            { version: "v22.11.0", lts: "Jod" },
            { version: "v24.1.0", lts: false },
            { version: "v20.18.0", lts: "Iron" },
          ];
        }

        if (url === pnpmRegistryUrl) {
          return {
            versions: {
              "10.1.0": { engines: { node: ">=18.12" } },
              "11.0.0": { engines: { node: ">=24.0.0" } },
              "10.2.0": { engines: { node: ">=22.0.0" } },
            },
          };
        }

        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(requestedUrls).toEqual([nodeReleaseIndexUrl, pnpmRegistryUrl]);
    expect(result.nodeLtsMajor.value).toBe("22");
    expect(result.packageManagerPin.value).toBe("pnpm@10.2.0");
    expect(result.diagnostics).toEqual([
      "Node source parsing succeeded; latest LTS major is 22.",
      "pnpm source parsing succeeded; latest compatible pnpm release is 10.2.0.",
      "Compatibility selection succeeded for pnpm@10.2.0 on Node 22.",
    ]);
  });

  it("identifies Node source parsing failures", async () => {
    await expect(
      checkOnlineToolchainResolutionContract({
        fetchJson: async () => ({ versions: {} }),
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
            return [{ version: "v22.11.0", lts: "Jod" }];
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
            return [{ version: "v22.11.0", lts: "Jod" }];
          }

          return {
            versions: {
              "11.0.0": { engines: { node: ">=24.0.0" } },
            },
          };
        },
      }),
    ).rejects.toThrow(
      "Online toolchain resolution contract failed during compatibility selection: pnpm registry metadata did not contain a release compatible with Node 22",
    );
  });

  it("skips incompatible higher pnpm releases during compatibility selection", async () => {
    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: async (url) => {
        if (url === nodeReleaseIndexUrl) {
          return [{ version: "v22.11.0", lts: "Jod" }];
        }

        return {
          versions: {
            "10.3.0": { engines: { node: ">=20.0.0" } },
            "11.0.0": { engines: { node: ">=24.0.0" } },
          },
        };
      },
    });

    expect(result.packageManagerPin.value).toBe("pnpm@10.3.0");
  });

  it("does not select pnpm releases with unsupported engine range syntax", async () => {
    const result = await checkOnlineToolchainResolutionContract({
      fetchJson: async (url) => {
        if (url === nodeReleaseIndexUrl) {
          return [{ version: "v22.11.0", lts: "Jod" }];
        }

        return {
          versions: {
            "10.2.0": { engines: { node: ">=22.0.0" } },
            "11.0.0": { engines: { node: "^22.0.0" } },
            "11.1.0": { engines: { node: ">=20.0.0 || >=22.0.0" } },
            "11.2.0": { engines: { node: "~22.0.0" } },
          },
        };
      },
    });

    expect(result.packageManagerPin.value).toBe("pnpm@10.2.0");
  });

  it.each([
    ["caret", "^22.0.0"],
    ["OR", ">=20.0.0 || >=22.0.0"],
    ["unsupported", "~22.0.0"],
  ])("treats %s pnpm engine ranges as incompatible", async (_label, range) => {
    await expect(
      checkOnlineToolchainResolutionContract({
        fetchJson: async (url) => {
          if (url === nodeReleaseIndexUrl) {
            return [{ version: "v22.11.0", lts: "Jod" }];
          }

          return {
            versions: {
              "11.0.0": { engines: { node: range } },
            },
          };
        },
      }),
    ).rejects.toThrow(
      "Online toolchain resolution contract failed during compatibility selection: pnpm registry metadata did not contain a release compatible with Node 22",
    );
  });
});
