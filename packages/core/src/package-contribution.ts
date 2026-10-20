import path from "node:path";

import type { PackageDefinition } from "./project-blueprint.ts";
import type { RenderOperation } from "./renderer.ts";

/** 生成仓库计划中由单个包拥有的部分。 */
export type PackageContribution = {
  readonly definition: PackageDefinition;
  readonly operations: readonly RenderOperation[];
};

function operationPath(operation: RenderOperation): string {
  if ("to" in operation) return operation.to;
  if ("path" in operation) return operation.path;
  return "";
}

function isCanonicalRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value.split("/").every((segment) => segment.length > 0)
  );
}

/** 确保包贡献只写入自身的包边界。 */
export function assertPackageContribution(
  contribution: PackageContribution,
  provenance: {
    readonly definitionName?: string;
    readonly planner?: string;
  } = {},
): PackageContribution {
  const outsideOperation = contribution.operations.find((operation) => {
    const target = operationPath(operation);
    return (
      !isCanonicalRelativePath(target) ||
      !target.startsWith(`${contribution.definition.path}/`)
    );
  });
  if (outsideOperation) {
    const target = operationPath(outsideOperation);
    const rule = !isCanonicalRelativePath(target)
      ? "Package Contribution must use a canonical relative output path"
      : target.includes("/")
        ? "Package Contribution may not write a sibling Package Boundary"
        : "Package Contribution may not write a coordinated root output";
    const owner =
      provenance.definitionName === undefined
        ? ""
        : `${provenance.definitionName}: ${provenance.planner ?? "Package Contribution"} `;
    throw new Error(
      `${owner}${rule}; ${contribution.definition.path} attempted ${target}`,
    );
  }
  return contribution;
}
