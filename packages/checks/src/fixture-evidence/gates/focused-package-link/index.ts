import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import type { GeneratedRepositoryPlan } from "#template-builtin-presets";

import {
  deriveFixtureGateContractIdentity,
  ensureFixtureDependencies,
  normalizedFixtureDependencyInstallationPlan,
  type FixtureCommandRunner,
} from "../../kernel/index.ts";

type FocusedProviderManifest = {
  readonly name: string;
  readonly sourceTarget: string;
  readonly defaultTarget: string;
};

export type FocusedPackageLinkPlanInput = {
  readonly plan: GeneratedRepositoryPlan;
  readonly consumerPackagePath: string;
  readonly providerPackagePath: string;
};

export function deriveFocusedPackageLinkPlanInput(options: {
  readonly initialPlan: GeneratedRepositoryPlan;
  readonly finalPlan: GeneratedRepositoryPlan;
  readonly consumerPackagePaths: readonly string[];
}): FocusedPackageLinkPlanInput {
  const consumerPackagePath = options.consumerPackagePaths[0];
  const initialIntents = new Set(
    (options.initialPlan.blueprint.packageLinkIntents ?? []).map(
      (intent) =>
        `${intent.consumerPackagePath}\u0000${intent.providerPackagePath}`,
    ),
  );
  const matchingIntents = (
    options.finalPlan.blueprint.packageLinkIntents ?? []
  ).filter(
    (intent) =>
      intent.consumerPackagePath === consumerPackagePath &&
      !initialIntents.has(
        `${intent.consumerPackagePath}\u0000${intent.providerPackagePath}`,
      ),
  );
  if (
    consumerPackagePath === undefined ||
    options.consumerPackagePaths.length !== 1 ||
    matchingIntents.length !== 1
  ) {
    throw new Error(
      "Focused Package Link plan must identify exactly one consumer and one new final Package Link Intent",
    );
  }
  return {
    plan: options.finalPlan,
    consumerPackagePath,
    providerPackagePath: matchingIntents[0]!.providerPackagePath,
  };
}

function packageDefinition(
  options: FocusedPackageLinkPlanInput,
  packagePath: string,
  kind: "consumer" | "provider",
) {
  const definition = options.plan.blueprint.packages.find(
    (candidate) => candidate.path === packagePath,
  );
  if (definition === undefined) {
    throw new Error(
      `Focused Package Link ${kind} ${packagePath} is absent from the final Project Blueprint`,
    );
  }
  return definition;
}

function packageManifest(
  plan: GeneratedRepositoryPlan,
  packageName: string,
): Readonly<Record<string, unknown>> {
  const manifest = plan.manifests.find(
    (candidate) => candidate.name === packageName,
  );
  if (manifest === undefined) {
    throw new Error(
      `Focused Package Link package ${packageName} has no planned manifest`,
    );
  }
  return manifest;
}

export function normalizedFocusedPackageLinkPlan(
  options: FocusedPackageLinkPlanInput,
): unknown {
  const consumer = packageDefinition(
    options,
    options.consumerPackagePath,
    "consumer",
  );
  const provider = packageDefinition(
    options,
    options.providerPackagePath,
    "provider",
  );
  const intent = {
    consumerPackagePath: options.consumerPackagePath,
    providerPackagePath: options.providerPackagePath,
  };
  if (
    !options.plan.blueprint.packageLinkIntents?.some(
      (candidate) =>
        candidate.consumerPackagePath === intent.consumerPackagePath &&
        candidate.providerPackagePath === intent.providerPackagePath,
    )
  ) {
    throw new Error(
      `Focused Package Link Intent ${intent.consumerPackagePath} -> ${intent.providerPackagePath} is absent from the final Project Blueprint`,
    );
  }
  const consumerManifest = packageManifest(options.plan, consumer.name);
  const providerManifest = packageManifest(options.plan, provider.name);
  const dependencies = consumerManifest.dependencies as
    | Readonly<Record<string, unknown>>
    | undefined;
  const dependenciesMeta = consumerManifest.dependenciesMeta as
    | Readonly<Record<string, unknown>>
    | undefined;
  const rootExport = (
    providerManifest.exports as Readonly<Record<string, unknown>> | undefined
  )?.["."];

  return {
    gate: "focused-package-link",
    consumer: {
      name: consumer.name,
      path: consumer.path,
      role: consumer.role,
      providerDependency: dependencies?.[provider.name] ?? null,
      providerDependencyMeta: dependenciesMeta?.[provider.name] ?? null,
    },
    provider: {
      name: provider.name,
      path: provider.path,
      role: provider.role,
      rootExport: rootExport ?? null,
    },
    intent,
    dependencyInstallation: normalizedFixtureDependencyInstallationPlan(),
    probe: {
      sourceCondition: "source",
      build: {
        command: "pnpm",
        args: [
          "exec",
          "turbo",
          "run",
          "build",
          `--filter=${consumer.name}`,
          `--filter=${provider.name}`,
          "--force",
        ],
      },
      defaultCondition: "default",
    },
  };
}

