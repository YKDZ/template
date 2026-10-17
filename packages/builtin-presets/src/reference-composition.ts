import { isDeepStrictEqual } from "node:util";

import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import { referencePackage as rust } from "@ykdz/reference-rust-bin/template";
import { referencePackage as cli } from "@ykdz/reference-ts-cli/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as database } from "@ykdz/reference-vike-db/template";
import { referencePackage as migrations } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as vike } from "@ykdz/reference-vike-web/template";
import { referencePackage as vue } from "@ykdz/reference-vue-app/template";
import { referencePackage as web } from "@ykdz/reference-vue-hono-web/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import type {
  GenerationContext,
  PlannedPackageContribution,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import { defineReferencePackage } from "@ykdz/template-core/reference-package";
import {
  resolveTemplateSource,
  type RenderOperation,
} from "@ykdz/template-core/renderer";

export class ReferenceCompositionFailure extends Error {
  readonly suggestion =
    "请先显式修正或迁移生成记录及共同包接口；新增操作不会推测身份或覆盖已有定制。";
}

export const configuration = defineReferencePackage(configurationDefinition);
export const typescriptReferencePackage = configuration;

export const referencePackages = [
  configuration,
  library,
  vueShared,
  vue,
  web,
  api,
  cli,
  rust,
  vike,
  database,
  migrations,
];

export function requireReferencePackage(identity: string) {
  const reference = referencePackages.find(
    (candidate) => candidate.manifest.name === identity,
  );
  if (reference === undefined)
    throw new ReferenceCompositionFailure(`未知原生参考包：${identity}`);
  return reference;
}

export function referenceDependencyNames(identity: string): readonly string[] {
  const reference = requireReferencePackage(identity);
  return [
    ...new Set(
      [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ].flatMap((field) => {
        const dependencies = reference.manifest[field];
        return typeof dependencies === "object" && dependencies !== null
          ? Object.keys(dependencies).filter(
              (name) =>
                !reference.authoringDependencies.includes(name) &&
                referencePackages.some(
                  (candidate) => candidate.manifest.name === name,
                ),
            )
          : [];
      }),
    ),
  ];
}

export function defaultReferenceDefinition(
  identity: string,
  context: GenerationContext,
): PackageDefinition {
  const reference = requireReferencePackage(identity);
  return {
    name: `@${context.defaultPackageScope}/${reference.defaultLeafName}`,
    path: reference.defaultPath ?? `packages/${reference.defaultLeafName}`,
    role: reference.role,
  };
}

function operationIdentity(operation: RenderOperation): string {
  return "to" in operation
    ? `content:${operation.to}`
    : `${operation.kind}:${operation.path}`;
}

function comparableOperation(operation: RenderOperation): unknown {
  if ("source" in operation)
    return {
      ...operation,
      source: resolveTemplateSource(operation.source, operation.from),
      from: ".",
    };
  if (operation.kind === "writeTextFromFragments")
    return {
      ...operation,
      fragments: operation.fragments.map((fragment) =>
        resolveTemplateSource(fragment.source, fragment.from),
      ),
    };
  return operation;
}

function preserveManifestChanges(
  original: Readonly<Record<string, unknown>>,
  provided: Readonly<Record<string, unknown>>,
  projected: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result = { ...projected };
  for (const key of new Set([
    ...Object.keys(original),
    ...Object.keys(provided),
  ])) {
    if (isDeepStrictEqual(original[key], provided[key])) continue;
    if (!Object.hasOwn(provided, key)) {
      delete result[key];
      continue;
    }
    const before = original[key];
    const after = provided[key];
    const rebound = projected[key];
    if (
      [before, after, rebound].every(
        (value) =>
          typeof value === "object" && value !== null && !Array.isArray(value),
      )
    ) {
      result[key] = preserveManifestChanges(
        before as Record<string, unknown>,
        after as Record<string, unknown>,
        rebound as Record<string, unknown>,
      );
    } else result[key] = after;
  }
  return result;
}

