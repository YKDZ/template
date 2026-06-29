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
});
