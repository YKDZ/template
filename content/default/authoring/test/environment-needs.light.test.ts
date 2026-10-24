import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeEnvironmentNeeds,
  parseEnvironmentNeedsMetadata,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@ykdz/default-content-authoring/environment-needs";

const workspaceOwner = {
  kind: "workspace-orchestration" as const,
  path: "." as const,
};

void describe("环境需求生命周期", () => {
  void it("使用持久化语义声明作为规范身份", () => {
    const browser = playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: workspaceOwner,
    });
    const shellcheck = shellCheckEnvironmentNeed(workspaceOwner);

    assert.deepStrictEqual(
      normalizeEnvironmentNeeds({
        check: [shellcheck, browser, shellcheck],
        deployment: [{ kind: "docker-engine" }, { kind: "docker-engine" }],
      }),
      {
        schemaVersion: 1,
        check: [browser, shellcheck],
        deployment: [{ kind: "docker-engine" }],
      },
    );
  });

  void it("严格解析并规范化带版本的本地模板元数据", () => {
    assert.deepStrictEqual(
      parseEnvironmentNeedsMetadata({
        schemaVersion: 1,
        check: [
          {
            kind: "shellcheck-command",
            owner: workspaceOwner,
          },
        ],
        deployment: [],
      }),
      {
        schemaVersion: 1,
        check: [{ kind: "shellcheck-command", owner: workspaceOwner }],
        deployment: [],
      },
    );

    assert.throws(
      () =>
        parseEnvironmentNeedsMetadata({
          schemaVersion: 1,
          check: [
            {
              kind: "shellcheck-command",
              owner: workspaceOwner,
              inferredFromTaskGraph: true,
            },
          ],
          deployment: [],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes("check[0] 含有未知字段：inferredFromTaskGraph"),
    );
  });

  void it("拒绝语义参数冲突，避免持久化第二个身份", () => {
    assert.throws(
      () =>
        normalizeEnvironmentNeeds({
          check: [
            playwrightBrowserAssetsEnvironmentNeed({
              browser: "chromium",
              owner: workspaceOwner,
            }),
            {
              kind: "playwright-browser-assets",
              browser: "webkit" as never,
              owner: workspaceOwner,
            },
          ],
          deployment: [],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes("check[1].browser 必须是 chromium"),
    );
  });

  void it("不把部署环境需求当成常规检查环境需求，反之亦然", () => {
    assert.throws(
      () =>
        parseEnvironmentNeedsMetadata({
          schemaVersion: 1,
          check: [{ kind: "docker-engine" }],
          deployment: [],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes("check[0] 含有不支持的 kind：docker-engine"),
    );

    assert.throws(
      () =>
        parseEnvironmentNeedsMetadata({
          schemaVersion: 1,
          check: [],
          deployment: [
            {
              kind: "shellcheck-command",
              owner: workspaceOwner,
            },
          ],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes("deployment[0] 含有未知字段：owner"),
    );
  });
});
