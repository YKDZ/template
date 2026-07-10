import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TemplateDependencyCatalog = Record<string, string>;
export type TemplateCargoDependencyVersions = Record<string, string>;

export type GeneratedDependencyCatalogOptions = {
  readonly dependencies: readonly string[];
  readonly packages?: readonly string[];
  readonly allowBuilds?: Record<string, boolean>;
};

export type GeneratedPackageManifestDependencies = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

const templateInternalDependencyIdentities = new Set([
  "@typescript/native",
  "@typescript/typescript6",
]);

function assertGeneratedDependencyCatalogBoundary(
  dependencies: readonly string[],
): void {
  for (const dependency of dependencies) {
    if (templateInternalDependencyIdentities.has(dependency)) {
      throw new Error(
        `Generated Repository Dependency Catalog cannot include template-internal dependency: ${dependency}`,
      );
    }
  }
}

function templateRepositoryRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    moduleDir,
    path.resolve(moduleDir, ".."),
    path.resolve(moduleDir, "..", ".."),
    path.resolve(moduleDir, "..", "..", ".."),
  ];

  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, "pnpm-workspace.yaml")),
    ) ?? candidates[0]!
  );
}

function parseTemplateCatalogSection(
  workspaceYaml: string,
  sectionName: "catalog",
): TemplateDependencyCatalog {
  const catalog: TemplateDependencyCatalog = {};
  const lines = workspaceYaml.split(/\r?\n/);
  const catalogStart = lines.findIndex((line) => line === `${sectionName}:`);

  if (catalogStart === -1) {
    return catalog;
  }

  for (const line of lines.slice(catalogStart + 1)) {
    if (line.length > 0 && !line.startsWith("  ")) {
      break;
    }

    const match = /^  (?:"([^"]+)"|([^:]+)): (.+)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1] ?? match[2];
    const version = match[3];
    if (key === undefined || version === undefined) {
      continue;
    }

    catalog[key] = version;
  }

  return catalog;
}

function parseTemplateDependencyCatalog(
  workspaceYaml: string,
): TemplateDependencyCatalog {
  return parseTemplateCatalogSection(workspaceYaml, "catalog");
}

export function loadTemplateDependencyCatalog(): TemplateDependencyCatalog {
  return parseTemplateDependencyCatalog(
    readFileSync(
      path.join(templateRepositoryRoot(), "pnpm-workspace.yaml"),
      "utf8",
    ),
  );
}

export function selectTemplateDependencyCatalogEntries(
  dependencies: readonly string[],
  catalog: TemplateDependencyCatalog = loadTemplateDependencyCatalog(),
): TemplateDependencyCatalog {
  const selected: TemplateDependencyCatalog = {};

  for (const dependency of dependencies.toSorted()) {
    const version = catalog[dependency];
    if (version === undefined) {
      throw new Error(
        `Template Dependency Catalog is missing dependency: ${dependency}`,
      );
    }

    selected[dependency] = version;
  }

  return selected;
}

function parseTemplateCargoDependencyVersions(
  cargoToml: string,
): TemplateCargoDependencyVersions {
  const dependencies: TemplateCargoDependencyVersions = {};
  const lines = cargoToml.split(/\r?\n/);
  const dependenciesStart = lines.findIndex(
    (line) => line.trim() === "[dependencies]",
  );

  if (dependenciesStart === -1) {
    return dependencies;
  }

  for (const line of lines.slice(dependenciesStart + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      break;
    }

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*"([^"]+)"\s*$/.exec(
      trimmed,
    );
    if (!match) {
      throw new Error(
        `Unsupported Template Cargo dependency declaration: ${trimmed}`,
      );
    }

    const dependency = match[1] ?? match[2];
    const version = match[3];
    if (dependency === undefined || version === undefined) {
      continue;
    }

    dependencies[dependency] = version;
  }

  return dependencies;
}

export function loadTemplateCargoDependencyVersions(): TemplateCargoDependencyVersions {
  return parseTemplateCargoDependencyVersions(
    readFileSync(path.join(templateRepositoryRoot(), "Cargo.toml"), "utf8"),
  );
}

function loadTemplateCargoLock(): string {
  return readFileSync(
    path.join(templateRepositoryRoot(), "Cargo.lock"),
    "utf8",
  );
}

export function renderCargoLockForPackage(options: {
  readonly packageName: string;
  readonly packageVersion: string;
}): string {
  return loadTemplateCargoLock()
    .replace(
      'name = "template-cargo-dependencies"',
      `name = ${JSON.stringify(options.packageName)}`,
    )
    .replace(
      'version = "0.0.0"',
      `version = ${JSON.stringify(options.packageVersion)}`,
    );
}

