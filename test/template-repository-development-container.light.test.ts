import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

void describe("template Repository Development Container", () => {
  void it("installs GitHub CLI from its official stable Debian repository", async () => {
    const [dockerfile, devcontainer] = await Promise.all([
      readFile(path.join(process.cwd(), ".devcontainer/Dockerfile"), "utf8"),
      readFile(
        path.join(process.cwd(), ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    ]);

    assert.ok(
      dockerfile.includes("https://cli.github.com/packages stable main"),
    );
    assert.ok(dockerfile.includes("        gh \\\n"));
    assert.doesNotMatch(
      `${dockerfile}\n${devcontainer}`,
      /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b|\.config\/gh|\bgh\s+auth\b|\bauth\s+setup-git\b/u,
    );
  });
});
