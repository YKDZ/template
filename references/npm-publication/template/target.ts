import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";

export type PublicationConfiguration = { readonly publication: boolean };

/** 发布意图只由所属实例的现行配置表达。 */
export function normalizePublicationConfiguration(
  input: unknown,
): PublicationConfiguration {
  if (input === undefined) return { publication: false };
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("publication" in input) ||
    typeof input.publication !== "boolean" ||
    Object.keys(input).some((key) => key !== "publication")
  ) {
    throw new Error("发布配置必须是仅包含 publication 布尔值的对象。");
  }
  return { publication: input.publication };
}

export function isPublicationEnabled(
  input: unknown,
): input is PublicationConfiguration {
  return (
    typeof input === "object" &&
    input !== null &&
    "publication" in input &&
    input.publication === true
  );
}

/** 只选择已经由消费者原生清单声明的共享工具依赖。 */
export function publicationTargetDependencies(options: {
  readonly configuration: unknown;
  readonly dependencies: readonly string[];
}): readonly string[] {
  return options.dependencies.filter(
    (name) =>
      name !== "@ykdz/reference-npm-publication" ||
      isPublicationEnabled(options.configuration),
  );
}

/** 目标包投影自身发布清单、任务与资源，工具通过公开出口在目标 cwd 执行。 */
export function projectPublicationTarget(options: {
  readonly contribution: PackageContribution;
  readonly configuration: unknown;
  readonly bindings: ReadonlyMap<string, PackageDefinition> | undefined;
  readonly buildTask?: string;
}): PackageContribution {
  const { contribution, buildTask } = options;
  const scripts = {
    ...(contribution.manifest.scripts as Record<string, string>),
  };
  const enabled = isPublicationEnabled(options.configuration);
  if (enabled) {
    const tool = options.bindings?.get("@ykdz/reference-npm-publication");
    if (tool === undefined)
      throw new Error(
        `${contribution.definition.name} 的发布配置缺少共享工具实例绑定。`,
      );
    scripts["publication:prepare"] =
      `node --import ${tool.name}/prepare --eval ''`;
    scripts["publication:remote:npm"] =
      `node --import ${tool.name}/publish-target --eval '' --`;
    scripts["publication:remote:release"] =
      `node --import ${tool.name}/release-target --eval '' --`;
    if (buildTask !== undefined) {
      scripts.prepack = `node --import ${tool.name}/prepack-build --eval '' -- ${JSON.stringify(buildTask)}`;
    }
  } else {
    if (scripts.typecheck !== undefined) {
      scripts.typecheck = scripts.typecheck.replace(
        " && tsc -p tsconfig.scripts.json --noEmit --pretty false",
        "",
      );
    }
    delete scripts["publication:prepare"];
    delete scripts["publication:consume"];
    delete scripts["publication:remote:npm"];
    delete scripts["publication:remote:release"];
    delete scripts["publication:remote:npm"];
    delete scripts["publication:remote:release"];
  }
  return {
    ...contribution,
    manifest: {
      ...contribution.manifest,
      ...(enabled ? { private: false } : {}),
      scripts,
    },
    operations: contribution.operations
      .filter(
        (operation) =>
          enabled ||
          !(
            "to" in operation &&
            (operation.to === `${contribution.definition.path}/.npmignore` ||
              operation.to ===
                `${contribution.definition.path}/tsconfig.scripts.json` ||
              operation.to ===
                `${contribution.definition.path}/scripts/publication-consumer.ts`)
          ),
      )
      .map((operation) => {
        if (
          !enabled &&
          operation.kind === "writeJson" &&
          operation.to === `${contribution.definition.path}/tsconfig.json`
        ) {
          const config = operation.value as {
            readonly references: readonly { readonly path: string }[];
          };
          return {
            ...operation,
            value: {
              ...config,
              references: config.references.filter(
                (reference) => reference.path !== "./tsconfig.scripts.json",
              ),
            },
          };
        }
        if (
          operation.kind !== "writeJson" ||
          operation.to !== `${contribution.definition.path}/turbo.json`
        )
          return operation;
        const turbo = operation.value as {
          readonly tasks: Readonly<Record<string, unknown>>;
        };
        const tasks = { ...turbo.tasks };
        for (const name of Object.keys(tasks))
          if (name.startsWith("publication:")) delete tasks[name];
        if (enabled) {
          tasks["publication:prepare"] = {
            ...(buildTask === undefined ? {} : { dependsOn: [buildTask] }),
            tags: ["work:preparation"],
            cache: false,
            passThroughEnv: [
              "PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY",
              "PUBLICATION_BATCH_TARGET_COUNT",
              "PUBLICATION_REPOSITORY_ROOT",
              "PUBLICATION_SOURCE_SHA",
              "GITHUB_DEFAULT_BRANCH",
              ...(buildTask === undefined
                ? []
                : ["NPM_PUBLICATION_PREBUILT_TARGETS"]),
            ],
          };
          tasks["publication:consume"] = {
            tags: ["quality:conditional"],
            cache: false,
          };
          for (const task of [
            "publication:remote:npm",
            "publication:remote:release",
          ]) {
            tasks[task] = { tags: ["work:on-demand"], cache: false };
          }
        }
        return { ...operation, value: { ...turbo, tasks } };
      }),
  };
}
