import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const matcherSymbol = Symbol("test matcher");

type Matcher =
  | { readonly [matcherSymbol]: "any"; readonly constructor: Function }
  | {
      readonly [matcherSymbol]: "array-containing";
      readonly values: readonly unknown[];
    }
  | { readonly [matcherSymbol]: "object-containing"; readonly value: object }
  | { readonly [matcherSymbol]: "string-containing"; readonly value: string }
  | { readonly [matcherSymbol]: "string-matching"; readonly value: RegExp }
  | { readonly [matcherSymbol]: "not"; readonly value: unknown };

export function any(constructor: Function): Matcher {
  return { [matcherSymbol]: "any", constructor };
}

export function arrayContaining(values: readonly unknown[]): Matcher {
  return { [matcherSymbol]: "array-containing", values };
}

export function objectContaining(value: object): Matcher {
  return { [matcherSymbol]: "object-containing", value };
}

export function stringContaining(value: string): Matcher {
  return { [matcherSymbol]: "string-containing", value };
}

export function stringMatching(value: RegExp): Matcher {
  return { [matcherSymbol]: "string-matching", value };
}

export function not(value: unknown): Matcher {
  return { [matcherSymbol]: "not", value };
}

export function assertDeepStrictEqualWithMatchers(
  actual: unknown,
  expected: unknown,
): void {
  if (!hasMatcher(expected)) {
    assert.deepStrictEqual(actual, expected);
    return;
  }
  assertMatches(actual, expected, true);
}

export function assertPartialDeepStrictEqual(
  actual: unknown,
  expected: unknown,
): void {
  if (
    !hasMatcher(expected) &&
    !hasEmptyObject(expected) &&
    !(isPlainObject(expected) && isObjectLike(actual) && !isPlainObject(actual))
  ) {
    assert.partialDeepStrictEqual(actual, expected);
    assertArrayLengths(actual, expected);
    return;
  }
  assertMatches(actual, expected, false);
}

export function assertNotPartialDeepStrictEqual(
  actual: unknown,
  expected: unknown,
): void {
  assert.ok(!matches(actual, expected, false));
}

export function assertNotDeepStrictEqualWithMatchers(
  actual: unknown,
  expected: unknown,
): void {
  assert.ok(!matches(actual, expected, true));
}

export function assertContainsEqual(
  actual: readonly unknown[],
  expected: unknown,
): void {
  assert.ok(
    actual.some((candidate) =>
      hasMatcher(expected)
        ? matches(candidate, expected, true)
        : isDeepStrictEqual(candidate, expected),
    ),
    `Expected array to contain a value matching ${describe(expected)}`,
  );
}

export function assertContainsEach(
  actual: readonly unknown[],
  expected: readonly unknown[],
): void {
  for (const expectedValue of expected) {
    assert.ok(
      actual.some((candidate) =>
        hasMatcher(expectedValue)
          ? matches(candidate, expectedValue, true)
          : isDeepStrictEqual(candidate, expectedValue),
      ),
      `Expected array to contain a value matching ${describe(expectedValue)}`,
    );
  }
}

export function assertNotContainsEqual(
  actual: readonly unknown[],
  expected: unknown,
): void {
  assert.ok(!actual.some((candidate) => matches(candidate, expected, true)));
}

export function assertLength<Value>(
  actual: Value,
  expectedLength: number,
): asserts actual is Exclude<Value, null | undefined> {
  assert.ok(actual !== null && actual !== undefined);
  let actualLength: number;
  if (typeof actual === "string") {
    actualLength = actual.length;
  } else if (typeof actual === "object" && "size" in actual) {
    actualLength = actual.size as number;
  } else if (typeof actual === "object" && "length" in actual) {
    actualLength = actual.length as number;
  } else {
    assert.fail("Expected a value with a length or size");
  }
  assert.strictEqual(actualLength, expectedLength);
}

export function assertNotLength(
  actual: string | readonly unknown[] | ReadonlySet<unknown>,
  unexpectedLength: number,
): void {
  assert.notStrictEqual(getLength(actual), unexpectedLength);
}

export function assertMockCalledWith(
  actual: {
    readonly mock: {
      readonly calls: readonly { readonly arguments: readonly unknown[] }[];
    };
  },
  ...expectedArguments: readonly unknown[]
): void {
  assert.ok(
    actual.mock.calls.some((call) =>
      isDeepStrictEqual(call.arguments, expectedArguments),
    ),
  );
}

