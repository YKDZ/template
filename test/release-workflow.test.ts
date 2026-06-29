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

  it("guarantees a Trusted Publishing-capable npm CLI before publishing", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8"
    );

    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("npm install -g npm@^11.5.1");
    expect(workflow).toContain("npm --version");
    expect(workflow).toContain(">=11.5.1");
    expect(workflow.indexOf(">=11.5.1")).toBeLessThan(
      workflow.indexOf("npm publish --access public --provenance")
    );
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

  it("documents npm Trusted Publisher settings using npm's expected field values", async () => {
    const docs = await readFile(
      path.join(repoRoot, "docs/npm-trusted-publishing.md"),
      "utf8"
    );
    const trustedPublisherLine = docs
      .split("\n")
      .find((line) => line.includes("Trusted publisher:"));

    expect(trustedPublisherLine).toContain("workflow filename `release.yml`");
    expect(trustedPublisherLine).not.toContain(".github/workflows/release.yml");
    expect(trustedPublisherLine).toContain("Allowed actions");
    expect(trustedPublisherLine).toContain("npm publish");
  });
});
