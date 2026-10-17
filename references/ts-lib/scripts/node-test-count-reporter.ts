const emptySuiteDiagnostic =
  "没有执行任何 Node 业务测试用例；请检查测试 glob 与测试内容";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default async function* requireExecutedTestCase(
  events: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  let count = 0;

  for await (const event of events) {
    if (
      !isRecord(event) ||
      (event.type !== "test:pass" && event.type !== "test:fail")
    ) {
      continue;
    }
    const data = event.data;
    if (!isRecord(data) || typeof data.entryFile !== "string") continue;
    if (data.skip || data.todo) continue;
    if (!isRecord(data.details) || data.details.type !== "test") continue;
    count += 1;
  }

  if (count === 0) {
    process.exitCode = 1;
    yield `${emptySuiteDiagnostic}\n`;
  }
}
