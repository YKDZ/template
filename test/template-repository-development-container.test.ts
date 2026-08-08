import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("template Repository Development Container", () => {
  it("installs GitHub CLI from its official stable Debian repository", async () => {
    const [dockerfile, devcontainer] = await Promise.all([
      readFile(path.join(process.cwd(), ".devcontainer/Dockerfile"), "utf8"),
      readFile(
        path.join(process.cwd(), ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    ]);

    expect(dockerfile).toContain("https://cli.github.com/packages stable main");
    expect(dockerfile).toContain("        gh \\\n");
    expect(`${dockerfile}\n${devcontainer}`).not.toMatch(
      /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b|\.config\/gh|\bgh\s+auth\b|\bauth\s+setup-git\b/u,
    );
  });
});
