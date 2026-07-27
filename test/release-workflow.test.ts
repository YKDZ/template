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
  it("keeps the unreleased CLI version in one package manifest field", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "packages/cli/package.json"), "utf8"),
    ) as { readonly version: string };
    const cliSource = await readFile(
      path.join(repoRoot, "packages/cli/src/cli.ts"),
      "utf8",
    );
    const applicationSource = await readFile(
      path.join(repoRoot, "packages/cli/src/application.ts"),
      "utf8",
    );
    const controlSource = await readFile(
      path.join(repoRoot, "packages/cli/src/main.ts"),
      "utf8",
    );

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(cliSource).toContain('require("../package.json")');
    expect(cliSource.match(/packageManifest\.version/gu)).toHaveLength(1);
    expect(
      `${cliSource}\n${applicationSource}\n${controlSource}`,
    ).not.toContain(manifest.version);
  });

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

  it("keeps focused generated links as a durable CI gate", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/check.yml"),
      "utf8",
    );

    expect(workflow).toContain("run: pnpm run check:focused");
    expect(workflow).toContain("run: pnpm install --frozen-lockfile");
  });
});
