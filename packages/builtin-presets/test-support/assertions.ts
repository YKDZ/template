import assert from "node:assert/strict";
import { it } from "node:test";
import { format, isDeepStrictEqual } from "node:util";

const matcherTag = Symbol("test matcher");

type Matcher = {
  readonly [matcherTag]: true;
  readonly kind:
    | "any"
    | "array-containing"
    | "object-containing"
    | "string-containing"
    | "string-matching";
  readonly expected: unknown;
};

function createMatcher(kind: Matcher["kind"], expected: unknown): Matcher {
  return { [matcherTag]: true, kind, expected };
}

function isMatcher(value: unknown): value is Matcher {
  return typeof value === "object" && value !== null && matcherTag in value;
}

export function any(expectedType: Function): Matcher {
  return createMatcher("any", expectedType);
}

export function arrayContaining(expected: readonly unknown[]): Matcher {
  return createMatcher("array-containing", expected);
}

export function objectContaining(expected: object): Matcher {
  return createMatcher("object-containing", expected);
}

export function stringContaining(expected: string): Matcher {
  return createMatcher("string-containing", expected);
}

export function stringMatching(expected: RegExp): Matcher {
  return createMatcher("string-matching", expected);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesAny(value: unknown, expectedType: Function): boolean {
  switch (expectedType) {
    case Number:
      return typeof value === "number" || value instanceof Number;
    case String:
      return typeof value === "string" || value instanceof String;
    case Boolean:
      return typeof value === "boolean" || value instanceof Boolean;
    case BigInt:
      return typeof value === "bigint";
    case Symbol:
      return typeof value === "symbol";
    case Function:
      return typeof value === "function";
    case Object:
      return value !== null && typeof value === "object";
    case Array:
      return Array.isArray(value);
    default:
      return (
        value instanceof (expectedType as new (...args: never[]) => object)
      );
  }
}

function matchesStringPattern(
  value: unknown,
  expected: string | RegExp,
): boolean {
  if (typeof value !== "string") return false;
  if (typeof expected === "string") return value.includes(expected);

  expected.lastIndex = 0;
  const matches = expected.test(value);
  expected.lastIndex = 0;
  return matches;
}

function matchesExact(actual: unknown, expected: unknown): boolean {
  if (isMatcher(expected)) {
    switch (expected.kind) {
      case "any":
        return matchesAny(actual, expected.expected as Function);
      case "array-containing": {
        if (!Array.isArray(actual)) return false;
        return (expected.expected as readonly unknown[]).every((item) =>
          actual.some((candidate) => matchesExact(candidate, item)),
        );
      }
      case "object-containing": {
        if (!isObject(actual)) return false;
        const entries = Object.entries(expected.expected as object);
        return entries.every(
          ([key, value]) =>
            Object.hasOwn(actual, key) && matchesExact(actual[key], value),
        );
      }
      case "string-containing":
        return matchesStringPattern(actual, expected.expected as string);
      case "string-matching":
        return matchesStringPattern(actual, expected.expected as RegExp);
    }
  }

  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matchesExact(actual[index], value))
    );
  }

  if (isPlainRecord(expected)) {
    if (!isPlainRecord(actual)) return false;
    const actualKeys = Object.keys(actual).toSorted();
    const expectedKeys = Object.keys(expected).toSorted();
    return (
      isDeepStrictEqual(actualKeys, expectedKeys) &&
      expectedKeys.every((key) => matchesExact(actual[key], expected[key]))
    );
  }

  return isDeepStrictEqual(actual, expected);
}

function assertPartialMatch(actual: unknown, expected: unknown): void {
  if (isMatcher(expected)) {
    assert.ok(matchesExact(actual, expected));
    return;
  }

  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.strictEqual(actual.length, expected.length);
    expected.forEach((value, index) => {
      assertPartialMatch(actual[index], value);
    });
    return;
  }

  if (isPlainRecord(expected)) {
    assert.ok(isObject(actual));
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), `Missing property: ${key}`);
      assertPartialMatch(actual[key], value);
    }
    return;
  }

  assert.deepStrictEqual(actual, expected);
}

export function assertMatches(actual: unknown, expected: unknown): void {
  assert.ok(matchesExact(actual, expected), "Values did not match");
}

export function assertDoesNotMatch(actual: unknown, expected: unknown): void {
  assert.ok(!matchesExact(actual, expected), "Values unexpectedly matched");
}

