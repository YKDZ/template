import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const migrationsRoot = path.resolve(packageRoot, "../db-migrations");
const databaseFile = path.join(packageRoot, "node_modules/.tmp/test.sqlite");

export function setup(): void {
  rmSync(databaseFile, { force: true });
  process.env.DATABASE_FILE = databaseFile;
  execFileSync("pnpm", ["run", "db:push"], {
    cwd: migrationsRoot,
    env: process.env,
    stdio: "inherit",
  });
}

export function teardown(): void {
  rmSync(databaseFile, { force: true });
}
