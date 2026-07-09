import type { GeneratedScenarioReplayCache } from "@ykdz/template-core/generated-scenarios";

export function fixtureReplayCacheFromEnv():
  | GeneratedScenarioReplayCache
  | undefined {
  const directory = process.env.TEMPLATE_FIXTURE_REPLAY_CACHE_DIR;

  if (!directory) {
    return undefined;
  }

  return {
    directory,
    read: process.env.TEMPLATE_FIXTURE_REPLAY_CACHE_READ !== "0",
    write: process.env.TEMPLATE_FIXTURE_REPLAY_CACHE_WRITE === "1",
  };
}