export function assertMatchesPartial(actual: unknown, expected: unknown): void {
  assertPartialMatch(actual, expected);
}

export function assertDoesNotMatchPartial(
  actual: unknown,
  expected: unknown,
): void {
  try {
    assertPartialMatch(actual, expected);
  } catch (error) {
    if (error instanceof assert.AssertionError) return;
    throw error;
  }
  assert.fail("Values unexpectedly matched");
}

export function assertContains(actual: unknown, expected: unknown): void {
  if (typeof actual === "string" && typeof expected === "string") {
    assert.ok(
      actual.includes(expected),
      `Expected ${format("%o", actual)} to contain ${format("%o", expected)}`,
    );
    return;
  }
  if (Array.isArray(actual)) {
    assert.ok(actual.some((value) => Object.is(value, expected)));
    return;
  }
  if (actual instanceof Set) {
    assert.ok(actual.has(expected));
    return;
  }
  if (actual instanceof Map) {
    assert.ok(actual.has(expected));
    return;
  }
  assert.fail("Expected a string, array, set, or map");
}

export function assertDoesNotContain(actual: unknown, expected: unknown): void {
  if (typeof actual === "string" && typeof expected === "string") {
    assert.ok(!actual.includes(expected));
    return;
  }
  if (Array.isArray(actual)) {
    assert.ok(!actual.some((value) => Object.is(value, expected)));
    return;
  }
  if (actual instanceof Set) {
    assert.ok(!actual.has(expected));
    return;
  }
  if (actual instanceof Map) {
    assert.ok(!actual.has(expected));
    return;
  }
  assert.fail("Expected a string, array, set, or map");
}

export function assertContainsEqual(actual: unknown, expected: unknown): void {
  assert.ok(Array.isArray(actual));
  assert.ok(actual.some((value) => matchesExact(value, expected)));
}

function hasPropertyPath(
  actual: unknown,
  path: string | readonly PropertyKey[],
): boolean {
  const segments = typeof path === "string" ? path.split(".") : path;
  let current: unknown = actual;

  for (const segment of segments) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      !(segment in current)
    ) {
      return false;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }

  return true;
}

export function assertHasProperty(
  actual: unknown,
  path: string | readonly PropertyKey[],
  expected?: unknown,
): void {
  assert.ok(hasPropertyPath(actual, path));
  if (arguments.length === 3) {
    const segments = typeof path === "string" ? path.split(".") : path;
    let current = actual as Record<PropertyKey, unknown>;
    for (const segment of segments) {
      current = current[segment] as Record<PropertyKey, unknown>;
    }
    assert.deepStrictEqual(current, expected);
  }
}

export function assertLacksProperty(
  actual: unknown,
  path: string | readonly PropertyKey[],
): void {
  assert.ok(!hasPropertyPath(actual, path));
}

export function matchesThrownError(
  error: unknown,
  expected?: string | RegExp,
): boolean {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  return matchesStringPattern(message, expected);
}

export function assertThrows(
  callback: () => unknown,
  expected?: string | RegExp,
): void {
  assert.throws(callback, (error: unknown) =>
    matchesThrownError(error, expected),
  );
}

type TestResult = void | Promise<void>;

export function testEach<const Case>(
  cases: readonly Case[],
  name: string,
  handler: (value: Case) => TestResult,
): void;
export function testEach<const Cases extends readonly (readonly unknown[])[]>(
  cases: Cases,
  name: string,
  handler: (...args: [...Cases[number]]) => TestResult,
): void;
export function testEach(
  cases: readonly unknown[],
  name: string,
  handler: (...args: unknown[]) => TestResult,
): void {
  for (const [index, entry] of cases.entries()) {
    const args = Array.isArray(entry) ? entry : [entry];
    let testName = name.replaceAll("%#", String(index));
    if (/%[sdifjoO]/u.test(testName)) testName = format(testName, ...args);
    testName = testName.replace(
      /\$(\d+|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/gu,
      (_placeholder, key: string) => {
        let value: unknown;
        if (/^\d+$/u.test(key)) {
          value = args[Number(key)];
        } else {
          value = entry;
          for (const segment of key.split(".")) {
            if (
              (typeof value !== "object" && typeof value !== "function") ||
              value === null ||
              !(segment in value)
            ) {
              value = undefined;
              break;
            }
            value = (value as Record<string, unknown>)[segment];
          }
        }
        return format("%s", value);
      },
    );
    void it(testName, () => handler(...args));
  }
}
