import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default function teardown(): void {
  rmSync(
    fileURLToPath(
      new URL("../node_modules/.tmp/playwright-port", import.meta.url),
    ),
    { force: true },
  );
}
