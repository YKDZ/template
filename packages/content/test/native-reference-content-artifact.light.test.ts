import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { pathToFileURL } from "node:url";

import type { Composition } from "@ykdz/template-core/composition";
import type { LoadedContentMember } from "@ykdz/template-core/content-identity";
import type { PackageDefinitionId } from "@ykdz/template-core/project-blueprint";
import type { ReferencePackageDefinition } from "@ykdz/template-core/reference-package";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import { createGenerator } from "@ykdz/template-generator";
import { defineNativeReferenceContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

const roots: string[] = [];

type ScopeConventions = { readonly policy: "resource-scope" };
type ScopeCreationInput = { readonly packagePath: string };
type ScopePreparedFacts = { readonly resourceCount: number };
type ScopeStableCommon = { readonly policy: "resource-scope" };
type ScopePackageInput = { readonly operation: "initialization" };
type ScopeContributionFacts = { readonly resourceCount: number };
type ScopeOwnerFacts = {
  readonly resourceCounts: Readonly<Record<string, number>>;
};
type ScopeOperationFacts = { readonly operation: "initialization" };
type ScopeReferenceDefinition = ReferencePackageDefinition<
  ScopeConventions,
  ScopeCreationInput,
  ScopePreparedFacts,
  ScopeStableCommon,
  ScopePackageInput,
  ScopeContributionFacts
>;

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

void it("同一资源声明为参考包准备快照并保留完整制品", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-reference-artifact-"));
  roots.push(root);
  await mkdir(path.join(root, "template-dist"), { recursive: true });
  await mkdir(path.join(root, "resources"), { recursive: true });
  await mkdir(path.join(root, "packages/child"), { recursive: true });
  await writeFile(path.join(root, "template-dist/index.js"), "export {};\n");
  await writeFile(
    path.join(root, "template-dist/index.d.ts"),
    'export declare const templateVersion: "v1";\n',
  );
  await writeFile(path.join(root, "resources/guide.md"), "指南字节\n");
  await writeFile(path.join(root, "resources/README.md"), "根包资源\n");
  await writeFile(path.join(root, "packages/child/README.md"), "子包字节\n");

  const manifest = {
    name: "@fixture/native-reference",
    version: "1.0.0",
    exports: {
      "./template": {
        types: "./template-dist/index.d.ts",
        default: "./template-dist/index.js",
      },
    },
  };
  const referencePackage = defineNativeReferenceContentArtifact(
    {
      alias: "native-reference",
      instance: "independent",
      externalExtension: { version: "v1" as const },
    },
    {
      manifest,
      resourceRoot: pathToFileURL(`${root}${path.sep}`),
      exportPath: "./template",
      resources: [
        {
          path: "resources/README.md",
          targetPath: "README.md",
          source: createTemplateSourceHandle(
            path.join(root, "resources/README.md"),
          ),
          mode: 0o644,
        },
        {
          path: "resources/guide.md",
          targetPath: "docs/guide.md",
          source: createTemplateSourceHandle(
            path.join(root, "resources/guide.md"),
          ),
          mode: 0o644,
        },
        {
          path: "packages/child/README.md",
          targetPath: "packages/child/README.md",
          source: createTemplateSourceHandle(
            path.join(root, "packages/child/README.md"),
          ),
          mode: 0o644,
        },
      ],
      prepareFacts(resources) {
        return { resourceCount: resources.length };
      },
    },
  );

  const extensionVersion: "v1" = referencePackage.externalExtension.version;
  const prepared = referencePackage.prepare({
    excludedPackagePaths: ["resources", "packages/child"],
  });
  const artifact = referencePackage.prepareArtifact();
  assert.equal(extensionVersion, "v1");
  assert.deepEqual(
    prepared.resources.map(({ path: resourcePath, mode }) => [
      resourcePath,
      mode,
    ]),
    [
      ["resources/README.md", 0],
      ["resources/guide.md", 0],
    ],
  );
  assert.deepEqual(prepared.facts, { resourceCount: 2 });
  assert.deepEqual(
    artifact.resources.map(({ path: resourcePath, data, mode }) => [
      resourcePath,
      data.toString(),
      mode,
    ]),
    [
      ["resources/README.md", "根包资源\n", 0o644],
      ["resources/guide.md", "指南字节\n", 0o644],
      ["packages/child/README.md", "子包字节\n", 0o644],
    ],
  );
  assert.ok(
    artifact.compiled.some(({ path: filePath }) => filePath.endsWith(".d.ts")),
  );
});