export async function deriveFocusedPackageLinkContractIdentity(
  options: FocusedPackageLinkPlanInput,
): Promise<string> {
  return await deriveFixtureGateContractIdentity({
    normalizedPlan: normalizedFocusedPackageLinkPlan(options),
    sourceProjections: [
      {
        name: "focused-package-link",
        root: fileURLToPath(new URL(".", import.meta.url)),
      },
      {
        name: "fixture-evidence-kernel",
        root: fileURLToPath(new URL("../../kernel/", import.meta.url)),
      },
    ],
  });
}

function packageTargetPath(options: {
  readonly packageRoot: string;
  readonly target: unknown;
  readonly condition: "source" | "default";
}): string {
  if (typeof options.target !== "string" || !options.target.startsWith("./")) {
    throw new Error(
      `root ${options.condition} export must be a package-relative string`,
    );
  }
  const resolved = path.resolve(options.packageRoot, options.target);
  const relative = path.relative(options.packageRoot, resolved);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `root ${options.condition} export escapes the provider Package Boundary`,
    );
  }
  return resolved;
}

async function readFocusedProviderManifest(
  providerRoot: string,
): Promise<FocusedProviderManifest> {
  const manifest = JSON.parse(
    await readFile(path.join(providerRoot, "package.json"), "utf8"),
  ) as {
    readonly name?: unknown;
    readonly exports?: { readonly "."?: unknown };
  };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error("provider package manifest must declare a package name");
  }
  const rootExport = manifest.exports?.["."];
  if (
    typeof rootExport !== "object" ||
    rootExport === null ||
    Array.isArray(rootExport)
  ) {
    throw new Error(
      "provider package manifest must declare conditional root exports",
    );
  }
  const conditions = rootExport as Record<string, unknown>;
  return {
    name: manifest.name,
    sourceTarget: packageTargetPath({
      packageRoot: providerRoot,
      target: conditions.source,
      condition: "source",
    }),
    defaultTarget: packageTargetPath({
      packageRoot: providerRoot,
      target: conditions.default,
      condition: "default",
    }),
  };
}

async function readPackageName(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { readonly name?: unknown };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error("consumer package manifest must declare a package name");
  }
  return manifest.name;
}

function commandStdout(result: unknown): string {
  return typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof result.stdout === "string"
    ? result.stdout.trim()
    : "";
}

/**
 * Proves one focused Package Link consumes the current provider manifest in
 * both source and built-distribution modes.
 */
export async function executeFocusedPackageLink(options: {
  readonly scenarioLabel: string;
  readonly projectDir: string;
  readonly fixtureWorkspace: string;
  readonly consumerPackagePath: string;
  readonly providerPackagePath: string;
  readonly run?: FixtureCommandRunner;
}): Promise<void> {
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  await ensureFixtureDependencies({
    projectDir: options.projectDir,
    fixtureWorkspace: options.fixtureWorkspace,
    run,
  });
  const consumerRoot = path.join(
    options.projectDir,
    options.consumerPackagePath,
  );
  const providerRoot = path.join(
    options.projectDir,
    options.providerPackagePath,
  );
  const diagnostic = `${options.scenarioLabel} (consumer ${options.consumerPackagePath}, provider ${options.providerPackagePath})`;
  let consumerName: string;
  let provider: FocusedProviderManifest;
  try {
    [consumerName, provider] = await Promise.all([
      readPackageName(consumerRoot),
      readFocusedProviderManifest(providerRoot),
    ]);
  } catch (error) {
    throw new Error(
      `Focused provider probe could not read manifests for ${diagnostic}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const id = randomUUID().replaceAll("-", "");
  const exportName = `templateFocusedExport${id}`;
  const marker = `focused-provider-marker:${id}`;
  const probeName = `.focused-provider-probe-${id}.mjs`;
  const probePath = path.join(consumerRoot, probeName);
  try {
    const originalSource = await readFile(provider.sourceTarget, "utf8");
    await Promise.all([
      writeFile(
        provider.sourceTarget,
        `${originalSource}${originalSource.endsWith("\n") ? "" : "\n"}export const ${exportName} = ${JSON.stringify(marker)};\n`,
      ),
      writeFile(
        probePath,
        [
          `import { ${exportName} } from ${JSON.stringify(provider.name)};`,
          `console.log(${exportName});`,
          "",
        ].join("\n"),
      ),
    ]);
    const sourceResult = await run("node", ["--conditions=source", probeName], {
      cwd: consumerRoot,
    });
    if (commandStdout(sourceResult) !== marker) {
      throw new Error("source probe did not print the injected marker");
    }

    await run(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "build",
        `--filter=${consumerName}`,
        `--filter=${provider.name}`,
        "--force",
      ],
      { cwd: options.projectDir, stdio: "inherit" },
    );
    await readFile(provider.defaultTarget);
    await rm(provider.sourceTarget);

    const defaultResult = await run("node", [probeName], {
      cwd: consumerRoot,
    });
    if (commandStdout(defaultResult) !== marker) {
      throw new Error("default probe did not print the built marker");
    }
  } catch (error) {
    throw new Error(
      `Focused provider consumption failed for ${diagnostic} (${provider.name}): ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(probePath, { force: true });
  }
}
