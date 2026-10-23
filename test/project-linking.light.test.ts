import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { templateContent } from "@ykdz/template-content";
import type { LoadedContentMember } from "@ykdz/template-core/content-identity";
import type { PackageDefinitionId } from "@ykdz/template-core/project-blueprint";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

type PackageLinkIssue =
  | { readonly kind: "unknown-consumer"; readonly path: string }
  | {
      readonly kind: "unsupported-link";
      readonly consumerPath: string;
      readonly providerPath: string;
    };

type FixtureOptions = {
  readonly providerRole?: "shared-library";
  readonly consumerRole?: "runtime-service" | "native-package";
  readonly providerExports?: Readonly<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInjectedDependency(value: unknown, packageName: string): boolean {
  if (!isRecord(value)) return false;
  const metadata = value[packageName];
  return isRecord(metadata) && metadata.injected === true;
}

function packageLinkIssue(result: unknown): PackageLinkIssue | undefined {
  if (!isRecord(result) || !isRecord(result.error)) return undefined;
  const issue = result.error.packageLinkIssue;
  if (!isRecord(issue)) return undefined;
  if (issue.kind === "unknown-consumer" && typeof issue.path === "string") {
    return { kind: issue.kind, path: issue.path };
  }
  if (
    issue.kind === "unsupported-link" &&
    typeof issue.consumerPath === "string" &&
    typeof issue.providerPath === "string"
  ) {
    return {
      kind: issue.kind,
      consumerPath: issue.consumerPath,
      providerPath: issue.providerPath,
    };
  }
  return undefined;
}

function summary(result: unknown): string {
  if (isRecord(result) && isRecord(result.error)) {
    const message = result.error.message;
    if (typeof message === "string") return message;
  }
  if (isRecord(result) && typeof result.reason === "string") {
    return result.reason;
  }
  return isRecord(result) && typeof result.status === "string"
    ? result.status
    : "结果类型无效";
}

function canonicalProviderExports() {
  return {
    ".": {
      source: "./src/index.ts",
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
    "./feature": {
      source: "./src/feature.ts",
      types: "./dist/feature.d.ts",
      default: "./dist/feature.js",
    },
  };
}

async function fixture(context: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "project-linking-sdk-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const providerRoot = path.join(root, "content/provider");
  const consumerRoot = path.join(root, "content/consumer");
  for (const packageRoot of [providerRoot, consumerRoot]) {
    await mkdir(path.join(packageRoot, "src"), { recursive: true });
  }

  const providerManifest = {
    name: "@fixture/provider",
    private: true,
    type: "module",
    exports: options.providerExports ?? canonicalProviderExports(),
  };
  const consumerManifest = {
    name: "@fixture/consumer",
    private: true,
    type: options.consumerRole === "native-package" ? "commonjs" : "module",
    dependencies: { "@fixture/provider": "workspace:*" },
  };
  await writeFile(
    path.join(providerRoot, "package.json"),
    `${JSON.stringify(providerManifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(providerRoot, "src/index.ts"),
    "export const provider = true;\n",
  );
  await writeFile(
    path.join(providerRoot, "src/feature.ts"),
    "export const feature = true;\n",
  );
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(consumerRoot, "src/index.ts"),
    'import { provider } from "@fixture/provider";\nvoid provider;\n',
  );

  const providerResourceRoot = pathToFileURL(`${providerRoot}${path.sep}`);
  const consumerResourceRoot = pathToFileURL(`${consumerRoot}${path.sep}`);
  const providerIdentity = {
    namespace: "checks-fixture",
    packageName: "@fixture/provider",
    exportPath: "./template",
  } as const;
  const consumerIdentity = {
    namespace: "checks-fixture",
    packageName: "@fixture/consumer",
    exportPath: "./template",
  } as const;
  const providerDefinition = defineReferencePackage({
    manifest: providerManifest,
    resourceRoot: providerResourceRoot,
    alias: "provider",
    instance: "independent",
    defaultLeafName: "provider",
    role: options.providerRole ?? "shared-library",
    resources: [{ path: "src/index.ts" }, { path: "src/feature.ts" }],
  });
  const consumerDefinition = defineReferencePackage({
    manifest: consumerManifest,
    resourceRoot: consumerResourceRoot,
    alias: "consumer",
    instance: "independent",
    defaultLeafName: "consumer",
    role: options.consumerRole ?? "runtime-service",
    dependencies: [
      {
        key: "provider",
        contentIdentity: providerIdentity,
      },
    ],
    templateDependencies: [{ name: "@fixture/provider", purpose: "target" }],
    resources: [{ path: "src/index.ts" }],
  });
  const members: readonly LoadedContentMember[] = [
    {
      identity: providerIdentity,
      kind: "reference",
      alias: "provider",
      definition: providerDefinition,
      source: {
        specifier: import.meta.url,
        moduleURL: import.meta.url,
        manifestURL: pathToFileURL(path.join(providerRoot, "package.json"))
          .href,
      },
    },
    {
      identity: consumerIdentity,
      kind: "reference",
      alias: "consumer",
      definition: consumerDefinition,
      source: {
        specifier: import.meta.url,
        moduleURL: import.meta.url,
        manifestURL: pathToFileURL(path.join(consumerRoot, "package.json"))
          .href,
      },
    },
  ];
  return {
    root,
    content: [...templateContent, ...members],
    providerIdentity,
    consumerIdentity,
    providerPackageName: "@checks/provider",
    consumerRole: options.consumerRole ?? "runtime-service",
  };
}

async function initialize(
  generator: ReturnType<typeof createDefaultGenerator>,
  targetRoot: string,
  presetAlias = "ts-lib",
) {
  const preset = templateContent.find(
    (member) => member.kind === "preset" && member.alias === presetAlias,
  );
  assert.ok(preset);
  const result = await generator.init({
    targetRoot,
    selection: { presets: [{ contentIdentity: preset.identity }] },
    conventions: {
      repositoryName: "project-linking",
      defaultPackageScope: "checks",
    },
  });
  assert.equal(result.status, "success", JSON.stringify(result));
}

async function snapshotTree(root: string): Promise<unknown> {
  const entries: unknown[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      const itemPath = path.posix.join(relative, entry.name);
      const mode = (await stat(fullPath)).mode & 0o777;
      if (entry.isDirectory()) {
        entries.push([itemPath, "directory", mode]);
        await visit(fullPath, itemPath);
      } else {
        entries.push([
          itemPath,
          "file",
          mode,
          (await readFile(fullPath)).toString("base64"),
        ]);
      }
    }
  }
  await visit(root);
  return entries;
}

async function addProvider(
  generator: ReturnType<typeof createDefaultGenerator>,
  targetRoot: string,
  providerIdentity: FixtureResult["providerIdentity"],
) {
  const planned = await generator.planAdd({
    repositoryRoot: targetRoot,
    contentIdentity: providerIdentity,
    creationInput: { packagePath: "packages/provider" },
  });
  assert.equal(planned.status, "planned", summary(planned));
  if (planned.status !== "planned") throw new Error(summary(planned));
  const provider = planned.blueprint.packages.find(
    ({ path: packagePath }) => packagePath === "packages/provider",
  );
  assert.ok(provider);
  const committed = await generator.commitPlan(planned.plan);
  assert.equal(committed.status, "success", summary(committed));
  return provider.packageDefinitionId;
}

type FixtureResult = Awaited<ReturnType<typeof fixture>>;

async function addConsumer(
  generator: ReturnType<typeof createDefaultGenerator>,
  targetRoot: string,
  providerId: PackageDefinitionId,
  consumerIdentity: FixtureResult["consumerIdentity"],
  consumerPath: string,
) {
  return generator.planAdd({
    repositoryRoot: targetRoot,
    contentIdentity: consumerIdentity,
    creationInput: {
      leafName: path.posix.basename(consumerPath),
      packagePath: consumerPath,
    },
    dependencyBindings: { provider: { packageDefinitionId: providerId } },
  });
}

async function writeProviderManifest(
  targetRoot: string,
  providerExports: Readonly<Record<string, unknown>>,
) {
  const manifestPath = path.join(targetRoot, "packages/provider/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, exports: providerExports }, null, 2)}\n`,
  );
}

async function committedConsumerManifest(
  generator: ReturnType<typeof createDefaultGenerator>,
  planned: Awaited<ReturnType<typeof addConsumer>>,
  targetRoot: string,
  consumerPath: string,
) {
  assert.equal(planned.status, "planned", summary(planned));
  if (planned.status !== "planned") throw new Error(summary(planned));
  const committed = await generator.commitPlan(planned.plan);
  assert.equal(committed.status, "success", summary(committed));
  return JSON.parse(
    await readFile(path.join(targetRoot, consumerPath, "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

await test("按当前provider导出真值决定是否注入并保留显式包连接", async (context) => {
  const setup = await fixture(context);
  const generator = createDefaultGenerator({ content: setup.content });
  const targetRoot = path.join(setup.root, "project");
  await initialize(generator, targetRoot);
  const providerId = await addProvider(
    generator,
    targetRoot,
    setup.providerIdentity,
  );

  const cases = [
    {
      path: "packages/default-only",
      exports: {
        ...canonicalProviderExports(),
        ".": { default: "./dist/index.js" },
      },
      injected: true,
    },
    {
      path: "packages/out-of-order",
      exports: {
        ...canonicalProviderExports(),
        ".": {
          default: "./dist/index.js",
          source: "./src/index.ts",
          types: "./dist/index.d.ts",
        },
      },
      injected: true,
    },
    {
      path: "packages/unusable-source-conditions",
      exports: {
        ...canonicalProviderExports(),
        ".": {
          source: "./src/index.ts",
          types: "./dist/index.js",
          default: "./dist/index.js",
        },
      },
      injected: true,
    },
    {
      path: "packages/source-conditions",
      exports: canonicalProviderExports(),
      injected: false,
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    await writeProviderManifest(targetRoot, scenario.exports);
    const planned = await addConsumer(
      generator,
      targetRoot,
      providerId,
      setup.consumerIdentity,
      scenario.path,
    );
    const manifest = await committedConsumerManifest(
      generator,
      planned,
      targetRoot,
      scenario.path,
    );
    const dependenciesMeta = manifest.dependenciesMeta;
    if (scenario.injected) {
      assert.equal(
        isInjectedDependency(dependenciesMeta, setup.providerPackageName),
        true,
        `case ${index}: provider must be injected`,
      );
    } else {
      assert.equal(
        isInjectedDependency(dependenciesMeta, setup.providerPackageName),
        false,
        `case ${index}: source conditions must use the ordinary workspace link`,
      );
    }
  }
});

await test("同一正式加包计划按新provider的输出manifest校验链接", async (context) => {
  const setup = await fixture(context, { providerExports: {} });
  const generator = createDefaultGenerator({ content: setup.content });
  const targetRoot = path.join(setup.root, "project");
  await initialize(generator, targetRoot, "ts-cli");
  const before = await snapshotTree(targetRoot);

  const result = await generator.planAdd({
    repositoryRoot: targetRoot,
    contentIdentity: setup.providerIdentity,
    creationInput: {
      packagePath: "packages/provider",
      linkFrom: ["packages/cli"],
    },
  });

  assert.equal(result.status, "operation-failure", summary(result));
  assert.deepEqual(packageLinkIssue(result), {
    kind: "unsupported-link",
    consumerPath: "packages/cli",
    providerPath: "packages/provider",
  });
  assert.deepEqual(await snapshotTree(targetRoot), before);
});

await test("拒绝native consumer并在规划失败时保持项目未改写", async (context) => {
  const setup = await fixture(context, { consumerRole: "native-package" });
  const generator = createDefaultGenerator({ content: setup.content });
  const targetRoot = path.join(setup.root, "project");
  await initialize(generator, targetRoot);
  const providerId = await addProvider(
    generator,
    targetRoot,
    setup.providerIdentity,
  );
  const manifestBefore = await readFile(path.join(targetRoot, "package.json"));
  const blueprintBefore = await readFile(
    path.join(targetRoot, ".template/blueprint.json"),
  );

  const result = await addConsumer(
    generator,
    targetRoot,
    providerId,
    setup.consumerIdentity,
    "packages/native-consumer",
  );
  assert.equal(result.status, "operation-failure", JSON.stringify(result));
  assert.deepEqual(packageLinkIssue(result), {
    kind: "unsupported-link",
    consumerPath: "packages/native-consumer",
    providerPath: "packages/provider",
  });
  assert.deepEqual(
    await readFile(path.join(targetRoot, "package.json")),
    manifestBefore,
  );
  assert.deepEqual(
    await readFile(path.join(targetRoot, ".template/blueprint.json")),
    blueprintBefore,
  );
  await assert.rejects(
    readFile(path.join(targetRoot, "packages/native-consumer/package.json")),
    { code: "ENOENT" },
  );
});

await test("拒绝没有可导入根导出的provider并保留端点诊断", async (context) => {
  const setup = await fixture(context);
  const generator = createDefaultGenerator({ content: setup.content });
  const targetRoot = path.join(setup.root, "project");
  await initialize(generator, targetRoot);
  const providerId = await addProvider(
    generator,
    targetRoot,
    setup.providerIdentity,
  );
  await writeProviderManifest(targetRoot, {
    "./feature": {
      source: "./src/feature.ts",
      types: "./dist/feature.d.ts",
      default: "./dist/feature.js",
    },
  });

  const result = await addConsumer(
    generator,
    targetRoot,
    providerId,
    setup.consumerIdentity,
    "packages/consumer",
  );
  assert.equal(result.status, "operation-failure", JSON.stringify(result));
  assert.deepEqual(packageLinkIssue(result), {
    kind: "unsupported-link",
    consumerPath: "packages/consumer",
    providerPath: "packages/provider",
  });
  await assert.rejects(
    readFile(path.join(targetRoot, "packages/consumer/package.json")),
    { code: "ENOENT" },
  );
});
