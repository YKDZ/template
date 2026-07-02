import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("npm release workflow", () => {
  it("publishes through GitHub Actions OIDC without a long-lived npm token", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("needs: check");
    expect(workflow).toContain(
      "pnpm publish --no-git-checks --access public --provenance",
    );
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  it("uses package metadata and pnpm for publishing", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("uses: actions/checkout@v6");
    expect(workflow).toContain("uses: actions/setup-node@v6");
    expect(workflow).toContain("node-version-file: package.json");
    expect(workflow).toContain("run: corepack enable");
    expect(workflow).toContain("run: pnpm install --frozen-lockfile");
    expect(workflow).toContain(
      "run: pnpm publish --no-git-checks --access public --provenance",
    );
    expect(workflow).not.toContain("node-version:");
    expect(workflow).not.toContain("npm install -g");
    expect(workflow).not.toMatch(/run:\s+npm publish/);
  });

  it("reuses the repository check workflow before publishing", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("uses: ./.github/workflows/check.yml");
    expect(workflow).toContain("needs: check");
    expect(workflow).not.toContain("run: pnpm run check\n");
    expect(workflow).not.toContain("run: pnpm run check:fixtures");
  });

  it("documents the human-owned trusted publishing setup checklist", async () => {
    const docs = await readFile(
      path.join(repoRoot, "public/npm-trusted-publishing.md"),
      "utf8",
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
      path.join(repoRoot, "public/npm-trusted-publishing.md"),
      "utf8",
    );
    const trustedPublisherLine = docs
      .split("\n")
      .find((line) => line.includes("Trusted publisher:"));

    expect(trustedPublisherLine).toContain("workflow filename `release.yml`");
    expect(trustedPublisherLine).not.toContain(".github/workflows/release.yml");
    expect(trustedPublisherLine).toContain("Allowed actions");
    expect(trustedPublisherLine).toContain("pnpm publish");
  });
});
