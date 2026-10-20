import {
  builtInPresetRegistry,
  createGenerationContext,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

/** 从公开来源与新增能力找到本次旅程要消费的预设。 */
export function requireReferencePresetName(
  referencePackageName: string,
): string {
  const context = createGenerationContext({
    targetDir: "project",
    defaultPackageScope: "acme",
    toolchain: {
      nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.split(".")[0]!,
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
    },
  });
  const definition = builtInPresetRegistry.all().find((candidate) => {
    if (candidate.planPackageAddition === undefined) return false;
    return (
      candidate.planPackageAddition({
        context,
        packageLeafName: "consumer",
        packagePath: "packages/consumer",
      }).referenceSource === referencePackageName
    );
  });
  if (definition === undefined) {
    throw new Error(
      `没有可新增且拥有指定公开来源的预设：${referencePackageName}`,
    );
  }
  return definition.metadata.name;
}
