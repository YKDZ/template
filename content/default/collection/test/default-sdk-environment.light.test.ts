import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";

import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-workspace-root/template",
    "@ykdz/reference-vike-web/template",
    "@ykdz/reference-vike-db/template",
    "@ykdz/reference-vike-migrations/template",
    "@ykdz/reference-tooling-config/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-npm-publication/template",
    "@ykdz/preset-vike-app/template",
  ],
});

const member = (kind: "preset" | "reference", packageName: string) => {
  const found = content.find(
    (item) => item.kind === kind && item.identity.packageName === packageName,
  );
  assert.ok(found, `显式内容集合缺少 ${kind} ${packageName}`);
  return found;
};

const root = member("reference", "@ykdz/reference-workspace-root");
const preset = member("preset", "@ykdz/preset-vike-app");
const conventions = {
  repositoryName: "environment-demo",
  defaultPackageScope: "demo",
};
const temporaryRoots = new Set<string>();

async function createTargetRoot(): Promise<string> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-default-sdk-environment-"),
  );
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, "demo");
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

await it("把组合声明的浏览器和ShellCheck需求投影进同一容器", async () => {
  const targetRoot = await createTargetRoot();
  const initialized = await createDefaultGenerator({ content }).init({
    targetRoot,
    selection: { presets: [{ contentIdentity: preset.identity }] },
    conventions,
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;

  const checkNeeds = initialized.ownerFacts.environmentNeeds.check;
  assert.ok(
    checkNeeds.some((need) => need.kind === "playwright-browser-assets"),
  );
  assert.ok(checkNeeds.some((need) => need.kind === "shellcheck-command"));

  const container = initialized.ownerFacts.container;
  const playwrightVersion =
    initialized.ownerFacts.dependencyCatalog["@playwright/test"];
  assert.ok(playwrightVersion);
  assert.match(container.dockerfileText, /PLAYWRIGHT_CLI_PACKAGE/u);
  assert.match(
    container.dockerfileText,
    /playwright install --with-deps chromium/u,
  );
  assert.match(
    container.dockerfileText,
    /apt-get install -y --no-install-recommends shellcheck/u,
  );
  assert.ok(
    container.buildArguments.some(
      ({ name, value }) =>
        name === "PLAYWRIGHT_CLI_PACKAGE" &&
        value === `@playwright/test@${playwrightVersion}`,
    ),
  );
  assert.deepEqual(
    container.probes.find(({ identity }) => identity === "playwright"),
    {
      identity: "playwright",
      command: "npx",
      args: [
        "--yes",
        "--package",
        `@playwright/test@${playwrightVersion}`,
        "playwright",
        "--version",
      ],
    },
  );
  assert.deepEqual(
    container.probes.find(({ identity }) => identity === "shellcheck"),
    {
      identity: "shellcheck",
      command: "shellcheck",
      args: ["--version"],
    },
  );
});

await it("未声明浏览器或ShellCheck时不添加对应容器层", async () => {
  const targetRoot = await createTargetRoot();
  const initialized = await createDefaultGenerator({ content }).init({
    targetRoot,
    selection: {
      roots: [{ nodeIdentity: "root", contentIdentity: root.identity }],
    },
    conventions,
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;

  assert.equal(
    initialized.ownerFacts.container.probes.some(
      ({ identity }) => identity === "playwright" || identity === "shellcheck",
    ),
    false,
  );
  assert.doesNotMatch(
    initialized.ownerFacts.container.dockerfileText,
    /PLAYWRIGHT_CLI_PACKAGE|shellcheck/u,
  );
});
