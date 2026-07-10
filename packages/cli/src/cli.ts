#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

if (import.meta.url.endsWith(".ts")) {
  process.env.TEMPLATE_REPOSITORY_ROOT ??= path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
}

await import("./main.ts");
