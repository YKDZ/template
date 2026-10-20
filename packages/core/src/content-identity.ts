/** 内容身份只由来源命名空间、所属原生包名和公开导出入口确定。 */
export type ContentIdentity = Readonly<{
  readonly namespace: string;
  readonly packageName: string;
  readonly exportPath: string;
}>;

export type ContentKind = "preset" | "reference";

/** 选择可使用展示别名，或提供完整规范身份。 */
export type ContentSelector =
  | ContentIdentity
  | string
  | Readonly<{ alias: string; namespace?: string }>;

/** 装载后的成员保留原定义对象，并记录本次实际公开入口。 */
export type LoadedContentMember<
  Definition = unknown,
  Kind extends ContentKind = ContentKind,
> = Readonly<{
  readonly identity: ContentIdentity;
  readonly kind: Kind;
  readonly alias: string;
  readonly definition: Definition;
  readonly source: Readonly<{
    readonly specifier: string;
    readonly moduleURL: string;
    readonly manifestURL: string;
  }>;
}>;

export type ContentIndex<
  Member extends LoadedContentMember = LoadedContentMember,
> = Readonly<{
  readonly members: readonly Member[];
  resolve<Kind extends Member["kind"]>(
    selector: ContentSelector,
    expectedKind: Kind,
  ): Member & { readonly kind: Kind };
  fromDefinition<Kind extends Member["kind"]>(
    definition: unknown,
    expectedKind: Kind,
  ): Member & { readonly kind: Kind };
}>;

/** 使用JSON三元组作为Map键，避免分隔符碰撞和附加身份维度。 */
export function contentIdentityKey(identity: ContentIdentity): string {
  assertContentIdentity(identity);
  return JSON.stringify([
    identity.namespace,
    identity.packageName,
    identity.exportPath,
  ]);
}

export function contentIdentityLabel(identity: ContentIdentity): string {
  return `${identity.namespace}:${identity.packageName}#${identity.exportPath}`;
}

export function isContentIdentity(value: unknown): value is ContentIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.namespace === "string" &&
    record.namespace.trim().length > 0 &&
    typeof record.packageName === "string" &&
    record.packageName.trim().length > 0 &&
    typeof record.exportPath === "string" &&
    (record.exportPath === "." || record.exportPath.startsWith("./"))
  );
}

export function assertContentIdentity(
  value: unknown,
): asserts value is ContentIdentity {
  if (!isContentIdentity(value)) {
    throw new Error("内容身份必须包含命名空间、包名和公开导出入口");
  }
}

/** 创建纯索引；不访问磁盘、不解析模块，也不隐式补充未登记成员。 */
export function createContentIndex<Member extends LoadedContentMember>(
  members: readonly Member[],
): ContentIndex<Member> {
  const identities = new Map<string, Member>();
  const aliases = new Map<string, Member[]>();
  const definitions = new Map<object, Member[]>();

  for (const member of members) {
    assertContentIdentity(member.identity);
    if (member.kind !== "preset" && member.kind !== "reference") {
      throw new Error(`内容${contentIdentityLabel(member.identity)}的种类无效`);
    }
    if (typeof member.alias !== "string" || member.alias.trim().length === 0) {
      throw new Error(
        `内容${contentIdentityLabel(member.identity)}缺少有效别名`,
      );
    }
    const key = contentIdentityKey(member.identity);
    const previous = identities.get(key);
    if (previous !== undefined) {
      const cause =
        previous.source.moduleURL === member.source.moduleURL
          ? "重复规范身份"
          : "同一规范身份存在多个未明确选择的来源修订";
      throw new Error(`${cause}：${contentIdentityLabel(member.identity)}`);
    }
    identities.set(key, member);
    const aliasMembers = aliases.get(member.alias) ?? [];
    aliasMembers.push(member);
    aliases.set(member.alias, aliasMembers);
    if (typeof member.definition === "object" && member.definition !== null) {
      const definitionMembers = definitions.get(member.definition) ?? [];
      definitionMembers.push(member);
      definitions.set(member.definition, definitionMembers);
    }
  }

  const requireKind = <Kind extends Member["kind"]>(
    member: Member,
    expectedKind: Kind,
  ): Member & { readonly kind: Kind } => {
    if (member.kind !== expectedKind) {
      throw new Error(
        `内容${contentIdentityLabel(member.identity)}种类不符：需要${expectedKind}，实际为${member.kind}`,
      );
    }
    return member as Member & { readonly kind: Kind };
  };

  const resolve = <Kind extends Member["kind"]>(
    selector: ContentSelector,
    expectedKind: Kind,
  ): Member & { readonly kind: Kind } => {
    if (isContentIdentity(selector)) {
      const member = identities.get(contentIdentityKey(selector));
      if (member === undefined) {
        throw new Error(`规范内容不存在：${contentIdentityLabel(selector)}`);
      }
      return requireKind(member, expectedKind);
    }

    const aliasSelector =
      typeof selector === "string" ? { alias: selector } : selector;
    if (
      typeof aliasSelector.alias !== "string" ||
      aliasSelector.alias.trim().length === 0
    ) {
      throw new Error("内容别名不能为空");
    }
    const candidates = (aliases.get(aliasSelector.alias) ?? []).filter(
      (member) =>
        aliasSelector.namespace === undefined ||
        member.identity.namespace === aliasSelector.namespace,
    );
    if (candidates.length === 0) {
      throw new Error(`内容别名不存在：${aliasSelector.alias}`);
    }
    if (candidates.length > 1) {
      const choices = candidates
        .map((member) => contentIdentityLabel(member.identity))
        .join("、");
      throw new Error(`内容别名存在歧义：${aliasSelector.alias}（${choices}）`);
    }
    return requireKind(candidates[0]!, expectedKind);
  };

  const fromDefinition = <Kind extends Member["kind"]>(
    definition: unknown,
    expectedKind: Kind,
  ): Member & { readonly kind: Kind } => {
    if (typeof definition !== "object" || definition === null) {
      throw new Error("内容定义未由显式集合装载");
    }
    const candidates = (definitions.get(definition) ?? []).filter(
      (member) => member.kind === expectedKind,
    );
    if (candidates.length === 0) {
      throw new Error("内容定义未由显式集合装载");
    }
    if (candidates.length > 1) {
      throw new Error(
        `同一内容定义属于多个命名空间，必须明确来源：${candidates
          .map((member) => contentIdentityLabel(member.identity))
          .join("、")}`,
      );
    }
    return candidates[0] as Member & { readonly kind: Kind };
  };

  return Object.freeze({ members: [...members], resolve, fromDefinition });
}
