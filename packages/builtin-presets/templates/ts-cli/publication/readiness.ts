import { readdir, readFile, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";

import { parse as parseSemver, valid as validSemver } from "semver";
import parseSpdxExpression from "spdx-expression-parse";

import {
  inspectPackageReleaseChangelog,
  type ChangelogBlockerCode,
} from "./changelog.ts";
import { cliCommandIdentity } from "./cli-command-identity.ts";

export type NpmPublicationReadinessBlockerCode =
  | "package-name"
  | "cli-bin"
  | "description"
  | "version"
  | "private"
  | "manifest-contract"
  | "license-id"
  | "license-content"
  | "repository"
  | "homepage"
  | "bugs"
  | "readme-missing"
  | "readme-content"
  | "license-missing"
  | "license-mismatch"
  | "changelog-missing"
  | ChangelogBlockerCode
  | "local-template-metadata-missing"
  | "local-template-metadata-invalid"
  | "local-template-metadata-mismatch"
  | "private-runtime-dependency";

export type NpmPublicationReadinessBlocker = {
  readonly code: NpmPublicationReadinessBlockerCode;
  readonly owner: {
    readonly path: string;
    readonly pointer?: string;
  };
  readonly observed: string;
  readonly expected: string;
  readonly nextAction: string;
};

export type NpmPublicationReadiness =
  | {
      readonly kind: "blocked";
      readonly mode: "safe-unconfigured" | "public-intent";
      readonly target: { readonly packagePath: string };
      readonly blockers: readonly [
        NpmPublicationReadinessBlocker,
        ...NpmPublicationReadinessBlocker[],
      ];
    }
  | {
      readonly kind: "ready";
      readonly target: { readonly packagePath: string };
      readonly blockers: readonly [];
      readonly publication: {
        readonly packagePath: string;
        readonly packageName: string;
        readonly commandName: string;
        readonly version: string;
        readonly repository: string;
        readonly releaseDate: string;
        readonly releaseNotes: string;
      };
    };

type JsonObject = Record<string, unknown>;

type TextFact =
  | { readonly kind: "present"; readonly source: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string };

const publicationFiles = [
  "dist",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (value === undefined) return "missing";
  try {
    return JSON.stringify(value);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

function blocker(options: {
  readonly code: NpmPublicationReadinessBlockerCode;
  readonly path: string;
  readonly pointer?: string;
  readonly observed: string;
  readonly expected: string;
  readonly nextAction: string;
}): NpmPublicationReadinessBlocker {
  return {
    code: options.code,
    owner: {
      path: options.path,
      ...(options.pointer === undefined ? {} : { pointer: options.pointer }),
    },
    observed: options.observed,
    expected: options.expected,
    nextAction: options.nextAction,
  };
}

function compareBlockers(
  left: NpmPublicationReadinessBlocker,
  right: NpmPublicationReadinessBlocker,
): number {
  const leftKey = `${left.owner.path}\u0000${left.owner.pointer ?? ""}\u0000${left.code}`;
  const rightKey = `${right.owner.path}\u0000${right.owner.pointer ?? ""}\u0000${right.code}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

async function textFact(filePath: string): Promise<TextFact> {
  try {
    return { kind: "present", source: await readFile(filePath, "utf8") };
  } catch (error) {
    if (
      isObject(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return { kind: "missing" };
    }
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseJsonFact(fact: TextFact): JsonObject | undefined {
  if (fact.kind !== "present") return undefined;
  try {
    const value: unknown = JSON.parse(fact.source);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function validNpmPackageName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 214 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value === "." ||
    value === ".." ||
    value === "node_modules" ||
    value === "favicon.ico" ||
    isBuiltin(value)
  ) {
    return false;
  }

  const scoped = /^@([^/]+)\/([^/]+)$/u.exec(value);
  if (value.startsWith("@") && scoped === null) return false;
  const scope = scoped?.[1];
  const leaf = scoped?.[2] ?? value;
  if (scope === undefined && /^[._-]/u.test(leaf)) return false;
  if (scope !== undefined && leaf.startsWith(".")) return false;
  if (/[~'!()*]/u.test(leaf)) return false;
  return (
    encodeURIComponent(leaf) === leaf &&
    (scope === undefined || encodeURIComponent(scope) === scope)
  );
}

function stableVersion(value: unknown): value is string {
  if (typeof value !== "string" || validSemver(value) !== value) return false;
  const parsed = parseSemver(value);
  return (
    parsed !== null &&
    parsed.prerelease.length === 0 &&
    parsed.build.length === 0
  );
}

function validSpdx(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    parseSpdxExpression(value);
    return true;
  } catch {
    return false;
  }
}

function exactStringSet(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string") &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    expected.every((item) => value.includes(item))
  );
}

function nonPlaceholderText(source: string): boolean {
  const normalized = source.trim();
  return (
    normalized.length > 0 &&
    !/\bTODO\b/iu.test(normalized) &&
    !/^(?:your name|name of copyright owner|copyright holder|\{\{[A-Z][A-Z0-9_]*\}\}|\[(?:yyyy|name of copyright owner|copyright holder)\])$/iu.test(
      normalized,
    )
  );
}

function hasNonPlaceholderCopyrightHolder(source: string): boolean {
  return [
    ...source.matchAll(
      /^Copyright(?: \(c\))?\s+(?:\d{4}(?:-\d{4})?\s+)?([^\r\n]+)$/gimu,
    ),
  ].some(
    (match) =>
      nonPlaceholderText(match[1]!) &&
      !/\[(?:yyyy|name of copyright owner|copyright holder)\]/iu.test(
        match[1]!,
      ),
  );
}

function githubRepository(
  value: unknown,
  packagePath: string,
):
  | {
      readonly canonicalUrl: string;
      readonly webUrl: string;
    }
  | undefined {
  if (!isObject(value)) return undefined;
  if (
    Object.keys(value).toSorted().join("\u0000") !==
      ["directory", "type", "url"].toSorted().join("\u0000") ||
    value.type !== "git" ||
    value.directory !== packagePath ||
    typeof value.url !== "string"
  ) {
    return undefined;
  }
  const match =
    /^git\+https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)\.git$/u.exec(
      value.url,
    );
  if (match === null || match[2]!.endsWith(".")) return undefined;
  return {
    canonicalUrl: value.url,
    webUrl: `https://github.com/${match[1]}/${match[2]}`,
  };
}

function validRecordOfStrings(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function runtimeDependencyNames(manifest: JsonObject): readonly string[] {
  return [manifest.dependencies, manifest.optionalDependencies].flatMap(
    (value) => (isObject(value) ? Object.keys(value) : []),
  );
}

function workspacePatterns(source: string): readonly string[] {
  const lines = source.split(/\r?\n/u);
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/u.test(line)) break;
    const item = /^\s+-\s+["']?([^"']+?)["']?\s*$/u.exec(line)?.[1];
    if (inPackages && item !== undefined) patterns.push(item);
  }
  return patterns;
}

async function actualWorkspaceManifests(repositoryRoot: string): Promise<{
  readonly manifests: readonly {
    readonly path: string;
    readonly manifest: JsonObject;
  }[];
  readonly failures: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}> {
  const workspace = await textFact(
    path.join(repositoryRoot, "pnpm-workspace.yaml"),
  );
  if (workspace.kind !== "present") {
    return {
      manifests: [],
      failures: [
        {
          path: "pnpm-workspace.yaml",
          reason: workspace.kind === "missing" ? "missing" : workspace.reason,
        },
      ],
    };
  }
  const manifests: { path: string; manifest: JsonObject }[] = [];
  const failures: { path: string; reason: string }[] = [];
  const patterns = workspacePatterns(workspace.source);
  if (patterns.length === 0) {
    failures.push({
      path: "pnpm-workspace.yaml",
      reason: "No workspace package patterns were found",
    });
  }
  for (const pattern of patterns) {
    const match = /^([a-z0-9][a-z0-9-]*)\/\*$/u.exec(pattern);
    if (match === null) {
      failures.push({
        path: "pnpm-workspace.yaml",
        reason: `Unsupported workspace package pattern ${JSON.stringify(pattern)}`,
      });
      continue;
    }
    const collection = match[1]!;
    let entries;
    try {
      entries = await readdir(path.join(repositoryRoot, collection), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") continue;
      failures.push({
        path: collection,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packagePath = `${collection}/${entry.name}`;
      const manifestFact = await textFact(
        path.join(repositoryRoot, packagePath, "package.json"),
      );
      if (manifestFact.kind === "missing") continue;
      const manifest = parseJsonFact(manifestFact);
      if (manifest === undefined) {
        failures.push({
          path: `${packagePath}/package.json`,
          reason:
            manifestFact.kind === "unreadable"
              ? manifestFact.reason
              : "Invalid JSON object",
        });
        continue;
      }
      if (manifest !== undefined)
        manifests.push({ path: packagePath, manifest });
    }
  }
  return { manifests, failures };
}

function addManifestBlockers(options: {
  readonly manifest: JsonObject;
  readonly manifestPath: string;
  readonly packagePath: string;
  readonly rootManifest: JsonObject | undefined;
  readonly blockers: NpmPublicationReadinessBlocker[];
}): {
  readonly packageName?: string;
  readonly commandName?: string;
  readonly version?: string;
  readonly repository?: {
    readonly canonicalUrl: string;
    readonly webUrl: string;
  };
  readonly license?: string;
} {
  const { blockers, manifest, manifestPath, packagePath, rootManifest } =
    options;
  const packageName =
    typeof manifest.name === "string" && validNpmPackageName(manifest.name)
      ? manifest.name
      : undefined;
  if (packageName === undefined) {
    blockers.push(
      blocker({
        code: "package-name",
        path: manifestPath,
        pointer: "/name",
        observed: display(manifest.name),
        expected: "A valid scoped or unscoped npm package name",
        nextAction: "Set the final public npm package name.",
      }),
    );
  }

  let commandName: string | undefined;
  try {
    commandName = cliCommandIdentity(manifest).commandName;
  } catch (error) {
    blockers.push(
      blocker({
        code: "cli-bin",
        path: manifestPath,
        pointer: "/bin",
        observed: error instanceof Error ? error.message : String(error),
        expected: 'Exactly one safe bin that executes "./dist/cli.js"',
        nextAction: "Correct the public CLI bin declaration.",
      }),
    );
  }

  if (
    typeof manifest.description !== "string" ||
    manifest.description.trim().length === 0
  ) {
    blockers.push(
      blocker({
        code: "description",
        path: manifestPath,
        pointer: "/description",
        observed: display(manifest.description),
        expected: "A non-empty public package description",
        nextAction: "Describe the CLI for npm consumers.",
      }),
    );
  }

  const version = stableVersion(manifest.version)
    ? manifest.version
    : undefined;
  if (version === undefined) {
    blockers.push(
      blocker({
        code: "version",
        path: manifestPath,
        pointer: "/version",
        observed: display(manifest.version),
        expected: "A stable exact SemVer version",
        nextAction: "Set the reviewed public package version.",
      }),
    );
  }

  if (Object.hasOwn(manifest, "private")) {
    blockers.push(
      blocker({
        code: "private",
        path: manifestPath,
        pointer: "/private",
        observed: display(manifest.private),
        expected: "The private field to be absent",
        nextAction:
          "Remove private only after every publication fact is ready.",
      }),
    );
  }

  const license = validSpdx(manifest.license) ? manifest.license : undefined;
  if (license === undefined) {
    blockers.push(
      blocker({
        code: "license-id",
        path: manifestPath,
        pointer: "/license",
        observed: display(manifest.license),
        expected: "A valid SPDX license expression",
        nextAction: "Set the reviewed SPDX license identifier.",
      }),
    );
  }

  const repository = githubRepository(manifest.repository, packagePath);
  if (repository === undefined) {
    blockers.push(
      blocker({
        code: "repository",
        path: manifestPath,
        pointer: "/repository",
        observed: display(manifest.repository),
        expected:
          "A canonical public GitHub repository object with the Package Path directory",
        nextAction: "Set the exact public GitHub repository metadata.",
      }),
    );
  }
  if (
    repository === undefined ||
    manifest.homepage !== `${repository.webUrl}#readme`
  ) {
    blockers.push(
      blocker({
        code: "homepage",
        path: manifestPath,
        pointer: "/homepage",
        observed: display(manifest.homepage),
        expected:
          repository === undefined
            ? "A homepage derived from the canonical GitHub repository"
            : `${repository.webUrl}#readme`,
        nextAction: "Set the package homepage from the public repository.",
      }),
    );
  }
  const expectedBugs =
    repository === undefined ? undefined : `${repository.webUrl}/issues`;
  if (
    expectedBugs === undefined ||
    !isObject(manifest.bugs) ||
    Object.keys(manifest.bugs).length !== 1 ||
    manifest.bugs.url !== expectedBugs
  ) {
    blockers.push(
      blocker({
        code: "bugs",
        path: manifestPath,
        pointer: "/bugs",
        observed: display(manifest.bugs),
        expected:
          expectedBugs === undefined
            ? "An issues URL derived from the canonical GitHub repository"
            : display({ url: expectedBugs }),
        nextAction: "Set the package issues URL from the public repository.",
      }),
    );
  }

  const baseline =
    isObject(rootManifest?.engines) &&
    typeof rootManifest.engines.node === "string" &&
    /^\d+$/u.test(rootManifest.engines.node)
      ? rootManifest.engines.node
      : undefined;
  const publishConfig = manifest.publishConfig;
  const scripts = manifest.scripts;
  const forbiddenFields = [
    "main",
    "types",
    "exports",
    "imports",
    "provenance",
  ].filter((field) => Object.hasOwn(manifest, field));
  const manifestContractValid =
    manifest.type === "module" &&
    exactStringSet(manifest.files, publicationFiles) &&
    baseline !== undefined &&
    isObject(manifest.engines) &&
    manifest.engines.node === `>=${baseline}` &&
    validRecordOfStrings(manifest.dependencies) &&
    typeof manifest.dependencies.commander === "string" &&
    manifest.dependencies.commander.trim().length > 0 &&
    isObject(scripts) &&
    typeof scripts.build === "string" &&
    scripts.build.length > 0 &&
    typeof scripts.prepack === "string" &&
    scripts.prepack.length > 0 &&
    isObject(publishConfig) &&
    Object.keys(publishConfig).toSorted().join("\u0000") ===
      ["access", "registry"].join("\u0000") &&
    publishConfig.access === "public" &&
    publishConfig.registry === "https://registry.npmjs.org/" &&
    forbiddenFields.length === 0;
  if (!manifestContractValid) {
    blockers.push(
      blocker({
        code: "manifest-contract",
        path: manifestPath,
        observed: display({
          type: manifest.type,
          files: manifest.files,
          engines: manifest.engines,
          scripts: manifest.scripts,
          dependencies: manifest.dependencies,
          publishConfig: manifest.publishConfig,
          forbiddenFields,
        }),
        expected:
          "The minimal public CLI manifest contract derived from the root Node baseline",
        nextAction:
          "Restore the minimal CLI files, engines, scripts, dependencies, and public publish configuration.",
      }),
    );
  }

  return {
    ...(packageName === undefined ? {} : { packageName }),
    ...(commandName === undefined ? {} : { commandName }),
    ...(version === undefined ? {} : { version }),
    ...(repository === undefined ? {} : { repository }),
    ...(license === undefined ? {} : { license }),
  };
}

async function addDocumentBlockers(options: {
  readonly repositoryRoot: string;
  readonly packagePath: string;
  readonly version?: string;
  readonly license?: string;
  readonly blockers: NpmPublicationReadinessBlocker[];
}): Promise<{
  readonly releaseDate?: string;
  readonly releaseNotes?: string;
}> {
  const { blockers, packagePath, repositoryRoot } = options;
  const readmePath = `${packagePath}/README.md`;
  const readme = await textFact(path.join(repositoryRoot, readmePath));
  if (readme.kind === "missing") {
    blockers.push(
      blocker({
        code: "readme-missing",
        path: readmePath,
        observed: "missing",
        expected: "An independent package README",
        nextAction: "Create the public package README.",
      }),
    );
  } else if (
    readme.kind === "unreadable" ||
    !nonPlaceholderText(readme.source)
  ) {
    blockers.push(
      blocker({
        code: "readme-content",
        path: readmePath,
        observed:
          readme.kind === "unreadable"
            ? readme.reason
            : "empty or placeholder text",
        expected: "Non-placeholder documentation for npm consumers",
        nextAction: "Write the public package README.",
      }),
    );
  }

  const rootLicensePath = "LICENSE";
  const packageLicensePath = `${packagePath}/LICENSE`;
  const [rootLicense, packageLicense] = await Promise.all([
    textFact(path.join(repositoryRoot, rootLicensePath)),
    textFact(path.join(repositoryRoot, packageLicensePath)),
  ]);
  for (const [licensePath, fact] of [
    [rootLicensePath, rootLicense],
    [packageLicensePath, packageLicense],
  ] as const) {
    if (fact.kind === "missing") {
      blockers.push(
        blocker({
          code: "license-missing",
          path: licensePath,
          observed: "missing",
          expected: "The reviewed public package license text",
          nextAction: "Create matching root and package LICENSE files.",
        }),
      );
    } else if (fact.kind === "unreadable" || !nonPlaceholderText(fact.source)) {
      blockers.push(
        blocker({
          code: "license-content",
          path: licensePath,
          observed:
            fact.kind === "unreadable"
              ? fact.reason
              : "empty or placeholder text",
          expected: "Non-placeholder reviewed license text",
          nextAction: "Write the selected license text and real holder facts.",
        }),
      );
    }
  }
  if (
    rootLicense.kind === "present" &&
    packageLicense.kind === "present" &&
    rootLicense.source !== packageLicense.source
  ) {
    blockers.push(
      blocker({
        code: "license-mismatch",
        path: packageLicensePath,
        observed: "Package LICENSE bytes differ from root LICENSE",
        expected: "Byte-identical root and package LICENSE files",
        nextAction: "Copy the reviewed license bytes to both owners.",
      }),
    );
  }
  if (
    options.license !== undefined &&
    (options.license === "MIT" || options.license === "Apache-2.0") &&
    packageLicense.kind === "present" &&
    !hasNonPlaceholderCopyrightHolder(packageLicense.source)
  ) {
    blockers.push(
      blocker({
        code: "license-content",
        path: packageLicensePath,
        observed: "LICENSE does not contain a non-placeholder copyright holder",
        expected: `${options.license} license text with a non-placeholder copyright holder`,
        nextAction:
          "Write the selected license with the real copyright holder.",
      }),
    );
  }

  const changelogPath = `${packagePath}/CHANGELOG.md`;
  const changelog = await textFact(path.join(repositoryRoot, changelogPath));
  if (changelog.kind !== "present") {
    blockers.push(
      blocker({
        code: "changelog-missing",
        path: changelogPath,
        observed: changelog.kind === "missing" ? "missing" : changelog.reason,
        expected: "A package-local Keep a Changelog document",
        nextAction: "Create the reviewed package changelog.",
      }),
    );
    return {};
  }
  if (options.version === undefined) return {};
  const inspected = inspectPackageReleaseChangelog(
    changelog.source,
    options.version,
  );
  if (inspected.blockers.length > 0) {
    blockers.push(
      ...inspected.blockers.map((item) => ({
        ...item,
        owner: { path: changelogPath },
      })),
    );
    return {};
  }
  return {
    ...(inspected.releaseDate === undefined
      ? {}
      : { releaseDate: inspected.releaseDate }),
    ...(inspected.releaseNotes === undefined
      ? {}
      : { releaseNotes: inspected.releaseNotes }),
  };
}

async function addMetadataBlockers(options: {
  readonly repositoryRoot: string;
  readonly packagePath: string;
  readonly packageName?: string;
  readonly rootManifest?: JsonObject;
  readonly blockers: NpmPublicationReadinessBlocker[];
}): Promise<void> {
  const metadataRoot = path.join(options.repositoryRoot, ".template");
  let metadataRootState: "absent" | "directory" | "invalid";
  let metadataRootReason: string | undefined;
  try {
    metadataRootState = (await stat(metadataRoot)).isDirectory()
      ? "directory"
      : "invalid";
    if (metadataRootState === "invalid") {
      metadataRootReason = "Local Template Metadata root is not a directory";
    }
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") {
      metadataRootState = "absent";
    } else {
      metadataRootState = "invalid";
      metadataRootReason =
        error instanceof Error ? error.message : String(error);
    }
  }
  const blueprintPath = ".template/blueprint.json";
  const generationPath = ".template/generation.json";
  const [blueprintFact, generationFact] = await Promise.all([
    textFact(path.join(options.repositoryRoot, blueprintPath)),
    textFact(path.join(options.repositoryRoot, generationPath)),
  ]);
  if (
    metadataRootState === "absent" &&
    blueprintFact.kind === "missing" &&
    generationFact.kind === "missing"
  ) {
    return;
  }
  if (metadataRootState === "invalid") {
    options.blockers.push(
      blocker({
        code: "local-template-metadata-invalid",
        path: ".template",
        observed:
          metadataRootReason ?? "Unreadable Local Template Metadata root",
        expected: "A readable Local Template Metadata directory",
        nextAction:
          "Restore the .template directory before checking publication readiness.",
      }),
    );
  }
  for (const [metadataPath, fact] of [
    [blueprintPath, blueprintFact],
    [generationPath, generationFact],
  ] as const) {
    if (fact.kind === "missing") {
      options.blockers.push(
        blocker({
          code: "local-template-metadata-missing",
          path: metadataPath,
          observed: "missing",
          expected: "Complete Local Template Metadata when .template exists",
          nextAction: "Restore both supported Local Template Metadata files.",
        }),
      );
    } else if (fact.kind === "unreadable") {
      options.blockers.push(
        blocker({
          code: "local-template-metadata-invalid",
          path: metadataPath,
          observed: fact.reason,
          expected: "Readable Local Template Metadata JSON",
          nextAction: "Restore the supported Local Template Metadata file.",
        }),
      );
    }
  }
  const blueprint = parseJsonFact(blueprintFact);
  const generation = parseJsonFact(generationFact);
  const blueprintPackages =
    blueprint?.schemaVersion === 3 && Array.isArray(blueprint.packages)
      ? blueprint.packages
      : undefined;
  if (blueprintFact.kind === "present" && blueprintPackages === undefined) {
    options.blockers.push(
      blocker({
        code: "local-template-metadata-invalid",
        path: blueprintPath,
        observed: "Unreadable Blueprint publication facts",
        expected: "Blueprint schema version 3 with package facts",
        nextAction: "Restore the canonical Blueprint.",
      }),
    );
  }
  const generationPackages =
    generation?.schemaVersion === 2 &&
    typeof generation.repositoryName === "string" &&
    generation.repositoryName.trim().length > 0 &&
    typeof generation.defaultPackageScope === "string" &&
    generation.defaultPackageScope.trim().length > 0 &&
    Array.isArray(generation.packages)
      ? generation.packages
      : undefined;
  if (generationFact.kind === "present" && generationPackages === undefined) {
    options.blockers.push(
      blocker({
        code: "local-template-metadata-invalid",
        path: generationPath,
        observed: "Unreadable Generation Record publication facts",
        expected:
          "Generation Record schema version 2 with repository, default scope, and package facts",
        nextAction: "Restore the canonical Generation Record.",
      }),
    );
  }
  if (
    blueprintPackages === undefined ||
    generationPackages === undefined ||
    generation === undefined
  ) {
    return;
  }
  const definitions = blueprintPackages.filter(
    (item): item is JsonObject =>
      isObject(item) && item.path === options.packagePath,
  );
  const records = generationPackages.filter(
    (item): item is JsonObject =>
      isObject(item) && item.path === options.packagePath,
  );
  const definition = definitions[0];
  const record = records[0];
  const targetId =
    definition !== undefined &&
    typeof definition.packageDefinitionId === "string"
      ? definition.packageDefinitionId
      : undefined;
  const definitionsWithTargetId =
    targetId === undefined
      ? []
      : blueprintPackages.filter(
          (item): item is JsonObject =>
            isObject(item) && item.packageDefinitionId === targetId,
        );
  const recordsWithTargetId =
    targetId === undefined
      ? []
      : generationPackages.filter(
          (item): item is JsonObject =>
            isObject(item) && item.packageDefinitionId === targetId,
        );
  const candidateProvenance = generationPackages.filter(
    (item): item is JsonObject =>
      isObject(item) &&
      item.definitionName === "ts-cli" &&
      item.contributionIdentity === "cli-publication-candidate",
  );
  const initCandidates = candidateProvenance.filter(
    (item) => item.planningContribution === "planInitialization",
  );
  const definitionMatches =
    definitions.length === 1 &&
    definition !== undefined &&
    targetId !== undefined &&
    targetId.length > 0 &&
    definitionsWithTargetId.length === 1 &&
    definition.name === options.packageName &&
    definition.role === "cli-tool";
  const recordMatches =
    records.length === 1 &&
    record !== undefined &&
    definition !== undefined &&
    recordsWithTargetId.length === 1 &&
    record.packageDefinitionId === definition.packageDefinitionId &&
    candidateProvenance.length === 1 &&
    initCandidates.length === 1 &&
    initCandidates[0] === record;
  const repositoryMatches =
    generation.repositoryName === options.rootManifest?.name;
  if (!definitionMatches || !recordMatches || !repositoryMatches) {
    options.blockers.push(
      blocker({
        code: "local-template-metadata-mismatch",
        path: !definitionMatches ? blueprintPath : generationPath,
        observed: display({
          definitions,
          records,
          definitionsWithTargetId,
          recordsWithTargetId,
          candidateProvenance,
          repositoryName: generation.repositoryName,
        }),
        expected:
          "Exactly one matching public CLI target with stable ID and candidate provenance",
        nextAction:
          "Restore the matching Blueprint name and unchanged candidate planning facts.",
      }),
    );
  }
}

export async function inspectNpmPublicationReadiness(options: {
  readonly repositoryRoot: string;
  readonly packagePath: string;
}): Promise<NpmPublicationReadiness> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const packagePath = options.packagePath.split(path.sep).join("/");
  const targetRoot = path.resolve(repositoryRoot, packagePath);
  const safePackagePath =
    /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u.test(packagePath) &&
    targetRoot.startsWith(`${repositoryRoot}${path.sep}`);
  const manifestPath = `${packagePath}/package.json`;
  const blockers: NpmPublicationReadinessBlocker[] = [];
  if (!safePackagePath) {
    blockers.push(
      blocker({
        code: "manifest-contract",
        path: manifestPath,
        observed: options.packagePath,
        expected: "A safe two-segment Package Path inside the repository",
        nextAction:
          "Use the candidate Package Path projected by the repository.",
      }),
    );
    return {
      kind: "blocked",
      mode: "public-intent",
      target: { packagePath },
      blockers: blockers as [
        NpmPublicationReadinessBlocker,
        ...NpmPublicationReadinessBlocker[],
      ],
    };
  }

  const [manifestFact, rootManifestFact] = await Promise.all([
    textFact(path.join(repositoryRoot, manifestPath)),
    textFact(path.join(repositoryRoot, "package.json")),
  ]);
  const manifest = parseJsonFact(manifestFact);
  const rootManifest = parseJsonFact(rootManifestFact);
  if (manifest === undefined) {
    blockers.push(
      blocker({
        code: "manifest-contract",
        path: manifestPath,
        observed:
          manifestFact.kind === "missing"
            ? "missing"
            : manifestFact.kind === "unreadable"
              ? manifestFact.reason
              : "Invalid JSON object",
        expected: "A readable public CLI package manifest",
        nextAction: "Restore the candidate package manifest.",
      }),
    );
    return {
      kind: "blocked",
      mode: "public-intent",
      target: { packagePath },
      blockers: blockers as [
        NpmPublicationReadinessBlocker,
        ...NpmPublicationReadinessBlocker[],
      ],
    };
  }

  const mode =
    manifest.private === true && manifest.version === undefined
      ? "safe-unconfigured"
      : "public-intent";
  const identity = addManifestBlockers({
    manifest,
    manifestPath,
    packagePath,
    rootManifest,
    blockers,
  });
  const documents = await addDocumentBlockers({
    repositoryRoot,
    packagePath,
    ...(identity.version === undefined ? {} : { version: identity.version }),
    ...(identity.license === undefined ? {} : { license: identity.license }),
    blockers,
  });
  await addMetadataBlockers({
    repositoryRoot,
    packagePath,
    ...(rootManifest === undefined ? {} : { rootManifest }),
    ...(identity.packageName === undefined
      ? {}
      : { packageName: identity.packageName }),
    blockers,
  });

  const workspaceFacts = await actualWorkspaceManifests(repositoryRoot);
  for (const failure of workspaceFacts.failures) {
    blockers.push(
      blocker({
        code: "manifest-contract",
        path: failure.path,
        observed: failure.reason,
        expected: "Readable actual workspace package manifests",
        nextAction: "Restore the generated workspace membership and manifests.",
      }),
    );
  }
  for (const dependencyName of runtimeDependencyNames(manifest)) {
    const dependencyField =
      isObject(manifest.dependencies) &&
      Object.hasOwn(manifest.dependencies, dependencyName)
        ? "dependencies"
        : "optionalDependencies";
    for (const dependency of workspaceFacts.manifests) {
      if (
        dependency.manifest.name !== dependencyName ||
        dependency.manifest.private !== true
      ) {
        continue;
      }
      blockers.push(
        blocker({
          code: "private-runtime-dependency",
          path: manifestPath,
          pointer: `/${dependencyField}/${jsonPointerSegment(dependencyName)}`,
          observed: `${dependencyName} resolves to private workspace package ${dependency.path}`,
          expected: "Every direct public runtime dependency to be installable",
          nextAction:
            "Publish the dependency separately or remove the private runtime edge.",
        }),
      );
    }
  }

  blockers.sort(compareBlockers);
  if (blockers.length > 0) {
    return {
      kind: "blocked",
      mode,
      target: { packagePath },
      blockers: blockers as [
        NpmPublicationReadinessBlocker,
        ...NpmPublicationReadinessBlocker[],
      ],
    };
  }

  return {
    kind: "ready",
    target: { packagePath },
    blockers: [],
    publication: {
      packagePath,
      packageName: identity.packageName!,
      commandName: identity.commandName!,
      version: identity.version!,
      repository: identity.repository!.canonicalUrl,
      releaseDate: documents.releaseDate!,
      releaseNotes: documents.releaseNotes!,
    },
  };
}