/** 只展开已登记原生包之间明确存在的依赖；同一次新增返回一个完整闭包。 */
export function composeReferenceContributions(options: {
  readonly context: GenerationContext;
  readonly requested: readonly PlannedPackageContribution[];
  readonly existing?: readonly PlannedPackageContribution[];
}): readonly PlannedPackageContribution[] {
  const existing = options.existing ?? [];
  const planned = new Map(
    options.requested.map((contribution) => [
      contribution.definition.path,
      contribution,
    ]),
  );
  if (planned.size !== options.requested.length)
    throw new ReferenceCompositionFailure("请求的包拥有重复目标路径。");
  const completed = new Set<string>();
  const visiting = new Set<string>();
  function visit(
    contribution: PlannedPackageContribution,
  ): PlannedPackageContribution {
    const identity = contribution.referenceSource;
    if (identity === undefined || completed.has(contribution.definition.path))
      return contribution;
    if (visiting.has(contribution.definition.path))
      throw new ReferenceCompositionFailure(`参考包依赖形成循环：${identity}`);
    visiting.add(contribution.definition.path);
    const bindings = new Map<string, PackageDefinition>();
    for (const dependencyName of referenceDependencyNames(identity)) {
      const reference = requireReferencePackage(dependencyName);
      const candidates = [...existing, ...planned.values()].filter(
        (candidate) => candidate.referenceSource === dependencyName,
      );
      if (candidates.length > 1)
        throw new ReferenceCompositionFailure(
          `无法唯一选择共同包 ${dependencyName} 的持久实例。`,
        );
      let provider = candidates[0];
      if (provider === undefined) {
        if (reference.instance !== "shared")
          throw new ReferenceCompositionFailure(
            `缺少明确的独立参考包实例：${dependencyName}`,
          );
        const definition = defaultReferenceDefinition(
          dependencyName,
          options.context,
        );
        provider = {
          ...reference.contribute({ context: options.context, definition }),
          planningIdentity: dependencyName,
        };
        const occupied = [...existing, ...planned.values()].find(
          (candidate) =>
            candidate.definition.name === definition.name ||
            candidate.definition.path === definition.path,
        );
        if (occupied !== undefined)
          throw new ReferenceCompositionFailure(
            `共同包 ${dependencyName} 的默认身份已被其他实例占用：${definition.path}`,
          );
        planned.set(definition.path, provider);
      }
      if (!existing.includes(provider)) provider = visit(provider);
      bindings.set(dependencyName, provider.definition);
    }
    const reference = requireReferencePackage(identity);
    const original = reference.contribute({
      context: options.context,
      definition: contribution.definition,
      bindings: new Map(Object.entries(contribution.referenceBindings ?? {})),
      planningIdentity: contribution.planningIdentity,
      creationOrigin: "new",
    });
    const projected = reference.contribute({
      context: options.context,
      definition: contribution.definition,
      bindings,
      planningIdentity: contribution.planningIdentity,
      creationOrigin: "new",
    });
    const result: PlannedPackageContribution = {
      ...contribution,
      ...projected,
      manifest: preserveManifestChanges(
        original.manifest,
        contribution.manifest,
        projected.manifest,
      ),
      // 仅重新绑定未经修改的原生操作；预设的替换、删除和追加仍进入正式渲染。
      operations: [
        ...contribution.operations.map((operation) => {
          const identity = operationIdentity(operation);
          const native = original.operations.find(
            (candidate) => operationIdentity(candidate) === identity,
          );
          const rebound = projected.operations.find(
            (candidate) => operationIdentity(candidate) === identity,
          );
          if (
            operation.kind === "copyFile" &&
            native?.kind === "copyFile" &&
            rebound?.kind === "copyFile"
          ) {
            // 替换资源来源仍需绑定共同依赖；仅显式修改的模块映射覆盖新绑定。
            return {
              ...operation,
              moduleSpecifiers: {
                ...rebound.moduleSpecifiers,
                ...Object.fromEntries(
                  Object.entries(operation.moduleSpecifiers ?? {}).filter(
                    ([name, target]) =>
                      native.moduleSpecifiers?.[name] !== target,
                  ),
                ),
              },
            };
          }
          if (
            native === undefined ||
            !isDeepStrictEqual(
              comparableOperation(native),
              comparableOperation(operation),
            )
          )
            return operation;
          return rebound ?? operation;
        }),
        ...projected.operations.filter(
          (operation) =>
            !original.operations.some(
              (native) =>
                operationIdentity(native) === operationIdentity(operation),
            ),
        ),
      ],
      // 预设拓扑声明根编排关系，原生依赖只负责公开依赖的绑定。
      foundation: { ...projected.foundation, ...contribution.foundation },
      planningIdentity: contribution.planningIdentity,
    };
    planned.set(result.definition.path, result);
    visiting.delete(result.definition.path);
    completed.add(result.definition.path);
    return result;
  }
  for (const contribution of options.requested) visit(contribution);
  return [...planned.values()];
}