void it("按当前包目标作用域映射排除资源而保留根资源及完整制品", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-resource-scope-"));
  roots.push(root);
  const parentRoot = path.join(root, "parent-owner");
  const childRoot = path.join(root, "child-owner");
  const parentReadme = path.join(parentRoot, "resources/README.md");
  const parentChildReadme = path.join(parentRoot, "resources/child/README.md");
  const childReadme = path.join(childRoot, "resources/README.md");
  for (const ownerRoot of [parentRoot, childRoot]) {
    await mkdir(path.join(ownerRoot, "template-dist"), { recursive: true });
    await writeFile(
      path.join(ownerRoot, "template-dist/index.js"),
      "export {}\n",
    );
    await writeFile(
      path.join(ownerRoot, "template-dist/index.d.ts"),
      "export {};\n",
    );
  }
  await mkdir(path.dirname(parentReadme), { recursive: true });
  await mkdir(path.dirname(parentChildReadme), { recursive: true });
  await mkdir(path.dirname(childReadme), { recursive: true });
  await writeFile(parentReadme, "父包自己的根README\n");
  await writeFile(parentChildReadme, "属于子作用域的资源\n");
  await writeFile(childReadme, "子包自己的README\n");

  const conventions: ScopeConventions = { policy: "resource-scope" };
  const manifestFor = (name: string) => ({
    name,
    version: "1.0.0",
    exports: {
      "./template": {
        types: "./template-dist/index.d.ts",
        default: "./template-dist/index.js",
      },
    },
  });
  const parseCreationInput = (value: unknown): ScopeCreationInput => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("packagePath" in value) ||
      typeof value.packagePath !== "string"
    ) {
      throw new Error("scope fixture需要packagePath");
    }
    return { packagePath: value.packagePath };
  };
  const definitionFor = (
    alias: string,
  ): Omit<ScopeReferenceDefinition, "prepare"> => ({
    alias,
    instance: "independent",
    parseCreationInput,
    createDefinition({ creationInput }) {
      const packagePath = creationInput?.packagePath ?? ".";
      return {
        name: `${alias}:${packagePath}`,
        path: packagePath,
        role: "library",
      };
    },
    evaluate({ packageDefinitionId, prepared }) {
      const resource = prepared.resources.find(
        ({ path: resourcePath }) => resourcePath === "resources/README.md",
      );
      if (resource === undefined) {
        throw new Error(`${alias} root README resource missing`);
      }
      return {
        packageDefinitionId,
        files: [{ path: "README.md", content: resource.content, mode: 0 }],
        reconciliation: [{ path: "README.md", driver: "text" }],
        facts: { resourceCount: prepared.resources.length },
      };
    },
  });
  const parentManifest = manifestFor("@fixture/resource-scope-parent");
  const childManifest = manifestFor("@fixture/resource-scope-child");
  const parentDefinition = defineNativeReferenceContentArtifact(
    definitionFor("resource-scope-parent"),
    {
      manifest: parentManifest,
      resourceRoot: pathToFileURL(`${parentRoot}${path.sep}`),
      exportPath: "./template",
      resources: [
        {
          path: "resources/README.md",
          targetPath: "README.md",
          source: createTemplateSourceHandle(parentReadme),
          mode: 0o644,
        },
        {
          path: "resources/child/README.md",
          targetPath: "resources/README.md",
          source: createTemplateSourceHandle(parentChildReadme),
          mode: 0o644,
        },
      ],
      prepareFacts(resources) {
        return { resourceCount: resources.length };
      },
    },
  );
  const childDefinition = defineNativeReferenceContentArtifact(
    definitionFor("resource-scope-child"),
    {
      manifest: childManifest,
      resourceRoot: pathToFileURL(`${childRoot}${path.sep}`),
      exportPath: "./template",
      resources: [
        {
          path: "resources/README.md",
          targetPath: "README.md",
          source: createTemplateSourceHandle(childReadme),
          mode: 0o644,
        },
      ],
      prepareFacts(resources) {
        return { resourceCount: resources.length };
      },
    },
  );
  const parentName = parentManifest.name;
  const childName = childManifest.name;
  const parentMember = {
    identity: {
      namespace: "resource-scope",
      packageName: parentName,
      exportPath: "./template",
    },
    kind: "reference",
    alias: parentDefinition.alias,
    definition: parentDefinition,
    source: {
      specifier: `${parentName}/template`,
      moduleURL: pathToFileURL(path.join(parentRoot, "template-dist/index.js"))
        .href,
      manifestURL: pathToFileURL(path.join(parentRoot, "package.json")).href,
    },
  } satisfies LoadedContentMember<typeof parentDefinition, "reference">;
  const childMember = {
    identity: {
      namespace: "resource-scope",
      packageName: childName,
      exportPath: "./template",
    },
    kind: "reference",
    alias: childDefinition.alias,
    definition: childDefinition,
    source: {
      specifier: `${childName}/template`,
      moduleURL: pathToFileURL(path.join(childRoot, "template-dist/index.js"))
        .href,
      manifestURL: pathToFileURL(path.join(childRoot, "package.json")).href,
    },
  } satisfies LoadedContentMember<typeof childDefinition, "reference">;
  const composition: Composition<
    ScopeConventions,
    ScopeStableCommon,
    ScopePackageInput,
    ScopeContributionFacts,
    ScopeOwnerFacts,
    ScopeCreationInput,
    ScopeOperationFacts
  > = {
    identity: {
      namespace: "resource-scope",
      packageName: "@fixture/resource-scope-composition",
      exportPath: "./composition",
    },
    parseConventions(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("policy" in value) ||
        value.policy !== "resource-scope"
      ) {
        throw new Error("scope conventions无效");
      }
      return conventions;
    },
    resolve({ packages }) {
      const packageInputs = new Map<PackageDefinitionId, ScopePackageInput>();
      for (const item of packages) {
        packageInputs.set(item.packageDefinitionId, {
          operation: "initialization",
        });
      }
      return { stableCommon: conventions, packageInputs };
    },
    combine({ packages }) {
      const resourceCounts: Record<string, number> = {};
      for (const item of packages) {
        resourceCounts[item.package.definition.path] =
          item.contribution.facts.resourceCount;
      }
      return { facts: { resourceCounts } };
    },
  };
  const parentOnlyGenerator = createGenerator({
    content: [parentMember],
    composition,
  });
  const parentOnly = await parentOnlyGenerator.planInit({
    targetRoot: path.join(root, "parent-only"),
    selection: {
      roots: [
        {
          nodeIdentity: "parent",
          contentIdentity: parentMember.identity,
          creationInput: { packagePath: "." },
        },
      ],
    },
    conventions,
    operationFacts: { operation: "initialization" },
  });
  assert.equal(parentOnly.status, "planned", JSON.stringify(parentOnly));
  if (parentOnly.status !== "planned") return;
  assert.deepEqual(parentOnly.ownerFacts.resourceCounts, { ".": 2 });

  const completeParentArtifact = parentDefinition.prepareArtifact();
  assert.deepEqual(
    completeParentArtifact.resources.map(({ path: resourcePath, data }) => [
      resourcePath,
      data.toString(),
    ]),
    [
      ["resources/README.md", "父包自己的根README\n"],
      ["resources/child/README.md", "属于子作用域的资源\n"],
    ],
  );
  await rm(parentChildReadme);

  const generator = createGenerator({
    content: [parentMember, childMember],
    composition,
  });
  const planAndCommit = async (
    targetRoot: string,
    parentPath: string,
    childPath: string,
  ) => {
    const planning = await generator.planInit({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "parent",
            contentIdentity: parentMember.identity,
            creationInput: { packagePath: parentPath },
          },
          {
            nodeIdentity: "child",
            contentIdentity: childMember.identity,
            creationInput: { packagePath: childPath },
          },
        ],
      },
      conventions,
      operationFacts: { operation: "initialization" },
    });
    assert.equal(planning.status, "planned", JSON.stringify(planning));
    if (planning.status !== "planned") return;
    assert.deepEqual(planning.ownerFacts.resourceCounts, {
      [parentPath]: 1,
      [childPath]: 1,
    });
    const committed = await generator.commitPlan(planning.plan);
    assert.equal(committed.status, "success", JSON.stringify(committed));
  };

  const rootTarget = path.join(root, "root-project");
  await planAndCommit(rootTarget, ".", "resources");
  assert.equal(
    await readFile(path.join(rootTarget, "README.md"), "utf8"),
    "父包自己的根README\n",
  );
  assert.equal(
    await readFile(path.join(rootTarget, "resources/README.md"), "utf8"),
    "子包自己的README\n",
  );

  const manualTarget = path.join(root, "manual-project");
  await planAndCommit(manualTarget, "docs/manual", "docs/manual/resources");
  assert.equal(
    await readFile(path.join(manualTarget, "docs/manual/README.md"), "utf8"),
    "父包自己的根README\n",
  );
  assert.equal(
    await readFile(
      path.join(manualTarget, "docs/manual/resources/README.md"),
      "utf8",
    ),
    "子包自己的README\n",
  );
  assert.deepEqual(
    completeParentArtifact.resources.map(
      ({ path: resourcePath }) => resourcePath,
    ),
    ["resources/README.md", "resources/child/README.md"],
  );
});
