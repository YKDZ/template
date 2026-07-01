import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TemplateDependencyCatalog = Record<string, string>;

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

function templateRepositoryRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, ".."),
    path.resolve(moduleDir, "..", ".."),
  ];

  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, "pnpm-workspace.yaml")),
    ) ?? candidates[0]
  );
}

function parseTemplateDependencyCatalog(
  workspaceYaml: string,
): TemplateDependencyCatalog {
  const catalog: TemplateDependencyCatalog = {};
  const lines = workspaceYaml.split(/\r?\n/);
  const catalogStart = lines.findIndex((line) => line === "catalog:");

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

    catalog[match[1] ?? match[2]] = match[3];
  }

  return catalog;
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

  for (const dependency of [...dependencies].sort()) {
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

  return [...dependencies].sort();
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

  return [...dependencies].sort();
}

function renderCatalogKey(key: string): string {
  return key.startsWith("@") ? JSON.stringify(key) : key;
}

export function pnpmWorkspaceYamlWithCatalogDependencies(
  workspaceYaml: string,
  dependencies: readonly string[],
  templateCatalog: TemplateDependencyCatalog = loadTemplateDependencyCatalog(),
): string {
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
      .sort(([left], [right]) => left.localeCompare(right))
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
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dependency, allowed]) => `  ${dependency}: ${allowed}`),
      "",
    );
  }

  lines.push(
    "catalog:",
    ...Object.entries(catalog).map(
      ([dependency, version]) => `  ${renderCatalogKey(dependency)}: ${version}`,
    ),
    "",
  );

  return lines.join("\n");
}
