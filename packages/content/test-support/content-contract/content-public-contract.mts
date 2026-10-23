import {
  deriveTemplateMembers,
  templateContent,
} from "@fixture/content-contract";
import type { Composition } from "@ykdz/template-core/composition";
import type { PackageDefinitionId } from "@ykdz/template-core/project-blueprint";
import { createGenerator } from "@ykdz/template-generator";

const derived = deriveTemplateMembers(templateContent);
const reference = derived.referencePackages.find(
  (member) => member.alias === "contract-reference",
);
const selectedPreset = derived.presets.find(
  (member) => member.alias === "contract-preset",
);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("内容合同fixture不完整");
  return value;
}
const requiredReference = required(reference);
const preset = required(selectedPreset);

const authorMarker: "reference-extension-v1" | "reference-extension-v2" =
  requiredReference.definition.authorExtension.marker;
const authorFormat: "reference-format-v1" | "reference-format-v2" =
  requiredReference.definition.authorExtension.describe().format;
const preparedRevision: "reference-prepared-v1" | "reference-prepared-v2" =
  requiredReference.definition.prepare().facts.revision;
const presetTitle: string = preset.definition.metadata.title;
const presetChannel: "preset-extension-v2" =
  preset.definition.authorExtension.channel;
const presetFlavor: "neutral-project-v2" =
  preset.definition.authorExtension.describe().flavor;
const presetCreationInput: string | undefined =
  preset.definition.nodes.library.creationInput?.init?.projectName;

for (const member of derived.referencePackages) {
  if (member.definition.revision === "reference-extension-v1") {
    if (member.identity.namespace !== "alpha") {
      throw new Error("v1参考包来源命名空间错误");
    }
    const marker: "reference-extension-v1" =
      member.definition.authorExtension.marker;
    const format: "reference-format-v1" =
      member.definition.authorExtension.describe().format;
    const revision: "reference-prepared-v1" =
      member.definition.prepare().facts.revision;
    void marker;
    void format;
    void revision;
  } else {
    if (member.identity.namespace !== "beta") {
      throw new Error("v2参考包来源命名空间错误");
    }
    const marker: "reference-extension-v2" =
      member.definition.authorExtension.marker;
    const revision: "reference-prepared-v2" =
      member.definition.prepare().facts.revision;
    // @ts-expect-error 同名包的不同来源修订保留不同的扩展类型。
    const wrongRevision: "reference-extension-v1" =
      member.definition.authorExtension.marker;
    void marker;
    void revision;
    void wrongRevision;
  }
}

function proveNegativeTypes(): void {
  const wrongReferenceExtension: string =
    // @ts-expect-error 参考包扩展只属于参考包定义。
    preset.definition.authorExtension.marker;
  const wrongPresetExtension: string =
    // @ts-expect-error 预设扩展只属于预设定义。
    requiredReference.definition.authorExtension.channel;
  // @ts-expect-error 派生的参考包成员保留作者准备事实类型。
  const wrongPreparedFacts: number =
    requiredReference.definition.prepare().facts.revision;
  // @ts-expect-error 预设元数据保留字符串类型。
  const wrongPresetTitle: number = preset.definition.metadata.title;
  void wrongReferenceExtension;
  void wrongPresetExtension;
  void wrongPreparedFacts;
  void wrongPresetTitle;

  void generator.prepareProject({
    selection: {},
    conventions: {},
    // @ts-expect-error 组合只接收已声明的本次外围事实。
    operationFacts: { providerVersion: 7, operation: "initialization" },
  });
  void generator.prepareProject({
    selection: {
      roots: [
        {
          nodeIdentity: "bad",
          contentIdentity: requiredReference.identity,
          // @ts-expect-error 创建输入由被选参考包的解析函数推导。
          creationInput: { projectName: 7 },
        },
      ],
    },
    conventions: {},
    operationFacts: {
      providerVersion: "provider-v2",
      operation: "initialization",
    },
  });
  void generator.add({
    repositoryRoot: "/tmp/content-contract",
    contentIdentity: requiredReference.identity,
    creationInput: {
      // @ts-expect-error 原生 add 入口沿用所选参考包的创建输入。
      projectName: 7,
    },
    operationFacts: {
      providerVersion: "provider-v2",
      // @ts-expect-error add 只接受已声明的操作类别。
      operation: "update",
    },
  });
}

type Conventions = { readonly policy: "neutral" };
type CreationInput = ReturnType<
  typeof requiredReference.definition.parseCreationInput
>;
type StableCommon = {
  readonly edition: string;
  readonly providerVersion: string;
};
type PackageInput = { readonly providerVersion: string };
type ContributionFacts = {
  readonly kind: "contract-contribution";
  readonly projectName: string;
  readonly providerVersion: string;
  readonly ownerRevision: "reference-prepared-v1" | "reference-prepared-v2";
};
type OwnerFacts = { readonly packageCount: number };
type OperationFacts = {
  readonly providerVersion: string;
  readonly operation: "initialization" | "addition";
};