export function assertThrowsContaining(
  action: () => unknown,
  message: string,
): void {
  assertThrowsMatching(action, message);
}

export async function assertRejectsContaining(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  await assertRejectsMatching(promise, message);
}

export function assertThrowsMatching(
  action: () => unknown,
  expected: string | RegExp,
): void {
  assert.throws(action, (error: unknown) => matchesError(error, expected));
}

export async function assertRejectsMatching(
  promise: Promise<unknown> | (() => Promise<unknown>),
  expected: string | RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    matchesError(error, expected),
  );
}

export async function waitFor(
  check: () => void,
  options: { readonly timeout?: number; readonly interval?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 10;
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }

  if (lastError !== undefined) throw lastError;
  assert.fail(`Condition was not met within ${timeout}ms`);
}

type CaseRow<Case> = Case extends readonly unknown[] ? Case : readonly [Case];
type CaseColumn<Cases extends readonly unknown[], Index extends number> =
  CaseRow<Cases[number]> extends infer Row
    ? Row extends readonly unknown[]
      ? Index extends keyof Row
        ? Row[Index]
        : never
      : Index extends 0
        ? Row
        : never
    : never;
type CaseCallbackArguments<Cases extends readonly unknown[]> = [
  CaseColumn<Cases, 0>,
  CaseColumn<Cases, 1>,
  CaseColumn<Cases, 2>,
  CaseColumn<Cases, 3>,
  CaseColumn<Cases, 4>,
  CaseColumn<Cases, 5>,
];

export function testEach<const Cases extends readonly unknown[]>(
  cases: Cases,
  title: string,
  callback: (...values: CaseCallbackArguments<Cases>) => void | Promise<void>,
): void;
export function testEach(
  cases: readonly unknown[],
  title: string,
  callback: (...values: unknown[]) => void | Promise<void>,
): void {
  cases.forEach((value, index) => {
    const values = Array.isArray(value) ? [...value] : [value];
    const positionalTitle = title.replace(
      /%([sdifjoOp#%])/gu,
      (token, specifier: string) => {
        if (specifier === "%") return "%";
        if (specifier === "#") return String(index);
        const value = values.shift();
        switch (specifier) {
          case "d":
          case "i":
          case "f":
            return String(Number(value));
          case "j":
            return JSON.stringify(value) ?? "undefined";
          case "o":
          case "O":
            return JSON.stringify(value) ?? "undefined";
          default:
            return String(value);
        }
      },
    );
    const callbackValues = Array.isArray(value) ? value : [value];
    const row = Array.isArray(value) ? value[0] : value;
    const formattedTitle = positionalTitle
      .replace(/\$#/gu, String(index))
      .replace(/\$([A-Za-z_$][\w$]*)/gu, (_token, property: string) => {
        const propertyValue = readTitleProperty(row, property);
        return typeof propertyValue === "string"
          ? propertyValue
          : (JSON.stringify(propertyValue) ?? String(propertyValue));
      });
    const invoke = callback as unknown as (
      ...args: unknown[]
    ) => void | Promise<void>;
    void it(formattedTitle, async () => await invoke(...callbackValues));
  });
}

function readTitleProperty(value: unknown, property: string): unknown {
  let current = value;
  for (const segment of property.split(".")) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return current;
}

export function hasProperty(
  actual: unknown,
  propertyPath: PropertyKey | readonly PropertyKey[],
): boolean {
  const path = Array.isArray(propertyPath) ? propertyPath : [propertyPath];
  let current = actual;

  for (const key of path) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      !Object.hasOwn(current, key)
    ) {
      return false;
    }
    current = Reflect.get(current, key);
  }

  return true;
}

function matches(actual: unknown, expected: unknown, exact: boolean): boolean {
  if (isMatcher(expected)) {
    switch (expected[matcherSymbol]) {
      case "any":
        return matchesAny(actual, expected.constructor);
      case "array-containing":
        return (
          Array.isArray(actual) &&
          expected.values.every((value) =>
            actual.some((candidate) => matches(candidate, value, true)),
          )
        );
      case "object-containing":
        return matches(actual, expected.value, false);
      case "string-containing":
        return typeof actual === "string" && actual.includes(expected.value);
      case "string-matching":
        return (
          typeof actual === "string" &&
          new RegExp(expected.value.source, expected.value.flags).test(actual)
        );
      case "not":
        return !matches(actual, expected.value, exact);
    }
  }

  if (expected instanceof RegExp) {
    return (
      typeof actual === "string" &&
      new RegExp(expected.source, expected.flags).test(actual)
    );
  }

  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matches(actual[index], value, exact))
    );
  }

  if (isPlainObject(expected)) {
    const expectedKeys = Reflect.ownKeys(expected);
    if (expectedKeys.length === 0) {
      if (!exact) return true;
      if (!isPlainObject(actual)) return false;
      return (
        Reflect.ownKeys(actual).length === 0 &&
        Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected)
      );
    }
    let actualObject: object;
    if (exact) {
      if (!isPlainObject(actual)) return false;
      actualObject = actual;
    } else {
      if (!isObjectLike(actual)) return false;
      actualObject = actual;
    }
    const actualKeys = Reflect.ownKeys(actualObject);
    if (
      exact &&
      (actualKeys.length !== expectedKeys.length ||
        expectedKeys.some((key) => !actualKeys.includes(key)))
    ) {
      return false;
    }
    return expectedKeys.every(
      (key) =>
        Object.hasOwn(actualObject, key) &&
        matches(
          Reflect.get(actualObject, key),
          Reflect.get(expected, key),
          exact,
        ),
    );
  }

  return isDeepStrictEqual(actual, expected);
}

