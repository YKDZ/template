import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

export const requiredCapabilityProbeIdentities = new Set([
  "cargo",
  "github-cli",
  "playwright",
  "shellcheck",
]);

export function registryCapabilityProbes(root: string) {
  return builtInPresetRegistry
    .all()
    .flatMap(
      (definition) =>
        planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir: path.join(root, `probe-${definition.metadata.name}`),
            defaultPackageScope: "fixture",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            },
          }),
        }).developmentContainer.probes,
    )
    .filter((probe) => requiredCapabilityProbeIdentities.has(probe.identity));
}
