import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const consumerRoot = process.env.NPM_PUBLICATION_CONSUMER_ROOT;
const packageName = process.env.NPM_PUBLICATION_PACKAGE_NAME;
if (consumerRoot === undefined || packageName === undefined)
  throw new Error("缺少原制品消费验收提供的安装目录或包名。");
const require = createRequire(path.join(consumerRoot, "package.json"));
const installed = (await import(
  pathToFileURL(require.resolve(packageName)).href
)) as { greet(name: string): { message: string } };
assert.deepEqual(installed.greet("publication"), {
  message: "Hello, publication",
});
assert.throws(() => installed.greet(""));
