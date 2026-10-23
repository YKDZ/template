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

const canonicalJsonPrintWidth = 80;

function isScalarJsonValue(value: JsonValue): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function stringifyJsonValue(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("JSON 输出无法序列化");
  }
  return serialized;
}

function formatCanonicalJsonValue(
  value: JsonValue,
  indentation: number,
  currentColumn = indentation,
  trailingComma = false,
): string {
  if (Array.isArray(value)) {
    if (value.every(isScalarJsonValue)) {
      const compact = `[${value.map(stringifyJsonValue).join(", ")}]`;
      if (
        currentColumn + compact.length + (trailingComma ? 1 : 0) <=
        canonicalJsonPrintWidth
      ) {
        return compact;
      }
    }
    return (
      "[\n" +
      value
        .map(
          (item, index) =>
            `${" ".repeat(indentation + 2)}${formatCanonicalJsonValue(
              item,
              indentation + 2,
              indentation + 2,
              index < value.length - 1,
            )}`,
        )
        .join(",\n") +
      `\n${" ".repeat(indentation)}]`
    );
  }
  if (!isRecord(value)) return stringifyJsonValue(value);

  const entries = Object.entries(value).toSorted(([left], [right]) =>
    compareStrings(left, right),
  );
  if (entries.length === 0) return "{}";
  return (
    "{\n" +
    entries
      .map(
        ([key, entry], index) =>
          `${" ".repeat(indentation + 2)}${JSON.stringify(key)}: ${formatCanonicalJsonValue(
            entry as JsonValue,
            indentation + 2,
            indentation + 2 + JSON.stringify(key).length + 2,
            index < entries.length - 1,
          )}`,
      )
      .join(",\n") +
    `\n${" ".repeat(indentation)}}`
  );
}

/** 稳定打印 JSON，供元数据作为普通文件进入期望文件树。 */
export function printCanonicalJson(value: JsonValue): Uint8Array {
  assertJsonValue(value, "JSON 输出");
  return new TextEncoder().encode(
    `${formatCanonicalJsonValue(sortJson(value), 0)}\n`,
  );
}
