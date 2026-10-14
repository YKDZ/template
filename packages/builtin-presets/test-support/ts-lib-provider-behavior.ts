import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { tsLibDefinition } from "../src/ts-lib/definition.ts";
import {
  cloneInstalledGeneratedRepository,
  preserveInstalledGeneratedRepositoryFailure,
  removeWithRetry,
  type InstalledGeneratedRepository,
} from "./installed-generated-repository.ts";
import {
  installedIntegrationSignal,
  throwIfInstalledIntegrationWasCancelled,
} from "./installed-integration-signal.ts";

export type TsLibProviderRepository = InstalledGeneratedRepository & {
  readonly consumerPackagePath: string;
};

let sharedProviderRepository: Promise<TsLibProviderRepository> | undefined;

async function prepareProviderRepository(): Promise<TsLibProviderRepository> {
  throwIfInstalledIntegrationWasCancelled();
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-ts-lib-provider-shared-"),
  );
  const targetDir = path.join(workspace, "consumer");
  let repository: TsLibProviderRepository | undefined;
  try {
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
          0,
          releaseToolchainSnapshot.nodeVersion.indexOf("."),
        ),
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });
    const consumerPackagePath = initialization.blueprint.packages[0]!.path;
    const addition = planGeneratedRepositoryPackageAddition({
      definition: tsLibDefinition,
      localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
      packageLeafName: "provider",
      linkFrom: [consumerPackagePath],
    });
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.projectProjections,
    });
    await execa("pnpm", ["install"], {
      cwd: targetDir,
      cancelSignal: installedIntegrationSignal(),
    });
    repository = { workspace, targetDir, consumerPackagePath };
    return repository;
  } catch (cause) {
    const partialRepository: TsLibProviderRepository = {
      workspace,
      targetDir,
      consumerPackagePath: "packages/lib",
    };
    const retained = await preserveInstalledGeneratedRepositoryFailure({
      label: "TS Lib",
      scenario: "ts-lib-shared-provider-preparation",
      repository: partialRepository,
      cause,
    });
    if (retained !== undefined) {
      try {
        await removeWithRetry(workspace);
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          "TS Lib provider preparation failed and its workspace could not be removed",
          { cause },
        );
      }
    }
    throw cause;
  }
}

async function cloneProviderRepository(
  source: TsLibProviderRepository,
  prefix: string,
): Promise<TsLibProviderRepository> {
  const copied = await cloneInstalledGeneratedRepository(
    source,
    prefix,
    "TS Lib",
  );
  return {
    ...copied,
    consumerPackagePath: source.consumerPackagePath,
  };
}

export async function withSharedTsLibProviderRepository<T>(
  prefix: string,
  callback: (repository: TsLibProviderRepository) => Promise<T>,
): Promise<T> {
  throwIfInstalledIntegrationWasCancelled();
  sharedProviderRepository ??= prepareProviderRepository();
  const base = await sharedProviderRepository;
  throwIfInstalledIntegrationWasCancelled();
  const scenario = await cloneProviderRepository(
    base,
    `template-ts-lib-provider-${prefix}-`,
  );
  try {
    throwIfInstalledIntegrationWasCancelled();
    const result = await callback(scenario);
    await removeWithRetry(scenario.workspace);
    return result;
  } catch (cause) {
    const retained = await preserveInstalledGeneratedRepositoryFailure({
      label: "TS Lib",
      scenario: prefix,
      repository: scenario,
      cause,
    });
    if (retained !== undefined) {
      try {
        await removeWithRetry(scenario.workspace);
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          `TS Lib scenario ${prefix} failed and its workspace could not be removed`,
          { cause },
        );
      }
    }
    throw cause;
  }
}

export async function cleanupSharedTsLibProviderRepository(): Promise<void> {
  const pending = sharedProviderRepository;
  if (pending === undefined) return;
  const repository = await pending.catch(() => undefined);
  if (repository === undefined) {
    if (sharedProviderRepository === pending)
      sharedProviderRepository = undefined;
    return;
  }
  try {
    await removeWithRetry(repository.workspace);
  } catch (cause) {
    await preserveInstalledGeneratedRepositoryFailure({
      label: "TS Lib",
      scenario: "ts-lib-shared-provider-cleanup",
      repository,
      cause,
    });
    throw cause;
  }
  if (sharedProviderRepository === pending)
    sharedProviderRepository = undefined;
}