function assertMatches(
  actual: unknown,
  expected: unknown,
  exact: boolean,
): void {
  if (matches(actual, expected, exact)) return;

  if (
    isMatcher(expected) &&
    expected[matcherSymbol] === "object-containing" &&
    !hasMatcher(expected.value)
  ) {
    assert.partialDeepStrictEqual(actual, expected.value);
    assertArrayLengths(actual, expected.value);
    return;
  }

  if (!hasMatcher(expected) && (exact || !hasEmptyObject(expected))) {
    if (exact) assert.deepStrictEqual(actual, expected);
    else {
      assert.partialDeepStrictEqual(actual, expected);
      assertArrayLengths(actual, expected);
    }
    return;
  }

  assert.fail(
    `Expected ${describe(actual)} to ${exact ? "deeply equal" : "match"} ${describe(expected)}`,
  );
}

function assertArrayLengths(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.strictEqual(actual.length, expected.length);
    expected.forEach((value, index) => {
      assertArrayLengths(actual[index], value);
    });
    return;
  }

  if (!isPlainObject(expected) || !isPlainObject(actual)) return;
  for (const key of Reflect.ownKeys(expected)) {
    if (Object.hasOwn(actual, key)) {
      assertArrayLengths(Reflect.get(actual, key), Reflect.get(expected, key));
    }
  }
}

function hasMatcher(value: unknown): boolean {
  if (isMatcher(value)) return true;
  if (Array.isArray(value)) return value.some(hasMatcher);
  return (
    isPlainObject(value) &&
    Reflect.ownKeys(value).some((key) => hasMatcher(Reflect.get(value, key)))
  );
}

function hasEmptyObject(value: unknown): boolean {
  if (isPlainObject(value) && Reflect.ownKeys(value).length === 0) return true;
  if (Array.isArray(value)) return value.some(hasEmptyObject);
  return (
    isPlainObject(value) &&
    Reflect.ownKeys(value).some((key) =>
      hasEmptyObject(Reflect.get(value, key)),
    )
  );
}

function getLength(
  actual: string | readonly unknown[] | ReadonlySet<unknown>,
): number {
  if (typeof actual === "string") return actual.length;
  if ("size" in actual) return actual.size;
  return actual.length;
}

function isMatcher(value: unknown): value is Matcher {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, matcherSymbol) !== undefined
  );
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function matchesAny(actual: unknown, constructor: Function): boolean {
  if (constructor === String) return typeof actual === "string";
  if (constructor === Number) return typeof actual === "number";
  if (constructor === Boolean) return typeof actual === "boolean";
  if (constructor === Function) return typeof actual === "function";
  if (constructor === Object)
    return typeof actual === "object" && actual !== null;
  if (constructor === Array) return Array.isArray(actual);
  return actual instanceof constructor;
}

function matchesError(error: unknown, expected: string | RegExp): boolean {
  if (!(error instanceof Error)) return false;
  return typeof expected === "string"
    ? error.message.includes(expected)
    : new RegExp(expected.source, expected.flags).test(error.message);
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
