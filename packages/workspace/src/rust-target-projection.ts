import { existsSync } from "node:fs";
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
import { projectTomlStringValues } from "@ykdz/template-core/toml";
import type {
  GeneratorPackageState,
  GeneratorSelectionRoot,
} from "@ykdz/template-core/workspace-strategy";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";

import { releaseToolchainSnapshot } from "./release-toolchain-snapshot.ts";
import {
  readRootRustToolchainDeclaration,
  rootRustDeclarationFileName,
} from "./rust-toolchain-facts.ts";

type RustToolchain = NonNullable<
  PackageContribution["foundation"]["toolchains"]["rust"]
> & {
  readonly configurationText: string;
};

type RustContent = LoadedContentMember<
  { readonly requiresRootRustToolchain?: true },
  "reference"
>;

function isRustContent(content: RustContent | undefined): boolean {
  return content?.definition.requiresRootRustToolchain === true;
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

/** 加包准备读取现有根声明一次，投影只消费声明快照。 */
export function prepareRustTargetAddition(options: {
  readonly targetRoot: string;
  readonly packages: readonly GeneratorPackageState[];
  readonly contentIdentity: ContentIdentity;
  readonly contentByIdentity: ReadonlyMap<string, RustContent>;
}): {
  readonly rustVersion?: string;
  readonly existingDeclaration?: string;
} {
  const hasRustPackage = options.packages.some((record) =>
    isRustContent(
      options.contentByIdentity.get(contentIdentityKey(record.contentIdentity)),
    ),
  );
  const addsRustPackage = isRustContent(
    options.contentByIdentity.get(contentIdentityKey(options.contentIdentity)),
  );
  if (!hasRustPackage && !addsRustPackage) return {};

  const declarationPath = path.join(
    options.targetRoot,
    rootRustDeclarationFileName,
  );
  if (hasRustPackage || existsSync(declarationPath)) {
    const declaration = readRootRustToolchainDeclaration(options.targetRoot);
    return {
      rustVersion: declaration.channel,
      existingDeclaration: declaration.declaration,
    };
  }
  return { rustVersion: releaseToolchainSnapshot.rustVersion };
}

function rustToolchain(
  contributions: readonly PackageContribution[],
): RustToolchain | undefined {
  const declarations = contributions.flatMap((contribution) => {
    const rust = contribution.foundation.toolchains.rust;
    if (rust === undefined) return [];
    if (typeof rust.configurationText !== "string") {
      throw new Error("Rust 工具链能力缺少 prepare 阶段配置文本");
    }
    return [{ ...rust, configurationText: rust.configurationText }];
  });
  const fingerprints = declarations.map((rust) =>
    JSON.stringify({
      toolchain: rust.toolchain,
      components: [...new Set(rust.components)].toSorted(),
      configurationText: rust.configurationText,
    }),
  );
  if (new Set(fingerprints).size > 1) {
    throw new Error("工作区要求所有 Rust 工具链声明相互兼容");
  }
  return declarations[0];
}

/** 默认策略纯投影 Rust 根声明，并在已有 Rust 仓库加包时保留原始字节。 */
export function projectRustTarget(options: {
  readonly context: GenerationContext & {
    readonly existingRustDeclaration?: string;
  };
  readonly packages: readonly GeneratorPackageState[];
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
  const existingDeclaration = wasAddition
    ? options.context.existingRustDeclaration
    : undefined;
  const text =
    existingDeclaration ??
    projectTomlStringValues(toolchain.configurationText, [
      { path: ["toolchain", "channel"], value: toolchain.toolchain },
    ]);
  return {
    toolchain,
    operation: {
      kind: "writeText",
      to: rootRustDeclarationFileName,
      text,
    },
  };
}
