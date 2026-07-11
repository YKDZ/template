import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const mode = process.argv[2];

if (mode !== "dev" && mode !== "test") {
  throw new Error("Usage: node scripts/prepare-database.ts <dev|test>");
}

const packageDirectory = process.cwd();
const databaseFile = process.env.DATABASE_FILE
  ? path.resolve(
      process.env.INIT_CWD ?? packageDirectory,
      process.env.DATABASE_FILE,
    )
  : path.resolve(packageDirectory, "../../apps/web/data/app.sqlite");
const environment = { ...process.env, DATABASE_FILE: databaseFile };

mkdirSync(path.dirname(databaseFile), { recursive: true });
if (mode === "test") {
  rmSync(databaseFile, { force: true });
}

execFileSync("pnpm", ["run", "db:push"], {
  cwd: packageDirectory,
  env: environment,
  stdio: "inherit",
});
execFileSync("pnpm", ["--dir", "../db", "run", "db:seed:example"], {
  cwd: packageDirectory,
  env: environment,
  stdio: "inherit",
});
