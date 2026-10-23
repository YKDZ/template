export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 检查值是否能无损保存为 JSON 数据。 */
export function assertJsonValue(
  value: unknown,
  label: string,
): asserts value is JsonValue {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) return;
    if (typeof candidate !== "object") {
      throw new Error(`${label}必须是有效 JSON 数据`);
    }
    if (ancestors.has(candidate)) {
      throw new Error(`${label}必须是有效 JSON 数据`);
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      if (Object.keys(candidate).length !== candidate.length) {
        throw new Error(`${label}必须是有效 JSON 数据`);
      }
      for (const item of candidate) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(candidate).length > 0
      ) {
        throw new Error(`${label}必须是有效 JSON 数据`);
      }
      for (const item of Object.values(candidate)) visit(item);
    }
    ancestors.delete(candidate);
  };
  visit(value);
}

export function cloneJsonValue<Value extends JsonValue>(value: Value): Value {
  assertJsonValue(value, "数据");
  return JSON.parse(JSON.stringify(value)) as Value;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, sortJson(entry as JsonValue)]),
  );
}

/** 稳定打印 JSON，供元数据作为普通文件进入期望文件树。 */
export function printCanonicalJson(value: JsonValue): Uint8Array {
  assertJsonValue(value, "JSON 输出");
  return new TextEncoder().encode(
    `${JSON.stringify(sortJson(value), null, 2)}\n`,
  );
}
