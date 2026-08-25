import { describe, expect, it } from "vitest";

import {
  normalizeEnvironmentNeeds,
  parseEnvironmentNeedsMetadata,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "#template-core/module-graph";

const workspaceOwner = {
  kind: "workspace-orchestration" as const,
  path: "." as const,
};

describe("Environment Need lifecycle", () => {
  it("uses the durable semantic declaration as canonical identity", () => {
    const browser = playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: workspaceOwner,
    });
    const shellcheck = shellCheckEnvironmentNeed(workspaceOwner);

    expect(
      normalizeEnvironmentNeeds({
        check: [shellcheck, browser, shellcheck],
        deployment: [{ kind: "docker-engine" }, { kind: "docker-engine" }],
      }),
    ).toEqual({
      schemaVersion: 1,
      check: [browser, shellcheck],
      deployment: [{ kind: "docker-engine" }],
    });
  });

  it("strictly parses and normalizes versioned Local Template Metadata", () => {
    expect(
      parseEnvironmentNeedsMetadata({
        schemaVersion: 1,
        check: [
          {
            kind: "shellcheck-command",
            owner: workspaceOwner,
          },
        ],
        deployment: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      check: [{ kind: "shellcheck-command", owner: workspaceOwner }],
      deployment: [],
    });

    expect(() =>
      parseEnvironmentNeedsMetadata({
        schemaVersion: 1,
        check: [
          {
            kind: "shellcheck-command",
            owner: workspaceOwner,
            inferredFromTaskGraph: true,
          },
        ],
        deployment: [],
      }),
    ).toThrow("check[0] contains unknown field: inferredFromTaskGraph");
  });

  it("rejects semantic-parameter conflicts instead of persisting a second identity", () => {
    expect(() =>
      normalizeEnvironmentNeeds({
        check: [
          playwrightBrowserAssetsEnvironmentNeed({
            browser: "chromium",
            owner: workspaceOwner,
          }),
          {
            kind: "playwright-browser-assets",
            browser: "webkit" as never,
            owner: workspaceOwner,
          },
        ],
        deployment: [],
      }),
    ).toThrow("check[1].browser must be chromium");
  });

  it("does not accept Deployment Environment Needs as ordinary Check Environment Needs or vice versa", () => {
    expect(() =>
      parseEnvironmentNeedsMetadata({
        schemaVersion: 1,
        check: [{ kind: "docker-engine" }],
        deployment: [],
      }),
    ).toThrow("check[0] has unsupported kind: docker-engine");

    expect(() =>
      parseEnvironmentNeedsMetadata({
        schemaVersion: 1,
        check: [],
        deployment: [
          {
            kind: "shellcheck-command",
            owner: workspaceOwner,
          },
        ],
      }),
    ).toThrow("deployment[0] contains unknown field: owner");
  });
});
