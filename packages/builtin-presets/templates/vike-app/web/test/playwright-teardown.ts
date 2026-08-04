import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default function teardown(): void {
  rmSync(path.join(webRoot, "node_modules/.tmp/e2e.sqlite"), { force: true });
  rmSync(path.join(webRoot, "node_modules/.tmp/playwright-port"), {
    force: true,
  });
}
