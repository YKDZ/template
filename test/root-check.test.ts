import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

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

  it("runs direct shared OXC template source checks from Root Check", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    const sharedOxcPackageJson = JSON.parse(
      await readFile(
        path.join(repoRoot, "templates/shared/oxc/package.json"),
        "utf8"
      )
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts).toHaveProperty(
      "check:templates:shared-oxc"
    );
    expect(rootPackageJson.scripts.check).toContain(
      "pnpm run check:templates:shared-oxc"
    );
    expect(rootPackageJson.scripts["check:templates:shared-oxc"]).toBe(
      "pnpm --dir templates/shared/oxc run check"
    );
    expect(sharedOxcPackageJson.scripts.check).toContain(
      "pnpm run format:check"
    );
    expect(sharedOxcPackageJson.scripts.check).toContain("pnpm run lint");
    expect(sharedOxcPackageJson.scripts.check).toContain("pnpm run typecheck");

    await execa("pnpm", ["run", "check:templates:shared-oxc"], {
      cwd: repoRoot
    });
  });
});
