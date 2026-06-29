import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("npm release workflow", () => {
  it("publishes through GitHub Actions OIDC without a long-lived npm token", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8"
    );

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("npm publish --access public --provenance");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  it("documents the human-owned trusted publishing setup checklist", async () => {
    const docs = await readFile(
      path.join(repoRoot, "docs/npm-trusted-publishing.md"),
      "utf8"
    );

    expect(docs).toContain("npm account");
    expect(docs).toContain("Package access");
    expect(docs).toContain("Trusted publisher");
    expect(docs).toContain("GitHub environment");
    expect(docs).toContain("release permission");
    expect(docs).toContain("Security settings");
    expect(docs).toContain("NPM_TOKEN");
    expect(docs).toContain("Maintainer confirmation");
  });
});
