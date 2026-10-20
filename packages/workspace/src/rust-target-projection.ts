import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  contentIdentityKey,
  isContentIdentity,
} from "@ykdz/template-core/content-identity";
import type {
  ContentIdentity,
  LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import { resolveTemplateSource } from "@ykdz/template-core/renderer";
import { projectTomlStringValues } from "@ykdz/template-core/toml";
import type {
  GeneratorPackageRecord,
  GeneratorSelectionRoot,
} from "@ykdz/template-core/workspace-strategy";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/preset-definition";

import { releaseToolchainSnapshot } from "./release-toolchain-snapshot.ts";
import {
  readRootRustToolchainChannel,
  rootRustDeclarationFileName,
} from "./rust-toolchain-facts.ts";

type RustToolchain = NonNullable<
  PackageContribution["foundation"]["toolchains"]["rust"]
>;

type RustContent = LoadedContentMember;

const rustModuleURL = import.meta.resolve("@ykdz/reference-rust-bin/template");

function isRustContent(content: RustContent | undefined): boolean {
  return content?.source.moduleURL === rustModuleURL;
}

/** 默认策略从被选中的原生 Rust 内容初始化其根工具链版本。 */
export function initialRustVersion(
  selection: readonly GeneratorSelectionRoot[],
  contentByIdentity: ReadonlyMap<string, RustContent>,
): string | undefined {
  return selection.some(
    (root) =>
      isContentIdentity(root.contentIdentity) &&
      isRustContent(
        contentByIdentity.get(contentIdentityKey(root.contentIdentity)),
      ),
  )
    ? releaseToolchainSnapshot.rustVersion
    : undefined;
}

/** 默认策略加 Rust 包时沿用现行根事实或发布快照。 */
export function rustVersionForAddition(options: {
  readonly targetRoot: string;
  readonly packages: readonly GeneratorPackageRecord[];
  readonly contentIdentity: ContentIdentity;
  readonly contentByIdentity: ReadonlyMap<string, RustContent>;
}): string | undefined {
  const hasRustPackage = options.packages.some((record) =>
    isRustContent(
      options.contentByIdentity.get(contentIdentityKey(record.contentIdentity)),
    ),
  );
  const addsRustPackage = isRustContent(
    options.contentByIdentity.get(contentIdentityKey(options.contentIdentity)),
  );
  if (!hasRustPackage && !addsRustPackage) return undefined;

  const declarationPath = path.join(
    options.targetRoot,
    rootRustDeclarationFileName,
  );
  if (hasRustPackage || existsSync(declarationPath)) {
    return readRootRustToolchainChannel(options.targetRoot);
  }
  return releaseToolchainSnapshot.rustVersion;
}

function rustToolchain(
  contributions: readonly PackageContribution[],
): RustToolchain | undefined {
  const declarations = contributions.flatMap((contribution) => {
    const rust = contribution.foundation.toolchains.rust;
    return rust === undefined ? [] : [rust];
  });
  const fingerprints = declarations.map((rust) =>
    JSON.stringify({
      toolchain: rust.toolchain,
      components: [...new Set(rust.components)].toSorted(),
      configurationSource: resolveTemplateSource(
        rust.configurationSource.source,
        rust.configurationSource.from,
      ),
    }),
  );
  if (new Set(fingerprints).size > 1) {
    throw new Error("工作区要求所有 Rust 工具链声明相互兼容");
  }
  return declarations[0];
}

/** 默认策略投影 Rust 根声明，并在已有 Rust 仓库加包时保留原始字节。 */
export function projectRustTarget(options: {
  readonly context: GenerationContext;
  readonly packages: readonly GeneratorPackageRecord[];
  readonly contributions: readonly PackageContribution[];
}): {
  readonly toolchain: RustToolchain | undefined;
  readonly operation: RenderOperation | undefined;
} {
  const toolchain = rustToolchain(options.contributions);
  if (toolchain === undefined) return { toolchain, operation: undefined };

  const wasAddition = options.packages.some(
    (record) => record.createdBy === "addition",
  );
  const existingDeclarationPath = path.join(
    options.context.targetDir,
    rootRustDeclarationFileName,
  );
  const existingDeclaration =
    wasAddition && existsSync(existingDeclarationPath)
      ? readFileSync(existingDeclarationPath, "utf8")
      : undefined;
  const text =
    existingDeclaration ??
    projectTomlStringValues(
      readFileSync(
        resolveTemplateSource(
          toolchain.configurationSource.source,
          toolchain.configurationSource.from,
        ),
        "utf8",
      ),
      [{ path: ["toolchain", "channel"], value: toolchain.toolchain }],
    );
  return {
    toolchain,
    operation: {
      kind: "writeText",
      to: rootRustDeclarationFileName,
      text,
    },
  };
}