export function selectTemplateCargoDependencyVersions(
  dependencies: readonly string[],
  catalog: TemplateCargoDependencyVersions = loadTemplateCargoDependencyVersions(),
): TemplateCargoDependencyVersions {
  const selected: TemplateCargoDependencyVersions = {};

  for (const dependency of dependencies.toSorted()) {
    const version = catalog[dependency];
    if (version === undefined) {
      throw new Error(
        `Template Cargo dependency versions are missing dependency: ${dependency}`,
      );
    }

    selected[dependency] = version;
  }

  return selected;
}

function renderTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export function renderCargoDependencyTomlEntries(
  dependencies: readonly string[],
  catalog: TemplateCargoDependencyVersions = loadTemplateCargoDependencyVersions(),
): string[] {
  return Object.entries(
    selectTemplateCargoDependencyVersions(dependencies, catalog),
  ).map(([dependency, version]) => {
    return `${renderTomlKey(dependency)} = ${JSON.stringify(version)}`;
  });
}

export function collectGeneratedManifestCatalogDependencies(
  manifests: readonly GeneratedPackageManifestDependencies[],
): string[] {
  const dependencies = new Set<string>();

  for (const manifest of manifests) {
    for (const dependencyMap of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [dependency, specifier] of Object.entries(
        dependencyMap ?? {},
      )) {
        if (specifier !== "catalog:") {
          throw new Error(
            `Generated manifest dependency ${dependency} must use catalog:, got ${specifier}`,
          );
        }

        dependencies.add(dependency);
      }
    }
  }

  return [...dependencies].toSorted();
}

export function collectGeneratedManifestCatalogReferences(
  manifests: readonly GeneratedPackageManifestDependencies[],
): string[] {
  const dependencies = new Set<string>();

  for (const manifest of manifests) {
    for (const dependencyMap of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [dependency, specifier] of Object.entries(
        dependencyMap ?? {},
      )) {
        if (specifier.startsWith("catalog:")) {
          dependencies.add(dependency);
        }
      }
    }
  }

  return [...dependencies].toSorted();
}

function renderCatalogKey(key: string): string {
  return key.startsWith("@") ? JSON.stringify(key) : key;
}

export function pnpmWorkspaceYamlWithCatalogDependencies(
  workspaceYaml: string,
  dependencies: readonly string[],
  templateCatalog: TemplateDependencyCatalog = loadTemplateDependencyCatalog(),
): string {
  assertGeneratedDependencyCatalogBoundary(dependencies);
  const catalogStart = workspaceYaml
    .split(/\r?\n/)
    .findIndex((line) => line === "catalog:");

  if (catalogStart === -1) {
    throw new Error(
      "Cannot update pnpm Dependency Catalog: missing catalog section",
    );
  }

  const existingCatalog = parseTemplateDependencyCatalog(workspaceYaml);
  const missingDependencies = dependencies.filter(
    (dependency) => existingCatalog[dependency] === undefined,
  );

  if (missingDependencies.length === 0) {
    return workspaceYaml;
  }

  const nextCatalog = {
    ...existingCatalog,
    ...selectTemplateDependencyCatalogEntries(
      missingDependencies,
      templateCatalog,
    ),
  };
  const lines = workspaceYaml.split(/\r?\n/);
  const catalogEnd = lines.findIndex(
    (line, index) =>
      index > catalogStart && line.length > 0 && !line.startsWith("  "),
  );
  const replacementEnd = catalogEnd === -1 ? lines.length : catalogEnd;
  const catalogLines = [
    "catalog:",
    ...Object.entries(nextCatalog)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(
        ([dependency, version]) =>
          `  ${renderCatalogKey(dependency)}: ${version}`,
      ),
    "",
  ];

  return [
    ...lines.slice(0, catalogStart),
    ...catalogLines,
    ...lines.slice(replacementEnd),
  ].join("\n");
}

export function renderGeneratedPnpmWorkspaceYaml(
  options: GeneratedDependencyCatalogOptions,
): string {
  assertGeneratedDependencyCatalogBoundary(options.dependencies);
  const catalog = selectTemplateDependencyCatalogEntries(options.dependencies);
  const packages = options.packages ?? ["."];
  const lines = [
    "packages:",
    ...packages.map((workspacePackage) => `  - ${workspacePackage}`),
    "",
  ];

  if (options.allowBuilds) {
    lines.push(
      "allowBuilds:",
      ...Object.entries(options.allowBuilds)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([dependency, allowed]) => `  ${dependency}: ${allowed}`),
      "",
    );
  }

  lines.push(
    "catalog:",
    ...Object.entries(catalog).map(
      ([dependency, version]) =>
        `  ${renderCatalogKey(dependency)}: ${version}`,
    ),
    "",
  );

  return lines.join("\n");
}
