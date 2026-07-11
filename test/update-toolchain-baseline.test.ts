import {
  runToolchainBaselineUpdate,
  type ToolchainBaselineUpdateRepository,
} from "@ykdz/template-checks/update-toolchain-baseline";

function fakeRepository(options: {
  candidate?: number;
  current?: { nodeLtsMajor: string; packageManagerPin: `pnpm@${string}` };
}) {
  const events: string[] = [];
  const repository: ToolchainBaselineUpdateRepository = {
    readBaseline: async () =>
      options.current ?? {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    findCandidate: async () =>
      ({
        pullRequest:
          options.candidate === undefined
            ? { kind: "absent" }
            : { kind: "open", pullRequestNumber: options.candidate },
        remoteBranch:
          options.candidate === undefined
            ? { kind: "absent" }
            : { kind: "present", sha: "abc123" },
      }) as const,
    cleanupCandidate: async (number) => {
      events.push(`cleanup:${number}`);
    },
    refreshFromDefaultBranch: async () => {
      events.push("refresh");
    },
    writeBaseline: async (baseline) => {
      events.push(
        `write:${baseline.nodeLtsMajor}:${baseline.packageManagerPin}`,
      );
    },
    provisionToolchain: async (baseline) => {
      events.push(
        `provision:${baseline.nodeLtsMajor}:${baseline.packageManagerPin}`,
      );
    },
    refreshLockfile: async () => {
      events.push("lockfile");
    },
    runChecks: async () => {
      events.push("checks");
    },
    commitAndGuardedForcePush: async () => {
      events.push("push-with-lease");
    },
    createCandidate: async () => {
      events.push("create-pr");
    },
    refreshCandidate: async (number) => {
      events.push(`refresh-pr:${number}`);
    },
  };

  return { events, repository };
}

const desired = {
  nodeLtsMajor: { kind: "NodeLtsMajor" as const, value: "26" },
  packageManagerPin: {
    kind: "PackageManagerPin" as const,
    value: "pnpm@12.1.0" as const,
  },
  source: "online" as const,
  diagnostics: [],
};

describe("toolchain baseline updater", () => {
  it("refreshes one candidate from the default branch and validates all baseline material before pushing", async () => {
    const fake = fakeRepository({ candidate: 41 });

    await runToolchainBaselineUpdate({
      repository: fake.repository,
      resolve: async () => desired,
    });

    expect(fake.events).toEqual([
      "refresh",
      "write:26:pnpm@12.1.0",
      "provision:26:pnpm@12.1.0",
      "lockfile",
      "checks",
      "push-with-lease",
      "refresh-pr:41",
    ]);
  });

  it("creates a candidate without auto-merging when no candidate exists", async () => {
    const fake = fakeRepository({});

    await runToolchainBaselineUpdate({
      repository: fake.repository,
      resolve: async () => desired,
    });

    expect(fake.events.at(-1)).toBe("create-pr");
    expect(fake.events).not.toContain("merge");
  });

  it("closes and deletes an obsolete candidate when the default branch already matches", async () => {
    const fake = fakeRepository({
      candidate: 41,
      current: { nodeLtsMajor: "26", packageManagerPin: "pnpm@12.1.0" },
    });

    await runToolchainBaselineUpdate({
      repository: fake.repository,
      resolve: async () => desired,
    });

    expect(fake.events).toEqual(["cleanup:41"]);
  });

  it("does not mutate the repository when there is no drift or candidate", async () => {
    const fake = fakeRepository({
      current: { nodeLtsMajor: "26", packageManagerPin: "pnpm@12.1.0" },
    });

    const result = await runToolchainBaselineUpdate({
      repository: fake.repository,
      resolve: async () => desired,
    });

    expect(result).toEqual({ kind: "no-drift" });
    expect(fake.events).toEqual([]);
  });
});
