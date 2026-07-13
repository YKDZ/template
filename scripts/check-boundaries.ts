import { execa } from "execa";

await execa("pnpm", ["exec", "turbo", "boundaries", "--no-color"], {
  stdio: "inherit",
});
