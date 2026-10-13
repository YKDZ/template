import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeEnvironmentNeeds,
  parseEnvironmentNeedsMetadata,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@ykdz/template-core/module-graph";

const workspaceOwner = {
  kind: "workspace-orchestration" as const,
  path: "." as const,
};

void describe("Environment Need lifecycle", () => {
  void it("uses the durable semantic declaration as canonical identity", () => {
    const browser = playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: workspaceOwner,
    });
    const shellcheck = shellCheckEnvironmentNeed(workspaceOwner);

    assert.deepStrictEqual(
      normalizeEnvironmentNeeds({
        check: [shellcheck, browser, shellcheck],
        deployment: [{ kind: "docker-engine" }, { kind: "docker-engine" }],
      }),
      {
        schemaVersion: 1,
        check: [browser, shellcheck],
        deployment: [{ kind: "docker-engine" }],
      },
    );
  });

  void it("strictly parses and normalizes versioned Local Template Metadata", () => {
    assert.deepStrictEqual(
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
      {
        schemaVersion: 1,
        check: [{ kind: "shellcheck-command", owner: workspaceOwner }],
        deployment: [],
      },
    );

    assert.throws(
      () =>
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
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "check[0] contains unknown field: inferredFromTaskGraph",
        ),
    );
  });

  void it("rejects semantic-parameter conflicts instead of persisting a second identity", () => {
    assert.throws(
      () =>
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
      (error) =>
        error instanceof Error &&
        error.message.includes("check[1].browser must be chromium"),
    );
  });

  void it("does not accept Deployment Environment Needs as ordinary Check Environment Needs or vice versa", () => {
    assert.throws(
      () =>
        parseEnvironmentNeedsMetadata({
          schemaVersion: 1,
          check: [{ kind: "docker-engine" }],
          deployment: [],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes("check[0] has unsupported kind: docker-engine"),
    );

    assert.throws(
      () =>
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
      (error) =>
        error instanceof Error &&
        error.message.includes("deployment[0] contains unknown field: owner"),
    );
  });
});
