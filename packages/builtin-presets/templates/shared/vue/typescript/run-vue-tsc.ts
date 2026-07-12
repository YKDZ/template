import { createRequire } from "node:module";

import { run } from "vue-tsc";

const require = createRequire(import.meta.url);

const compatibilityPackage = require.resolve("typescript/package.json");
const requireCompatibilityDependency = createRequire(compatibilityPackage);

// The official compatibility package owns the real TypeScript 6 compiler as
// @typescript/old; resolve from that package so isolated linking is respected.
run(requireCompatibilityDependency.resolve("@typescript/old/lib/tsc.js"));
