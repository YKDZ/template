import type { JsonValue } from "@ykdz/template-core/json";
import type { ResourceFileSnapshot } from "@ykdz/template-core/reference-package";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";
import type {
  DefaultCompositionFile,
  DefaultRootDeclarationData,
  ReferencePackageManifest,
} from "@ykdz/template-workspace/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

type PublicationOwnerFacts = {
  readonly gitignoreFragment: string;
  readonly files: readonly DefaultCompositionFile[];
};

function resource(
  resources: readonly ResourceFileSnapshot[],
  resourcePath: string,
): ResourceFileSnapshot {
  const snapshot = resources.find(({ path }) => path === resourcePath);
  if (snapshot === undefined) {
    throw new Error(`npm publication缺少所属资源：${resourcePath}`);
  }
  return snapshot;
}

function rootDeclaration(
  ownerFacts: PublicationOwnerFacts,
): DefaultRootDeclarationData {
  const manifest = referenceManifest as ReferencePackageManifest;
  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts ?? {}).filter(([name]) =>
      name.startsWith("publication:"),
    ),
  );
  return {
    requiredTemplateDependency: manifest.name,
    manifest: {
      devDependencies: {
        "@changesets/cli": manifest.devDependencies!["@changesets/cli"]!,
      },
      scripts,
    },
    turboTasks: Object.fromEntries(
      Object.keys(scripts).map((name) => [
        `//#${name}`,
        { tags: ["work:release"], cache: false },
      ]),
    ),
    gitignoreFragments: [ownerFacts.gitignoreFragment],
    files: ownerFacts.files,
  };
}

export const referencePackage = defineReferencePackage<
  JsonValue,
  PublicationOwnerFacts
>({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "npm-publication",
  instance: "shared",
  defaultLeafName: "npm-publication",
  defaultPath: "tools/npm-publication",
  role: "shared-library",
  resources: [
    { path: "README.md" },
    { path: ".changeset/config.json" },
    { path: "resources/gitignore" },
    { path: "resources/release.yml" },
  ],
  templateDependencies: [
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    { name: "@ykdz/template-core", purpose: "template-build" },
    { name: "@ykdz/template-workspace", purpose: "template-execution" },
  ],
  executionDependencies: ["@ykdz/template-workspace"],
  templateScripts: [
    "build:template",
    "publication:pack",
    "publication:publish",
  ],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions"],
      interval: "weekly",
    },
  },
  environmentNeeds: [],
  prepareFacts(resources) {
    const config = resource(resources, ".changeset/config.json");
    const release = resource(resources, "resources/release.yml");
    const gitignore = resource(resources, "resources/gitignore");
    return {
      gitignoreFragment: new TextDecoder("utf-8", { fatal: true }).decode(
        gitignore.content,
      ),
      files: [
        {
          path: ".changeset/config.json",
          content: config.content.slice(),
          mode: config.mode,
          sourcePath: config.path,
        },
        {
          path: ".github/workflows/release.yml",
          content: release.content.slice(),
          mode: release.mode,
          sourcePath: release.path,
        },
      ],
    };
  },
  rootDeclaration,
});
