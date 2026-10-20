import type {
  ContentIdentity,
  LoadedContentMember,
} from "@ykdz/template-core/content-identity";

type TestReferenceDefinition = Readonly<{
  readonly alias: string;
  readonly instance: "shared" | "independent";
  readonly manifest: Readonly<{ readonly name: string }>;
  readonly resolve: (specifier: string) => string;
}>;

const identities = new WeakMap<object, ContentIdentity>();

/** 将业务测试拥有的原生参考对象登记为显式内容成员。 */
export function loadTestReferences<
  const Definitions extends readonly TestReferenceDefinition[],
>(
  definitions: Definitions,
): {
  readonly [Index in keyof Definitions]: LoadedContentMember<
    Definitions[Index],
    "reference"
  >;
} {
  return definitions.map((definition) => {
    const identity = testContentIdentity(definition);
    return {
      identity,
      kind: "reference",
      alias: definition.alias,
      definition,
      source: {
        specifier: `${definition.manifest.name}/template`,
        moduleURL: new URL(
          definition.resolve(`${definition.manifest.name}/template`),
        ).href,
        manifestURL: new URL(
          definition.resolve(`${definition.manifest.name}/reference`),
        ).href,
      },
    };
  }) as {
    readonly [Index in keyof Definitions]: LoadedContentMember<
      Definitions[Index],
      "reference"
    >;
  };
}

export function testContentIdentity(
  definition: TestReferenceDefinition,
): ContentIdentity {
  const current = identities.get(definition);
  if (current !== undefined) return current;
  const identity = Object.freeze({
    namespace: "ykdz",
    packageName: definition.manifest.name,
    exportPath: "./template",
  });
  identities.set(definition, identity);
  return identity;
}
