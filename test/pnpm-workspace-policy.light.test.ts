import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderGeneratedPnpmWorkspaceYaml } from "@ykdz/template-workspace/dependency-catalog";

void describe("pnpm Workspace Policy", () => {
  void it("renders only explicitly requested dependency overrides", () => {
    const workspace = renderGeneratedPnpmWorkspaceYaml({
      dependencies: [],
      overrides: { "example>peer": "-" },
    });

    assert.ok(workspace.includes('"example>peer": "-"'));
    assert.ok(workspace.includes("injectWorkspacePackages: false"));
    assert.ok(!workspace.includes("valibot>typescript"));
    assert.ok(!workspace.includes("pnpmfile"));
  });
});