const composition: Composition<
  Conventions,
  StableCommon,
  PackageInput,
  ContributionFacts,
  OwnerFacts,
  CreationInput,
  OperationFacts
> = {
  identity: {
    namespace: "contract",
    packageName: "@fixture/content-contract-composition",
    exportPath: "./composition",
  },
  parseConventions(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("policy" in value) ||
      value.policy !== "neutral"
    ) {
      throw new Error("约定无效");
    }
    return { policy: "neutral" };
  },
  resolve({ conventions, operationFacts, packages }) {
    const packageInputs = new Map<PackageDefinitionId, PackageInput>();
    for (const packageDefinition of packages) {
      packageInputs.set(packageDefinition.packageDefinitionId, {
        providerVersion: operationFacts.providerVersion,
      });
    }
    return {
      stableCommon: {
        edition: conventions.policy,
        providerVersion: operationFacts.providerVersion,
      },
      packageInputs,
    };
  },
  combine({ packages }) {
    return { facts: { packageCount: packages.length } };
  },
};

const generator = createGenerator({ content: templateContent, composition });
const calculated = await generator.prepareProject({
  selection: {
    presets: [{ contentIdentity: preset.identity }],
  },
  conventions: { policy: "neutral" },
  operationFacts: {
    providerVersion: "provider-v2",
    operation: "initialization",
  },
});
const result = generator.computeProject(calculated);
const ownerPackageCount: number = result.ownerFacts.packageCount;
const generatedContribution = result.packages[0];
if (generatedContribution === undefined) {
  throw new Error("计算结果缺少包贡献");
}
const contributionKind: "contract-contribution" =
  generatedContribution.contribution.facts.kind;
const contributionOwnerRevision:
  | "reference-prepared-v1"
  | "reference-prepared-v2" =
  generatedContribution.contribution.facts.ownerRevision;

void authorMarker;
void authorFormat;
void preparedRevision;
void presetTitle;
void presetChannel;
void presetFlavor;
void presetCreationInput;
void ownerPackageCount;
void contributionKind;
void contributionOwnerRevision;
void proveNegativeTypes;

export async function runContentContractInitialization(targetRoot: string) {
  const planned = await generator.planInit({
    targetRoot,
    selection: { presets: [{ contentIdentity: preset.identity }] },
    conventions: { policy: "neutral" },
    operationFacts: {
      providerVersion: "provider-v2",
      operation: "initialization",
    },
  });
  if (planned.status !== "planned") {
    throw new Error(`规划失败：${JSON.stringify(planned)}`);
  }
  const plannedOwnerCount: number = planned.ownerFacts.packageCount;
  const committed = await generator.commitPlan(planned.plan);
  if (committed.status !== "success") {
    throw new Error(`提交失败：${JSON.stringify(committed)}`);
  }
  return {
    packagePaths: committed.blueprint.packages.map(({ path }) => path),
    ownerPackageCount: committed.ownerFacts.packageCount,
    plannedOwnerCount,
    references: derived.referencePackages.map(({ identity, definition }) => ({
      namespace: identity.namespace,
      packageName: identity.packageName,
      revision: definition.authorExtension.marker,
    })),
  };
}

export async function runContentContractAddition(targetRoot: string) {
  const result = await generator.add({
    repositoryRoot: targetRoot,
    contentIdentity: requiredReference.identity,
    creationInput: { projectName: "contract-added" },
    operationFacts: {
      providerVersion: "provider-v3",
      operation: "addition",
    },
  });
  if (result.status === "success") {
    const packagePaths = new Map(
      result.blueprint.packages.map(({ packageDefinitionId, path }) => [
        packageDefinitionId,
        path,
      ]),
    );
    return {
      status: result.status,
      packagePaths: result.blueprint.packages.map(({ path }) => path),
      packageCount: result.generationRecord.packages.length,
      ownerPackageCount: result.ownerFacts.packageCount,
      additions: result.generationRecord.packages
        .filter(({ createdBy }) => createdBy === "addition")
        .map(({ packageDefinitionId, contentIdentity, creationInput }) => ({
          path: packagePaths.get(packageDefinitionId),
          namespace: contentIdentity.namespace,
          packageName: contentIdentity.packageName,
          creationInput,
        })),
      references: derived.referencePackages.map(({ identity, definition }) => ({
        namespace: identity.namespace,
        packageName: identity.packageName,
        revision: definition.authorExtension.marker,
      })),
    };
  }
  if (result.status === "conflict") {
    return {
      status: result.status,
      conflictCount: result.conflicts.length,
      actions: result.actions,
    };
  }
  return {
    status: result.status,
    phase: result.phase,
    error: result.error.message,
  };
}
