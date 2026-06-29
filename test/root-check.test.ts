import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Project Kit Root Check", () => {
  it("invokes built-in preset fixture checks", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts).toHaveProperty("check:fixtures");
    expect(packageJson.scripts.check).toContain("pnpm run check:fixtures");
  });

  it("keeps ordinary checks separate from npm publishing", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    const ordinaryCheckScripts = [
      packageJson.scripts.check,
      packageJson.scripts["check:fixtures"]
    ];

    for (const script of ordinaryCheckScripts) {
      expect(script).not.toMatch(/\bnpm\s+publish\b/);
      expect(script).not.toContain("NPM_TOKEN");
      expect(script).not.toContain("NODE_AUTH_TOKEN");
    }
  });
});
