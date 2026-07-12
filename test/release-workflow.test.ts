import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publicCliPackageName = ["@ykdz", "template"].join("/");
const publishCommand = `pnpm --filter ${publicCliPackageName} run publish:bundled --no-git-checks --access public --provenance`;

function expectWorkflowUsesVersionedAction(
  workflow: string,
  action: "actions/checkout" | "actions/setup-node",
): void {
  expect(workflow).toMatch(new RegExp(`uses: ${action}@v\\d+`));
}

describe("npm release workflow", () => {
  it("publishes through GitHub Actions OIDC without a long-lived npm token", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("needs: check");
    expect(workflow).toContain(publishCommand);
    expect(workflow).not.toContain("PNPM_CONFIG_NODE_LINKER");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  it("uses package metadata and pnpm for publishing", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expectWorkflowUsesVersionedAction(workflow, "actions/checkout");
    expectWorkflowUsesVersionedAction(workflow, "actions/setup-node");
    expect(workflow).toContain("node-version-file: package.json");
    expect(workflow).toContain("run: corepack enable");
    expect(workflow).toContain("run: pnpm install --frozen-lockfile");
    expect(workflow).toContain(`run: ${publishCommand}`);
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
});
