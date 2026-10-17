import { createRequire } from "node:module";

import { run } from "vue-tsc";

const require = createRequire(import.meta.url);

const compatibilityPackage = require.resolve("typescript/package.json");
const requireCompatibilityDependency = createRequire(compatibilityPackage);

// 官方兼容包通过 @typescript/old 提供 TypeScript 6。
// 从其自身依赖范围解析编译器，遵守隔离链接。
run(requireCompatibilityDependency.resolve("@typescript/old/lib/tsc.js"));
